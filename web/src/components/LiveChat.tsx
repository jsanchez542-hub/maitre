import { formatBooking, formatTime, localNow, type Language, type PlainDate } from 'maitre';
import { DEMO_RESTAURANT, type DemoSuggestion } from 'maitre/demo';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { PANEL } from '../i18n/routes';
import { connect } from '../lib/connect';
import { LiveError, readClockOf, say, sendPhone, type LiveProblem, type RestaurantTime, type Turn } from '../lib/live';
import { eveningOf } from '../lib/restaurant';
import { currentSandbox, forgetSandbox, keepChat, recordTurn, type StoredSandbox } from '../lib/sandbox';
import { typeset } from '../lib/typography';
import type { Line, Said } from '../lib/chat';
import { ChatLog, useNewestInView } from './ChatLog';

const MAX_LENGTH = 500;
/** From here the field says how much room is left, before it stops taking text. */
const COUNT_FROM = 400;

/** Problems the live chat cannot get past here: it offers the recorded conversations instead. */
const RECORDED_INSTEAD: readonly LiveProblem[] = ['too_many_sandboxes', 'live_paused', 'not_configured', 'offline', 'unexpected'];
/** Problems with one message, not with the chat: it is still live. */
const STILL_LIVE: readonly LiveProblem[] = ['rate_limited', 'invalid'];

export type ChatStatus = 'connecting' | 'live' | 'down';

interface Props {
  language: Language;
  t: Messages;
  greeting: string;
  siteKey: string | undefined;
  open: boolean;
  /** What the button that opened the chat puts in the field: the request of «Groupes et privatisation», or nothing. */
  prefill: { text: string; at: number } | null;
  onRecorded: () => void;
  /** Said under the chat's title: live only once the visitor's restaurant has opened. */
  onStatus: (status: ChatStatus) => void;
  /** The restaurant's own time, and the table it suggests then: read when the chat opens and when the page comes back. */
  onClock: (time: RestaurantTime) => void;
  /** The first dinner a guest could still book, and the restaurant's date: the first example asks for it. */
  suggested: { suggestion: DemoSuggestion; today: PlainDate } | null;
}

