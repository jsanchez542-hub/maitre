import { localNow, toMinutes, type FreeTablesResult, type StaffBookingView } from 'maitre';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { minutesLate, stageOf, telHref, type TableNow } from '../lib/service-view';
import { Icon } from './Icons';

interface Common {
  entry: TableNow;
  timeZone: string;
  /** Bookings made in the chat, which the card shows as new. */
  fresh: ReadonlySet<string>;
  t: Messages['service'];
  onClose: () => void;
  /** The other tables that would take a booking for its whole stay, as the engine answers; undefined when out of reach. */
  tablesFor: (reference: string) => Promise<FreeTablesResult | undefined>;
  onMove: (reference: string, table: string) => void;
  onEdit: (party: StaffBookingView) => void;
  onConfirm: (reference: string) => void;
  onCancel: (reference: string) => void;
  /** The booking the card was opened on from the list, picked out among the table's parties. */
  focus: string | null;
}

interface Props extends Common {
  minute: number;
  /** The parties due at the table after the next one, tonight. */
  later: StaffBookingView[];
  /** Outside every arrival window, when the next opens: a free table then offers no party at the door. */
  outsideService: { next: string | null } | null;
  onArrived: (reference: string) => void;
  onSeat: (reference: string, table: string) => void;
  onLeft: (reference: string) => void;
  onWalkIn: (table: string, partySize: number) => void;
  onNoShow: (reference: string) => void;
}

function Allergies({ party, t }: { party: StaffBookingView; t: Messages['service'] }) {
  if (party.allergies.length === 0) return null;
  return (
    <ul class="tags" aria-label={t.allergy}>
      {party.allergies.map((allergen) => (
        <li class="tag" key={allergen.id}>
          {allergen.name}
        </li>
      ))}
    </ul>
  );
}

function Phone({ phone }: { phone: string }) {
  return (
    <p class="card__line">
      <a class="card__phone" href={telHref(phone)}>
        {phone}
      </a>
    </p>
  );
}

function NewPill({ party, fresh, t }: { party: StaffBookingView; fresh: ReadonlySet<string>; t: Messages['service'] }) {
  return fresh.has(party.reference) ? <span class="pill pill--new">{t.newBooking}</span> : null;
}

function Stage({ party, fresh, t }: { party: StaffBookingView; fresh: ReadonlySet<string>; t: Messages['service'] }) {
  const stage = stageOf(party);
  return (
    <>
      <NewPill party={party} fresh={fresh} t={t} />
      <span class={`pill pill--${stage}`}>{t.stage[stage]}</span>
      {party.outsideHours && <span class="pill pill--outside">{t.outsideHours}</span>}
    </>
  );
}

function HoldLine({ entry, timeZone, t }: Pick<Common, 'entry' | 'timeZone' | 't'>) {
  const { hold } = entry;
  if (!hold) return null;
  return <p class="card__line card__hold">{t.holdDetail(hold.partySize, hold.time, localNow(new Date(hold.expiresAt), timeZone).time)}</p>;
}

/**
 * «Annuler» and «No-show»: each asks once more before it is done, since neither is undone by a click. A no-show
 * is offered once the booking's time has come, as the engine allows it.
 */
export function Undo({ party, t, onCancel, onNoShow }: { party: StaffBookingView; t: Messages['service']; onCancel: (reference: string) => void; onNoShow?: ((reference: string) => void) | undefined }) {
  const [asking, setAsking] = useState<'cancel' | 'no-show' | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => setAsking(null), [party.reference]);
  // The button pressed gives way to the next step: the focus goes to the step's first button, not to the page.
  const ask = (next: 'cancel' | 'no-show' | null) => {
    setAsking(next);
    requestAnimationFrame(() => first.current?.focus());
  };
  if (asking) {
    return (
      <div class="card__undo" role="group" aria-label={`${party.guestName} · ${party.time}`}>
        <button type="button" class="action" ref={first} onClick={() => (asking === 'cancel' ? onCancel(party.reference) : onNoShow?.(party.reference))}>
          {asking === 'cancel' ? t.confirmCancel : t.confirmNoShow}
        </button>
        <button type="button" class="action action--quiet" onClick={() => ask(null)}>
          {t.back}
        </button>
      </div>
    );
  }
  return (
    <div class="card__undo" role="group" aria-label={`${party.guestName} · ${party.time}`}>
      <button type="button" class="action" ref={first} onClick={() => ask('cancel')}>
        {t.cancel}
      </button>
      {onNoShow && (
        <button type="button" class="action" onClick={() => ask('no-show')}>
          {t.noShow}
        </button>
      )}
    </div>
  );
}

