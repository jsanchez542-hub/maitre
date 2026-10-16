import {
  validateConfig,
  type Activity,
  type BusinessConfig,
  type FreeTablesResult,
  type Language,
  type PlainDate,
  type PlainTime,
  type ServiceDay,
  type StaffActionResult,
  type StaffBookRequest,
  type StaffBookResult,
  type StaffBookingView,
  type StaffChangeRequest,
  type StaffChangeResult,
  type TableActionResult,
} from 'maitre';
import type { DemoSuggestion } from 'maitre/demo';
import { callsFrom, turnsFrom, type CallRecord, type TurnRecord } from './conversations';
import type { EditableSettings, SettingsAnswer } from './settings';

/**
 * The live demo, on the same origin under /v1/demo: each visitor gets a
 * restaurant of their own for 24 hours, on the real date and time in Bordeaux,
 * its service seeded around the hour it opened, and talks there to the real
 * assistant.
 */

/** What can go wrong with the live demo, in terms the page can explain. */
export type LiveProblem =
  | 'turnstile_failed'
  | 'too_many_sandboxes'
  | 'live_paused'
  | 'not_configured'
  | 'not_found'
  | 'rate_limited'
  | 'sandbox_limit'
  | 'call_limit'
  /** The restaurant takes no calls now: no voice agent has checked in, or its speech fails. */
  | 'calls_unavailable'
  | 'invalid'
  | 'offline'
  | 'unexpected';

export class LiveError extends Error {
  readonly problem: LiveProblem;

  constructor(problem: LiveProblem) {
    super(`The live demo answered ${problem}`);
    this.name = 'LiveError';
    this.problem = problem;
  }
}

/** The Worker's own codes, from its `{ error }` bodies. Anything else is unexpected. */
const PROBLEMS: Record<string, LiveProblem> = {
  turnstile_failed: 'turnstile_failed',
  too_many_sandboxes: 'too_many_sandboxes',
  live_paused: 'live_paused',
  not_configured: 'not_configured',
  not_found: 'not_found',
  rate_limited: 'rate_limited',
  sandbox_limit: 'sandbox_limit',
  call_limit: 'call_limit',
  calls_unavailable: 'calls_unavailable',
  invalid: 'invalid',
  body_too_large: 'invalid',
  body_is_not_json: 'invalid',
  body_must_be_an_object: 'invalid',
};

/** The calls a restaurant of the demo takes from the browser: how many, and how long each may last. */
export interface CallOffer {
  perRestaurant: number;
  maxSeconds: number;
}

/** The restaurant's time, and what follows from it: the service the panel opens on, and the table a guest could still book. */
export interface RestaurantTime {
  /** An instant in UTC: the real time. */
  clock: string;
  /** Today while one of today's services is still going, otherwise the next day the restaurant opens. */
  day: PlainDate;
  suggestion: DemoSuggestion;
  /**
   * The calls the restaurant still takes, as the Worker counts them: a pass counts while it is inside its minute to
   * join, or once the agent has started the call. Null where the Worker does not say.
   */
  callsLeft: number | null;
}

export interface Sandbox extends RestaurantTime {
  id: string;
  expiresAt: string;
  /** Null when the demo cannot take calls (no voice agent): then the page offers none. */
  calls: CallOffer | null;
}

/**
 * Whether the live demo is open now (its model reachable, its budget not spent), the call's terms if it takes calls,
 * and the restaurant's time, before the visitor has a restaurant of their own.
 */
export interface DemoStatus {
  live: boolean;
  calls: CallOffer | null;
  now: string;
  /** The date in Bordeaux. */
  today: PlainDate;
  day: PlainDate;
  suggestion: DemoSuggestion;
}

/** The pass into the call's room, where the voice agent answers, good for one call of `maxSeconds` at most. */
export interface Line {
  url: string;
  token: string;
  sessionId: string;
  maxSeconds: number;
  /** The calls left once this pass counts. */
  callsLeft: number | null;
}

