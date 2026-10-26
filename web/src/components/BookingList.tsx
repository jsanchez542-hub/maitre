import type { StaffBookingView } from 'maitre';
import { useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { groupsOf, isLive, minutesLate, stageOf, stayUsed, type GroupId } from '../lib/service-view';

interface Props {
  bookings: StaffBookingView[];
  minute: number;
  /** Bookings made in the chat, which the list shows as new. */
  fresh: ReadonlySet<string>;
  selected: string | null;
  /** The booking the card was opened on, when it was opened from the list. */
  focus: string | null;
  onSelect: (table: string, reference: string) => void;
  t: Messages['service'];
}

function Row({ booking, minute, fresh, selected, focus, onSelect, t }: Omit<Props, 'bookings'> & { booking: StaffBookingView }) {
  const stage = stageOf(booking);
  const late = minutesLate(booking, minute);
  const moved = booking.history[booking.history.length - 1]?.from.time;
  const details = [booking.walkIn ? t.walkIn : t.channel[booking.channel], moved ? t.movedFrom(moved) : '', booking.notes ?? '']
    .filter((part) => part !== '')
    .join(', ');
  const table = isLive(booking) ? booking.table : undefined;
  const isNew = fresh.has(booking.reference);
  const body = (
    <>
      <span class="glyph" aria-hidden="true" />
      <span class="row__main">
        <span class="row__time">{booking.time}</span>
        <span class="row__name">{booking.guestName}</span>
        <span class="row__meta">
          {isNew && <span class="pill pill--new">{t.newBooking}</span>}
          <span class={`pill pill--${stage}`}>{t.stage[stage]}</span>
          {booking.outsideHours && <span class="pill pill--outside">{t.outsideHours}</span>}
          {late > 0 && <span class="row__late">{t.late(late)}</span>}
          {booking.allergies.map((allergen) => (
            <span class="tag" key={allergen.id}>
              <span class="sr-only">{`${t.allergy} `}</span>
              {allergen.name}
            </span>
          ))}
          {details && <span>{details}</span>}
        </span>
      </span>
      <span class="row__covers">
        <span aria-hidden="true">{booking.partySize}</span>
        <span class="sr-only">{t.covers(booking.partySize)}</span>
      </span>
      <span class="row__table">
        {booking.table && (
          <>
            <span aria-hidden="true">{booking.table}</span>
            <span class="sr-only">{t.table(booking.table)}</span>
          </>
        )}
      </span>
      {booking.stage === 'seated' && (
        <span class="row__stay" aria-hidden="true">
          <span style={{ width: `${Math.round(stayUsed(booking, minute) * 100)}%` }} />
        </span>
      )}
    </>
  );
  return (
    <li class={`rows__item is-${stage}${late > 0 ? ' is-late' : ''}${isNew ? ' is-new' : ''}`}>
      {table ? (
        <button
          type="button"
          class="row"
          aria-pressed={selected === table && (focus === null || focus === booking.reference)}
          onClick={() => onSelect(table, booking.reference)}
        >
          {body}
        </button>
      ) : (
        <div class="row">{body}</div>
      )}
    </li>
  );
}

export function BookingList({ bookings, minute, fresh, selected, focus, onSelect, t }: Props) {
  const groups = groupsOf(bookings);
  // Finished and cancelled bookings start folded: during service the host looks at who is coming and who is seated.
  const [folded, setFolded] = useState<readonly GroupId[]>(['done']);
  if (groups.length === 0) return <p class="empty">{t.empty}</p>;
  return (
    <div class="groups">
      {groups.map((group) => {
        const open = !folded.includes(group.id);
        const id = `group-${group.id}`;
        return (
          <div class="group" key={group.id}>
            <h3 class="group__head">
              <button
                type="button"
                class="group__toggle"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setFolded(open ? [...folded, group.id] : folded.filter((other) => other !== group.id))}
              >
                <span class="group__name">{t.groups[group.id]}</span>
                <span class="group__count">
                  <span aria-hidden="true">{`${group.covers} (${group.bookings.length})`}</span>
                  <span class="sr-only">{`${t.covers(group.covers)}, ${t.bookings(group.bookings.length)}`}</span>
                </span>
              </button>
            </h3>
            <ul class="rows" id={id} hidden={!open}>
              {group.bookings.map((booking) => (
                <Row key={booking.reference} booking={booking} minute={minute} fresh={fresh} selected={selected} focus={focus} onSelect={onSelect} t={t} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
