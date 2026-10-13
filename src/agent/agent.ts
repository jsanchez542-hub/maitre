import type { BookingEngine, Session } from '../engine.js';
import { messages } from '../i18n/index.js';
import { TOOL_DEFINITIONS, bookingWaitsForPhone, runTool, type ToolOutput } from '../tools.js';
import { dropGuessedTitles, dropNameVocatives, dropSpokenReferences, enforceAllergenRelay, promisesTeam, referencesIn } from './guards.js';
import { addUsage, NO_USAGE, type LanguageModel, type TranscriptEntry, type Usage } from './model.js';
import { buildSystemPrompt } from './prompt.js';
import { sanitizeReply } from './sanitize.js';

export interface AgentOptions {
  /** Model calls allowed in one turn before giving up: a guard against loops. */
  maxModelCalls?: number;
  maxOutputTokens?: number;
  /** Hears about failures that the guest only sees as a polite message. */
  onError?: (error: unknown) => void;
  /** Milliseconds, for latency. Injected so tests are predictable. */
  clock?: () => number;
  /** Hears the tools the model is about to run, before they run: the phone line says a short line meanwhile. */
  onToolCalls?: (names: readonly string[]) => void;
}

export interface ToolRecord {
  name: string;
  input: unknown;
  output: ToolOutput;
  ms: number;
}

/**
 * What the code tells the model once the guest has typed their number in the
 * web chat's own field, so the turn goes on without the guest having to write
 * "done". The guest never writes this and never sees it: the chat shows the
 * number sent, then the reply.
 */
export const PHONE_ENTERED =
  '[Note from the website, not written by the guest: they have just typed their phone number in the field below the chat. Carry on from where you were.]';

/** The same note on the phone, once the caller has typed their number on the keypad and pressed the hash key. */
export const KEYPAD_ENTERED =
  '[Note from the phone line, not said by the caller: they have just typed their phone number on the keypad. Carry on from where you were.]';

/** What a turn did, read from the engine's answers and never from the reply: what a chat or a dashboard shows besides the words. */
export interface TurnEffects {
  /** Bookings made, moved, or asked for again in this turn. */
  booked: { reference: string; date: string; time: string; partySize: number }[];
  /** A request passed to the team, which will call the guest back. */
  passedToTeam: boolean;
  /** The web chat should now show its phone field. */
  askForPhone: boolean;
}

export function turnEffects(tools: readonly { name: string; output: ToolOutput }[]): TurnEffects {
  const booked: TurnEffects['booked'] = [];
  for (const tool of tools) {
    // A guest who asks for the same booking twice gets the one they already have: it is theirs all the same.
    const made =
      (tool.name === 'book_table' && (tool.output.status === 'booked' || tool.output.status === 'duplicate')) ||
      (tool.name === 'change_booking' && tool.output.status === 'changed');
    const booking = tool.output['booking'] as { reference?: unknown; date?: unknown; time?: unknown; partySize?: unknown } | undefined;
    if (made && booking && typeof booking.reference === 'string' && typeof booking.date === 'string' && typeof booking.time === 'string') {
      booked.push({ reference: booking.reference, date: booking.date, time: booking.time, partySize: Number(booking.partySize) });
    }
  }
  return {
    booked,
    passedToTeam: tools.some((tool) => (tool.name === 'hand_over' && tool.output.status === 'recorded') || tool.output['passedToTeam'] === true),
    askForPhone: tools.some((tool) => tool.output.status === 'phone_required' || tool.output['needsPhone'] === true),
  };
}

export type TurnOutcome = 'answered' | 'failed_handed_over' | 'failed_retry' | 'empty_message';

/** A rule the code enforced because the model did not follow it on its own. */
export type Correction = 'allergen_relay' | 'guessed_title' | 'name_vocative' | 'spoken_reference' | 'kept_promise' | 'needless_hand_over';

/** Whether the last booking the conversation tried waits only for the guest's number. */
export function waitsForNumber(transcript: readonly TranscriptEntry[]): boolean {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role === 'tool' && entry.name === 'book_table') return entry.output.status === 'phone_required';
  }
  return false;
}

/**
 * A hand_over for no stated reason while a booking waits only for the number is
 * a model taking that wait for a failure: the team would call back about a table
 * the caller was about to book, and the caller would hear it could not be made.
 * Large groups, events and complaints go to the team as ever.
 */
function needlessHandOver(name: string, input: unknown, transcript: readonly TranscriptEntry[]): boolean {
  return name === 'hand_over' && (input as { reason?: unknown } | null)?.reason === 'other' && waitsForNumber(transcript);
}