export interface Booked {
  reference: string;
  date: PlainDate;
  time: PlainTime;
  partySize: number;
}

/** One turn of the assistant, with what the engine did in it: never read from the reply's text. */
export interface Turn {
  reply: string;
  askForPhone: boolean;
  booked: Booked[];
  passedToTeam: boolean;
}

export type PhoneAnswer = ({ status: 'ok'; phone: string } & Turn) | { status: 'unreadable' };

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const segment = encodeURIComponent;

/** The Worker's answer, its `{ error }` bodies turned into the page's own problems. */
async function send(path: string, body?: Json, method: 'POST' | 'PUT' = 'POST'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path === '' ? '/v1/demo' : `/v1/demo/${path}`, {
      method: body === undefined ? 'GET' : method,
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new LiveError('offline');
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (isRecord(json) && typeof json['error'] === 'string') {
    throw new LiveError(Object.hasOwn(PROBLEMS, json['error']) ? (PROBLEMS[json['error']] ?? 'unexpected') : 'unexpected');
  }
  return json;
}

async function call(path: string, body?: Json, method?: 'POST' | 'PUT'): Promise<{ json: Json }> {
  const json = await send(path, body, method);
  if (!isRecord(json)) throw new LiveError('unexpected');
  return { json };
}

/** A list the Worker answers, such as the latest turns. */
async function list(path: string): Promise<unknown[]> {
  const json = await send(path);
  if (!Array.isArray(json)) throw new LiveError('unexpected');
  return json;
}

/** Bookings as the Worker reports them, keeping only well-formed ones: it is read from the network and from storage. */
export function bookedFrom(value: unknown): Booked[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Booked[] =>
    isRecord(entry) &&
    typeof entry['reference'] === 'string' &&
    typeof entry['date'] === 'string' &&
    typeof entry['time'] === 'string' &&
    typeof entry['partySize'] === 'number'
      ? [{ reference: entry['reference'], date: entry['date'], time: entry['time'], partySize: entry['partySize'] }]
      : [],
  );
}

function readTurn(json: Json): Turn {
  if (json['status'] === 'invalid') throw new LiveError('invalid');
  if (json['status'] !== 'ok' || typeof json['reply'] !== 'string') throw new LiveError('unexpected');
  return {
    reply: json['reply'],
    askForPhone: json['askForPhone'] === true,
    booked: bookedFrom(json['booked']),
    passedToTeam: json['passedToTeam'] === true,
  };
}

/** The Worker's offer of calls, as it sent it or as the browser kept it. */
export function callOfferFrom(value: unknown): CallOffer | null {
  return isRecord(value) && typeof value['perRestaurant'] === 'number' && typeof value['maxSeconds'] === 'number'
    ? { perRestaurant: value['perRestaurant'], maxSeconds: value['maxSeconds'] }
    : null;
}

// Fields of a known, short length: the patterns only ever see ten or five characters.
const isDate = (value: unknown): value is PlainDate => typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: unknown): value is PlainTime => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value);
const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function readSuggestion(value: unknown): DemoSuggestion {
  if (!isRecord(value) || !isDate(value['date']) || !isTime(value['time']) || typeof value['partySize'] !== 'number') throw new LiveError('unexpected');
  return { date: value['date'], time: value['time'], partySize: value['partySize'] };
}

const callsLeftOf = (json: Json): number | null => (typeof json['callsLeft'] === 'number' ? json['callsLeft'] : null);

function readTime(json: Json, clock: unknown): RestaurantTime {
  if (!isInstant(clock) || !isDate(json['day'])) throw new LiveError('unexpected');
  return { clock, day: json['day'], suggestion: readSuggestion(json['suggestion']), callsLeft: callsLeftOf(json) };
}

