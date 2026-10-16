import type { ComponentChildren } from 'preact';
import type { Messages } from '../i18n/messages';
import { chairsFor } from '../lib/chairs';
import { minutesLate, tableLabel, type TableNow } from '../lib/service-view';

interface Props {
  tables: TableNow[];
  minute: number;
  /** Bookings made in the chat, which the plan shows as new. */
  fresh: ReadonlySet<string>;
  selected: string | null;
  onSelect: (table: string) => void;
  t: Messages['service'];
  /** The room drawn behind the tables: walls, windows, bar. */
  children?: ComponentChildren;
}

/** What is written under a table: who sits there, or who is due next and when, while it is free. */
function nameOf(entry: TableNow, t: Messages['service']): { who: string; time?: string } | undefined {
  const { booking, next, hold } = entry;
  if (booking) return { who: booking.guestName };
  if (hold) return { who: t.stage.held, time: hold.time };
  return next ? { who: next.guestName, time: next.time } : undefined;
}

function Table({ entry, minute, fresh, selected, onSelect, t }: Omit<Props, 'tables' | 'children'> & { entry: TableNow }) {
  const { table, booking, next, hold } = entry;
  const late = booking ? minutesLate(booking, minute) : 0;
  // A free table carries the allergies of the party due next, so the floor sees them coming.
  const party = booking ?? (hold ? undefined : next);
  const allergic = (party?.allergies.length ?? 0) > 0;
  const name = nameOf(entry, t);
  const isNew = party !== undefined && fresh.has(party.reference);
  const shown = !name ? '' : name.time ? `${name.who} ${name.time}` : name.who;
  // The name starts with what the table shows, in the same order (WCAG 2.5.3): a voice user says what they see.
  const label = [
    table.number,
    shown,
    t.seats(table.seats),
    // A held table already shows the word.
    hold ? '' : t.stage[tableLabel(entry)],
    !booking && !hold && next ? t.upNext : '',
    isNew ? t.newBooking : '',
    late > 0 ? t.late(late) : '',
    allergic ? t.allergy : '',
    entry.waiter ? t.waiter(entry.waiter) : '',
  ]
    .filter((part) => part !== '')
    .join(', ');
  const classes = [
    'table',
    `table--${table.shape ?? 'square'}`,
    table.rotation === 90 ? 'table--turned' : '',
    // At a banquette the chairs and the name stand on the room's side.
    table.zone === 'banquette' ? `table--bench table--room-${(table.x ?? 0) < 50 ? 'right' : 'left'}` : '',
    `is-${entry.state}`,
    isNew ? 'is-new' : '',
    late > 0 ? 'is-late' : '',
    selected === table.number ? 'is-selected' : '',
  ]
    .filter((name) => name !== '')
    .join(' ');
  const placed = table.x !== undefined && table.y !== undefined;

  return (
    <button
      type="button"
      id={`table-${table.number}`}
      class={classes}
      style={placed ? { left: `${table.x}%`, top: `${table.y}%` } : undefined}
      aria-label={label}
      aria-pressed={selected === table.number}
      onClick={() => onSelect(table.number)}
    >
      <span class="table__top">
        {chairsFor(table).map((chair, index) => (
          <span key={index} class="chair" style={{ left: `${chair.x * 100}%`, top: `${chair.y * 100}%`, '--turn': `${chair.turn}deg` }} />
        ))}
        {table.number}
        {allergic && (
          <span class="table__allergy" aria-hidden="true">
            !
          </span>
        )}
      </span>{' '}
      {name && (
        <span class={name.time ? 'table__name table__name--next' : 'table__name'} aria-hidden="true">
          {shown}
        </span>
      )}
    </button>
  );
}

export function FloorPlan({ tables, minute, fresh, selected, onSelect, t, children }: Props) {
  const drawn = tables.every((entry) => entry.table.x !== undefined && entry.table.y !== undefined);
  return (
    <div class={drawn ? 'plan' : 'plan plan--rows'} role="group" aria-label={t.room}>
      {drawn && children}
      {tables.map((entry) => (
        <Table key={entry.table.number} entry={entry} minute={minute} fresh={fresh} selected={selected} onSelect={onSelect} t={t} />
      ))}
    </div>
  );
}
