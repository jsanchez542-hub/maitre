import type { TurnEvents } from '../../src/agent/agent.js';
import type { TranscriptEntry, Usage } from '../../src/agent/model.js';
import type { Language } from '../../src/i18n/index.js';
import type { Channel, PhoneSource } from '../../src/store.js';

/**
 * What the assistant remembers of each conversation, and the log the owner
 * reads in the dashboard: every turn with its reply, latency and cost, so the
 * assistant is never a black box. Both are deleted after `RETENTION_DAYS`.
 */

export const RETENTION_DAYS = 90;

export interface StoredSession {
  id: string;
  channel: Channel;
  language: Language;
  phone?: string;
  phoneSource?: PhoneSource;
  transcript: TranscriptEntry[];
  updatedAt: string;
  /**
   * The last turn the phone line asked for, by its own id, and the answer it got:
   * a line that asks again after a dropped connection gets the same answer
   * instead of a second turn.
   */
  lastTurn?: { id: string; answer: unknown };
}

/** One phone call, for the dashboard: how long it lasted, how it ended and how fast each answer came. */
export interface CallLog {
  sessionId: string;
  startedAt: string;
  language: Language;
  endedAt?: string;
  seconds?: number;
  endedBy?: CallEndedBy;
  /** For each answer, from the caller's last word to the agent's first, as the voice agent measured it. */
  voiceToVoiceMs?: number[];
}

/** Who ended a call: the caller hung up, or the line did, after a goodbye, a silence, the call's longest or the demo's budget. */
export const CALL_ENDINGS = ['caller', 'goodbye', 'silence', 'time_limit', 'paused', 'error'] as const;
export type CallEndedBy = (typeof CALL_ENDINGS)[number];