/** Asked on every visit, without opening a restaurant or counting the visitor. */
export async function readDemoStatus(): Promise<DemoStatus> {
  const { json } = await call('');
  if (typeof json['live'] !== 'boolean' || !isDate(json['today'])) throw new LiveError('unexpected');
  const { clock, day, suggestion } = readTime(json, json['now']);
  return { live: json['live'], calls: json['live'] ? callOfferFrom(json['calls']) : null, now: clock, today: json['today'], day, suggestion };
}

/** A restaurant of the visitor's own, once Turnstile has vouched for them: its guests' requests are written in the page's language. */
export async function openSandbox(turnstile: string, language: Language): Promise<Sandbox> {
  const { json } = await call('sandboxes', { turnstile, language });
  if (typeof json['sandbox'] !== 'string' || typeof json['expiresAt'] !== 'string') throw new LiveError('unexpected');
  return { id: json['sandbox'], expiresAt: json['expiresAt'], ...readTime(json, json['clock']), calls: callOfferFrom(json['calls']) };
}

/** «Appeler le restaurant»: a line to the visitor's restaurant, whose agent greets in `language`. */
export async function openLine(sandbox: string, language: Language): Promise<Line> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/calls`, { language });
  const { url, token, sessionId, maxSeconds } = json;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof sessionId !== 'string' || typeof maxSeconds !== 'number') throw new LiveError('unexpected');
  return { url, token, sessionId, maxSeconds, callsLeft: callsLeftOf(json) };
}

export async function say(sandbox: string, sessionId: string, message: string, language: Language): Promise<Turn> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/chat`, { sessionId, message, language });
  return readTurn(json);
}

/** The number typed in the chat's own field. The restaurant keeps it and the assistant answers at once. */
export async function sendPhone(sandbox: string, sessionId: string, phone: string): Promise<PhoneAnswer> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/sessions/${segment(sessionId)}/phone`, { phone });
  if (json['status'] === 'invalid') return { status: 'unreadable' };
  if (typeof json['phone'] !== 'string') throw new LiveError('unexpected');
  return { status: 'ok', phone: json['phone'], ...readTurn(json) };
}

export async function readDay(sandbox: string, date: PlainDate, language: Language): Promise<ServiceDay> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/day?date=${segment(date)}&language=${language}`);
  if (json['status'] === 'invalid') throw new LiveError('invalid');
  if (typeof json['date'] !== 'string' || !Array.isArray(json['bookings'])) throw new LiveError('unexpected');
  return json as unknown as ServiceDay;
}

export async function readClockOf(sandbox: string): Promise<RestaurantTime> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/clock`);
  return readTime(json, json['clock']);
}

export type StaffAction = 'confirm' | 'arrived' | 'seated' | 'left' | 'table' | 'cancel' | 'no-show';

/** The engine's answer to the staff, refusals included: they are answers to show, not failures. */
export async function staffAction(
  sandbox: string,
  reference: string,
  action: StaffAction,
  language: Language,
  table?: string,
): Promise<StaffActionResult | TableActionResult> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/staff/bookings/${segment(reference)}/${action}`, { language, ...(table ? { table } : {}) });
  if (typeof json['status'] !== 'string') throw new LiveError('unexpected');
  return json as unknown as StaffActionResult | TableActionResult;
}

/** «Fait» on a request to call back: the team has called. */
export async function completeCallback(sandbox: string, id: string): Promise<'done' | 'not_found'> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/staff/callbacks/${segment(id)}/done`, {});
  if (json['status'] !== 'done' && json['status'] !== 'not_found') throw new LiveError('unexpected');
  return json['status'];
}

/** What the staff changed on a booking, and only that: a field left out stays as it is. */
export async function staffChange(sandbox: string, reference: string, change: StaffChangeRequest): Promise<StaffChangeResult> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/staff/bookings/${segment(reference)}/change`, { ...change });
  if (typeof json['status'] !== 'string') throw new LiveError('unexpected');
  return json as unknown as StaffChangeResult;
}

