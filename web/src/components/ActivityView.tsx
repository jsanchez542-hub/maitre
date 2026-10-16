import { formatDate, type Activity, type Channel } from 'maitre';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { secondsOf } from '../lib/format';
import { typeset } from '../lib/typography';
import type { PanelApp } from './Panel';
import { SectionBar } from './PanelBar';

const PERIODS = [
  { days: 1, name: 'today' },
  { days: 7, name: 'week' },
  { days: 30, name: 'month' },
] as const;
type Days = (typeof PERIODS)[number]['days'];
const isDays = (value: number | undefined): value is Days => PERIODS.some((period) => period.days === value);

const CHANNELS: readonly Channel[] = ['web', 'whatsapp', 'voice', 'staff'];
/** The figures move as the guests write and call: read again now and then while the section is open. */
const POLL_MS = 15_000;

/**
 * What the assistant did for the restaurant, as an owner weighs it: the calls it answered while nobody could, how
 * fast it answered, the bookings it brought by each way in, and the conversations it held. Plain counts, a quiet
 * period included: nothing is estimated.
 */
export function ActivityView({ app }: { app: PanelApp }) {
  const { t, language, snapshot } = app;
  const a = t.panel.activity;
  const [days, setDays] = useState<Days>(() => (isDays(app.place.days) ? app.place.days : 7));
  const [activity, setActivity] = useState<Activity | null>(null);

  useLayoutEffect(() => {
    app.place.days = days;
  }, [days]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const read = await app.ask((backend) => backend.activity?.(days));
      if (!stopped && read) setActivity(read);
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [days]);

  const dateOf = (date: string) => typeset(formatDate(date, language, snapshot.today));

  return (
    <div class="screen screen--section">
      <SectionBar app={app} title={a.title}>
        <div class="services" role="group" aria-label={a.period}>
          {PERIODS.map((period) => (
            <button type="button" key={period.days} class="services__tab" aria-pressed={days === period.days} onClick={() => setDays(period.days)}>
              {a.periods[period.name]}
            </button>
          ))}
        </div>
      </SectionBar>
      {activity && (
        // It scrolls on its own under the bar: focusable, so a keyboard scrolls it too.
        <div class="section__body" role="region" aria-labelledby="section-title" tabIndex={0}>
          <p class="section__lead">{activity.from === activity.to ? dateOf(activity.to) : a.range(dateOf(activity.from), dateOf(activity.to))}</p>
          <div class="tiles">
            <div class="tiles__stack">
              <Calls activity={activity} app={app} />
              <AnswerTime activity={activity} app={app} />
            </div>
            <Bookings activity={activity} app={app} />
            <section class="tile" aria-labelledby="talks-title">
              <h2 class="tile__title" id="talks-title">
                {a.conversations}
              </h2>
              <dl class="facts facts--figures">
                <Fact name={a.written} help={a.writtenHelp} value={activity.conversations.written} />
                <Fact name={a.turns} help={a.turnsHelp} value={activity.conversations.turns} />
                <Fact name={a.passed} value={activity.conversations.passedToTeam} />
              </dl>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

interface TileProps {
  activity: Activity;
  app: PanelApp;
}

/** The owner's first question: the calls the assistant took while the restaurant could not. */
function Calls({ activity, app }: TileProps) {
  const a = app.t.panel.activity;
  const { calls } = activity;
  return (
    <section class="tile" aria-labelledby="calls-title">
      <h2 class="tile__title" id="calls-title">
        {a.calls}
      </h2>
      <p class="figure">{calls.whileClosed}</p>
      <p class="figure__label">
        {a.closedCalls}
        {/* A quiet period says it plainly: no «out of 0» and no rows of zeros under it. */}
        {calls.answered > 0 && <span class="figure__of"> {a.closedCallsOf(calls.answered)}</span>}
      </p>
      <p class="tile__help">{a.closedCallsHelp}</p>
      {calls.answered > 0 && (
        <>
          <dl class="facts facts--figures">
            <Fact name={a.duringService} value={calls.duringService} />
          </dl>
          <p class="tile__help">{a.minutes(calls.minutes)}</p>
        </>
      )}
    </section>
  );
}

function AnswerTime({ activity, app }: TileProps) {
  const a = app.t.panel.activity;
  const { median, p90 } = activity.calls.answerMs;
  return (
    <section class="tile" aria-labelledby="answer-title">
      <h2 class="tile__title" id="answer-title">
        {a.answerTime}
      </h2>
      {median === null ? (
        <p class="tile__empty">{a.noCalls}</p>
      ) : (
        <>
          <p class="figure">{secondsOf(median, app.language)}</p>
          {p90 !== null && <p class="figure__label">{a.p90(secondsOf(p90, app.language))}</p>}
        </>
      )}
      <p class="tile__help">{a.answerTimeHelp}</p>
    </section>
  );
}

/** The bookings by each way in, as bars against the busiest: drawn in SVG, sized by attributes and never by a style. */
function Bookings({ activity, app }: TileProps) {
  const { t } = app;
  const a = t.panel.activity;
  const { made, covers, byChannel } = activity.bookings;
  const busiest = Math.max(1, ...CHANNELS.map((channel) => byChannel[channel]));
  return (
    <section class="tile" aria-labelledby="bookings-title">
      <h2 class="tile__title" id="bookings-title">
        {a.bookings}
      </h2>
      <p class="figure">{made}</p>
      <p class="figure__label">{t.service.covers(covers)}</p>
      <h3 class="tile__subtitle">{a.byChannel}</h3>
      <ul class="bars">
        {CHANNELS.map((channel) => (
          <li class="bar" key={channel}>
            <span class="bar__name">{t.service.channel[channel]}</span>
            <svg class="bar__track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <rect class="bar__fill" width={(byChannel[channel] / busiest) * 100} height="8" rx="1" />
            </svg>
            <span class="bar__value">{byChannel[channel]}</span>
          </li>
        ))}
      </ul>
      <p class="tile__help">{a.bookingsHelp}</p>
    </section>
  );
}

/** One line of a tile: what it counts, and the count. */
function Fact({ name, help, value }: { name: string; help?: string; value: number }) {
  return (
    <div class="fact">
      <dt>
        {name}
        {help && <span class="fact__help">{help}</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
