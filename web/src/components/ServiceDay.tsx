import { localNow, type Language, type StaffActionResult, type StaffBookResult, type TableActionResult } from 'maitre';
import { DEMO_EVENING_DATE, DEMO_RESTAURANT, demoEvening, type DemoEvening } from 'maitre/demo';
import { useState } from 'preact/hooks';
import { messagesFor, type Messages } from '../i18n/messages';
import { bookingsIn, coversCurve, isLive, minuteOn, seatCount, serviceAt, stageOf, tablesAt } from '../lib/service-view';
import { BookingList } from './BookingList';
import { CoversCurve } from './CoversCurve';
import { FloorPlan } from './FloorPlan';
import { TableCard } from './TableCard';

const STEP_MS = 15 * 60_000;

type View = 'plan' | 'list';
type Outcome = StaffActionResult | TableActionResult | StaffBookResult;

function readEvening(evening: DemoEvening, language: Language) {
  const day = evening.engine.serviceDay(DEMO_EVENING_DATE, language);
  const moment = localNow(evening.clock.now(), DEMO_RESTAURANT.timeZone);
  return { day, time: moment.time, minute: minuteOn(day, moment) };
}

/** The engine's answer in the page's words. Its `problems` are written for developers and never reach the screen. */
function noticeFor(outcome: Outcome, t: Messages['service']): string {
  switch (outcome.status) {
    case 'done':
    case 'booked':
      return t.done(outcome.booking.guestName, t.stage[stageOf(outcome.booking)]);
    case 'not_found':
      return t.notFound;
    case 'not_allowed':
      return t.refusal[outcome.reason];
    case 'table_taken':
      return t.tableTaken(outcome.free);
    case 'unknown_table':
      return t.unknownTable;
    case 'unavailable': {
      const times = outcome.alternatives.map((offer) => offer.readBack);
      return times.length > 0 ? `${t.unavailable[outcome.reason]} ${t.alternatives(times)}` : t.unavailable[outcome.reason];
    }
    case 'invalid':
      return t.invalid;
  }
}

export function ServiceDay({ language }: { language: Language }) {
  const t = messagesFor(language).service;
  const [evening] = useState(demoEvening);
  const [{ day, time, minute }, setSnapshot] = useState(() => readEvening(evening, language));
  const [service, setService] = useState(() => serviceAt(day, minute)?.service);
  const [view, setView] = useState<View>('plan');
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const sitting = day.sittings.find((candidate) => candidate.service === service);
  if (!sitting) return null;

  const tables = tablesAt(day, sitting, minute);
  const bookings = bookingsIn(day, sitting);
  const allergies = bookings.filter((booking) => isLive(booking) && booking.allergies.length > 0).length;
  const chosen = tables.find((entry) => entry.table.number === selected);
  const later = new Date(evening.clock.now().getTime() + STEP_MS);
  // The demo keeps to its own evening: the clock never runs into the next day.
  const canMoveOn = localNow(later, DEMO_RESTAURANT.timeZone).date === DEMO_EVENING_DATE;

  const settle = (outcome: Outcome) => {
    setNotice(noticeFor(outcome, t));
    setSnapshot(readEvening(evening, language));
  };
  const moveOn = () => {
    evening.clock.set(later);
    setNotice('');
    setSnapshot(readEvening(evening, language));
  };
  const showSitting = (id: string) => {
    setService(id);
    setSelected(null);
    setNotice('');
  };
  const select = (table: string) => {
    setNotice('');
    setSelected(table === selected ? null : table);
  };
  const close = () => {
    if (selected) document.getElementById(`table-${selected}`)?.focus();
    setSelected(null);
  };

  return (
    <div class="service">
      <header class="service__head">
        <div class="service__top">
          <p class="service__restaurant">{DEMO_RESTAURANT.name}</p>
          <p class="service__clock">
            <span class="service__now">{t.now(time)}</span>
            <button type="button" class="action action--quiet action--small" title={t.laterLabel} disabled={!canMoveOn} onClick={moveOn}>
              {t.later}
            </button>
          </p>
        </div>
        <h2 class="service__day">{day.readBack}</h2>
        <div class="sittings" role="group" aria-label={t.sittings}>
          {day.sittings.map((candidate) => (
            <button
              type="button"
              key={candidate.service}
              class="sitting"
              aria-pressed={candidate.service === sitting.service}
              onClick={() => showSitting(candidate.service)}
            >
              <span class="sitting__name">{candidate.name}</span>
              <span class="sitting__count">{`${t.covers(candidate.covers)} · ${t.bookings(candidate.bookings)}`}</span>
            </button>
          ))}
        </div>
        <ul class="counters" aria-label={t.counters}>
          <li class={allergies > 0 ? 'counter counter--allergy' : 'counter'}>{t.allergies(allergies)}</li>
          <li class={day.callbacks.open > 0 ? 'counter counter--callback' : 'counter'}>{t.callbacks(day.callbacks.open)}</li>
          <li class={day.holds.length > 0 ? 'counter counter--hold' : 'counter'}>{t.holds(day.holds.length)}</li>
        </ul>
        <CoversCurve points={coversCurve(day, sitting)} minute={minute} seats={seatCount(day)} t={t} />
        <div class="views" role="group" aria-label={t.views}>
          <button type="button" class="view" aria-pressed={view === 'plan'} onClick={() => setView('plan')}>
            {t.plan}
          </button>
          <button type="button" class="view" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            {t.list}
          </button>
        </div>
      </header>

      {view === 'plan' ? (
        <div class="floor">
          <FloorPlan tables={tables} minute={minute} selected={selected} onSelect={select} t={t} />
          <div class="floor__side">
            <p class="notice" role="status">
              {notice}
            </p>
            {chosen && (
              <TableCard
                entry={chosen}
                minute={minute}
                timeZone={DEMO_RESTAURANT.timeZone}
                t={t}
                onArrived={(reference) => settle(evening.engine.markArrived(reference, language))}
                onSeat={(reference, table) => settle(evening.engine.seat(reference, table, language))}
                onLeft={(reference) => settle(evening.engine.markLeft(reference, language))}
                onWalkIn={(table, partySize) => settle(evening.engine.staffBook({ date: DEMO_EVENING_DATE, partySize, walkIn: true, table, language }))}
                onClose={close}
              />
            )}
          </div>
        </div>
      ) : (
        <BookingList bookings={bookings} minute={minute} t={t} />
      )}
    </div>
  );
}
