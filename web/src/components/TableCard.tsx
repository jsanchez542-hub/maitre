import { localNow, type StaffBookingView } from 'maitre';
import { useEffect, useRef } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { maskedPhone, minutesLate, stageOf, type TableNow } from '../lib/service-view';

interface Props {
  entry: TableNow;
  minute: number;
  timeZone: string;
  t: Messages['service'];
  onArrived: (reference: string) => void;
  onSeat: (reference: string, table: string) => void;
  onLeft: (reference: string) => void;
  onWalkIn: (table: string, partySize: number) => void;
  onClose: () => void;
}

function Allergies({ party, t }: { party: StaffBookingView; t: Messages['service'] }) {
  if (party.allergies.length === 0) return null;
  return (
    <ul class="chips" aria-label={t.allergy}>
      {party.allergies.map((allergen) => (
        <li class="chip chip--allergy" key={allergen.id}>
          {allergen.name}
        </li>
      ))}
    </ul>
  );
}

export function TableCard({ entry, minute, timeZone, t, onArrived, onSeat, onLeft, onWalkIn, onClose }: Props) {
  const { table, booking, next, hold } = entry;
  const heading = useRef<HTMLHeadingElement>(null);
  // The button just pressed is gone once the table changes state: focus goes back to the card, not to the page.
  useEffect(() => heading.current?.focus(), [table.number, entry.state]);

  const late = booking ? minutesLate(booking, minute) : 0;
  const moved = booking?.history[booking.history.length - 1]?.from.time;
  const title = booking
    ? `${t.table(table.number)} · ${booking.guestName} · ${t.covers(booking.partySize)}`
    : `${t.table(table.number)} · ${t.stage.free}`;
  const detail = booking
    ? [
        t.stage[stageOf(booking)],
        late > 0 ? t.late(late) : '',
        entry.state === 'seated' || entry.state === 'arrived' ? t.freeAt(booking.endsAt) : '',
        booking.walkIn ? t.walkIn : t.channel[booking.channel],
        moved ? t.movedFrom(moved) : '',
        entry.waiter ? t.waiter(entry.waiter) : '',
      ]
        .filter((part) => part !== '')
        .join(' · ')
    : '';
  const sizes = Array.from({ length: table.seats }, (_, index) => index + 1);
  const holdLine = hold && <p class="card__line card__hold">{t.holdDetail(hold.partySize, hold.time, localNow(new Date(hold.expiresAt), timeZone).time)}</p>;

  return (
    <section class="card" aria-labelledby="table-card-title">
      <div class="card__head">
        <h3 class="card__title" id="table-card-title" tabIndex={-1} ref={heading}>
          {title}
        </h3>
        {booking && <span class="card__time">{booking.time}</span>}
      </div>

      {booking ? (
        <>
          <p class="card__detail">{detail}</p>
          <Allergies party={booking} t={t} />
          {booking.notes && (
            <p class="card__line">
              <span class="card__label">{t.note}</span> {booking.notes}
            </p>
          )}
          {booking.phone && <p class="card__line card__phone">{maskedPhone(booking.phone)}</p>}
          {holdLine}
          {next && <p class="card__line card__next">{t.nextBooking(next.guestName, next.time)}</p>}
          <div class="card__actions">
            {entry.state === 'expected' && (
              <>
                <button type="button" class="action action--primary" onClick={() => onArrived(booking.reference)}>
                  {t.markArrived}
                </button>
                <button type="button" class="action" onClick={() => onSeat(booking.reference, table.number)}>
                  {t.seatAt(table.number)}
                </button>
              </>
            )}
            {entry.state === 'arrived' && (
              <button type="button" class="action action--primary" onClick={() => onSeat(booking.reference, table.number)}>
                {t.seatAt(table.number)}
              </button>
            )}
            {entry.state === 'seated' && (
              <button type="button" class="action" onClick={() => onLeft(booking.reference)}>
                {t.freeTable}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {holdLine}
          <div class="card__group" role="group" aria-labelledby="walk-in-sizes">
            <p class="card__line" id="walk-in-sizes">
              {t.walkInAsk}
            </p>
            <div class="sizes">
              {sizes.map((size) => (
                <button type="button" class="action action--size" key={size} aria-label={t.walkInSize(size)} onClick={() => onWalkIn(table.number, size)}>
                  {size}
                </button>
              ))}
            </div>
          </div>
          {next && (
            <div class="card__group" role="group" aria-labelledby="next-party">
              <p class="card__line card__next" id="next-party">
                {t.nextBooking(next.guestName, next.time)}
              </p>
              <Allergies party={next} t={t} />
              <div class="card__actions">
                <button type="button" class="action" onClick={() => onArrived(next.reference)}>
                  {t.markArrived}
                </button>
                <button type="button" class="action" onClick={() => onSeat(next.reference, table.number)}>
                  {t.seatAt(table.number)}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <button type="button" class="action action--quiet card__close" onClick={onClose}>
        {t.close}
      </button>
    </section>
  );
}
