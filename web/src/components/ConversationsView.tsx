import { formatBooking, formatDate, localNow } from 'maitre';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { medianOf, type BookingEvent, type Conversation, type TurnRecord } from '../lib/conversations';
import { dollarsOf, secondsOf } from '../lib/format';
import { telHref } from '../lib/service-view';
import { typeset } from '../lib/typography';
import { Icon } from './Icons';
import type { PanelApp } from './Panel';
import { SectionBar } from './PanelBar';

/** The log follows the restaurant as the service does: what the assistant says shows on the next read. */
const POLL_MS = 5000;
/** Where the list and the conversation sit side by side; below it, one at a time. */
const SIDE_BY_SIDE = '(min-width: 880px)';

/** The engine's own name for what the panel has no word for yet: a new tool or status still reads as the engine wrote it. */
const wordFor = (words: Record<string, string>, key: string): string => (Object.hasOwn(words, key) ? (words[key] ?? key) : key);

/** The turns that did not end as answers: the guest never sees the engine fail silently, nor does the owner. */
const FAILED = new Set(['failed_handed_over', 'failed_retry', 'empty_message', 'keypad_unreadable']);

/**
 * The conversations as an owner reads messages: who wrote or called, when, and what it came to; each one a thread of
 * the guest's words and the assistant's, with what it booked between them. What the assistant asked the engine, the
 * rules the code kept, how fast and at what cost, wait behind «Détails techniques».
 */
