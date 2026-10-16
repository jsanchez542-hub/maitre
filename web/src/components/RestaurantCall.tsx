import { PUBLIC_TURNSTILE_SITE_KEY } from 'astro:env/client';
import { addDays, localNow, type Language, type PlainDate } from 'maitre';
import { DEMO_RESTAURANT } from 'maitre/demo';
import type { LocalAudioTrack, Participant, Room } from 'livekit-client';
import { useEffect, useRef, useState } from 'preact/hooks';
import { messagesFor, type Messages } from '../i18n/messages';
import { PANEL } from '../i18n/routes';
import { BARREL } from '../lib/barrel';
import { useRestaurantClock } from '../lib/clock';
import { connect } from '../lib/connect';
import { LiveError, openLine, readClockOf, readDay, type CallOffer, type LiveProblem } from '../lib/live';
import { clockOf } from '../lib/restaurant';
import { currentSandbox, forgetSandbox, noteOfCall, recordTurn } from '../lib/sandbox';
import { demoStatus } from '../lib/status';
import { typeset } from '../lib/typography';
import { useNewestInView } from './ChatLog';

type Phase = 'ready' | 'connecting' | 'ringing' | 'live' | 'ended';
type AgentState = 'listening' | 'thinking' | 'speaking';
type Problem = keyof Messages['call']['problems'] | 'expired' | 'offline' | 'verify' | 'tooMany';

interface Caption {
  id: string;
  from: 'agent' | 'caller';
  text: string;
  final: boolean;
}

/** A call that cannot go on, with the words that say why; none when the visitor hung up before it began. */
class Stop extends Error {
  constructor(readonly problem: Problem | null) {
    super(`The call stopped: ${problem ?? 'hung up'}`);
    this.name = 'Stop';
  }
}

const FROM_LIVE: Record<LiveProblem, Problem> = {
  call_limit: 'callLimit',
  sandbox_limit: 'callLimit',
  calls_unavailable: 'unavailable',
  rate_limited: 'rateLimited',
  live_paused: 'paused',
  not_configured: 'unavailable',
  not_found: 'expired',
  turnstile_failed: 'verify',
  too_many_sandboxes: 'tooMany',
  offline: 'offline',
  invalid: 'line',
  unexpected: 'line',
};

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

/** −80 dBFS: below it a microphone gives no sound at all, as when it is muted, rather than a quiet room. */
const SILENCE = 0.0001;
/** How long the restaurant may wait for the visitor's voice, hearing nothing, before the screen says so. */
const SILENCE_MS = 6000;
/**
 * How far ahead the bookings a call made are looked for afterwards: the days a caller books for. One further ahead is
 * in the restaurant all the same, only not announced on the panel.
 */
const LOOK_AHEAD_DAYS = 14;
/** As a phone gives up on a line nobody picks up: no restaurant on it by then, and it is not answering. */
const RING_MS = 30_000;

const minutesAndSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Recognition cuts a sentence into pieces: one speaker's pieces in a row read as one message. */
function turns(captions: readonly Caption[]): { id: string; from: Caption['from']; text: string; final: boolean }[] {
  const grouped: { id: string; from: Caption['from']; text: string; final: boolean }[] = [];
  for (const caption of captions) {
    const last = grouped[grouped.length - 1];
    if (last && last.from === caption.from) {
      last.text = `${last.text} ${caption.text}`.trim();
      last.final &&= caption.final;
    } else {
      grouped.push({ ...caption });
    }
  }
  return grouped;
}

/** Merrain's barrel, larger: the restaurant on the line, still while it listens and its staves moving while it thinks or speaks. */
function RestaurantMark() {
  return (
    <svg class="call__mark" viewBox={BARREL.viewBox} aria-hidden="true" focusable="false">
      <path d={BARREL.hoops} />
      {BARREL.staves.map((stave) => (
        <path key={stave} class="call__stave" d={stave} />
      ))}
    </svg>
  );
}

/**
 * «Appeler le restaurant»: a call from the browser to the visitor's own restaurant, where the voice agent answers
 * with the same assistant as the chat. The panel is a phone's call screen: the restaurant, the call's state and
 * length, call or hang up, and the keypad when the restaurant asks for the number, which goes as real tones.
 */
