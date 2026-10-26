import { PUBLIC_TURNSTILE_SITE_KEY } from 'astro:env/client';
import { addDays, localNow, type BusinessConfig, type Language, type PlainDate, type ServiceDay, type StaffBookingView } from 'maitre';
import { DEMO_EVENING_DATE, DEMO_RESTAURANT, demoEvening, type DemoEvening } from 'maitre/demo';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { messagesFor, type Messages } from '../i18n/messages';
import { liveBackend, localBackend, type PanelBackend, type Reading } from '../lib/backend';
import { connect } from '../lib/connect';
import { LiveError, readClockOf } from '../lib/live';
import { keepPlace, readScrolled, restoreScrolled, takePlace, type PanelPlace } from '../lib/place';
import { chatKey, readPlayed } from '../lib/played';
import { currentSandbox, forgetSandbox, takeNews } from '../lib/sandbox';
import type { EditableSettings, SettingsAnswer } from '../lib/settings';
import { demoStatus } from '../lib/status';
import { minuteOn } from '../lib/service-view';
import { typeset } from '../lib/typography';
import { ActivityView } from './ActivityView';
import { ConversationsView } from './ConversationsView';
import { Icon } from './Icons';
import { Rail, SECTIONS, isSection, type Section } from './Rail';
import { SalleView } from './SalleView';
import { SettingsView } from './SettingsView';
import { Tour } from './Tour';

/** The live panel reads the restaurant again this often, as a dashboard on the pass would. */
const POLL_MS = 4000;
/** How long a message stays: long enough to read the longest, a new booking said in full. */
const MESSAGE_MS = 10_000;
/** What the recorded evening can show: it has no log of conversations, and so nothing to weigh the assistant by. */
const RECORDED_SECTIONS: readonly Section[] = ['service', 'settings'];

export interface Snapshot {
  day: ServiceDay;
  now: Date;
  time: string;
  /** The restaurant's own date at this moment: actions on the floor only happen on it. */
  today: PlainDate;
  minute: number;
}

/** What the panel's screens read and do: one restaurant, one clock, one day on screen. */
export interface PanelApp {
  t: Messages;
  language: Language;
  date: PlainDate;
  snapshot: Snapshot;
  /** The restaurant's settings, as the server keeps them. */
  config: BusinessConfig;
  /** The bookings still to come that the opening hours leave out, until the staff move or cancel each. */
  outside: readonly StaffBookingView[];
  /** References of the bookings the visitor made in the chat, shown as new. */
  fresh: ReadonlySet<string>;
  /** Where the panel opens: the service and table of the booking the chat made, if it made one. */
  opening: { service: string; table: string | null; reference: string } | null;
  /** What the screens show, which they keep up to date and start from: the language links carry it to the other panel. */
  place: PanelPlace;
  goTo: (days: number) => void;
  /** Sends what the staff did and reads the day again. Undefined when the restaurant could not be reached. */
  act: <T>(run: (backend: PanelBackend) => Promise<T>) => Promise<T | undefined>;
  /** Reads what the restaurant keeps beside the day. Undefined when it could not be reached, or does not keep it. */
  ask: <T>(run: (backend: PanelBackend) => Promise<T> | undefined) => Promise<T | undefined>;
  /**
   * The owner's changes to the settings, which the restaurant checks as a whole and the whole panel reads from then
   * on. Null on the recorded evening, which has nowhere to keep them.
   */
  saveSettings: ((changes: EditableSettings) => Promise<SettingsAnswer | undefined>) | null;
  notify: (message: string) => void;
  /** The first visit's tour, again: from the panel's bar, for anyone who wants to see it once more. */
  tour: () => void;
}

function snapshotOf({ day, now }: Reading, timeZone: string): Snapshot {
  const moment = localNow(now, timeZone);
  return { day, now, time: moment.time, today: moment.date, minute: minuteOn(day, moment) };
}

