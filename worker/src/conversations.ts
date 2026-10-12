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
}

export interface TurnLog {
  at: string;
  sessionId: string;
  channel: Channel;
  language: Language;
  /** What the guest wrote; empty on the turn that followed the number typed in the web chat's field. */
  guest: string;
  /** The turn the code started once the guest typed their number in the web chat's field. */
  phoneEntered?: true;
  reply: string;
  outcome: string;
  latencyMs: number;
  modelCalls: number;
  usage: Usage;
  costUsd?: number;
  /** Tool names and their status only: the full outputs stay out of the log. */
  tools: { name: string; status: string }[];
  corrections: string[];
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
];

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

  /** Deletes sessions and turns older than the retention period. Returns how many rows went. */
  purgeBefore(cutoffIso: string): number {
    const turns = this.#sql.exec(`DELETE FROM turns WHERE at < ?`, cutoffIso);
    turns.toArray();
    const sessions = this.#sql.exec(`DELETE FROM sessions WHERE updated_at < ?`, cutoffIso);
    sessions.toArray();
    return turns.rowsWritten + sessions.rowsWritten;
  }
}
