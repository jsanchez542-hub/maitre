import { turnEffects, type TurnResult } from '../src/agent/agent.js';
import { comparable, referencesIn } from '../src/agent/guards.js';
import type { Language } from '../src/i18n/index.js';
import type { Booking, CallbackRequest } from '../src/store.js';
import type { Expectation, Scenario } from './scenarios.js';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** What one run of a scenario left behind: its turns, and the bookings and callbacks it created. */
export interface Outcome {
  turns: TurnResult[];
  /** Bookings made during the conversation (not by the setup). */
  newBookings: Booking[];
  /** Every booking after the conversation, setup ones included. */
  allBookings: Booking[];
  callbacks: CallbackRequest[];
  refs: Record<string, string>;
  /** The guest's number, from the channel or typed in the web chat's field, if any. */
  phone: string | null;
}

/** The same comparison the guard uses, so the evaluation measures what the code enforces. */
export const normalize = comparable;

/**
 * Words that belong to one language only. Words shared by two of them ("la",
 * "de", "en", "que") are left out: in a Spanish list of dishes, "la" appears
 * four times and would make it look French.
 */
const STOPWORDS: Record<Language, ReadonlySet<string>> = {
  fr: new Set(['vous', 'votre', 'vos', 'nous', 'pour', 'avec', 'est', 'sont', 'une', 'des', 'du', 'au', 'aux', 'je', 'pas', 'souhaitez', 'merci', 'très', 'cette', 'mais', 'êtes', 'avez', 'pouvez']),
  en: new Set(['the', 'you', 'your', 'for', 'with', 'is', 'are', 'and', 'to', 'of', 'we', 'not', 'this', 'that', 'can', 'would', 'have', 'will', 'please', 'thank']),
  es: new Set(['usted', 'para', 'una', 'los', 'las', 'es', 'son', 'y', 'su', 'sus', 'con', 'por', 'gracias', 'puedo', 'desea', 'del', 'está', 'están', 'muy', 'pero', 'estos', 'platos']),
};

/** The language a reply is most likely in, or undefined when it is too short or too mixed to tell. */
export function detectLanguage(text: string): Language | undefined {
  const words = text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿñæœáíóú]+/g) ?? [];
  if (words.length < 8) return undefined;
  const scores = (Object.keys(STOPWORDS) as Language[]).map((language) => ({
    language,
    score: words.filter((word) => STOPWORDS[language].has(word)).length,
  }));
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best || best.score === 0 || (second && best.score === second.score)) return undefined;
  return best.language;
}

const LEAKS = /\b(find_table|book_table|check_dish|dishes_without|hand_over|holdId|sayExactly|passedToTeam|needsPhone|internal_error|invalid_input)\b|"status"\s*:/;

/** A title in front of a name: it guesses whether the guest is a man or a woman, which none of them said. */
const TITLE = /\b(?:[Mm]onsieur|[Mm]adame|[Mm]ademoiselle|Mme|Mlle|M\.|Mr|Mrs|Ms|Miss|[Ss]e[ñn]or|[Ss]e[ñn]ora|[Ss]e[ñn]orita|Sra|Srta|Sr)\.?\s+\p{Lu}/u;

/** Rules every reply of every conversation must follow, whatever the scenario. */
export function universalChecks(scenario: Scenario, outcome: Outcome): Check[] {
  const checks: Check[] = [];
  outcome.turns.forEach((turn, index) => {
    const label = `turn ${index + 1}`;
    if (turn.outcome !== 'answered') {
      checks.push({ name: `${label} answered`, ok: false, detail: turn.outcome });
    }

    for (const tool of turn.tools) {
      if (tool.name !== 'check_dish' || tool.output.status !== 'ok') continue;
      const sentences = (tool.output['sayExactly'] as string[] | undefined) ?? [];
      for (const sentence of sentences) {
        const relayed = normalize(turn.reply).includes(normalize(sentence));
        checks.push({
          name: `${label} repeats the allergen sheet word for word`,
          ok: relayed,
          ...(relayed ? {} : { detail: `missing: ${sentence}` }),
        });
      }
    }

    const leak = LEAKS.exec(turn.reply);
    checks.push({ name: `${label} shows no internals`, ok: !leak, ...(leak ? { detail: leak[0] } : {}) });

    const styleProblem = /\*\*|^#|^\s*[-*] |[–—]/m.exec(turn.reply);
    checks.push({ name: `${label} is plain text`, ok: !styleProblem, ...(styleProblem ? { detail: styleProblem[0] } : {}) });

    const title = TITLE.exec(turn.reply);
    checks.push({ name: `${label} guesses no title for the guest`, ok: !title, ...(title ? { detail: title[0] } : {}) });

    const detected = detectLanguage(turn.reply);
    if (detected !== undefined) {
      checks.push({
        name: `${label} is in ${scenario.language}`,
        ok: detected === scenario.language,
        ...(detected === scenario.language ? {} : { detail: `looks like ${detected}` }),
      });
    }

    if (outcome.phone) {
      const national = outcome.phone.slice(-9);
      const compact = turn.reply.replace(/[\s.\-  ]/g, '');
      const repeated = compact.includes(national);
      checks.push({ name: `${label} never repeats the guest's number`, ok: !repeated });
    }

    // On the phone a reference is noise the caller cannot note: none is ever read out.
    if (scenario.channel === 'voice') {
      const spoken = referencesIn(outcome.turns.flatMap((each) => each.tools.map((tool) => tool.output))).find((reference) =>
        new RegExp([...reference].join('[\\s.,-]*'), 'i').test(turn.reply),
      );
      checks.push({ name: `${label} reads no booking reference aloud`, ok: !spoken, ...(spoken ? { detail: spoken } : {}) });
      // Nothing is sent after a call: a written confirmation offered on the phone is a promise nobody keeps.
      const promised = IN_WRITING.exec(turn.reply);
      checks.push({ name: `${label} promises nothing in writing`, ok: !promised, ...(promised ? { detail: promised[0] } : {}) });
      // Only the last reply may end the call: a line that hangs up earlier cuts the caller off.
      if (index < outcome.turns.length - 1) {
        checks.push({ name: `${label} keeps the line open`, ok: !turnEffects(turn.tools).hangUp });
      }
    }
  });
  return checks;
}

