import type { Booking, BookingStore, BookingTx, CallbackRequest, Hold } from '../../src/store.js';

/**
 * The booking store on a Durable Object's SQLite database.
 *
 * Each record is kept whole as JSON, next to the columns it is looked up by.
 * The engine's transactions map onto `transactionSync`: a Durable Object
 * handles one request at a time and its SQLite API is synchronous, so a check
 * for a free table and the write that takes it can never be interleaved with
 * another guest's request. Unique indexes on the booking reference and the
 * hold behind each booking are a second guard below the engine's own logic.
 */

const SCHEMA_VERSION = 1;

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bookings (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL UNIQUE,
     hold_id TEXT NOT NULL UNIQUE,
     date TEXT NOT NULL,
     time TEXT NOT NULL,
     phone TEXT,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS bookings_by_date ON bookings (date)`,
  `CREATE INDEX IF NOT EXISTS bookings_by_phone ON bookings (phone, date, time)`,
  `CREATE TABLE IF NOT EXISTS holds (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     date TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS holds_by_date ON holds (date, expires_at)`,
  `CREATE INDEX IF NOT EXISTS holds_by_session ON holds (session_id)`,
  `CREATE TABLE IF NOT EXISTS callbacks (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS callbacks_by_status ON callbacks (status, created_at)`,
];

type Row = Record<string, SqlStorageValue>;

function parse<T>(rows: Row[]): T[] {
  return rows.map((row) => JSON.parse(String(row['data'])) as T);
}

export function migrate(sql: SqlStorage): void {
  sql.exec(MIGRATIONS[0] as string);
  const current = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0];
  if (current && Number(current.value) >= SCHEMA_VERSION) return;
  for (const statement of MIGRATIONS.slice(1)) sql.exec(statement);
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    String(SCHEMA_VERSION),
  );
}

export class SqlStore implements BookingStore {
  readonly #storage: DurableObjectStorage;
  readonly #tx: BookingTx;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    migrate(storage.sql);
    this.#tx = this.#makeTx(storage.sql);
  }

  /** Whether any hold is stored, expired or not: tells the alarm when to come back. */
  hasHolds(): boolean {
    return this.#storage.sql.exec(`SELECT 1 AS present FROM holds LIMIT 1`).toArray().length > 0;
  }

  transaction<T>(work: (tx: BookingTx) => T): T {
    return this.#storage.transactionSync(() => {
      const result = work(this.#tx);
      if (result instanceof Promise) throw new Error('A transaction must not be asynchronous');
      return result;
    });
  }

  #makeTx(sql: SqlStorage): BookingTx {
    const rows = (query: string, ...bindings: SqlStorageValue[]): Row[] => sql.exec<Row>(query, ...bindings).toArray();
    return {
      bookingsOn: (date) => parse<Booking>(rows(`SELECT data FROM bookings WHERE date = ?`, date)),
      bookingByReference: (reference) => parse<Booking>(rows(`SELECT data FROM bookings WHERE reference = ?`, reference))[0],
      bookingByHold: (holdId) => parse<Booking>(rows(`SELECT data FROM bookings WHERE hold_id = ?`, holdId))[0],
      bookingsForPhone: (phone, fromDate) =>
        parse<Booking>(rows(`SELECT data FROM bookings WHERE phone = ? AND date >= ? ORDER BY date, time`, phone, fromDate)),
      saveBooking: (booking) => {
        sql.exec(
          `INSERT INTO bookings (id, reference, hold_id, date, time, phone, data) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET reference = excluded.reference, hold_id = excluded.hold_id, date = excluded.date,
             time = excluded.time, phone = excluded.phone, data = excluded.data`,
          booking.id,
          booking.reference,
          booking.holdId,
          booking.date,
          booking.time,
          booking.phone ?? null,
          JSON.stringify(booking),
        );
      },
      referenceTaken: (reference) => rows(`SELECT 1 AS taken FROM bookings WHERE reference = ? LIMIT 1`, reference).length > 0,

      holdsOn: (date, nowMs) => parse<Hold>(rows(`SELECT data FROM holds WHERE date = ? AND expires_at > ?`, date, nowMs)),
      hold: (id) => parse<Hold>(rows(`SELECT data FROM holds WHERE id = ?`, id))[0],
      holdsOfSession: (sessionId) => parse<Hold>(rows(`SELECT data FROM holds WHERE session_id = ?`, sessionId)),
      saveHold: (hold) => {
        sql.exec(
          `INSERT INTO holds (id, session_id, date, expires_at, data) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, date = excluded.date,
             expires_at = excluded.expires_at, data = excluded.data`,
          hold.id,
          hold.sessionId,
          hold.date,
          hold.expiresAt,
          JSON.stringify(hold),
        );
      },
      deleteHold: (id) => {
        sql.exec(`DELETE FROM holds WHERE id = ?`, id);
      },
      deleteExpiredHolds: (nowMs) => written(sql.exec(`DELETE FROM holds WHERE expires_at <= ?`, nowMs)),

      saveCallback: (request) => {
        sql.exec(
          `INSERT INTO callbacks (id, status, created_at, data) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`,
          request.id,
          request.status,
          request.createdAt,
          JSON.stringify(request),
        );
      },
      callback: (id) => parse<CallbackRequest>(rows(`SELECT data FROM callbacks WHERE id = ?`, id))[0],
      openCallbacks: () => parse<CallbackRequest>(rows(`SELECT data FROM callbacks WHERE status = 'open' ORDER BY created_at`)),
    };
  }
}

/** Rows a statement changed. A cursor's counters are only final once it has been read to the end. */
function written(cursor: SqlStorageCursor<Row>): number {
  cursor.toArray();
  return cursor.rowsWritten;
}