export function ConversationsView({ app }: { app: PanelApp }) {
  const { t, language, snapshot, config } = app;
  const c = t.panel.conversations;
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => app.place.conversation ?? null);
  const opened = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string | null>(null);

  const when = (at: string): string => {
    const moment = localNow(new Date(at), config.timeZone);
    return moment.date === snapshot.today ? moment.time : `${typeset(formatDate(moment.date, language, snapshot.today))}, ${moment.time}`;
  };
  const words: Words = {
    booking: (made) => typeset(formatBooking(made.partySize, made.date, made.time, language, snapshot.today)),
    who: (conversation) => conversation.guestName ?? conversation.phone ?? t.service.channel[conversation.channel],
    when,
  };

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const read = await app.ask((backend) => backend.conversations?.());
      if (stopped || !read) return;
      setConversations(read);
      // Side by side, the latest conversation is open from the start, as a mail client opens its newest message; one the
      // panel had open stays open while it is still there.
      setChosen((current) =>
        current && read.some((conversation) => conversation.sessionId === current) ? current : matchMedia(SIDE_BY_SIDE).matches ? (read[0]?.sessionId ?? null) : null,
      );
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const current = conversations?.find((conversation) => conversation.sessionId === chosen);
  useLayoutEffect(() => {
    app.place.conversation = chosen;
  }, [chosen]);

  const choose = (sessionId: string) => {
    opener.current = sessionId;
    setChosen(sessionId);
  };
  // On the phone the conversation replaces the list: its title takes the focus, and «Toutes les conversations» gives it back.
  useEffect(() => {
    if (opener.current && opener.current === chosen && !matchMedia(SIDE_BY_SIDE).matches) opened.current?.focus();
  }, [chosen]);
  const back = () => {
    const row = chosen;
    setChosen(null);
    requestAnimationFrame(() => document.getElementById(`talk-${row}`)?.focus());
  };

  return (
    <div class="screen screen--section">
      <SectionBar app={app} title={c.title} />
      {conversations === null ? null : conversations.length === 0 ? (
        <div class="section__empty">
          <p>{c.empty}</p>
        </div>
      ) : (
        <div class="log" data-open={current ? 'conversation' : 'list'}>
          <ul class="log__list" aria-label={c.list}>
            {conversations.map((conversation) => {
              const who = words.who(conversation);
              const channel = t.service.channel[conversation.channel];
              const said = lastWords(conversation);
              return (
                <li key={conversation.sessionId}>
                  <button
                    type="button"
                    class="talk"
                    id={`talk-${conversation.sessionId}`}
                    aria-current={conversation.sessionId === chosen ? 'true' : undefined}
                    onClick={() => choose(conversation.sessionId)}
                  >
                    <span class="talk__head">
                      <span class="talk__who">{who}</span>
                      <span class="talk__when">{when(conversation.startedAt)}</span>
                    </span>
                    <span class="talk__line">{[who === channel ? '' : channel, outcomeOf(conversation, app, words)].filter(Boolean).join(' · ')}</span>
                    {said && <span class="talk__said">{said}</span>}
                    {conversation.call && <span class="talk__call">{callOf(conversation, app)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {/* It scrolls on its own beside the list: focusable, so a keyboard scrolls it too. */}
          <section class="log__conversation" aria-labelledby={current ? 'conversation-title' : undefined} tabIndex={current ? 0 : undefined}>
            {current ? <Thread conversation={current} app={app} words={words} heading={opened} onBack={back} /> : <p class="log__choose">{c.choose}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

interface Words {
  /** A booking said as the guest heard it: «une table pour 2 personnes le jeudi 15 octobre à 20 h 30». */
  booking: (made: BookingEvent) => string;
  /** Who the conversation was with: the name a booking is under, else the number, else the way they came. */
  who: (conversation: Conversation) => string;
  when: (at: string) => string;
}

/** What the guest said last, as they said it: a row's preview, as an inbox shows one. */
function lastWords(conversation: Conversation): string {
  return conversation.turns.findLast((turn) => turn.guest.trim() !== '')?.guest ?? '';
}

/** What a conversation came to, in one line: the booking as it stands, a request passed to the team, or an answer. */
function outcomeOf(conversation: Conversation, app: PanelApp, words: Words): string {
  const c = app.t.panel.conversations;
  const { result, booking } = conversation;
  const said =
    result === 'booked'
      ? booking
        ? c.events.booked(words.booking(booking))
        : c.result.booked
      : result === 'changed'
        ? booking
          ? c.events.changed(words.booking(booking))
          : c.result.changed
        : result === 'cancelled'
          ? c.events.cancelled
          : result === 'confirmed'
            ? c.events.confirmed
            : result === 'answered' && conversation.passedToTeam
              ? c.events.passed
              : c.result[result];
  return conversation.passedToTeam && result !== 'answered' ? `${said} · ${c.passed}` : said;
}

/** How long a call lasted and how it ended, or that it is still going. */
function callOf(conversation: Conversation, app: PanelApp): string {
  const c = app.t.panel.conversations;
  const { call } = conversation;
  if (!call) return '';
  const ended = wordFor(c.ended, call.endedBy ?? 'going');
  return call.seconds === null ? ended : `${c.length(call.seconds)} · ${ended}`;
}

interface ThreadProps {
  conversation: Conversation;
  app: PanelApp;
  words: Words;
  heading: { current: HTMLHeadingElement | null };
  onBack: () => void;
}

/** One conversation as a thread: the guest's words as they wrote them, the assistant's, and what each turn did. */
function Thread({ conversation, app, words, heading, onBack }: ThreadProps) {
  const { t, language } = app;
  const c = t.panel.conversations;
  const who = words.who(conversation);
  const channel = t.service.channel[conversation.channel];
  const facts = [who === channel ? '' : channel, words.when(conversation.startedAt), t.panel.languages[conversation.language], callOf(conversation, app)].filter(Boolean);
  const answer = conversation.call ? medianOf(conversation.call.answerMs) : null;

  return (
    <article class="transcript">
      <button type="button" class="transcript__back" onClick={onBack}>
        <Icon name="chevron-left" />
        {c.back}
      </button>
      <header class="transcript__head">
        <h2 class="transcript__title" id="conversation-title" ref={heading} tabIndex={-1}>
          {who}
        </h2>
        <p class="transcript__facts">
          {facts.join(' · ')}
          {conversation.phone && conversation.phone !== who && (
            <>
              {' · '}
              <a href={telHref(conversation.phone)}>{conversation.phone}</a>
            </>
          )}
        </p>
      </header>
      <ol class="thread">
        {conversation.turns.map((turn, index) => (
          <Exchange key={index} turn={turn} app={app} words={words} lang={conversation.language} />
        ))}
      </ol>
      {conversation.turns.length > 0 && (
        <details class="tech">
          <summary class="tech__summary">{c.details}</summary>
          <div class="tech__body">
            {answer !== null && <p class="tech__line">{c.answers(secondsOf(answer, language))}</p>}
            <ol class="tech__turns">
              {conversation.turns.map((turn, index) => (
                <Trace key={index} turn={turn} app={app} />
              ))}
            </ol>
          </div>
        </details>
      )}
    </article>
  );
}

/** One turn of the thread: the guest's words, the assistant's reply, and what the turn did to a booking or for the team. */
function Exchange({ turn, app, words, lang }: { turn: TurnRecord; app: PanelApp; words: Words; lang: string }) {
  const { t, config } = app;
  const c = t.panel.conversations;
  const time = localNow(new Date(turn.at), config.timeZone).time;
  const made = (tool: string, status: string) => turn.tools.some((call) => call.name === tool && call.status === status);
  // A turn logged before the Worker said what each turn did still says what it did, without the booking's details.
  const events = [
    ...(turn.booked.length > 0 ? turn.booked.map((booking) => c.events.booked(words.booking(booking))) : made('book_table', 'booked') ? [c.result.booked] : []),
    ...(turn.changed.length > 0 ? turn.changed.map((booking) => c.events.changed(words.booking(booking))) : made('change_booking', 'changed') ? [c.result.changed] : []),
    ...(turn.cancelled.length > 0 || made('cancel_booking', 'cancelled') ? [c.events.cancelled] : []),
    ...(made('confirm_booking', 'confirmed') ? [c.events.confirmed] : []),
    ...(turn.passedToTeam || made('hand_over', 'recorded') ? [c.events.passed] : []),
  ];
  const booking = turn.booked.length > 0 || made('book_table', 'booked');

  return (
    <>
      {turn.guest.trim() ? (
        <li class="bubble bubble--guest">
          <p class="sr-only">{c.guest}</p>
          <p lang={lang}>{turn.guest}</p>
          <p class="bubble__time">{time}</p>
        </li>
      ) : (
        turn.phoneEntered && <li class="event">{c.typed}</li>
      )}
      {FAILED.has(turn.outcome) && <li class="event">{wordFor(c.outcomes, turn.outcome)}</li>}
      <li class="bubble bubble--assistant">
        <p class="sr-only">{c.assistant}</p>
        <p lang={lang}>{typeset(turn.reply)}</p>
      </li>
      {events.map((event, index) => (
        <li key={index} class={booking && index === 0 ? 'event event--booked' : 'event'}>
          {event}
        </li>
      ))}
    </>
  );
}

/** What one turn asked the engine and what it answered, the rules the code applied, how fast and at what cost. */
function Trace({ turn, app }: { turn: TurnRecord; app: PanelApp }) {
  const { t, language, config } = app;
  const c = t.panel.conversations;
  const meta = [c.latency(secondsOf(turn.latencyMs, language)), turn.costUsd === null ? '' : c.cost(dollarsOf(turn.costUsd, language)), turn.fellBack ? c.fellBack : ''].filter(
    Boolean,
  );
  return (
    <li class="tech__turn">
      <p class="tech__time">{localNow(new Date(turn.at), config.timeZone).time}</p>
      {turn.tools.length > 0 && (
        <div class="tech__group">
          <p class="tech__label">{c.engine}</p>
          <ul class="tech__list">
            {turn.tools.map((tool, index) => (
              <li key={index}>
                {wordFor(c.tools, tool.name)}
                <span aria-hidden="true"> → </span>
                <span class="sr-only">: </span>
                <span class="tech__status">{wordFor(c.statuses, tool.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {turn.corrections.length > 0 && (
        <div class="tech__group">
          <p class="tech__label">{c.corrected}</p>
          <ul class="tech__list">
            {turn.corrections.map((name) => (
              <li key={name}>{wordFor(c.corrections, name)}</li>
            ))}
          </ul>
        </div>
      )}
      <p class="tech__line">{meta.join(' · ')}</p>
    </li>
  );
}
