import { formatBooking, formatPhone, localNow, type Language } from 'maitre';
import { DEMO_RESTAURANT, RECORDINGS, Replay, ReplayError, type Recording, type ReplayedTurn } from 'maitre/demo';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { PANEL } from '../i18n/routes';
import { bookedIn, outcomeOf } from '../lib/conversation';
import { rememberPlayed } from '../lib/played';
import { typeset } from '../lib/typography';
import type { Line, Said } from '../lib/chat';
import { ChatLog, useNewestInView } from './ChatLog';

/**
 * The conversations offered while the live chat is paused, in order: the
 * bookings first, then the questions. Only ones recorded in a site's chat,
 * where the agent asks for the number in its field: on WhatsApp the number
 * comes with the message, which a site cannot do. web-no-phone-fr is left out:
 * its guest leaves without a table.
 */
const SUGGESTED = [
  'web-book-fr',
  'web-allergy-at-booking-fr',
  'web-allergen-known-fr',
  'web-large-group-fr',
  'web-book-en',
  'web-allergen-unknown-en',
  'web-faq-en',
  'web-book-es',
  'web-gluten-free-dishes-es',
  'web-hours-es',
  'web-large-group-es',
];

/** The live chat's fallback: real conversations recorded in the evaluation, played back on the real engine. */
export function RecordedChat({ language, t, greeting, open }: { language: Language; t: Messages; greeting: string; open: boolean }) {
  const log = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  const nextId = useRef(1);
  const [lines, setLines] = useState<Line[]>([{ id: 0, from: 'agent', text: greeting }]);
  const [typing, setTyping] = useState(false);
  const [state, setState] = useState<'choosing' | 'playing' | 'done'>('choosing');
  // The phone field: shown once the agent needs a number, with what is typed in it so far.
  const [phone, setPhone] = useState<string | null>(null);
  const offered = (ids: readonly string[]) =>
    ids
      .map((id) => RECORDINGS.find((recording) => recording.id === id))
      .filter((recording): recording is Recording => recording !== undefined && recording.language === language && recording.channel === 'web');
  const choices = offered(SUGGESTED);

  useNewestInView(log, [lines, typing, state, phone === null], state === 'choosing');

  // Closing the chat stops the conversation where it is; it does not play on behind the page.
  useEffect(() => {
    if (open) return;
    run.current += 1;
    setTyping(false);
    setPhone(null);
    setState((current) => (current === 'playing' ? 'done' : current));
  }, [open]);

  const say = (line: Said) => {
    const id = nextId.current;
    nextId.current += 1;
    setLines((current) => [...current, { ...line, id }]);
  };
  const start = () => {
    run.current += 1;
    nextId.current = 1;
    setLines([{ id: 0, from: 'agent', text: greeting }]);
    setTyping(false);
    setPhone(null);
    setState('choosing');
  };

  const play = async (recording: Recording) => {
    run.current += 1;
    const id = run.current;
    setState('playing');
    const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, instant ? 0 : ms));
    const today = localNow(new Date(recording.at), DEMO_RESTAURANT.timeZone).date;
    const replay = new Replay(recording);
    const played: ReplayedTurn[] = [];
    for (const recorded of recording.turns) {
      if (recorded.fieldPhone) {
        // The guest types the number in the field and sends it.
        const number = formatPhone(recorded.fieldPhone);
        for (let length = instant ? number.length : 1; length <= number.length; length += 1) {
          setPhone(number.slice(0, length));
          await wait(70);
          if (run.current !== id) return;
        }
        await wait(500);
        if (run.current !== id) return;
        setPhone(null);
        say({ from: 'phone', number });
      }
      // A turn that brings the number alone has no message from the guest: the assistant answers the field.
      if (recorded.guest) say({ from: 'guest', text: recorded.guest });
      setTyping(true);
      // The recorded wait, capped: the visitor reads along, the model took that long.
      await wait(Math.min(recorded.latencyMs, 1800));
      if (run.current !== id) return;
      let turn: ReplayedTurn | undefined;
      try {
        turn = replay.next();
      } catch (error) {
        if (!(error instanceof ReplayError)) throw error;
        setTyping(false);
        say({ from: 'agent', text: t.chat.replayFailed });
        setState('done');
        return;
      }
      setTyping(false);
      if (!turn) break;
      played.push(turn);
      say({ from: 'agent', text: turn.reply });
      if (turn.asksForPhone) setPhone('');
      const booked = bookedIn(turn);
      if (booked) say({ from: 'booking', readBack: formatBooking(booked.partySize, booked.date, booked.time, language, today), reference: booked.reference });
      await wait(900);
      if (run.current !== id) return;
    }
    // The panel shows what the conversation left: a table booked, or a request passed to the team.
    const outcome = outcomeOf(played);
    if (outcome === 'booked' || outcome === 'handover') rememberPlayed(recording.id);
    setPhone(null);
    setState('done');
  };

  const choice = (recording: Recording) => (
    <button type="button" key={recording.id} class="chat__choice" onClick={() => void play(recording)}>
      {typeset(recording.turns[0]?.guest ?? '')}
    </button>
  );

  return (
    <>
      <ChatLog lines={lines} typing={typing} t={t.chat} log={log}>
        {state === 'choosing' && (
          <div class="chat__choices">
            <div class="chat__group" role="group" aria-labelledby="chat-prompt">
              <p class="chat__label" id="chat-prompt">
                {t.chat.prompt}
              </p>
              {choices.map(choice)}
            </div>
          </div>
        )}
      </ChatLog>
      <div class="chat__foot">
        {phone !== null && (
          <form class="chat__phone" onSubmit={(event) => event.preventDefault()}>
            <label class="chat__label" for="chat-phone">
              {t.chat.phoneLabel}
            </label>
            <div class="chat__row">
              <input id="chat-phone" class="chat__field" type="tel" autoComplete="tel" readOnly value={phone} />
              <button type="submit" class="chat__send" disabled>
                {t.chat.send}
              </button>
            </div>
          </form>
        )}
        {state === 'done' && (
          <div class="chat__end">
            <a class="chat__primary" href={PANEL[language]}>
              {t.chat.panel}
            </a>
            <button type="button" class="chat__secondary" onClick={start}>
              {t.chat.again}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