export interface TurnLog {
  at: string;
  sessionId: string;
  channel: Channel;
  language: Language;
  /** What the guest wrote; empty on the turn that followed the number typed in the web chat's field. */
  guest: string;
  /** The turn the code started once the guest typed their number in the web chat's field or on the keypad. */
  phoneEntered?: true;
  /** On the phone, the short line said while the tools ran, before the reply. */
  working?: string;
  /** The turn was answered by the fallback model: the first one's provider failed. */
  fellBack?: true;
  /** On the phone, the caller had heard none of the reply before: they spoke on before it began. */
  unheardBefore?: true;
  reply: string;
  outcome: string;
  latencyMs: number;
  modelCalls: number;
  /** Time spent waiting for the model alone, per call. */
  modelMs?: number[];
  /** Who served each model call: a provider that changes loses the prompt cache, and the call is slower. */
  servedBy?: string[];
  usage: Usage;
  costUsd?: number;
  /** Tool names and their status only: the full outputs stay out of the log. */
  tools: { name: string; status: string }[];
  corrections: string[];
  /** What the turn did, as the dashboard tells the conversation: bookings made, with their names, moved and cancelled. */
  booked?: TurnEvents['booked'];
  changed?: TurnEvents['changed'];
  cancelled?: TurnEvents['cancelled'];
  /** The turn passed a request to the team, which calls the guest back. */
  passedToTeam?: true;
  /** The guest's number as the conversation knows it (caller ID, WhatsApp, or typed on the website), written for the staff. */
  phone?: string;
}

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_by_update ON sessions (updated_at)`,
  `CREATE TABLE IF NOT EXISTS turns (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     at TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS turns_by_time ON turns (at)`,
  `CREATE INDEX IF NOT EXISTS turns_by_session ON turns (session_id, at)`,
  `CREATE TABLE IF NOT EXISTS calls (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS calls_by_start ON calls (started_at)`,
];

/** The most measurements a call keeps: a long call is summed up by its first answers, not stored whole. */
const MAX_MEASUREMENTS = 200;

export class Conversations {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    for (const statement of MIGRATIONS) sql.exec(statement);
  }

  get(id: string): StoredSession | undefined {
    const row = this.#sql.exec<{ data: string }>(`SELECT data FROM sessions WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.data) as StoredSession) : undefined;
  }

  save(session: StoredSession): void {
    this.#sql.exec(
      `INSERT INTO sessions (id, updated_at, data) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`,
      session.id,
      session.updatedAt,
      JSON.stringify(session),
    );
  }

  log(turn: TurnLog): void {
    this.#sql.exec(`INSERT INTO turns (session_id, at, data) VALUES (?, ?, ?)`, turn.sessionId, turn.at, JSON.stringify(turn));
  }

  /** The most recent turns first, for the dashboard. */
  recent(limit: number): TurnLog[] {
    return this.#sql
      .exec<{ data: string }>(`SELECT data FROM turns ORDER BY id DESC LIMIT ?`, Math.max(1, Math.min(limit, 500)))
      .toArray()
      .map((row) => JSON.parse(row.data) as TurnLog);
  }

  /** A call starting. Starting the same call again keeps the first record. */
  startCall(call: CallLog): void {
    this.#sql.exec(
      `INSERT INTO calls (session_id, started_at, data) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING`,
      call.sessionId,
      call.startedAt,
      JSON.stringify(call),
    );
  }

  call(sessionId: string): CallLog | undefined {
    const row = this.#sql.exec<{ data: string }>(`SELECT data FROM calls WHERE session_id = ?`, sessionId).toArray()[0];
    return row ? (JSON.parse(row.data) as CallLog) : undefined;
  }

  /** How the call ended. A call ends once: what the line reports after that changes nothing. */
  endCall(sessionId: string, ending: { endedAt: string; seconds: number; endedBy: CallEndedBy; voiceToVoiceMs: number[] }): CallLog | undefined {
    const call = this.call(sessionId);
    if (!call || call.endedAt) return call;
    const ended: CallLog = { ...call, ...ending, voiceToVoiceMs: ending.voiceToVoiceMs.slice(0, MAX_MEASUREMENTS) };
    this.#sql.exec(`UPDATE calls SET data = ? WHERE session_id = ?`, JSON.stringify(ended), sessionId);
    return ended;
  }

  /** The most recent calls first, for the dashboard. */
  recentCalls(limit: number): CallLog[] {
    return this.#sql
      .exec<{ data: string }>(`SELECT data FROM calls ORDER BY started_at DESC LIMIT ?`, Math.max(1, Math.min(limit, 500)))
      .toArray()
      .map((row) => JSON.parse(row.data) as CallLog);
  }

  /** Turns answered between two instants, for the restaurant's activity. */
  turnsBetween(fromIso: string, toIso: string): TurnLog[] {
    return this.#sql
      .exec<{ data: string }>(`SELECT data FROM turns WHERE at >= ? AND at < ?`, fromIso, toIso)
      .toArray()
      .map((row) => JSON.parse(row.data) as TurnLog);
  }

  /** Calls started between two instants, for the restaurant's activity. */
  callsBetween(fromIso: string, toIso: string): CallLog[] {
    return this.#sql
      .exec<{ data: string }>(`SELECT data FROM calls WHERE started_at >= ? AND started_at < ?`, fromIso, toIso)
      .toArray()
      .map((row) => JSON.parse(row.data) as CallLog);
  }

  /** Deletes sessions, turns and calls older than the retention period. Returns how many rows went. */
  purgeBefore(cutoffIso: string): number {
    const turns = this.#sql.exec(`DELETE FROM turns WHERE at < ?`, cutoffIso);
    turns.toArray();
    const sessions = this.#sql.exec(`DELETE FROM sessions WHERE updated_at < ?`, cutoffIso);
    sessions.toArray();
    const calls = this.#sql.exec(`DELETE FROM calls WHERE started_at < ?`, cutoffIso);
    calls.toArray();
    return turns.rowsWritten + sessions.rowsWritten + calls.rowsWritten;
  }
}