export function RestaurantCall({ language }: { language: Language }) {
  const t = messagesFor(language);
  const dialog = useRef<HTMLDialogElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const sound = useRef<HTMLDivElement>(null);
  const verification = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const book = useRef<HTMLAnchorElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const room = useRef<Room | null>(null);
  const microphone = useRef<LocalAudioTrack | null>(null);
  const hungUp = useRef(false);
  const digits = useRef('');
  const awaitingVoice = useRef(false);
  const answered = useRef(false);
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState<CallOffer | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [showCaptions, setShowCaptions] = useState(false);
  const [keypad, setKeypad] = useState(false);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [silent, setSilent] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [input, setInput] = useState<string | null>(null);
  // The browser's track under the microphone on the line: a new one each time the visitor changes microphone.
  const [heard, setHeard] = useState<MediaStreamTrack | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [booked, setBooked] = useState(0);
  const [verifying, setVerifying] = useState(false);
  // As the Worker counts them; until the visitor has a restaurant, the restaurant's whole allowance.
  const [callsLeft, setCallsLeft] = useState<number | null>(null);

  const maxSeconds = offer?.maxSeconds ?? 240;
  const { now, sync } = useRestaurantClock();
  const place = now ? clockOf(DEMO_RESTAURANT, now, language, t.site) : '';
  const left = callsLeft ?? offer?.perRestaurant ?? null;
  const calling = phase === 'connecting' || phase === 'ringing' || phase === 'live';
  const keys = phase === 'live' && keypad;
  // With no call left, that is said before anything is tried, with a new restaurant to call instead.
  const shown = problem ?? (left === 0 && !calling ? 'callLimit' : null);
  // No calls to take: «Appeler» and the microphone would do nothing, and the written way to book takes their place.
  const unavailable = shown === 'unavailable';

  // The ways in stay hidden until the Worker says the demo takes calls: no button that would fail.
  useEffect(() => {
    if (!PUBLIC_TURNSTILE_SITE_KEY) return;
    void demoStatus().then((status) => {
      if (status) sync(status.now);
      const kept = currentSandbox();
      if (!status?.calls || kept?.calls === null) return;
      setOffer(kept?.calls ?? status.calls);
      for (const trigger of document.querySelectorAll<HTMLElement>('[data-call]')) trigger.hidden = false;
    });
    const onClick = (event: MouseEvent) => {
      const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-call]') : null;
      if (!trigger) return;
      event.preventDefault();
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
    // The restaurant's own time, which the panel may have moved on: read when the call opens.
    const kept = currentSandbox();
    if (open && kept) {
      readClockOf(kept.id).then((time) => {
        sync(time.clock);
        setCallsLeft(time.callsLeft);
      }, ignoreLive);
    }
  }, [open]);

  // Whatever takes this screen away (a page that swaps it, a hot update while developing) takes the call with it: a
  // line left open with no screen on it could not be hung up.
  useEffect(
    () => () => {
      hungUp.current = true;
      void room.current?.disconnect();
      microphone.current?.stop();
    },
    [],
  );

  /** The microphones to choose from. The browser names them only once it has allowed one; before that, none is offered. */
  const listInputs = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // Windows lists its communications microphone a second time, under that name: the copy is left out.
    const named = devices.filter((device) => device.kind === 'audioinput' && device.label !== '' && device.deviceId !== 'communications');
    setInputs(named);
    setInput((chosen) => (chosen && named.some((device) => device.deviceId === chosen) ? chosen : null));
  };

  // A laptop often has several inputs, and the browser may open one that hears nothing: «Stereo Mix» records the
  // speakers, an empty jack records silence. The list follows what is plugged in while the call screen is open.
  useEffect(() => {
    // Missing outside a secure context, such as the site opened by its address on the local network.
    if (!open || !navigator.mediaDevices) return;
    void listInputs();
    navigator.mediaDevices.addEventListener('devicechange', listInputs);
    return () => navigator.mediaDevices.removeEventListener('devicechange', listInputs);
  }, [open]);

  // The call's length, counted while the restaurant is on the line.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // What changed last is at the foot of the screen: the newest caption, or the state when the keypad takes the room.
  useNewestInView(screen, [captions, phase, keys, showCaptions, silent, problem, muted, verifying, booked]);

  // «Appeler» gives way to «Raccrocher», and that to «Rappeler»: the focus follows, rather than fall to the page.
  useEffect(() => {
    if (open) action.current?.focus();
  }, [calling]);

  useEffect(() => {
    if (unavailable) book.current?.focus();
  }, [unavailable]);

  // The microphone's level while the line is open: the meter moves with the visitor's voice, and a microphone that
  // gives nothing at all while the restaurant waits for an answer is named.
  useEffect(() => {
    if (phase !== 'live' || !heard) return;
    const audio = new AudioContext();
    // Made after the click's awaits, the context may start suspended; until it runs, it hears nothing.
    void audio.resume();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(new MediaStream([heard])).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let level = 0;
    let quietSince = performance.now();
    let told = false;
    let frame = 0;
    const listen = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const loudness = Math.sqrt(sum / samples.length);
      // From −60 dBFS, a quiet room, to −10 dBFS, a raised voice; it falls back slowly, as a level meter does.
      level = Math.max(Math.min(1, Math.max(0, (20 * Math.log10(loudness) + 60) / 50)), level * 0.9);
      meter.current?.style.setProperty('--level', level.toFixed(3));
      const now = performance.now();
      if (loudness > SILENCE || !awaitingVoice.current || audio.state !== 'running') quietSince = now;
      const quiet = now - quietSince > SILENCE_MS;
      if (quiet !== told) {
        told = quiet;
        setSilent(quiet);
      }
      frame = requestAnimationFrame(listen);
    };
    listen();
    return () => {
      cancelAnimationFrame(frame);
      void audio.close();
      setSilent(false);
    };
  }, [phase, heard]);

  // On a computer the keys type the number too, while the keypad is open, and Enter ends it as # does. The keypad
  // takes the focus from «Raccrocher», where an Enter after the number would have hung up; it gives it back after.
  useEffect(() => {
    if (!keys) {
      if (calling) action.current?.focus();
      return;
    }
    pad.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const onControl = event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement;
      const key = event.key === 'Enter' && !onControl ? '#' : event.key;
      if (!(KEYS as readonly string[]).includes(key)) return;
      event.preventDefault();
      press(key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keys]);

  const caption = (next: Caption) =>
    setCaptions((current) => (current.some((line) => line.id === next.id) ? current.map((line) => (line.id === next.id ? next : line)) : [...current, next]));

  /** The agent's own word for what it is doing, and whether it wants the number. */
  const follow = (participant: Participant) => {
    if (!participant.isAgent) return;
    const state = participant.attributes['lk.agent.state'];
    const asking = participant.attributes['maitre.keypad'] === 'open';
    if (state === 'listening' || state === 'thinking' || state === 'speaking') {
      answered.current = true;
      setAgent(state);
      setPhase('live');
    }
    setKeypad(asking);
    awaitingVoice.current = state === 'listening' && !asking;
  };

  const press = (key: string) => {
    // DTMF codes as a phone sends them: the digits are their own, the star and the hash come after.
    void room.current?.localParticipant.publishDtmf(key === '*' ? 10 : key === '#' ? 11 : Number(key), key);
    if (key !== '#') {
      digits.current += key;
      setTyped(digits.current);
      return;
    }
    // The number goes with #: it shows in the captions, as the chat shows the number typed in its field.
    if (digits.current) caption({ id: `keypad-${Date.now()}`, from: 'caller', text: t.call.keypad.sent(digits.current), final: true });
    digits.current = '';
    setTyped('');
  };

  /** The visitor's microphone: for the next call, and at once on the line, where the meter shows whether it hears. */
  const choose = async (deviceId: string) => {
    setInput(deviceId);
    const track = microphone.current;
    if (!track) return;
    // A microphone that will not open leaves the line silent, and the silence notice offers another.
    await track.setDeviceId({ exact: deviceId }).catch(() => false);
    setHeard(track.mediaStreamTrack);
  };

  /** What the call left in the restaurant, for the panel to show as new. */
  const takeNote = async (sandbox: string, today: PlainDate, since: string) => {
    const days = await Promise.all(Array.from({ length: LOOK_AHEAD_DAYS }, (_, ahead) => readDay(sandbox, addDays(today, ahead), language)));
    const note = noteOfCall(days, since);
    recordTurn(sandbox, note);
    setBooked(note.booked.length);
  };

  /** The microphone and the line let go, as at the end of any call. */
  const release = () => {
    microphone.current?.stop();
    microphone.current = null;
    setHeard(null);
    room.current = null;
    awaitingVoice.current = false;
    for (const element of sound.current?.querySelectorAll('audio') ?? []) element.remove();
    setAgent(null);
    setKeypad(false);
    setMuted(false);
  };

  const finish = (sandbox: string, today: PlainDate, since: string) => {
    release();
    setPhase('ended');
    takeNote(sandbox, today, since).catch(ignoreLive);
  };

  /** The line rang and nobody picked up: the screen is back where it started, and says so. */
  const giveUp = () => {
    release();
    setPhase('ready');
    setProblem('noAnswer');
  };

  const start = async () => {
    if (calling) return;
    hungUp.current = false;
    awaitingVoice.current = false;
    answered.current = false;
    setProblem(null);
    setCaptions([]);
    digits.current = '';
    setTyped('');
    setSeconds(0);
    setBooked(0);
    setPhase('connecting');
    let livekit: typeof import('livekit-client') | undefined;
    try {
      const kit = await import('livekit-client').catch(() => {
        throw new Stop('offline');
      });
      livekit = kit;
      // The SDK's own logs stay out of a visitor's console: a call the restaurant ends closes its channels with errors
      // that are none, and they name the call's room.
      if (import.meta.env.PROD) kit.setLogLevel('silent');
      // The microphone first: a visitor who refuses it has not spent one of the restaurant's calls.
      const voice = await kit
        .createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(input ? { deviceId: { exact: input } } : {}),
        })
        .catch((error: unknown) => {
          throw new Stop(error instanceof DOMException && error.name === 'NotAllowedError' ? 'micDenied' : 'micFailed');
        });
      microphone.current = voice;
      setHeard(voice.mediaStreamTrack);
      setInput(voice.mediaStreamTrack.getSettings().deviceId ?? input);
      void listInputs();
      const sandbox = await connect({ container: verification.current ?? document.body, siteKey: PUBLIC_TURNSTILE_SITE_KEY, language, theme: 'light', onInteractive: setVerifying });
      if (sandbox.calls === null) throw new Stop('unavailable');
      if (sandbox.calls) setOffer(sandbox.calls);
      if (hungUp.current) throw new Stop(null);
      const line = await openLine(sandbox.id, language);
      setCallsLeft(line.callsLeft);
      if (hungUp.current) throw new Stop(null);
      // The restaurant's clock as the call begins: what the line books after it is new, whichever day it is for.
      const since = await readClockOf(sandbox.id).then(
        (time) => {
          sync(time.clock);
          return time.clock;
        },
        (error: unknown) => {
          if (!(error instanceof LiveError)) throw error;
          return new Date().toISOString();
        },
      );
      const today = localNow(new Date(since), DEMO_RESTAURANT.timeZone).date;

      const call = new kit.Room({ adaptiveStream: true, dynacast: true });
      room.current = call;
      call.on(kit.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === kit.Track.Kind.Audio) sound.current?.append(track.attach());
      });
      call.on(kit.RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) element.remove();
      });
      call.on(kit.RoomEvent.ParticipantConnected, follow);
      call.on(kit.RoomEvent.ParticipantAttributesChanged, (_changed, participant) => follow(participant));
      call.on(kit.RoomEvent.AudioPlaybackStatusChanged, () => setMuted(!call.canPlaybackAudio));
      // The visitor hangs up, or the restaurant does (silence, the call's longest, the demo's budget): the same end.
      // A room left before the microphone was on the line is a failed call, which the catch below explains.
      let onLine = false;
      let unanswered = false;
      call.on(kit.RoomEvent.Disconnected, () => {
        if (unanswered) giveUp();
        else if (onLine) finish(sandbox.id, today, since);
      });
      call.registerTextStreamHandler('lk.transcription', (reader, participant) => {
        const from = participant.identity === call.localParticipant.identity ? 'caller' : 'agent';
        const id = reader.info.attributes?.['lk.segment_id'] || reader.info.id;
        const final = reader.info.attributes?.['lk.transcription_final'] === 'true';
        void (async () => {
          let text = '';
          for await (const chunk of reader) {
            text += chunk;
            caption({ id, from, text, final });
          }
          // The agent's words are final once said; the caller's, once recognition says so.
          caption({ id, from, text, final: final || from === 'agent' });
        })();
      });
      await call.connect(line.url, line.token);
      // Published as the microphone, the one source the pass allows; LiveKit's own track, so that the visitor can
      // change microphone on the line. The cast is for LiveKit's types, whose audio track declares `processor` in a
      // way `exactOptionalPropertyTypes` will not match with a plain track's.
      await call.localParticipant.publishTrack(voice as Parameters<typeof call.localParticipant.publishTrack>[0], { source: kit.Track.Source.Microphone });
      onLine = true;
      if (hungUp.current) {
        await call.disconnect();
        return;
      }
      setPhase((current) => (current === 'connecting' ? 'ringing' : current));
      for (const participant of call.remoteParticipants.values()) follow(participant);
      window.setTimeout(() => {
        if (answered.current || room.current !== call) return;
        unanswered = true;
        void call.disconnect();
      }, RING_MS);
    } catch (error) {
      microphone.current?.stop();
      microphone.current = null;
      setHeard(null);
      const failed = room.current;
      room.current = null;
      void failed?.disconnect();
      setPhase('ready');
      if (error instanceof Stop) setProblem(error.problem);
      else if (error instanceof LiveError) {
        setProblem(FROM_LIVE[error.problem]);
        // The restaurant takes no calls now: its buttons go, rather than fail again.
        if (error.problem === 'calls_unavailable') for (const trigger of document.querySelectorAll<HTMLElement>('[data-call]')) trigger.hidden = true;
      }
      // A LiveKit room that would not open, or a microphone it could not publish: the line, from the visitor's side.
      else if (livekit && error instanceof livekit.LivekitError) setProblem('line');
      else throw error;
    }
  };

  const hangUp = () => {
    hungUp.current = true;
    if (room.current) void room.current.disconnect();
  };

  const close = () => {
    hangUp();
    setOpen(false);
  };

  /** A new restaurant, when this one has taken all its calls or expired: three more calls. */
  const fresh = () => {
    forgetSandbox();
    setCallsLeft(null);
    setProblem(null);
  };

  const explanation: Record<Problem, string> = {
    ...t.call.problems,
    callLimit: t.call.problems.callLimit(offer?.perRestaurant ?? 3),
    expired: t.live.expired,
    offline: t.live.offline,
    verify: t.live.verifyFailed,
    tooMany: t.live.tooMany,
  };
  const state = agent && phase === 'live' ? agent : phase;
  // Nothing before the call: the screen shows the restaurant, and «Appeler» says the rest.
  const said = phase === 'ready' ? '' : t.call.status[phase];
  const status = phase === 'live' || phase === 'ended' ? `${said} · ${minutesAndSeconds(seconds)}` : said;

  return (
    <dialog ref={dialog} class="chat call" aria-label={t.call.title} onClose={close}>
      <div class="call__top">
        <button type="button" class="chat__close" onClick={close}>
          {t.chat.close}
        </button>
      </div>
      {/* The one scrolling part, should the keypad or the captions need the room. */}
      <div class={showCaptions ? 'call__screen call__screen--captions' : 'call__screen'} ref={screen} tabIndex={0}>
        <div class={`call__stage call__stage--${state}`}>
          <RestaurantMark />
          <h2 class="call__name">{DEMO_RESTAURANT.name}</h2>
          <p class="call__place">{place}</p>
        </div>
        {status && (
          <p class={phase === 'live' ? 'call__status call__status--live' : 'call__status'}>
            {phase === 'live' && <span class="chat__dot" aria-hidden="true" />}
            {status}
          </p>
        )}
        {/* Said once per change of the call, not every second of it. */}
        <p class="sr-only" role="status">
          {silent ? t.call.silent(inputs.length > 1) : said}
        </p>
        {phase === 'live' && (
          <div class="call__level" aria-hidden="true">
            <svg class="call__mic" viewBox="0 0 12 16" focusable="false">
              <path d="M6 1.5a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0v-4a2 2 0 0 1 2-2zM2.5 7.5a3.5 3.5 0 0 0 7 0M6 11v3.5M4 14.5h4" />
            </svg>
            <span class="call__meter" ref={meter}>
              <span />
            </span>
          </div>
        )}
        {silent && <p class="call__hint">{typeset(t.call.silent(inputs.length > 1))}</p>}
        {shown && (
          <div class="chat__problem call__problem" role="status">
            <p>{typeset(explanation[shown])}</p>
            {(shown === 'callLimit' || shown === 'expired') && (
              <button type="button" class="chat__secondary" onClick={fresh}>
                {t.live.fresh}
              </button>
            )}
            {unavailable && (
              <>
                <p>{typeset(t.call.written)}</p>
                {/* The site's own «Réserver»: the chat opens on it as on every other, and the call screen gives way. */}
                <a class="chat__primary" href="#reserver" aria-haspopup="dialog" data-book ref={book} onClick={close}>
                  {t.site.book}
                </a>
              </>
            )}
          </div>
        )}
        {inputs.length > 1 && phase !== 'connecting' && phase !== 'ringing' && !unavailable && (
          <label class="call__device">
            {t.call.device}
            <select value={input ?? inputs[0]?.deviceId ?? ''} onChange={(event) => void choose(event.currentTarget.value)}>
              {inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {showCaptions && captions.length > 0 && (
          // A log, as the chat's, not read aloud: the restaurant's own voice is already speaking.
          <div class="call__captions" role="log" aria-live="off" aria-label={t.call.captions}>
            <ol class="chat__lines">
              {turns(captions).map((line) => (
                <li key={line.id} class={`chat__line chat__line--${line.from === 'agent' ? 'agent' : 'guest'}${line.final ? '' : ' call__partial'}`}>
                  {line.from === 'caller' && <span class="sr-only">{`${t.chat.you} `}</span>}
                  {typeset(line.text)}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
      <div class="call__controls">
        <div class="chat__verify">
          {verifying && <p class="chat__label">{t.live.verify}</p>}
          <div ref={verification} />
        </div>
        {muted && (
          <button type="button" class="chat__secondary" onClick={() => void room.current?.startAudio()}>
            {t.call.sound}
          </button>
        )}
        {/* The restaurant's voice says what to type: the keypad needs no words of its own on screen. */}
        {keys && (
          <div class="call__keypad" role="group" aria-label={t.call.keypad.ask} ref={pad} tabIndex={-1}>
            <output class="call__typed" aria-label={t.call.keypad.typed}>
              {typed}
            </output>
            <div class="call__keys">
              {KEYS.map((key) => (
                <button type="button" key={key} class="call__key" onClick={() => press(key)}>
                  {key}
                </button>
              ))}
            </div>
          </div>
        )}
        {phase === 'ended' && booked > 0 && (
          <a class="chat__primary call__panel" href={PANEL[language]}>
            {t.chat.panel}
          </a>
        )}
        {calling ? (
          <button type="button" class="call__hang" ref={action} onClick={hangUp}>
            {t.call.hangUp}
          </button>
        ) : (
          !unavailable && (
            <button
              type="button"
              class={phase === 'ended' && booked > 0 ? 'call__call call__call--quiet' : 'call__call'}
              ref={action}
              autoFocus
              onClick={() => void start()}
              disabled={left === 0}
            >
              {phase === 'ended' ? t.call.again : t.call.call}
            </button>
          )
        )}
        {phase === 'ended' && booked === 0 && (
          <a class="chat__secondary call__panel" href={PANEL[language]}>
            {t.chat.panel}
          </a>
        )}
        {(calling || captions.length > 0) && (
          <button type="button" class="chat__secondary call__switch" aria-pressed={showCaptions} onClick={() => setShowCaptions((on) => !on)}>
            {t.call.captions}
          </button>
        )}
        {phase === 'ready' && !shown && <p class="call__terms">{typeset(t.call.terms(Math.round(maxSeconds / 60)))}</p>}
        {phase === 'ended' && left !== null && left > 0 && <p class="call__terms">{typeset(t.call.left(left))}</p>}
      </div>
      <div ref={sound} hidden />
    </dialog>
  );
}

/** The time and the after-call note are courtesies: a restaurant out of reach shows when the visitor calls. */
function ignoreLive(error: unknown): void {
  if (!(error instanceof LiveError)) throw error;
}