/** Whether the conversation has already passed something to the team: by hand_over, or by an allergen question the sheet could not answer. */
function passedOn(transcript: readonly TranscriptEntry[]): boolean {
  return transcript.some(
    (entry) => entry.role === 'tool' && ((entry.name === 'hand_over' && entry.output.status === 'recorded') || entry.output['passedToTeam'] === true),
  );
}

export interface TurnResult {
  /** What the guest sees or hears. */
  reply: string;
  /** The conversation including this turn, to pass to the next one. */
  transcript: TranscriptEntry[];
  tools: ToolRecord[];
  usage: Usage;
  /** Sum of the costs providers reported. Missing when one call did not report it. */
  costUsd?: number;
  modelCalls: number;
  /** From the guest's message to the reply, tools included. */
  latencyMs: number;
  /** Time spent waiting for the model alone, per call. */
  modelMs: number[];
  /** Who served each model call, when a router chose: a provider that changes loses the prompt cache. */
  servedBy?: string[];
  outcome: TurnOutcome;
  /** Rules the code had to enforce in this turn: how far the model can be trusted on its own. */
  corrections: Correction[];
}

const MAX_MESSAGE_LENGTH = 2000;
const MAX_TRANSCRIPT_ENTRIES = 60;

/**
 * Keeps a long conversation within bounds by dropping its oldest part, always
 * cutting before a guest message so no tool result is left without its call.
 */
export function trimTranscript(transcript: readonly TranscriptEntry[], max = MAX_TRANSCRIPT_ENTRIES): TranscriptEntry[] {
  if (transcript.length <= max) return [...transcript];
  let start = transcript.length - max;
  while (start < transcript.length && transcript[start]?.role !== 'user') start += 1;
  return transcript.slice(start);
}

/**
 * One turn of the conversation: the guest's message in, the reply out.
 *
 * The model may call tools several times before answering. If anything fails,
 * or the model loops, the guest gets a message written by the code, never an
 * error, and when the conversation has a phone number the team is asked to
 * call back.
 */
