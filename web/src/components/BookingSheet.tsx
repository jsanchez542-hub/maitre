import {
  ALLERGENS,
  addDays,
  daysBetween,
  formatDate,
  messages,
  slotsOn,
  toMinutes,
  type Allergen,
  type BusinessConfig,
  type Language,
  type PlainDate,
  type PlainTime,
  type SlotOffer,
  type StaffBookingView,
  type StaffChangeRequest,
} from 'maitre';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { LANGUAGE_NAMES } from '../i18n/routes';
import type { PanelBackend } from '../lib/backend';
import { noticeFor, type EngineAnswer } from '../lib/notice';
import { typeset } from '../lib/typography';

/** The day the sheet opens on: the one asked for, or the next with a time still to book, as after the last seating. */
function firstDayWithTimes(from: PlainDate, today: PlainDate, maxAdvanceDays: number, timesOn: (day: PlainDate) => PlainTime[]): PlainDate {
  for (let day = from; daysBetween(today, day) <= maxAdvanceDays; day = addDays(day, 1)) {
    if (timesOn(day).length > 0) return day;
  }
  return from;
}

const sameAllergies = (a: readonly Allergen[], b: readonly Allergen[]) => a.length === b.length && a.every((allergen) => b.includes(allergen));

interface Props {
  t: Messages;
  language: Language;
  /** The restaurant's own settings: its times, how far ahead it books, its largest party, its languages. */
  config: BusinessConfig;
  /** The booking to change; none for a booking taken by hand. */
  booking?: StaffBookingView;
  /** Where a new booking starts: the day the panel shows, or today if that day is past. */
  date: PlainDate;
  today: PlainDate;
  /** The restaurant's time now, in minutes from midnight: today's times before it are gone. */
  minute: number;
  act: (run: (backend: PanelBackend) => Promise<EngineAnswer>) => Promise<EngineAnswer | undefined>;
  onDone: (booking: StaffBookingView) => void;
  onClose: () => void;
}

/**
 * A booking the staff take by hand, as on the phone, or one they change. The times offered are the restaurant's own
 * for the day chosen; whether a table is free, the engine says, with the times or the tables it would give instead.
 * A change sends what the staff touched and nothing else: the rest of the booking stays as the engine keeps it.
 */
