import { daysBetween, formatDate, formatTime, isoWeekday } from 'maitre';
import { serviceDayAt } from 'maitre/demo';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { typeset } from '../lib/typography';
import { Icon } from './Icons';
import type { PanelApp } from './Panel';

/** ‹ mardi 13 octobre › at the top of every screen, and «Aujourd’hui» once away from it. */
export function DayNav({ app }: { app: PanelApp }) {
  const { t, snapshot, goTo, date } = app;
  return (
    <div class="day">
      <button type="button" class="day__step" aria-label={t.service.previousDay} onClick={() => goTo(-1)}>
        <Icon name="chevron-left" />
      </button>
      <h2 class="day__label">{typeset(snapshot.day.readBack)}</h2>
      <button type="button" class="day__step" aria-label={t.service.nextDay} onClick={() => goTo(1)}>
        <Icon name="chevron-right" />
      </button>
      {date !== snapshot.today && (
        <button type="button" class="day__today" onClick={() => goTo(daysBetween(date, snapshot.today))}>
          {t.service.today}
        </button>
      )}
    </div>
  );
}

/** The restaurant's own time, on the panel and in the demo's bar. */
export function Clock({ app }: { app: PanelApp }) {
  const { t, language, snapshot } = app;

  // The bar is static HTML outside this island: its line says the restaurant's day and time as the panel reads them,
  // and, when no service is left today, that the panel shows the next one.
  useEffect(() => {
    const when = document.getElementById('demo-when');
    if (!when) return;
    const next = serviceDayAt(snapshot.now);
    const day = typeset(formatDate(snapshot.today, language, snapshot.today));
    const time = typeset(formatTime(snapshot.time, language));
    const ahead = next === snapshot.today ? '' : ` · ${t.demo.next(t.site.weekdays[isoWeekday(next) - 1] ?? '')}`;
    when.textContent = ` · ${day}, ${time}${ahead}`;
  });

  return (
    <p class="clock">
      <span class="clock__now">{t.service.now(snapshot.time)}</span>
    </p>
  );
}

/**
 * The top of every section but the service's: the restaurant, the section's name, what the section adds, and the
 * time. The name takes the focus when the rail opens the section, so a screen reader hears where it went.
 */
export function SectionBar({ app, title, children }: { app: PanelApp; title: string; children?: ComponentChildren }) {
  return (
    <header class="topbar">
      <p class="topbar__brand">{app.config.name}</p>
      <h1 class="topbar__title" id="section-title" tabIndex={-1}>
        {title}
      </h1>
      {children}
      <Clock app={app} />
    </header>
  );
}