export async function respond(
  engine: BookingEngine,
  model: LanguageModel,
  session: Session,
  transcript: readonly TranscriptEntry[],
  message: string,
  options: AgentOptions = {},
): Promise<TurnResult> {
  const clock = options.clock ?? (() => Date.now());
  const started = clock();
  const words = messages(session.language);
  const text = message.trim().slice(0, MAX_MESSAGE_LENGTH);

  if (text === '') {
    return {
      reply: words.emptyMessage(),
      transcript: [...transcript],
      tools: [],
      usage: NO_USAGE,
      modelCalls: 0,
      latencyMs: clock() - started,
      modelMs: [],
      outcome: 'empty_message',
      corrections: [],
    };
  }

  // A conversation that ends with the guest's words lost the reply to them, which the caller never heard:
  // what they said then and say now is one message.
  const earlier = trimTranscript(transcript);
  const unanswered = earlier.at(-1);
  const working: TranscriptEntry[] =
    unanswered?.role === 'user' ? [...earlier.slice(0, -1), { role: 'user', text: `${unanswered.text} ${text}` }] : [...earlier, { role: 'user', text }];
  const tools: ToolRecord[] = [];
  const modelMs: number[] = [];
  const servedBy: string[] = [];
  // Rules the code enforced on the tool calls, before the reply.
  const guarded: Correction[] = [];
  let usage: Usage = NO_USAGE;
  let costUsd: number | undefined = 0;
  const system = buildSystemPrompt(engine.config, session.language, session.channel, engine.now());
  const maxCalls = options.maxModelCalls ?? 6;

  const finish = (reply: string, outcome: TurnOutcome, corrections: Correction[] = []): TurnResult => {
    working.push({ role: 'assistant', text: reply, toolCalls: [] });
    return {
      reply,
      transcript: working,
      tools,
      usage,
      ...(costUsd === undefined ? {} : { costUsd }),
      modelCalls: modelMs.length,
      latencyMs: clock() - started,
      modelMs,
      ...(servedBy.length > 0 ? { servedBy } : {}),
      outcome,
      corrections,
    };
  };

  const fail = (error: unknown): TurnResult => {
    options.onError?.(error);
    if (!session.phone) return finish(words.failureRetry(), 'failed_retry');
    try {
      const recorded = engine.requestCallback(session, {
        reason: 'other',
        summary: `The assistant could not finish answering: "${text.slice(0, 300)}"`,
      });
      if (recorded.status === 'recorded') return finish(words.failureHandedOver(), 'failed_handed_over');
    } catch (callbackError) {
      // The guest is only told the team will call when the request was really recorded.
      options.onError?.(callbackError);
    }
    return finish(words.failureRetry(), 'failed_retry');
  };

  for (let call = 0; call < maxCalls; call += 1) {
    const before = clock();
    let response;
    try {
      response = await model.complete({
        system,
        transcript: working,
        tools: TOOL_DEFINITIONS,
        maxOutputTokens: options.maxOutputTokens ?? 700,
      });
    } catch (error) {
      modelMs.push(clock() - before);
      return fail(error);
    }
    modelMs.push(clock() - before);
    if (response.servedBy) servedBy.push(response.servedBy);
    usage = addUsage(usage, response.usage);
    costUsd = costUsd === undefined || response.costUsd === undefined ? undefined : costUsd + response.costUsd;

    if (response.toolCalls.length === 0) {
      const cleaned = sanitizeReply(response.text, session.channel, session.language);
      if (cleaned === '') return fail(new Error('The model answered with an empty message'));
      const corrections: Correction[] = [...guarded];
      let reply = cleaned;
      const relay = enforceAllergenRelay(reply, tools);
      if (relay.corrected) {
        reply = sanitizeReply(relay.reply, session.channel, session.language);
        corrections.push('allergen_relay');
      }
      const untitled = dropGuessedTitles(reply);
      if (untitled.corrected) {
        reply = untitled.reply;
        corrections.push('guessed_title');
      }
      // The names the model booked or held under in this conversation, as its own tool calls gave them.
      const names = working.flatMap((entry) =>
        entry.role === 'assistant' ? entry.toolCalls.map((call) => (call.input as Record<string, unknown> | null)?.['guestName']) : [],
      );
      const unnamed = dropNameVocatives(reply, names.filter((name): name is string => typeof name === 'string'));
      if (unnamed.corrected) {
        reply = unnamed.reply;
        corrections.push('name_vocative');
      }
      if (session.channel === 'voice') {
        // Any reference the conversation has seen, this turn's or an earlier one's.
        const references = referencesIn(working.flatMap((entry) => (entry.role === 'tool' ? [entry.output] : [])));
        const unread = dropSpokenReferences(reply, references);
        if (unread.corrected) {
          reply = unread.reply;
          corrections.push('spoken_reference');
        }
      }
      // A promise to the guest is kept by code: told the team has their request, the team gets it,
      // even when the model said so without calling hand_over.
      if (promisesTeam(reply) && !passedOn(working) && waitsForNumber(working) && (session.channel === 'voice' || session.channel === 'web')) {
        // Waiting only for the number, the team has nothing to call back about: the guest is asked for it instead.
        reply = words.bookingNeedsNumber(session.channel);
        if (!corrections.includes('needless_hand_over')) corrections.push('needless_hand_over');
      } else if (promisesTeam(reply) && !passedOn(working)) {
        const input = { reason: 'other', summary: `Told the team would get back to them, from: "${text.slice(0, 300)}"` };
        const output = runTool(engine, session, 'hand_over', input, options.onError);
        if (output.status === 'recorded') {
          // Written into the conversation as the call the model should have made, so it is never passed on twice.
          const callId = `kept-promise-${working.length}`;
          working.push({ role: 'assistant', text: '', toolCalls: [{ id: callId, name: 'hand_over', input }] });
          working.push({ role: 'tool', callId, name: 'hand_over', output });
          tools.push({ name: 'hand_over', input, output, ms: 0 });
          corrections.push('kept_promise');
        }
      }
      return finish(reply, 'answered', corrections);
    }

    working.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls });
    try {
      options.onToolCalls?.(response.toolCalls.map((toolCall) => toolCall.name));
    } catch (error) {
      // Whoever listens cannot break the turn: the guest still gets the answer.
      options.onError?.(error);
    }
    for (const toolCall of response.toolCalls) {
      const toolStarted = clock();
      const needless = needlessHandOver(toolCall.name, toolCall.input, working);
      if (needless) guarded.push('needless_hand_over');
      const output: ToolOutput = needless
        ? { status: 'not_needed', instruction: bookingWaitsForPhone(session.channel) }
        : runTool(engine, session, toolCall.name, toolCall.input, options.onError);
      tools.push({ name: toolCall.name, input: toolCall.input, output, ms: clock() - toolStarted });
      working.push({ role: 'tool', callId: toolCall.id, name: toolCall.name, output });
    }
  }

  return fail(new Error(`No answer after ${maxCalls} model calls`));
}