export function BookingSheet({ t, language, config, booking, date: start, today, minute, act, onDone, onClose }: Props) {
  const b = t.panel.booking;
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // A party already in the restaurant keeps its day and time: only its size and its details change.
  const settled = booking !== undefined && booking.stage !== 'expected';
  const timesOn = (day: PlainDate): PlainTime[] => {
    const times = slotsOn(config, day).filter((slot) => day !== today || toMinutes(slot) > minute);
    // A booking's own time stays on offer on its own day, gone or off the grid as it may be.
    if (booking && day === booking.date && !times.includes(booking.time)) return [...times, booking.time].sort((x, y) => toMinutes(x) - toMinutes(y));
    return times;
  };
  const initial = {
    date: booking?.date ?? firstDayWithTimes(start < today ? today : start, today, config.maxAdvanceDays, timesOn),
    partySize: booking?.partySize ?? 2,
    name: booking?.guestName ?? '',
    phone: booking?.phone ?? '',
    guestLanguage: booking?.language ?? language,
    allergies: booking?.allergies.map((allergen) => allergen.id) ?? [],
    notes: booking?.notes ?? '',
  };
  const [date, setDate] = useState(initial.date);
  const slots = timesOn(date);
  const [time, setTime] = useState(booking?.time ?? slots[0] ?? '');
  const [partySize, setPartySize] = useState(initial.partySize);
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [guestLanguage, setGuestLanguage] = useState<Language>(initial.guestLanguage);
  const [allergies, setAllergies] = useState<Allergen[]>(initial.allergies);
  const [notes, setNotes] = useState(initial.notes);
  const [problem, setProblem] = useState<string | null>(null);
  const [instead, setInstead] = useState<SlotOffer[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const sizes = Math.max(config.maxPartySize, booking?.partySize ?? 0);

  // On its title, not on the form: a form that scrolls takes the focus before its first field, and a field would bring
  // up a phone's keyboard over the sheet.
  useEffect(() => {
    dialog.current?.showModal();
    title.current?.focus();
  }, []);

  // Another day has other times: the one chosen stays if that day has it too. Set with the date, in the same event,
  // so a time picked straight after cannot be overwritten by a late correction.
  const chooseDate = (day: PlainDate) => {
    const times = timesOn(day);
    setDate(day);
    setTime((current) => (times.includes(current) ? current : (times[0] ?? '')));
  };

  const toggle = (allergen: Allergen) =>
    setAllergies((chosen) => (chosen.includes(allergen) ? chosen.filter((other) => other !== allergen) : [...chosen, allergen]));

  const take = (offer: SlotOffer) => {
    setDate(offer.date);
    setTime(offer.time);
    setProblem(null);
    setInstead([]);
  };

  /** What the staff touched on the booking, and only that: a phone sent back unchanged keeps where it came from. */
  const changes = (table?: string): StaffChangeRequest => ({
    language,
    ...(booking && date !== booking.date ? { date } : {}),
    ...(booking && time !== booking.time ? { time } : {}),
    ...(partySize !== initial.partySize ? { partySize } : {}),
    ...(name.trim() !== initial.name ? { guestName: name.trim() } : {}),
    ...(phone.trim() !== initial.phone ? { phone: phone.trim() } : {}),
    ...(notes.trim() !== initial.notes ? { notes: notes.trim() } : {}),
    ...(sameAllergies(allergies, initial.allergies) ? {} : { allergies }),
    ...(guestLanguage !== initial.guestLanguage ? { guestLanguage } : {}),
    ...(table ? { table } : {}),
  });

  const send = async (table?: string) => {
    if (busy || !time) return;
    if (!name.trim()) {
      setProblem(b.nameRequired);
      return;
    }
    const change = changes(table);
    // Nothing touched: nothing to send.
    if (booking && Object.keys(change).length === 1) {
      dialog.current?.close();
      return;
    }
    setBusy(true);
    setProblem(null);
    setInstead([]);
    setTables([]);
    const answer = await act((backend) =>
      booking
        ? backend.change(booking.reference, change)
        : backend.book({
            date,
            time,
            partySize,
            guestName: name.trim(),
            language,
            guestLanguage,
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            ...(allergies.length > 0 ? { allergies } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          }),
    );
    setBusy(false);
    // Out of reach: the panel says so in its message, and the form keeps what was typed.
    if (!answer) return;
    if (answer.status === 'booked') {
      dialog.current?.close();
      onDone(answer.booking);
      return;
    }
    if (answer.status === 'unavailable') {
      setProblem(t.service.unavailable[answer.reason]);
      setInstead(answer.alternatives);
      return;
    }
    // Its table no longer seats it at the new time or size: the tables that would, to choose from.
    if (answer.status === 'table_taken') setTables(answer.free);
    setProblem(noticeFor(answer, t.service));
  };

  const submit = (event: Event) => {
    event.preventDefault();
    void send();
  };

  return (
    <dialog ref={dialog} class="sheet" aria-labelledby="booking-sheet-title" onClose={onClose}>
      <form class="sheet__form" noValidate onSubmit={submit}>
        <h2 class="sheet__title" id="booking-sheet-title" tabIndex={-1} ref={title}>
          {booking ? b.editTitle : b.open}
        </h2>
        <div class="fields">
          <label class="field">
            <span class="field__label">{b.date}</span>
            <input
              type="date"
              required
              disabled={settled}
              min={today}
              max={addDays(today, config.maxAdvanceDays)}
              value={date}
              onInput={(event) => event.currentTarget.value && chooseDate(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span class="field__label">{b.time}</span>
            <select required value={time} disabled={settled || slots.length === 0} onInput={(event) => setTime(event.currentTarget.value)}>
              {slots.map((slot) => (
                <option key={slot} value={slot}>
                  {slot}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">{b.partySize}</span>
            <select value={partySize} onInput={(event) => setPartySize(Number(event.currentTarget.value))}>
              {Array.from({ length: sizes }, (_, index) => index + 1).map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
        {settled && <p class="sheet__note">{b.arrived}</p>}
        {!settled && slots.length === 0 && (
          <p class="sheet__note">{typeset(date === today && slotsOn(config, date).length > 0 ? b.noTimeLeft : t.service.unavailable.closed)}</p>
        )}
        <label class="field">
          <span class="field__label">{b.name}</span>
          <input type="text" required autoComplete="off" maxLength={80} value={name} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label class="field">
          <span class="field__label">
            {b.phone} <span class="field__optional">({b.optional})</span>
          </span>
          <input type="tel" autoComplete="off" inputMode="tel" maxLength={30} value={phone} onInput={(event) => setPhone(event.currentTarget.value)} />
        </label>
        <fieldset class="choices">
          <legend class="field__label">{b.guestLanguage}</legend>
          {config.languages.map((option) => (
            <label class="choice" key={option} lang={option}>
              <input type="radio" name="guest-language" checked={guestLanguage === option} onChange={() => setGuestLanguage(option)} />
              {LANGUAGE_NAMES[option]}
            </label>
          ))}
        </fieldset>
        <fieldset class="choices">
          <legend class="field__label">{b.allergies}</legend>
          {ALLERGENS.map((allergen) => (
            <label class="choice choice--allergen" key={allergen}>
              <input type="checkbox" checked={allergies.includes(allergen)} onChange={() => toggle(allergen)} />
              {messages(language).allergen(allergen)}
            </label>
          ))}
        </fieldset>
        <label class="field">
          <span class="field__label">
            {b.notes} <span class="field__optional">({b.optional})</span>
          </span>
          <textarea rows={2} maxLength={300} value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
        </label>
        {problem && (
          <div class="sheet__problem" role="alert">
            <p>{typeset(problem)}</p>
            {instead.length > 0 && (
              <div class="sheet__instead" role="group" aria-label={b.instead}>
                <p class="field__label">{b.instead}</p>
                <div class="sizes">
                  {instead.map((offer) => (
                    <button type="button" key={`${offer.date} ${offer.time}`} class="action" onClick={() => take(offer)}>
                      {offer.date === date ? offer.time : `${typeset(formatDate(offer.date, language, today))}, ${offer.time}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tables.length > 0 && (
              <div class="sheet__instead" role="group" aria-label={b.freeTables}>
                <p class="field__label">{b.freeTables}</p>
                <div class="sizes">
                  {tables.map((table) => {
                    const own = table === booking?.table;
                    return (
                      <button
                        type="button"
                        key={table}
                        class="action action--size"
                        aria-label={own ? `${t.service.table(table)} (${b.currentTable})` : t.service.table(table)}
                        onClick={() => void send(table)}
                      >
                        {table}
                        {own && <span class="action__note"> ({b.currentTable})</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        <div class="sheet__actions">
          <button type="submit" class="action action--primary" disabled={busy || (!settled && slots.length === 0)}>
            {booking ? b.save : b.submit}
          </button>
          <button type="button" class="action action--quiet" onClick={() => dialog.current?.close()}>
            {b.close}
          </button>
        </div>
      </form>
    </dialog>
  );
}
