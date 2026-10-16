import { PUBLIC_TURNSTILE_SITE_KEY } from 'astro:env/client';
import { localNow, messages, type Language } from 'maitre';
import { DEMO_EVENING_AT, DEMO_RESTAURANT, type DemoSuggestion } from 'maitre/demo';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { messagesFor } from '../i18n/messages';
import { useRestaurantClock } from '../lib/clock';
import type { RestaurantTime } from '../lib/live';
import { clockOf } from '../lib/restaurant';
import { demoStatus } from '../lib/status';
import { typeset } from '../lib/typography';
import { LiveChat, type ChatStatus } from './LiveChat';
import { RecordedChat } from './RecordedChat';

export function BookingChat({ language }: { language: Language }) {
  const t = messagesFor(language);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // Live, with the real assistant, unless this build has no Turnstile key or the live demo turns out to be paused.
  const [mode, setMode] = useState<'live' | 'recorded'>(PUBLIC_TURNSTILE_SITE_KEY ? 'live' : 'recorded');
  const [prefill, setPrefill] = useState<{ text: string; at: number } | null>(null);
  const [status, setStatus] = useState<ChatStatus>('connecting');
  // The restaurant's own time, as its clock says once the Worker answers, and the table a guest could still book then.
  const { now, sync } = useRestaurantClock();
  const [suggestion, setSuggestion] = useState<DemoSuggestion | null>(null);
  const today = now ? localNow(now, DEMO_RESTAURANT.timeZone).date : null;
  // The restaurant greets by its own hour («Bonsoir» from 18:00 in French); the recordings, by the hour they were made.
  const greetingAt = mode === 'live' ? now : new Date(DEMO_EVENING_AT);
  const hour = greetingAt ? Number(localNow(greetingAt, DEMO_RESTAURANT.timeZone).time.slice(0, 2)) : undefined;
  const greeting = messages(language).greeting(DEMO_RESTAURANT.name, 'web', hour);
  const onClock = (time: RestaurantTime) => {
    sync(time.clock);
    setSuggestion(time.suggestion);
  };

  // A demo closed today (its budget spent) opens on the recordings, saying so, without opening a restaurant to find out.
  useEffect(() => {
    if (!PUBLIC_TURNSTILE_SITE_KEY) return;
    void demoStatus().then((status) => {
      if (!status) return;
      if (!status.live) setMode('recorded');
      sync(status.now);
      setSuggestion(status.suggestion);
    });
  }, []);

  // Every «Réserver» on the page opens the chat, and «Groupes et privatisation» opens it with its message ready.
  // Without script they lead to the booking section. The listener is bound while the island hydrates, not after
  // the next paint: a tap that comes as soon as the page is ready still opens the chat.
  useLayoutEffect(() => {
    const onClick = (event: MouseEvent) => {
      const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-book]') : null;
      if (!trigger) return;
      event.preventDefault();
      setPrefill({ text: trigger.dataset['book'] === 'group' ? t.chat.example.group : '', at: Date.now() });
      setOpen(true);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} class="chat" aria-labelledby="chat-title" onClose={() => setOpen(false)}>
      <div class="chat__head">
        <div class="chat__heading">
          <h2 class="chat__title" id="chat-title">
            {t.chat.title}
          </h2>
          {mode === 'live' && (
            <p class={`chat__status chat__status--${status}`}>
              <span class="chat__dot" aria-hidden="true" />
              {status === 'live' ? `${t.chat.status.live} · ${t.chat.assistant}` : t.chat.status[status]}
            </p>
          )}
        </div>
        <button type="button" class="chat__close" onClick={() => setOpen(false)}>
          {t.chat.close}
        </button>
      </div>
      {mode === 'live' ? (
        // The restaurant's own day and time, as the call shows it, and what the visitor must know before writing.
        <div class="chat__notice">
          {now && <p>{clockOf(DEMO_RESTAURANT, now, language, t.site)}</p>}
          <p>{typeset(t.chat.notice)}</p>
        </div>
      ) : (
        <p class="chat__notice">{t.chat.recordedNotice}</p>
      )}
      {mode === 'live' ? (
        <LiveChat
          language={language}
          t={t}
          greeting={greeting}
          siteKey={PUBLIC_TURNSTILE_SITE_KEY}
          open={open}
          prefill={prefill}
          onRecorded={() => setMode('recorded')}
          onStatus={setStatus}
          onClock={onClock}
          suggested={suggestion && today ? { suggestion, today } : null}
        />
      ) : (
        <RecordedChat language={language} t={t} greeting={greeting} open={open} />
      )}
    </dialog>
  );
}