/** A confirmation offered in writing, in the three languages. */
const IN_WRITING =
  /par (?:écrit|sms|e-?mail|mail|message)|in writing|by (?:text|sms|e-?mail)|send you (?:a )?(?:text|confirmation|e-?mail)|por (?:escrito|sms|correo|mensaje)/i;

function describeBooking(booking: Booking): string {
  return `${booking.date} ${booking.time} for ${booking.partySize} (${booking.guestName}, ${booking.status})`;
}

export function expectationCheck(expectation: Expectation, outcome: Outcome): Check {
  const replies = outcome.turns.map((turn) => turn.reply);
  switch (expectation.kind) {
    case 'booking': {
      const label = `booked ${expectation.date} ${expectation.time} for ${expectation.partySize}`;
      if (outcome.newBookings.length !== 1) {
        return {
          name: label,
          ok: false,
          detail: `${outcome.newBookings.length} bookings made: ${outcome.newBookings.map(describeBooking).join('; ') || 'none'}`,
        };
      }
      const booking = outcome.newBookings[0] as Booking;
      const problems: string[] = [];
      if (booking.date !== expectation.date) problems.push(`date ${booking.date}`);
      if (booking.time !== expectation.time) problems.push(`time ${booking.time}`);
      if (booking.partySize !== expectation.partySize) problems.push(`party of ${booking.partySize}`);
      if (expectation.name && !expectation.name.test(booking.guestName)) problems.push(`name "${booking.guestName}"`);
      if (expectation.phone && booking.phone !== expectation.phone) problems.push('phone is not the one the guest gave');
      for (const allergen of expectation.allergies ?? []) {
        if (!booking.allergies.includes(allergen)) problems.push(`allergy ${allergen} not recorded`);
      }
      return { name: label, ok: problems.length === 0, ...(problems.length ? { detail: problems.join(', ') } : {}) };
    }
    case 'no_booking':
      return {
        name: 'nothing booked',
        ok: outcome.newBookings.length === 0,
        ...(outcome.newBookings.length ? { detail: outcome.newBookings.map(describeBooking).join('; ') } : {}),
      };
    case 'handover': {
      const matching = outcome.callbacks.filter(
        (callback) => (expectation.reason === undefined || callback.reason === expectation.reason) && (expectation.phone === undefined || callback.phone === expectation.phone),
      );
      const shown = (callback: CallbackRequest): string => `${callback.reason}${expectation.phone ? (callback.phone ? ' with a number' : ' with no number') : ''}`;
      return {
        name: `handed over${expectation.reason ? ` (${expectation.reason})` : ''}${expectation.phone ? ' with the guest’s number' : ''}`,
        ok: matching.length > 0,
        ...(matching.length ? {} : { detail: `callbacks: ${outcome.callbacks.map(shown).join(', ') || 'none'}` }),
      };
    }
    case 'cancelled': {
      const booking = outcome.allBookings.find((candidate) => candidate.reference === outcome.refs[expectation.ref]);
      return { name: `cancelled ${expectation.ref}`, ok: booking?.status === 'cancelled', detail: booking ? booking.status : 'missing' };
    }
    case 'moved': {
      const booking = outcome.allBookings.find((candidate) => candidate.reference === outcome.refs[expectation.ref]);
      const ok = booking?.date === expectation.date && booking.time === expectation.time && booking.status !== 'cancelled';
      return { name: `moved ${expectation.ref} to ${expectation.date} ${expectation.time}`, ok, ...(booking ? { detail: describeBooking(booking) } : { detail: 'missing' }) };
    }
    case 'tool': {
      const called = outcome.turns.some((turn) => turn.tools.some((tool) => tool.name === expectation.name && tool.output.status === 'ok'));
      return { name: `used ${expectation.name}`, ok: called };
    }
    case 'hangs_up': {
      const hangs = outcome.turns.map((turn) => turnEffects(turn.tools).hangUp);
      const ok = hangs.at(-1) === true && hangs.slice(0, -1).every((hung) => !hung);
      return { name: 'hangs up after the last reply, and only then', ok, ...(ok ? {} : { detail: `hang-ups by turn: ${hangs.join(', ')}` }) };
    }
    case 'stays_open': {
      const ok = outcome.turns.every((turn) => !turnEffects(turn.tools).hangUp);
      return { name: 'keeps the line open', ok };
    }
    case 'reply': {
      const ok = replies.some((reply) => expectation.pattern.test(reply));
      return { name: `a reply matches ${expectation.pattern}`, ok };
    }
    case 'no_reply': {
      const offending = replies.find((reply) => expectation.pattern.test(reply));
      return { name: `no reply matches ${expectation.pattern}`, ok: !offending, ...(offending ? { detail: offending.slice(0, 160) } : {}) };
    }
  }
}

export function checkScenario(scenario: Scenario, outcome: Outcome): Check[] {
  return [...scenario.expect.map((expectation) => expectationCheck(expectation, outcome)), ...universalChecks(scenario, outcome)];
}