/** The other tables that would take a booking for its whole stay: exactly those a move to a table accepts. */
export async function freeTablesOf(sandbox: string, reference: string): Promise<FreeTablesResult> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/staff/bookings/${segment(reference)}/tables`);
  if (json['status'] === 'ok' && !(Array.isArray(json['free']) && json['free'].every((table) => typeof table === 'string'))) throw new LiveError('unexpected');
  if (typeof json['status'] !== 'string') throw new LiveError('unexpected');
  return json as unknown as FreeTablesResult;
}

export async function staffBook(sandbox: string, request: StaffBookRequest): Promise<StaffBookResult> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/staff/bookings`, { ...request });
  if (typeof json['status'] !== 'string') throw new LiveError('unexpected');
  return json as unknown as StaffBookResult;
}

/** The assistant's latest turns, the most recent first, as the restaurant logged them for its owner. */
export async function readTurns(sandbox: string, limit: number): Promise<TurnRecord[]> {
  return turnsFrom(await list(`sandboxes/${segment(sandbox)}/conversations?limit=${limit}`));
}

/** The latest calls to the restaurant, the most recent first. */
export async function readCalls(sandbox: string, limit: number): Promise<CallRecord[]> {
  return callsFrom(await list(`sandboxes/${segment(sandbox)}/calls?limit=${limit}`));
}

/** Settings as the restaurant sent them, checked as the engine checks them: the panel draws every part of them. */
function configFrom(value: unknown): BusinessConfig {
  if (!isRecord(value)) throw new LiveError('unexpected');
  const config = value as unknown as BusinessConfig;
  let problems: string[];
  try {
    problems = validateConfig(config);
  } catch {
    // A part of the wrong kind altogether, which the validator cannot even walk.
    problems = ['the settings are not in the expected shape'];
  }
  if (problems.length > 0) throw new LiveError('unexpected');
  return config;
}

export async function readConfig(sandbox: string): Promise<BusinessConfig> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/config`);
  return configFrom(json);
}

/** The owner's changes, which the restaurant merges and checks as a whole: all kept, or nothing and why. */
export async function saveConfig(sandbox: string, settings: EditableSettings, language: Language): Promise<SettingsAnswer> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/config`, { settings, language }, 'PUT');
  if (json['status'] === 'invalid') {
    const problems = Array.isArray(json['problems']) ? json['problems'].filter((problem): problem is string => typeof problem === 'string') : [];
    return { status: 'invalid', problems };
  }
  if (json['status'] !== 'ok') throw new LiveError('unexpected');
  return { status: 'ok', config: configFrom(json['config']), outsideHours: bookingsIn(json['outsideHours']) };
}

/** Bookings as the staff see them, as the restaurant listed them: a list of records, or none. */
function bookingsIn(value: unknown): StaffBookingView[] {
  return Array.isArray(value) ? value.filter((entry): entry is StaffBookingView => isRecord(entry) && typeof entry['reference'] === 'string') : [];
}

/** The bookings the opening hours now leave out, to call: the list empties as each is moved or cancelled. */
export async function readOutsideHours(sandbox: string, language: Language): Promise<StaffBookingView[]> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/outside-hours?language=${language}`);
  if (!Array.isArray(json['bookings'])) throw new LiveError('unexpected');
  return bookingsIn(json['bookings']);
}

/** What the assistant did for the restaurant over its last `days`, today included. */
export async function readActivity(sandbox: string, days: number): Promise<Activity> {
  const { json } = await call(`sandboxes/${segment(sandbox)}/activity?days=${days}`);
  if (json['status'] === 'invalid') throw new LiveError('invalid');
  const { bookings, conversations, calls } = json;
  if (!isDate(json['from']) || !isDate(json['to']) || !isRecord(bookings) || !isRecord(conversations) || !isRecord(calls)) throw new LiveError('unexpected');
  if (!isRecord(bookings['byChannel']) || !isRecord(calls['answerMs'])) throw new LiveError('unexpected');
  return json as unknown as Activity;
}
