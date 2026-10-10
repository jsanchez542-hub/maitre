import type { Messages } from '../i18n/messages';
import { minutesLate, stayUsed, tableLabel, type TableNow } from '../lib/service-view';

interface Props {
  tables: TableNow[];
  minute: number;
  selected: string | null;
  onSelect: (table: string) => void;
  t: Messages['service'];
}

function captionOf(entry: TableNow, t: Messages['service']): string {
  const { booking, next, hold } = entry;
  if (booking) {
    if (entry.state === 'seated') return t.freeAt(booking.endsAt);
    if (entry.state === 'arrived') return booking.guestName;
    return `${booking.guestName} ${booking.time}`;
  }
  if (hold) return `${t.stage.held} ${hold.time}`;
  if (next) return `${next.guestName} ${next.time}`;
  return t.stage.free;
}

export function FloorPlan({ tables, minute, selected, onSelect, t }: Props) {
  const drawn = tables.every((entry) => entry.table.x !== undefined && entry.table.y !== undefined);
  return (
    <div class={drawn ? 'plan' : 'plan plan--rows'}>
      {drawn && <span class="plan__label plan__label--top">{t.windows}</span>}
      {drawn && <span class="plan__label plan__label--bottom">{t.entrance}</span>}
      {tables.map((entry) => {
        const { table, booking, next, hold } = entry;
        const caption = captionOf(entry, t);
        const late = booking ? minutesLate(booking, minute) : 0;
        // A free table carries the allergies of the party due next, so the floor sees them coming.
        const party = booking ?? (hold ? undefined : next);
        const allergic = (party?.allergies.length ?? 0) > 0;
        const spoken = booking || hold ? caption : next ? t.nextBooking(next.guestName, next.time) : '';
        const label = [t.table(table.number), t.seats(table.seats), t.stage[tableLabel(entry)], spoken, late > 0 ? t.late(late) : '', allergic ? t.allergy : '', entry.waiter ? t.waiter(entry.waiter) : '']
          .filter((part) => part !== '')
          .join(', ');
        const classes = [
          'table',
          `table--${table.shape ?? 'square'}`,
          table.rotation === 90 ? 'table--turned' : '',
          `is-${entry.state}`,
          late > 0 ? 'is-late' : '',
          selected === table.number ? 'is-selected' : '',
        ]
          .filter((name) => name !== '')
          .join(' ');
        return (
          <button
            type="button"
            key={table.number}
            id={`table-${table.number}`}
            class={classes}
            style={drawn ? { left: `${table.x}%`, top: `${table.y}%` } : undefined}
            aria-label={label}
            aria-pressed={selected === table.number}
            onClick={() => onSelect(table.number)}
          >
            <span class="table__shape">
              {table.number}
              {allergic && <span class="table__allergy" aria-hidden="true">!</span>}
            </span>
            <span class="table__caption" aria-hidden="true">{caption}</span>
            {entry.state === 'seated' && booking && (
              <span class="table__elapsed" aria-hidden="true">
                <span style={{ width: `${Math.round(stayUsed(booking, minute) * 100)}%` }} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