/**
 * What the host does with a booking besides seating it: settle «À confirmer» with the guest, change it, or move it to
 * another table, among those the engine says would take it for its whole stay.
 */
function Manage({ party, t, tablesFor, onMove, onEdit, onConfirm }: Pick<Common, 't' | 'tablesFor' | 'onMove' | 'onEdit' | 'onConfirm'> & { party: StaffBookingView }) {
  const [open, setOpen] = useState(false);
  // The tables that would take it, or why none can be asked about.
  const [free, setFree] = useState<string[] | string | null>(null);
  const answer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOpen(false);
    setFree(null);
  }, [party.reference]);
  useEffect(() => {
    if (free !== null) answer.current?.scrollIntoView({ block: 'nearest' });
  }, [free]);
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setFree(null);
    const answer = await tablesFor(party.reference);
    // Out of reach: the panel's message says so.
    if (!answer) setOpen(false);
    else setFree(answer.status === 'ok' ? answer.free : answer.status === 'not_allowed' ? t.refusal[answer.reason] : t.notFound);
  };
  const group = `move-${party.reference}`;
  return (
    <>
      <div class="card__more">
        {stageOf(party) === 'booked' && (
          <button type="button" class="action action--small" onClick={() => onConfirm(party.reference)}>
            {t.confirmBooking}
          </button>
        )}
        <button type="button" class="action action--small" aria-haspopup="dialog" onClick={() => onEdit(party)}>
          {t.edit}
        </button>
        <button type="button" class="action action--small" aria-expanded={open} aria-controls={group} onClick={() => void toggle()}>
          {t.moveTable}
        </button>
      </div>
      {open && (
        <div class="card__group" id={group} ref={answer} role="group" aria-labelledby={`${group}-label`}>
          <p class="card__line" id={`${group}-label`}>
            {t.moveTo}
          </p>
          {typeof free === 'string' ? (
            <p class="card__line">{free}</p>
          ) : free?.length === 0 ? (
            <p class="card__line">{t.noOtherTable}</p>
          ) : (
            free && (
              <div class="sizes">
                {free.map((number) => (
                  <button type="button" class="action action--size" key={number} aria-label={t.table(number)} onClick={() => onMove(party.reference, number)}>
                    {number}
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

/** One party of the table's service, with what the host can do with it before it comes. */
function Party({ party, ...props }: Common & { party: StaffBookingView }) {
  const { fresh, t, focus, onCancel } = props;
  const picked = party.reference === focus;
  const item = useRef<HTMLLIElement>(null);
  // The booking opened from the list comes into view on the card, below the table's own lines.
  useEffect(() => {
    if (picked) item.current?.scrollIntoView({ block: 'nearest' });
  }, [picked]);
  return (
    <li class={picked ? 'party party--picked' : 'party'} ref={item} aria-current={picked ? 'true' : undefined}>
      <p class="party__head">
        <span class="party__time">{party.time}</span>
        <span>{`${party.guestName} · ${t.covers(party.partySize)}`}</span>
      </p>
      <p class="card__detail">
        <Stage party={party} fresh={fresh} t={t} />
        <span>{party.walkIn ? t.walkIn : t.channel[party.channel]}</span>
      </p>
      <Allergies party={party} t={t} />
      {party.notes && (
        <p class="card__line">
          <span class="card__label">{t.note}</span> {party.notes}
        </p>
      )}
      {party.phone && <Phone phone={party.phone} />}
      {party.stage === 'expected' && (
        <>
          <Manage party={party} {...props} />
          <Undo party={party} t={t} onCancel={onCancel} />
        </>
      )}
    </li>
  );
}

/**
 * The next party due at the table. At a free table the host can greet it or seat it early; at a taken one it waits
 * its turn. Either way the host can change it, move it or cancel it from here.
 */
function NextParty({ party, seatable, ...props }: Props & { party: StaffBookingView; seatable: boolean }) {
  const { entry, minute, fresh, t, onArrived, onSeat, onCancel, onNoShow } = props;
  return (
    <div class="card__group card__party" role="group" aria-labelledby="next-party">
      <p class="card__line card__next" id="next-party">
        <NewPill party={party} fresh={fresh} t={t} />
        {party.outsideHours && <span class="pill pill--outside">{t.outsideHours}</span>}
        <span>{t.nextBooking(party.guestName, party.time)}</span>
      </p>
      <Allergies party={party} t={t} />
      {seatable && (
        <div class="card__actions">
          <button type="button" class="action" onClick={() => onArrived(party.reference)}>
            {t.markArrived}
          </button>
          <button type="button" class="action" onClick={() => onSeat(party.reference, entry.table.number)}>
            {t.seatAt(entry.table.number)}
          </button>
        </div>
      )}
      <Manage party={party} {...props} />
      <Undo party={party} t={t} onCancel={onCancel} onNoShow={minute >= toMinutes(party.time) ? onNoShow : undefined} />
    </div>
  );
}

/** The card's title takes the focus when it opens and when the table changes state. */
function useTitleFocus(...changes: unknown[]) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The button just pressed is gone once the table changes state: focus goes back to the card, not to the page.
  // The card is already in view (in the corner of the plan, or a sheet on the phone), so the page must not jump to it.
  useEffect(() => heading.current?.focus({ preventScroll: true }), changes);
  return heading;
}

/** A table tonight: who holds it now, and what the floor can do about it. */
export function TableCard(props: Props) {
  const { entry, later, outsideService, minute, timeZone, fresh, t, onArrived, onSeat, onLeft, onWalkIn, onCancel, onNoShow, onClose } = props;
  const { table, booking, next } = entry;
  const heading = useTitleFocus(table.number, entry.state);

  const late = booking ? minutesLate(booking, minute) : 0;
  const moved = booking?.history[booking.history.length - 1]?.from.time;
  const title = booking
    ? `${t.table(table.number)} · ${booking.guestName} · ${t.covers(booking.partySize)}`
    : `${t.table(table.number)} · ${t.stage.free}`;
  const detail = booking
    ? [
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
  const due = (party: StaffBookingView) => minute >= toMinutes(party.time);

  return (
    <section class="card" aria-labelledby="table-card-title">
      <span class="card__grabber" aria-hidden="true" />
      <div class="card__head">
        <h3 class="card__title" id="table-card-title" tabIndex={-1} ref={heading}>
          {title}
        </h3>
        {booking && <span class="card__time">{booking.time}</span>}
        <button type="button" class="card__close" aria-label={t.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {booking ? (
        <>
          <p class="card__detail">
            <Stage party={booking} fresh={fresh} t={t} />
            <span>{detail}</span>
          </p>
          <Allergies party={booking} t={t} />
          {booking.notes && (
            <p class="card__line">
              <span class="card__label">{t.note}</span> {booking.notes}
            </p>
          )}
          {booking.phone && <Phone phone={booking.phone} />}
          <HoldLine entry={entry} timeZone={timeZone} t={t} />
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
          <Manage party={booking} {...props} />
          {entry.state === 'expected' && <Undo party={booking} t={t} onCancel={onCancel} onNoShow={due(booking) ? onNoShow : undefined} />}
          {next && <NextParty party={next} seatable={false} {...props} />}
        </>
      ) : (
        <>
          <HoldLine entry={entry} timeZone={timeZone} t={t} />
          {outsideService ? (
            <div class="card__group">
              <p class="card__line">{t.walkInClosed}</p>
              {outsideService.next && <p class="card__line wait__next">{outsideService.next}</p>}
            </div>
          ) : (
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
          )}
          {next && <NextParty party={next} seatable {...props} />}
        </>
      )}

      {later.length > 0 && (
        <div class="card__group card__party" role="group" aria-labelledby="later-parties">
          <p class="card__line card__next" id="later-parties">
            {t.later}
          </p>
          <ul class="parties">
            {later.map((party) => (
              <Party key={party.reference} party={party} {...props} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * A table on another day. There is no "now" to act on: arrivals, seating and
 * walk-ins happen on the day itself, so the card lists the parties booked at
 * the table for the service.
 */
export function BookedTableCard(props: Common & { parties: StaffBookingView[] }) {
  const { entry, parties, timeZone, t, onClose } = props;
  const { table, waiter } = entry;
  const heading = useTitleFocus(table.number);
  return (
    <section class="card" aria-labelledby="table-card-title">
      <span class="card__grabber" aria-hidden="true" />
      <div class="card__head">
        <h3 class="card__title" id="table-card-title" tabIndex={-1} ref={heading}>
          {`${t.table(table.number)} · ${t.seats(table.seats)}`}
        </h3>
        <button type="button" class="card__close" aria-label={t.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {waiter && <p class="card__line">{t.waiter(waiter)}</p>}
      <HoldLine entry={entry} timeZone={timeZone} t={t} />
      {parties.length > 0 ? (
        <ul class="parties">
          {parties.map((party) => (
            <Party key={party.reference} party={party} {...props} />
          ))}
        </ul>
      ) : (
        !entry.hold && <p class="card__line">{t.stage.free}</p>
      )}
    </section>
  );
}
