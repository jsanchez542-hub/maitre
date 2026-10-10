import type { StaffBookingView } from 'maitre';
import type { Messages } from '../i18n/messages';
import { minutesLate, stageOf } from '../lib/service-view';

interface Props {
  bookings: StaffBookingView[];
  minute: number;
  t: Messages['service'];
}

export function BookingList({ bookings, minute, t }: Props) {
  if (bookings.length === 0) return <p class="empty">{t.empty}</p>;
  return (
    <ul class="bookings">
      {bookings.map((booking) => {
        const stage = stageOf(booking);
        const late = minutesLate(booking, minute);
        const moved = booking.history[booking.history.length - 1]?.from.time;
        const details = [booking.walkIn ? t.walkIn : t.channel[booking.channel], late > 0 ? t.late(late) : '', moved ? t.movedFrom(moved) : '', booking.notes ?? '']
          .filter((part) => part !== '')
          .join(' · ');
        return (
          <li class={`booking is-${stage}${late > 0 ? ' is-late' : ''}`} key={booking.reference}>
            <span class="booking__time">{booking.time}</span>
            <span class="booking__name">{booking.guestName}</span>
            <span class="booking__covers">
              <span aria-hidden="true">{booking.partySize}</span>
              <span class="sr-only">{t.covers(booking.partySize)}</span>
            </span>
            <span class="booking__table">
              {booking.table && (
                <>
                  <span aria-hidden="true">{`T${booking.table}`}</span>
                  <span class="sr-only">{t.table(booking.table)}</span>
                </>
              )}
            </span>
            <span class="booking__details">
              <span class={`status status--${stage}`}>{t.stage[stage]}</span>
              {details && <span>{details}</span>}
              {booking.allergies.map((allergen) => (
                <span class="chip chip--allergy" key={allergen.id}>
                  <span class="sr-only">{`${t.allergy} `}</span>
                  {allergen.name}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