export function Panel({ language }: { language: Language }) {
  const t = messagesFor(language);
  // Where the service is read: the visitor's own restaurant, on the real date and time, or the recorded evening in the
  // browser while the live demo is paused, said to be a recording. Nothing on the server's render: the panel shows a
  // service once it knows which, never the hour of the build.
  const backend = useRef<PanelBackend | null>(null);
  const [live, setLive] = useState(false);
  const [date, setDate] = useState<PlainDate>(DEMO_EVENING_DATE);
  const [reading, setReading] = useState<Reading | null>(null);
  // The demo restaurant's settings until its own arrive: they are the same until its owner changes them.
  const [config, setConfig] = useState<BusinessConfig>(DEMO_RESTAURANT);
  const [outside, setOutside] = useState<readonly StaffBookingView[]>([]);
  const [section, setSection] = useState<Section>('service');
  const [toast, setToast] = useState('');
  // A pointer or the focus on the message keeps it: whoever is reading it, or about to close it, is not rushed.
  const [holding, setHolding] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [opening, setOpening] = useState<PanelApp['opening']>(null);
  const [verifying, setVerifying] = useState(false);
  const [settled, setSettled] = useState(false);
  const [tours, setTours] = useState(0);
  const [touring, setTouring] = useState(false);
  const verification = useRef<HTMLDivElement>(null);
  const shown = useRef(date);
  shown.current = date;
  // The day the panel shows, once it shows one: before, there is no day of the visitor's to keep.
  const onScreen = useRef<PlainDate | undefined>(undefined);
  onScreen.current = reading ? date : undefined;
  const reads = useRef(0);
  const moved = useRef(false);
  const place = useRef<PanelPlace>({});
  // How far each part had scrolled in the other language, put back once the day is on screen.
  const scrolledBefore = useRef<Record<string, number> | null>(null);
  // What the staff do waits until the panel knows where the service lives: a click in the second it takes
  // to open the visitor's restaurant would otherwise go to the day in the browser and be lost.
  const decided = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!decided.current) {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    decided.current = { promise, resolve };
  }
  const snapshot = useMemo(() => (reading ? snapshotOf(reading, config.timeZone) : null), [reading, config.timeZone]);
  // Until the panel knows where its service lives, the rail has the live panel's sections, as it will in the usual
  // case: a rail that grew once the restaurant opened moved its items under the visitor's thumb.
  const sections = live || !settled ? SECTIONS : RECORDED_SECTIONS;
  const current = sections.includes(section) ? section : 'service';

  /** Where the panel reads from now on, and the settings it reads with. */
  const adopt = (next: PanelBackend) => {
    backend.current = next;
    next.config().then(
      (read) => {
        if (backend.current === next) setConfig(read);
      },
      (error: unknown) => {
        // Out of reach for now: the day's own read says so, and the settings stay as they were.
        if (!(error instanceof LiveError)) throw error;
      },
    );
  };

  const read = async (target: PlainDate = shown.current): Promise<Reading | undefined> => {
    const source = backend.current;
    if (!source) return undefined;
    reads.current += 1;
    const id = reads.current;
    try {
      const next = await source.read(target, language);
      // Reads overlap (the clock, an action, a click on the next day): only the latest one is shown.
      if (id !== reads.current) return next;
      setReading(next);
      if (source.live) setFresh(new Set(currentSandbox()?.booked.map((booking) => booking.reference)));
      return next;
    } catch (error) {
      if (!(error instanceof LiveError)) throw error;
      if (error.problem === 'not_found') {
        // The visitor's restaurant is past its day: a new one opens, seeded at the hour it opens.
        forgetSandbox();
        setToast(t.live.expired);
        void goLive();
      } else if (id === reads.current) {
        setToast(t.live.offline);
      }
      return undefined;
    }
  };

  const ask = async <T,>(run: (source: PanelBackend) => Promise<T> | undefined): Promise<T | undefined> => {
    await decided.current?.promise;
    const source = backend.current;
    if (!source) return undefined;
    try {
      return await run(source);
    } catch (error) {
      if (!(error instanceof LiveError)) throw error;
      setToast(t.live.offline);
      return undefined;
    }
  };

  /** Read again whenever the staff act or the hours change: only they move a booking out of the hours, or back in. */
  const readOutside = async () => {
    const source = backend.current;
    if (!source) return;
    try {
      setOutside(await source.outsideHours(language));
    } catch (error) {
      // Out of reach: the day's read says so, and the list stays as it was.
      if (!(error instanceof LiveError)) throw error;
    }
  };

  const goLive = async (wanted?: PlainDate) => {
    try {
      const sandbox = await connect({ container: verification.current ?? document.body, siteKey: PUBLIC_TURNSTILE_SITE_KEY, language, theme: 'dark', onInteractive: setVerifying });
      const time = await readClockOf(sandbox.id);
      adopt(liveBackend(sandbox.id, time));
      setLive(true);
      // What the chat did last is announced once, and the panel opens on the last table it booked; otherwise on the day
      // the visitor had on screen before changing language, or on the restaurant's service: today's while one is still
      // going, else the next.
      const news = takeNews(sandbox.id);
      const last = sandbox.booked[sandbox.booked.length - 1];
      const target = news === 'booked' && last ? last.date : (wanted ?? time.day);
      setDate(target);
      const next = await read(target);
      if (!next) return;
      if (news === 'booked' && last) {
        const booking = next.day.bookings.find((candidate) => candidate.reference === last.reference);
        const sitting = next.day.sittings.find((candidate) => candidate.name === booking?.service);
        if (booking && sitting) {
          setOpening({ service: sitting.service, table: booking.table ?? null, reference: booking.reference });
          setToast(t.panel.fromChat(booking.guestName, booking.channel, typeset(booking.readBack)));
        }
      }
      if (news === 'passed') {
        const request = [...next.day.callbacks.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (request) setToast(t.panel.callbackFromChat(request.channel, typeset(request.summary)));
      }
    } catch (error) {
      if (!(error instanceof LiveError)) throw error;
      // The live demo is paused or out of reach: the panel shows the recorded evening, and says so.
      setToast(error.problem === 'turnstile_failed' ? t.live.verifyFailed : t.live.local);
      await showRecording(undefined, wanted);
    }
  };

  /** The recorded evening, said to be one: while the live demo is paused or out of reach. */
  const showRecording = async (evening: DemoEvening = demoEvening(), wanted?: PlainDate) => {
    adopt(localBackend(evening));
    setLive(false);
    setDate(wanted ?? evening.day);
    await read(wanted ?? evening.day);
  };

  /** The chat played recordings while the live demo was paused: they join the evening in the browser. */
  const showRecorded = async (played: readonly string[], wanted?: PlainDate) => {
    const { recordingOutcome } = await import('maitre/demo/chat');
    // An id the engine no longer knows (an old session, a renamed recording) is skipped.
    const outcomes = played.flatMap((id) => {
      try {
        return [recordingOutcome(id)];
      } catch (error) {
        if (error instanceof RangeError) return [];
        throw error;
      }
    });
    const rebuilt = demoEvening({ fromChat: outcomes });
    adopt(localBackend(rebuilt));
    const booked = outcomes.flatMap((outcome) => outcome.bookings);
    // In the rebuilt evening the bookings have new references: they are found again by day, time and name.
    setFresh(
      new Set(
        booked.flatMap((made) => {
          const found = rebuilt.engine.serviceDay(made.date, language).bookings.find((candidate) => chatKey(candidate) === chatKey(made));
          return found ? [found.reference] : [];
        }),
      ),
    );
    const last = outcomes[outcomes.length - 1];
    const passed = last && last.bookings.length === 0 ? last.callbacks[0] : undefined;
    // Back from the other language, the visitor's own day, and nothing announced again.
    if (last && passed && !wanted) setToast(t.panel.callbackFromChat(last.channel, typeset(passed.summary)));
    const latest = booked[booked.length - 1];
    const target = wanted ?? latest?.date ?? shown.current;
    setDate(target);
    const next = await read(target);
    if (wanted || !latest || !next) return;
    const booking = next.day.bookings.find((candidate) => chatKey(candidate) === chatKey(latest));
    const sitting = next.day.sittings.find((candidate) => candidate.name === booking?.service);
    if (!booking || !sitting) return;
    setOpening({ service: sitting.service, table: booking.table ?? null, reference: booking.reference });
    if (!passed) setToast(t.panel.fromChat(booking.guestName, booking.channel, typeset(booking.readBack)));
  };

  // After the first render, which is the server's, so the two never disagree.
  useEffect(() => {
    const played = readPlayed();
    // Live, unless the build has no Turnstile key, or the visitor has only played recordings so far. A restaurant
    // already open is read whatever the demo's budget; a new one opens only if the demo is open today.
    const decide = async () => {
      // Arrived from the same panel in another language: its day, and what its screens had open, come back.
      const arrived = takePlace(location.pathname)?.panel;
      if (arrived) {
        const { date: _date, scrolled, ...shownThere } = arrived;
        place.current = shownThere;
        scrolledBefore.current = scrolled ?? null;
      }
      const wanted = arrived?.date;
      const kept = currentSandbox();
      const newcomer = Boolean(PUBLIC_TURNSTILE_SITE_KEY) && !kept && played.length === 0;
      const status = newcomer ? await demoStatus() : null;
      const opens = newcomer && status?.live !== false;
      if (opens) {
        // A new visitor's restaurant is seeded at the hour it opens, as this one is, at the restaurant's time and in the
        // page's language: the panel shows it at once, while Cloudflare's check and the restaurant take their second, and
        // nothing changes after.
        const seeded = demoEvening({ now: status ? new Date(status.now) : new Date(), language });
        adopt(localBackend(seeded));
        setDate(wanted ?? seeded.day);
        await read(wanted ?? seeded.day);
      }
      if (PUBLIC_TURNSTILE_SITE_KEY && (kept || opens)) await goLive(wanted);
      else if (played.length > 0) await showRecorded(played, wanted);
      else {
        setToast(t.live.local);
        await showRecording(undefined, wanted);
      }
    };
    void decide().finally(() => {
      decided.current?.resolve();
      setSettled(true);
      void readOutside();
    });
  }, []);

  // Each section has its address, «#conversations»: the rail's links change it, and so do the browser's arrows.
  useEffect(() => {
    const follow = () => {
      const wanted = location.hash.slice(1);
      moved.current = true;
      setSection(isSection(wanted) ? wanted : 'service');
    };
    const wanted = location.hash.slice(1);
    if (isSection(wanted)) setSection(wanted);
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);

  // A language link opens this same panel in the other language: its section stays in the address, and the day on
  // screen, what is open and how far each part has scrolled go with it.
  useEffect(() => {
    const languages = document.querySelector<HTMLElement>('.demo-bar__languages');
    const leave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || link.getAttribute('aria-current') === 'true') return;
      const target = new URL(link.href);
      target.hash = location.hash;
      link.href = target.href;
      // A new tab or window keeps a storage of its own: it gets the section, not the rest.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      keepPlace({ path: target.pathname, at: Date.now(), panel: { ...place.current, date: onScreen.current, scrolled: readScrolled() } });
    };
    languages?.addEventListener('click', leave);
    return () => languages?.removeEventListener('click', leave);
  }, []);

  useEffect(() => {
    if (!snapshot || !scrolledBefore.current) return;
    restoreScrolled(scrolledBefore.current);
    scrolledBefore.current = null;
  }, [snapshot]);

  // A section opened from the rail takes the focus to its title, so a screen reader hears where it went.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    document.getElementById('section-title')?.focus();
  }, [current]);

  useEffect(() => {
    if (!toast || holding || touring) return;
    const timer = setTimeout(() => setToast(''), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [toast, holding, touring]);

  // Said in the bar for as long as it lasts: the panel shows the evening in the browser, not the visitor's live restaurant.
  useEffect(() => {
    const marker = document.getElementById('demo-not-live');
    if (marker) marker.textContent = settled && !live ? ` (${t.demo.notLive})` : '';
  }, [settled, live]);

  // The live restaurant changes without the panel: what the assistant books arrives on the next read.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, POLL_MS);
    const back = () => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [live]);

  const app: PanelApp | null = snapshot && {
    t,
    language,
    date,
    snapshot,
    config,
    outside,
    fresh,
    opening,
    place: place.current,
    goTo: (days) => {
      const target = addDays(date, days);
      setDate(target);
      setToast('');
      void read(target);
    },
    act: async (run) => {
      const answer = await ask(run);
      if (answer !== undefined) await Promise.all([read(), readOutside()]);
      return answer;
    },
    ask,
    saveSettings: live
      ? async (changes) => {
          const answer = await ask((source) => source.saveSettings?.(changes, language));
          if (answer?.status === 'ok') {
            setConfig(answer.config);
            setOutside(answer.outsideHours);
            // The day on screen follows the new hours at once: a closed day, a shortened service, its bookings badged.
            void read();
          }
          return answer;
        }
      : null,
    notify: setToast,
    tour: () => setTours((count) => count + 1),
  };

  // The message waits for the tour: under its shade it ran out unread, and on the phone it covered the services the
  // first step points at.
  const message = touring ? '' : toast;

  return (
    <div class={touring ? 'app app--tour' : 'app'} data-section={current}>
      <Rail t={t.panel.sections} sections={sections} current={current} />
      <main class="app__main" id="main" aria-busy={!app}>
        {!app ? (
          <p class="app__opening">{t.panel.opening}</p>
        ) : current === 'conversations' ? (
          <ConversationsView app={app} />
        ) : current === 'activity' ? (
          <ActivityView app={app} />
        ) : current === 'settings' ? (
          <SettingsView app={app} />
        ) : (
          <SalleView app={app} />
        )}
      </main>
      <div
        class="toast"
        onMouseEnter={() => setHolding(true)}
        onMouseLeave={() => setHolding(false)}
        onFocusIn={() => setHolding(true)}
        onFocusOut={() => setHolding(false)}
      >
        <p class="toast__text" role="status">
          {message}
        </p>
        {message && (
          <button type="button" class="toast__close" aria-label={t.panel.dismiss} onClick={() => setToast('')}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {/* Cloudflare draws its check here only when it needs a click: until then the box takes no room. */}
      <div class="verify">
        {verifying && <p class="verify__label">{t.live.verify}</p>}
        <div ref={verification} />
      </div>
      {/* The tour points at the service's parts: it waits for the service to be on screen. */}
      {app && current === 'service' && (
        <Tour t={t.panel.tour} back={t.service.today} language={language} date={app.date} snapshot={app.snapshot} restart={tours} live={live} onShown={setTouring} />
      )}
    </div>
  );
}