/** The chat with the real assistant, in the visitor's own restaurant. */
export function LiveChat({ language, t, greeting, siteKey, open, prefill, onRecorded, onStatus, onClock, suggested }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  const verification = useRef<HTMLDivElement>(null);
  const restaurant = useRef<Promise<StoredSandbox> | null>(null);
  // The restaurant the conversation is kept with, once the chat knows it.
  const kept = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const nextId = useRef(1);
  // The last text a button put in the field.
  const filled = useRef('');
  const [lines, setLines] = useState<Line[]>([{ id: 0, from: 'agent', text: greeting }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState<{ value: string; unreadable: boolean } | null>(null);
  const [problem, setProblem] = useState<LiveProblem | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [ready, setReady] = useState(false);
  // Once the conversation booked a table or passed a request on, there is something to see on the panel.
  const [left, setLeft] = useState(false);
  // Until the kept conversation is back, nothing is written over it.
  const [restored, setRestored] = useState(false);
  const started = lines.some((line) => line.from === 'guest');
  const down = problem !== null && !STILL_LIVE.includes(problem);
  const evening = suggested ? eveningOf(suggested.suggestion.date, suggested.today, t) : null;
  const chips = [
    ...(suggested && evening
      ? [{ label: t.chat.chips.book(evening), text: t.chat.example.book(suggested.suggestion.partySize, evening, formatTime(suggested.suggestion.time, language)) }]
      : []),
    { label: t.chat.chips.allergen, text: t.chat.example.allergen },
  ];

  useNewestInView(log, [lines, busy, phone === null, problem, left]);

  // The greeting follows the restaurant's hour, known a moment after the page opens: until the visitor writes, it
  // is the first line as the restaurant would say it now.
  useEffect(() => {
    setLines((current) => (current.length === 1 && current[0]?.from === 'agent' ? [{ id: 0, from: 'agent', text: greeting }] : current));
  }, [greeting]);

  // The conversation kept with the visitor's restaurant: a reload, or the panel and back, finds it where it was. Read
  // after the first render, which is the server's, so the two never disagree.
  useEffect(() => {
    const sandbox = currentSandbox();
    const chat = sandbox?.chat;
    if (sandbox && chat) {
      kept.current = sandbox.id;
      session.current = chat.session;
      nextId.current = Math.max(...chat.lines.map((line) => line.id)) + 1;
      setLines(chat.lines);
      setPhone(chat.askingPhone ? { value: '', unreadable: false } : null);
      setLeft(chat.left);
    }
    setRestored(true);
  }, []);

  // Kept after each answer, not while one is awaited, and before it is painted: a reload the moment the answer shows
  // finds it. «Une autre demande» lets the last one go.
  useLayoutEffect(() => {
    if (!restored || busy || !kept.current) return;
    keepChat(kept.current, session.current ? { session: session.current, lines, askingPhone: phone !== null, left } : null);
  }, [restored, lines, busy, phone !== null, left]);

  const add = (line: Said): number => {
    const id = nextId.current;
    nextId.current += 1;
    setLines((current) => [...current, { ...line, id }]);
    return id;
  };
  const drop = (id: number) => setLines((current) => current.filter((line) => line.id !== id));

  const fail = (error: unknown) => {
    if (!(error instanceof LiveError)) throw error;
    setProblem(error.problem);
  };
  const ownRestaurant = (): Promise<StoredSandbox> => {
    restaurant.current ??= connect({
      container: verification.current ?? document.body,
      siteKey,
      language,
      theme: 'light',
      onInteractive: setVerifying,
    }).then(
      (sandbox) => {
        kept.current = sandbox.id;
        setReady(true);
        return sandbox;
      },
      (error: unknown) => {
        // The next attempt starts over: a new check, a new restaurant.
        restaurant.current = null;
        setReady(false);
        throw error;
      },
    );
    return restaurant.current;
  };

  useEffect(() => {
    onStatus(down ? 'down' : ready ? 'live' : 'connecting');
  }, [ready, down]);

  const readTime = () => {
    const opening = restaurant.current;
    if (!opening) return;
    opening
      .then((sandbox) => readClockOf(sandbox.id))
      .then(onClock)
      .catch((error: unknown) => {
        // The time is a courtesy: a restaurant out of reach says so when the visitor writes.
        if (!(error instanceof LiveError)) throw error;
      });
  };

  useEffect(() => {
    if (!open || !ready) return;
    readTime();
    // The suggested table moves on with the hour: read again when the visitor comes back to the page.
    const onVisible = () => {
      if (document.visibilityState === 'visible') readTime();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [open, ready]);

  // The restaurant opens with the chat, while the visitor reads the greeting.
  useEffect(() => {
    if (open && !restaurant.current) ownRestaurant().catch(fail);
  }, [open]);

  // A plain «Réserver» takes out the request another button put in, if the visitor left it as it was: words of
  // their own stay, as a draft does.
  useEffect(() => {
    if (!prefill) return;
    if (!prefill.text) {
      setDraft((current) => (current !== '' && current === filled.current ? '' : current));
      return;
    }
    filled.current = prefill.text;
    setDraft(prefill.text);
    field.current?.focus();
  }, [prefill]);

  useEffect(() => {
    if (phone && !phone.value) phoneField.current?.focus();
  }, [phone !== null]);

  const answer = (sandbox: StoredSandbox, turn: Turn) => {
    const today = localNow(new Date(sandbox.openedAt), DEMO_RESTAURANT.timeZone).date;
    add({ from: 'agent', text: turn.reply });
    for (const booked of turn.booked) {
      add({ from: 'booking', readBack: formatBooking(booked.partySize, booked.date, booked.time, language, today), reference: booked.reference });
    }
    setPhone(turn.askForPhone ? { value: '', unreadable: false } : null);
    recordTurn(sandbox.id, turn);
    if (turn.booked.length > 0 || turn.passedToTeam) setLeft(true);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    session.current ??= crypto.randomUUID();
    const id = add({ from: 'guest', text: message });
    setDraft('');
    setProblem(null);
    setBusy(true);
    try {
      const sandbox = await ownRestaurant();
      answer(sandbox, await say(sandbox.id, session.current, message, language));
    } catch (error) {
      // The message did not go: it goes back in the field, to send again.
      drop(id);
      setDraft(message);
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const sendNumber = async (value: string) => {
    if (busy || !session.current || !value.trim()) return;
    const id = add({ from: 'phone', number: value.trim() });
    setPhone(null);
    setProblem(null);
    setBusy(true);
    try {
      const sandbox = await ownRestaurant();
      const result = await sendPhone(sandbox.id, session.current, value);
      if (result.status === 'unreadable') {
        drop(id);
        setPhone({ value, unreadable: true });
        return;
      }
      // The restaurant writes the number as it stored it, grouped for reading.
      setLines((current) => current.map((line) => (line.id === id && line.from === 'phone' ? { ...line, number: result.phone } : line)));
      answer(sandbox, result);
    } catch (error) {
      drop(id);
      setPhone({ value, unreadable: false });
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  /** Another conversation in the same restaurant. */
  const again = () => {
    session.current = null;
    nextId.current = 1;
    setLines([{ id: 0, from: 'agent', text: greeting }]);
    setPhone(null);
    setProblem(null);
    setLeft(false);
  };
  /** A new restaurant, when this one expired or took all the messages it can. */
  const fresh = () => {
    forgetSandbox();
    restaurant.current = null;
    setReady(false);
    again();
    ownRestaurant().catch(fail);
  };
  const retry = () => {
    setProblem(null);
    ownRestaurant().catch(fail);
  };
  /** A chip fills the field with its whole example: the visitor sees what goes to the assistant, and sends it. */
  const use = (text: string) => {
    setDraft(text);
    field.current?.focus();
  };

  const explanation: Record<LiveProblem, string> = {
    turnstile_failed: t.live.verifyFailed,
    too_many_sandboxes: t.live.tooMany,
    live_paused: t.live.paused,
    not_configured: t.live.paused,
    offline: t.live.offline,
    unexpected: t.live.down,
    rate_limited: t.live.tooFast,
    sandbox_limit: t.live.full,
    call_limit: t.live.full,
    // A call's refusal: the chat never meets it, and would say the live demo is paused.
    calls_unavailable: t.live.paused,
    not_found: t.live.expired,
    invalid: t.live.notSent,
  };

  return (
    <>
      <ChatLog lines={lines} typing={busy} live t={t.chat} log={log} />
      <div class="chat__foot">
        <div class="chat__verify">
          {verifying && <p class="chat__label">{t.live.verify}</p>}
          <div ref={verification} />
        </div>
        {problem && (
          <div class="chat__problem" role="status">
            <p>{explanation[problem]}</p>
            <div class="chat__end">
              {(problem === 'turnstile_failed' || problem === 'offline' || problem === 'unexpected') && (
                <button type="button" class="chat__secondary" onClick={retry}>
                  {t.live.retry}
                </button>
              )}
              {(problem === 'sandbox_limit' || problem === 'not_found') && (
                <button type="button" class="chat__secondary" onClick={fresh}>
                  {t.live.fresh}
                </button>
              )}
              {RECORDED_INSTEAD.includes(problem) && (
                <button type="button" class="chat__secondary" onClick={onRecorded}>
                  {t.live.recorded}
                </button>
              )}
            </div>
          </div>
        )}
        {left && (
          <div class="chat__end">
            <a class="chat__primary" href={PANEL[language]}>
              {t.chat.panel}
            </a>
            <button type="button" class="chat__secondary" onClick={again}>
              {t.chat.again}
            </button>
          </div>
        )}
        {phone !== null && (
          <form
            class="chat__phone"
            onSubmit={(event) => {
              event.preventDefault();
              void sendNumber(phone.value);
            }}
          >
            <label class="chat__label" for="chat-phone">
              {t.chat.phoneLabel}
            </label>
            <div class="chat__row">
              <input
                id="chat-phone"
                ref={phoneField}
                class="chat__field"
                type="tel"
                autoComplete="off"
                inputMode="tel"
                placeholder={t.chat.phoneExample}
                aria-describedby="chat-phone-help"
                aria-invalid={phone.unreadable}
                value={phone.value}
                onInput={(event) => setPhone({ value: event.currentTarget.value, unreadable: false })}
              />
              <button type="submit" class="chat__send" disabled={busy || !phone.value.trim()}>
                {t.chat.send}
              </button>
            </div>
            <p class="chat__help" id="chat-phone-help">
              {phone.unreadable ? t.chat.phoneUnreadable : t.chat.phoneHelp}
            </p>
          </form>
        )}
        <form
          class="chat__compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <label class="sr-only" for="chat-message">
            {t.chat.message}
          </label>
          <div class="chat__row">
            <textarea
              id="chat-message"
              ref={field}
              class="chat__field chat__field--message"
              rows={1}
              maxLength={MAX_LENGTH}
              placeholder={t.chat.message}
              value={draft}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Enter sends, as in any chat; Shift+Enter goes to the next line.
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button type="submit" class="chat__send" disabled={busy || draft.trim() === ''}>
              {t.chat.send}
            </button>
          </div>
          {draft.length >= COUNT_FROM && <p class="chat__help">{t.chat.left(MAX_LENGTH - draft.length)}</p>}
        </form>
        {/* Suggestions for the live assistant: not while it cannot answer. */}
        {!started && !down && (
          <div class="chat__chips" role="group" aria-label={t.chat.examples}>
            {chips.map((chip) => (
              <button type="button" key={chip.label} class="chat__chip" onClick={() => use(chip.text)}>
                {typeset(chip.label)}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
