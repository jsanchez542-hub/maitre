import { formatDate, formatTime, type Language, type PlainDate } from 'maitre';
import { serviceDayAt } from 'maitre/demo';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { typeset } from '../lib/typography';
import type { Snapshot } from './Panel';

const KEY = 'maitre.tour';
/** Room around what a step points at, and between it and the step's card. */
const RING_PX = 4;
const GAP_PX = 12;
const MARGIN_PX = 16;

interface Step {
  /** What the step points at. The first that is on screen wins: the phone shows the list where a wide screen shows the plan. */
  targets: readonly string[];
  title: string;
  body: string;
}

interface Place {
  ring: { top: number; left: number; width: number; height: number };
  /** `high` when what the step points at sits low on the screen: on the phone, the card goes to the top. */
  card: { top: number; left: number; high: boolean };
}

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === 'done';
  } catch {
    // Storage refused: the tour shows each time, which is better than never.
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(KEY, 'done');
  } catch {
    // Storage refused: the tour will show again next time, which is better than never.
  }
}

const onScreen = (element: Element | null): element is HTMLElement => element instanceof HTMLElement && element.getClientRects().length > 0;

/**
 * The panel the first time: four steps that point at the day's service, the
 * room, what needs attention and the guest's side, as a product shows itself to
 * a new user. It shows by itself once, on the first visit; after that only from
 * «Visite guidée».
 */
export function Tour({
  t,
  back,
  language,
  date,
  snapshot,
  restart,
  live,
  onShown,
}: {
  t: Messages['panel']['tour'];
  /** The name of the button that brings the panel back to today. */
  back: string;
  language: Language;
  /** The day the panel shows, which a booking from the chat may have moved off today. */
  date: PlainDate;
  snapshot: Snapshot;
  restart: number;
  live: boolean;
  /** Told whether the tour is on screen: the panel holds back what would cover the parts it points at. */
  onShown: (shown: boolean) => void;
}) {
  // Closed on the server's render and for a returning visitor; opened after hydration on a first visit.
  const [step, setStep] = useState<number | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The first step says what the panel shows: today's service while one is still going, the next one otherwise, or the
  // day a booking from the chat opened it on.
  const next = serviceDayAt(snapshot.now);
  const today = typeset(formatDate(snapshot.today, language, snapshot.today));
  const time = typeset(formatTime(snapshot.time, language));
  const day = (plain: PlainDate) => typeset(formatDate(plain, language, snapshot.today));
  const opening =
    date !== next ? t.service.shown(today, time, day(date), back) : next === snapshot.today ? t.service.body(today, time) : t.service.next(today, time, day(next));
  const steps: Step[] = [
    { targets: ['.services'], title: t.service.title, body: opening },
    { targets: ['.floor', '.side'], title: t.room.title, body: t.room.body },
    { targets: ['.chips'], title: t.alerts.title, body: t.alerts.body },
    { targets: ['.rail'], title: t.rail.title, body: live ? t.rail.body : t.rail.recorded },
  ];
  const current = step === null ? undefined : steps[step];

  // Remembered as it shows, not as it closes: leaving the service or reloading in the middle of it unmounted it
  // unseen, and it came back each time.
  useEffect(() => {
    if (seen()) return;
    remember();
    setStep(0);
  }, []);

  useEffect(() => {
    onShown(step !== null);
    return () => onShown(false);
  }, [step === null]);

  // «Visite guidée» in the panel's bar: from the first step, however often.
  useEffect(() => {
    if (restart === 0) return;
    setPlace(null);
    setStep(0);
  }, [restart]);

  const close = () => {
    setStep(null);
    setPlace(null);
  };

  // The ring follows what it points at, and the card sits below it, above it, beside a column, or inside it when it fills the screen.
  useLayoutEffect(() => {
    if (!current) return;
    const target = current.targets.map((selector) => document.querySelector(selector)).find(onScreen);
    if (!target) {
      // Nothing to point at on this screen (a closed day has no service): the step is passed over.
      if (step !== null && step + 1 < steps.length) setStep(step + 1);
      else close();
      return;
    }
    const measure = () => {
      const box = target.getBoundingClientRect();
      const size = card.current?.getBoundingClientRect() ?? { width: 320, height: 200 };
      const below = box.bottom + GAP_PX;
      const above = box.top - GAP_PX - size.height;
      // A column down the side, as the rail on a desk: the card goes beside it, not over it.
      const column = box.height > innerHeight / 2 && box.width < innerWidth / 3;
      const top = column ? box.top + MARGIN_PX : below + size.height <= innerHeight - MARGIN_PX ? below : above >= MARGIN_PX ? above : box.top + MARGIN_PX;
      const left = Math.min(Math.max(column ? box.right + GAP_PX : box.left, MARGIN_PX), innerWidth - size.width - MARGIN_PX);
      setPlace({
        ring: { top: box.top - RING_PX, left: box.left - RING_PX, width: box.width + RING_PX * 2, height: box.height + RING_PX * 2 },
        card: { top: Math.max(top, MARGIN_PX), left, high: box.top + box.height / 2 > innerHeight / 2 },
      });
    };
    measure();
    addEventListener('resize', measure);
    addEventListener('scroll', measure, true);
    return () => {
      removeEventListener('resize', measure);
      removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // The card is measured hidden first: it takes the focus once it is in place, and at each step after.
  useEffect(() => {
    if (place) heading.current?.focus({ preventScroll: true });
  }, [step, place !== null]);

  // Escape skips the tour wherever the focus is: it points at the page and does not hold it.
  useEffect(() => {
    if (step === null) return;
    const skip = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', skip);
    return () => document.removeEventListener('keydown', skip);
  }, [step === null]);

  if (!current || step === null) return null;
  const last = step === steps.length - 1;

  return (
    <div class="tour">
      {place && <div class="tour__ring" aria-hidden="true" style={{ top: `${place.ring.top}px`, left: `${place.ring.left}px`, width: `${place.ring.width}px`, height: `${place.ring.height}px` }} />}
      <div
        ref={card}
        class={place?.card.high ? 'tour__card tour__card--high' : 'tour__card'}
        role="dialog"
        aria-label={t.label}
        aria-describedby="tour-body"
        style={place ? { top: `${place.card.top}px`, left: `${place.card.left}px` } : { visibility: 'hidden' }}
      >
        <p class="tour__step">{t.step(step + 1, steps.length)}</p>
        <h2 class="tour__title" tabIndex={-1} ref={heading}>
          {current.title}
        </h2>
        <p class="tour__body" id="tour-body">
          {current.body}
        </p>
        <div class="tour__actions">
          {!last && (
            <button type="button" class="tour__skip" onClick={close}>
              {t.skip}
            </button>
          )}
          <button type="button" class="tour__next" onClick={() => (last ? close() : setStep(step + 1))}>
            {last ? t.done : t.next}
          </button>
        </div>
      </div>
    </div>
  );
}
