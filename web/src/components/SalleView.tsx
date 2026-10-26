import { daysBetween, formatDate, sittingAt, type BusinessConfig, type Language, type PlainDate, type StaffBookingView } from 'maitre';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PanelBackend } from '../lib/backend';
import { useDismiss } from '../lib/dismiss';
import type { Messages } from '../i18n/messages';
import { noticeFor, type EngineAnswer } from '../lib/notice';
import { nextArrivals, serviceName } from '../lib/restaurant';
import { bookingsIn, coversCurve, holdsIn, isLive, laterAt, matchesName, seatCount, serviceAt, tablesAt } from '../lib/service-view';
import { typeset } from '../lib/typography';
import { BookingList } from './BookingList';
import { BookingSheet } from './BookingSheet';
import { Callbacks } from './Callbacks';
import { CoversChart } from './CoversChart';
import { FloorPlan } from './FloorPlan';
import { Icon } from './Icons';
import { MerrainRoom } from './MerrainRoom';
import { OutsideHours } from './OutsideHours';
import type { PanelApp } from './Panel';
import { Clock, DayNav } from './PanelBar';
import { BookedTableCard, TableCard } from './TableCard';

type View = 'list' | 'plan';

/** The next arrival window, as Réglages words it, its day first when it is not today's. */
function nextService(config: BusinessConfig, today: PlainDate, time: string, t: Messages, language: Language): string | null {
  const next = nextArrivals(config, today, time);
  if (!next) return null;
  const hours = typeset(t.site.service(serviceName(config, next.sitting.service, language), next.sitting.firstSeating, next.sitting.lastSeating));
  return next.date === today ? hours : `${typeset(formatDate(next.date, language, today))}, ${hours}`;
}

