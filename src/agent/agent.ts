import type { BookingEngine, Session } from '../engine.js';
import { messages } from '../i18n/index.js';
import { TOOL_DEFINITIONS, runTool, type ToolOutput } from '../tools.js';
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
}

export interface ToolRecord {
  name: string;
  input: unknown;
  output: ToolOutput;
  ms: number;
}

export type TurnOutcome = 'answered' | 'failed_handed_over' | 'failed_retry' | 'empty_message';

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
  outcome: TurnOutcome;
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
    };
  }

  const working: TranscriptEntry[] = [...trimTranscript(transcript), { role: 'user', text }];
  const tools: ToolRecord[] = [];
  const modelMs: number[] = [];
  let usage: Usage = NO_USAGE;
  let costUsd: number | undefined = 0;
  const system = buildSystemPrompt(engine.config, session.language, session.channel, engine.now());
  const maxCalls = options.maxModelCalls ?? 6;

  const finish = (reply: string, outcome: TurnOutcome): TurnResult => {
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
      outcome,
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
    usage = addUsage(usage, response.usage);
    costUsd = costUsd === undefined || response.costUsd === undefined ? undefined : costUsd + response.costUsd;

    if (response.toolCalls.length === 0) {
      const reply = sanitizeReply(response.text, session.channel);
      if (reply === '') return fail(new Error('The model answered with an empty message'));
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
        outcome: 'answered',
      };
    }

    working.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls });
    for (const toolCall of response.toolCalls) {
      const toolStarted = clock();
      const output = runTool(engine, session, toolCall.name, toolCall.input, options.onError);
      tools.push({ name: toolCall.name, input: toolCall.input, output, ms: clock() - toolStarted });
      working.push({ role: 'tool', callId: toolCall.id, name: toolCall.name, output });
    }
  }

  return fail(new Error(`No answer after ${maxCalls} model calls`));
}