export function SalleView({ app }: { app: PanelApp }) {
  const { t, language, date, snapshot, config, fresh, opening, act, notify, tour } = app;
  const s = t.service;
  const { day, today, minute } = snapshot;
  // Each starts where the panel left it, in this language or the other.
  const [service, setService] = useState(() => app.place.service ?? serviceAt(day, minute)?.service);
  // The phone and the middle widths show one at a time, the list first; a wide screen shows both.
  const [view, setView] = useState<View>(() => app.place.view ?? 'list');
  const [selected, setSelected] = useState<string | null>(() => app.place.table ?? null);
  // The booking the card was opened on from the list, picked out among its table's parties.
  const [focus, setFocus] = useState<string | null>(() => app.place.booking ?? null);
  const [query, setQuery] = useState('');
  const [askingWalkIn, setAskingWalkIn] = useState(false);
  // «Nouvelle réservation», or a booking opened to change it.
  const [sheet, setSheet] = useState<StaffBookingView | 'new' | null>(null);
  const [callingBack, setCallingBack] = useState(false);
  // A booking made by hand: the panel goes to its day, then opens its service and its table.
  const [landing, setLanding] = useState<StaffBookingView | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const callbacksToggle = useRef<HTMLButtonElement>(null);
  const walkInToggle = useRef<HTMLButtonElement>(null);
  useDismiss(callingBack, 'callbacks', callbacksToggle, () => setCallingBack(false));
  useDismiss(askingWalkIn, 'walk-in-sizes-bar', walkInToggle, () => setAskingWalkIn(false));

  // A booking just made in the chat: open on its service and its table.
  useEffect(() => {
    if (!opening) return;
    setService(opening.service);
    setSelected(opening.table);
    setFocus(opening.reference);
  }, [opening]);

  useEffect(() => {
    if (!landing || day.date !== landing.date) return;
    const its = day.sittings.find((candidate) => candidate.name === landing.service);
    if (its) setService(its.service);
    setSelected(landing.table ?? null);
    setFocus(landing.reference);
    setLanding(null);
  }, [day, landing]);

  const sitting = day.sittings.find((candidate) => candidate.service === service) ?? serviceAt(day, minute);

  // What the service shows, for the panel's place, written before the next event: a language link pressed straight
  // after reads it. The card is open only while the service is on screen.
  useLayoutEffect(() => {
    Object.assign(app.place, { service: sitting?.service, view, table: selected, booking: focus });
  }, [sitting?.service, view, selected, focus]);
  useLayoutEffect(
    () => () => {
      Object.assign(app.place, { table: null, booking: null });
    },
    [],
  );
  const isToday = date === today;
  // The engine seats a party at the door only inside an arrival window: outside one, the bar and the table's card say
  // when the next opens, rather than offer sizes it would refuse.
  const outsideService = isToday && !sittingAt(config, today, snapshot.time) ? { next: nextService(config, today, snapshot.time, t, language) } : null;
  // Another day has no "now": its plan and list read as the service stands booked, before anyone arrives.
  const at = isToday ? minute : Number.NEGATIVE_INFINITY;
  const tables = sitting ? tablesAt(day, sitting, at) : [];
  const bookings = sitting ? bookingsIn(day, sitting) : [];
  const shown = query.trim() ? bookings.filter((booking) => matchesName(booking.guestName, query)) : bookings;
  const allergies = bookings.filter((booking) => isLive(booking) && booking.allergies.length > 0).length;
  const chosen = tables.find((entry) => entry.table.number === selected);
  const later = chosen ? laterAt(bookings, chosen) : [];
  const toCallBack = day.callbacks.list.filter((callback) => callback.status === 'open');

  // A booking's card follows it to the table it moves to.
  const move = async (reference: string, table: string) => {
    const answer = await act((backend) => backend.move(reference, table, language));
    if (!answer) return;
    if (answer.status === 'done') {
      notify(s.movedTo(answer.booking.guestName, table));
      setSelected(table);
      setFocus(reference);
    } else {
      notify(noticeFor(answer, s));
    }
  };
  const settle = async (run: (backend: PanelBackend) => Promise<EngineAnswer>) => {
    const answer = await act(run);
    if (answer) notify(noticeFor(answer, s));
  };
  // Beside a card the room can be wider than its floor, which scrolls: the table chosen is brought into sight.
  useEffect(() => {
    if (selected) document.getElementById(`table-${selected}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  // From the plan, a table; from the list, a booking at its table. The same one again closes the card.
  const select = (table: string, reference: string | null = null) => {
    notify('');
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const again = table === selected && reference === focus;
    setSelected(again ? null : table);
    setFocus(again ? null : reference);
  };
  const close = () => {
    // Back to the row or the table that opened the card; one the chat opened goes back to its table. On a wide screen
    // the card stands where the list was: the focus waits for the list to be back.
    const back = opener.current?.isConnected ? opener.current : selected ? document.getElementById(`table-${selected}`) : null;
    opener.current = null;
    setSelected(null);
    setFocus(null);
    requestAnimationFrame(() => back?.focus());
  };

  // Escape closes the card as it closes the panel's menus, once nothing open over the card has taken it. Listening
  // from the render that opens it, as the menus do: an Escape pressed straight after must not find it deaf.
  useLayoutEffect(() => {
    if (!chosen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.popover, .tour__card, dialog[open]')) close();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [selected, chosen !== undefined]);

  // Made or changed, the panel goes to the booking's day, then opens its service and its table.
  const landOn = (made: StaffBookingView, notice: string) => {
    setSheet(null);
    if (made.date !== date) app.goTo(daysBetween(date, made.date));
    notify(notice);
    setLanding(made);
  };
  const markDone = async (id: string) => {
    if ((await act((backend) => backend.callbackDone(id))) === 'done') notify(t.panel.callbacks.doneNotice);
  };
  const seatWalkIn = async (partySize: number) => {
    setAskingWalkIn(false);
    const answer = await act((backend) => backend.book({ date, partySize, walkIn: true, language }));
    if (!answer) return;
    if (answer.status === 'booked' && answer.booking.table) {
      notify(s.seatedAt(answer.booking.guestName, answer.booking.table));
      setSelected(answer.booking.table);
    } else {
      notify(noticeFor(answer, s));
    }
  };

  return (
    <div class="screen" data-view={view}>
      <h1 class="sr-only" id="section-title" tabIndex={-1}>
        {t.panel.heading}
      </h1>
      <header class="topbar">
        <p class="topbar__brand">{config.name}</p>
        <DayNav app={app} />
        {sitting && (
          <div class="services" role="group" aria-label={s.sittings}>
            {day.sittings.map((candidate) => (
              <button
                type="button"
                key={candidate.service}
                class="services__tab"
                aria-pressed={candidate.service === sitting.service}
                onClick={() => {
                  setService(candidate.service);
                  setSelected(null);
                  setFocus(null);
                  notify('');
                }}
              >
                <span class="services__name">{candidate.name}</span>
                <span class="services__count">
                  <span aria-hidden="true">{candidate.covers}</span>
                  <span class="sr-only">{s.covers(candidate.covers)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {sitting && (
          <div class="views" role="group" aria-label={s.views}>
            <button type="button" class="views__button" aria-label={s.list} aria-pressed={view === 'list'} onClick={() => setView('list')}>
              <Icon name="list" />
            </button>
            <button type="button" class="views__button" aria-label={s.plan} aria-pressed={view === 'plan'} onClick={() => setView('plan')}>
              <Icon name="plan" />
            </button>
          </div>
        )}
        <div class="topbar__end">
          <Clock app={app} />
          <button type="button" class="topbar__action" onClick={tour}>
            <Icon name="help" />
            <span class="topbar__label">{t.panel.tourAgain}</span>
          </button>
          {isToday && sitting && (
            <div class="topbar__walk-in">
              <button
                type="button"
                class="topbar__action"
                ref={walkInToggle}
                aria-expanded={askingWalkIn}
                aria-controls="walk-in-sizes-bar"
                onClick={() => setAskingWalkIn(!askingWalkIn)}
              >
                <Icon name="walk-in" />
                <span class="topbar__label">{t.panel.walkIn}</span>
              </button>
              {askingWalkIn && (
                <div
                  class={outsideService ? 'popover' : 'popover popover--sizes'}
                  id="walk-in-sizes-bar"
                  role="group"
                  aria-label={outsideService ? t.panel.walkIn : t.panel.walkInAsk}
                >
                  {outsideService ? (
                    <>
                      <p class="popover__label">{s.walkInClosed}</p>
                      {outsideService.next && <p class="popover__label wait__next">{outsideService.next}</p>}
                    </>
                  ) : (
                    <>
                      <p class="popover__label">{t.panel.walkInAsk}</p>
                      <div class="sizes">
                        {Array.from({ length: config.maxPartySize }, (_, index) => index + 1).map((size) => (
                          <button type="button" key={size} class="action action--size" aria-label={s.walkInSize(size)} onClick={() => void seatWalkIn(size)}>
                            {size}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <button type="button" class="action action--quiet" onClick={() => setAskingWalkIn(false)}>
                    {s.close}
                  </button>
                </div>
              )}
            </div>
          )}
          <button type="button" class="topbar__action topbar__action--primary" aria-haspopup="dialog" onClick={() => setSheet('new')}>
            <Icon name="plus" />
            <span class="topbar__label">{t.panel.booking.open}</span>
          </button>
        </div>
      </header>
      {sheet && (
        <BookingSheet
          t={t}
          language={language}
          config={config}
          {...(sheet === 'new' ? {} : { booking: sheet })}
          date={date}
          today={today}
          minute={minute}
          act={act}
          onDone={(made) =>
            landOn(
              made,
              sheet === 'new' ? t.panel.booking.booked(made.guestName, typeset(made.readBack)) : t.panel.booking.changed(made.guestName, typeset(made.readBack)),
            )
          }
          onClose={() => setSheet(null)}
        />
      )}

      {sitting ? (
        <>
          <div class="status">
            {/* Every booking the hours leave out, whatever the day on screen: the list is the restaurant's, not the day's. */}
            <OutsideHours app={app} folded onEdit={setSheet} />
            <p class="status__summary">{s.summary(sitting.covers, sitting.bookings, sitting.name)}</p>
            <ul class="chips" aria-label={s.counters}>
              <li class="chip chip--allergy">{s.allergies(allergies)}</li>
              <li>
                <button
                  type="button"
                  class="chip chip--callback chip--button"
                  ref={callbacksToggle}
                  aria-expanded={callingBack}
                  aria-controls="callbacks"
                  onClick={() => setCallingBack(!callingBack)}
                >
                  {s.callbacks(day.callbacks.open)}
                </button>
              </li>
              <li class="chip chip--hold">{s.holds(holdsIn(day, sitting).length)}</li>
            </ul>
            {callingBack && (
              <Callbacks t={t} language={language} timeZone={config.timeZone} today={today} callbacks={toCallBack} onDone={(id) => void markDone(id)} onClose={() => setCallingBack(false)} />
            )}
            <details class="flow">
              <summary class="flow__toggle">{s.flow}</summary>
              <div class="flow__panel">
                <CoversChart points={coversCurve(day, sitting)} minute={minute} seats={seatCount(day)} t={s} />
              </div>
            </details>
          </div>
          <div class={chosen ? 'salle salle--card' : 'salle'}>
            <div class="side">
              {/* Above the list it filters; on the phone it goes away with the list. */}
              <label class="search">
                <Icon name="search" />
                <span class="sr-only">{t.panel.search}</span>
                <input type="search" id="salle-search" placeholder={t.panel.search} value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
              </label>
              <div class="side__list">
                {query.trim() && shown.length === 0 ? (
                  <p class="empty">{s.noMatch(query.trim())}</p>
                ) : (
                  <BookingList bookings={shown} minute={at} fresh={fresh} selected={selected} focus={focus} onSelect={select} t={s} />
                )}
              </div>
            </div>
            <div class="floor">
              <div class="floor__scroll">
                <FloorPlan tables={tables} minute={at} fresh={fresh} selected={selected} onSelect={select} t={s}>
                  <MerrainRoom t={s} />
                </FloorPlan>
              </div>
            </div>
            {/* Outside the floor: on the phone the list hides the plan, and the card opens over either. */}
            {chosen &&
              (isToday ? (
                <TableCard
                  entry={chosen}
                  later={later}
                  outsideService={outsideService}
                  focus={focus}
                  minute={minute}
                  tablesFor={(reference) => app.ask((backend) => backend.freeTables(reference))}
                  timeZone={config.timeZone}
                  fresh={fresh}
                  t={s}
                  onArrived={(reference) => void settle((backend) => backend.arrived(reference, language))}
                  onSeat={(reference, table) => void settle((backend) => backend.seat(reference, table, language))}
                  onLeft={(reference) => void settle((backend) => backend.left(reference, language))}
                  onWalkIn={(table, partySize) => void settle((backend) => backend.book({ date, partySize, walkIn: true, table, language }))}
                  onCancel={(reference) => void settle((backend) => backend.cancel(reference, language))}
                  onNoShow={(reference) => void settle((backend) => backend.noShow(reference, language))}
                  onMove={(reference, table) => void move(reference, table)}
                  onEdit={setSheet}
                  onConfirm={(reference) => void settle((backend) => backend.confirm(reference, language))}
                  onClose={close}
                />
              ) : (
                <BookedTableCard
                  entry={chosen}
                  focus={focus}
                  parties={bookings.filter((booking) => isLive(booking) && booking.table === chosen.table.number)}
                  timeZone={config.timeZone}
                  fresh={fresh}
                  t={s}
                  onCancel={(reference) => void settle((backend) => backend.cancel(reference, language))}
                  tablesFor={(reference) => app.ask((backend) => backend.freeTables(reference))}
                  onMove={(reference, table) => void move(reference, table)}
                  onEdit={setSheet}
                  onConfirm={(reference) => void settle((backend) => backend.confirm(reference, language))}
                  onClose={close}
                />
              ))}
          </div>
        </>
      ) : (
        <div class="closed">
          <OutsideHours app={app} folded={false} onEdit={setSheet} />
          <p>{s.unavailable.closed}</p>
        </div>
      )}
    </div>
  );
}
