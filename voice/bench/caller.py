"""A real call to the demo restaurant, made by a program: the end-to-end test of the voice channel.

    uv run python bench/caller.py          # in French; "en" or "es" for the other languages the line speaks
    uv run python bench/caller.py es en    # in Spanish, with the thanks after the goodbye said in English
    python bench/caller.py es en line      # the same thanks, on the restaurant's own line: a deployed agent, nothing booked

It does what a visitor's browser does. It opens a demo restaurant on the local
Worker, asks for the pass to call, and joins the LiveKit room as the caller; the
voice agent must be running (python -m maitre_voice.agent dev). Then it speaks
its lines through a microphone of its own (speech synthesized once with a native
voice unlike the agent's), types the number on the keypad as DTMF tones, and
listens. Each language is a test of its own: calls in Spanish were silent while
the calls in French, the only ones tested, went well. From the caller's side it measures, for every answer, the time from its
last word to the agent's first sound. Once the restaurant has said goodbye, it
says thanks back, as people do: the restaurant must hang up without another word,
and stay in the call's language whatever language the thanks was in. At the end
it checks the restaurant's evening: the booking must be there, with the number
from the keypad.

With "line", the call goes to the restaurant's own line instead, as a call to
its number does: no demo restaurant is opened and nothing is booked. The caller
asks for the opening hours, says goodbye and thanks the restaurant back. That is
how an agent is checked where it is deployed. Run on its server, the caller signs
its own pass with the LiveKit keys of that environment, which it never prints,
and LiveKit sends the call to the agent MAITRE_AGENT_NAME names: none is called
by default. The call stays in the restaurant's log like any other, as one
conversation of two turns. With MAITRE_STAFF_TOKEN set, the caller reads that log
back and checks the language of each turn. MAITRE_BENCH_OUT names the folder for
the recording and the result, where the one beside this file cannot be written.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import secrets
import statistics
import sys
import tempfile
import time
import wave
from pathlib import Path

import aiohttp
import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents.utils import http_context

from maitre_voice.speech import build_tts

API = "http://127.0.0.1:8787"
#: Per language: the caller's lines, said in turn once the agent has finished speaking (None means: type the number),
#: the name the booking must be under, and the caller's voice, native and unlike the agent's. The restaurant lives at the
#: real time: the caller asks for the evening the demo suggests, named as a caller would ("{when}").
CALLS: dict[str, tuple[list[str | None], str, str]] = {
    "fr": (
        [
            "Bonsoir, je voudrais réserver une table pour quatre personnes {when} à vingt et une heures trente.",
            "Au nom de Dupont, et personne n'a d'allergie.",
            None,
            "Merci beaucoup, au revoir.",
        ],
        "dupont",
        "hector",
    ),
    "es": (
        [
            "Buenas noches, quería reservar una mesa para cuatro personas {when} a las nueve y media.",
            "A nombre de Ortega, y nadie tiene alergias.",
            None,
            "Muchas gracias, adiós.",
        ],
        "ortega",
        "nestor",
    ),
    "en": (
        [
            "Good evening, I'd like to book a table for four people {when} at half past nine.",
            "Under the name Clarke, and nobody has any allergies.",
            None,
            "Thank you very much, goodbye.",
        ],
        "clarke",
        "orion",
    ),
}
#: What the caller says back to the restaurant's goodbye. Nobody answers that: the line hangs up.
THANKS = {
    "fr": "Merci, bonne soirée à vous aussi.",
    "es": "Gracias, igualmente, buenas noches.",
    "en": "Okay, thank you, bye bye.",
}
LANGUAGE = sys.argv[1] if len(sys.argv) > 1 else "fr"
#: The language of that thanks: the call's own, or another, which must not move the call into it.
THANKS_IN = sys.argv[2] if len(sys.argv) > 2 else LANGUAGE
SCRIPT, GUEST, CALLER_VOICE = CALLS[LANGUAGE]
#: With "line" as third argument, the call goes to the restaurant's own line and books nothing (see `line_pass`).
ON_THE_LINE = len(sys.argv) > 3 and sys.argv[3] == "line"
#: What that caller says: a question the restaurant answers from its opening hours, then goodbye.
QUESTIONS: dict[str, list[str | None]] = {
    "fr": ["Bonsoir, quels sont vos horaires d'ouverture le samedi ?", "Merci beaucoup, au revoir."],
    "es": ["Buenas noches, ¿qué horario tienen los sábados?", "Muchas gracias, adiós."],
    "en": ["Good evening, what are your opening hours on Saturdays?", "Thank you very much, goodbye."],
}
#: What the environment must name to call the line. The agent has no default: a call to a deployed agent is asked for.
LINE_SETTINGS = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "MAITRE_AGENT_NAME")
WEEKDAYS = {
    "fr": ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    "es": ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
    "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
}


def evening_of(today: str, date: str) -> str:
    """How a caller names the evening of `date`: tonight, tomorrow night, or its weekday within the week."""
    ahead = (dt.date.fromisoformat(date) - dt.date.fromisoformat(today)).days
    weekday = WEEKDAYS[LANGUAGE][dt.date.fromisoformat(date).weekday()]
    if LANGUAGE == "fr":
        return "ce soir" if ahead == 0 else "demain soir" if ahead == 1 else f"{weekday} soir"
    if LANGUAGE == "es":
        return "esta noche" if ahead == 0 else "mañana por la noche" if ahead == 1 else f"el {weekday} por la noche"
    return "tonight" if ahead == 0 else "tomorrow night" if ahead == 1 else f"on {weekday} night"


#: From ARCEP's range for fiction (06 39 98 xx xx): the booking it ends up in shows on the panel.
NUMBER = "0639980042"
DTMF_CODES = {"*": 10, "#": 11}
SAMPLE_RATE = 48_000
FRAME_MS = 20
#: Agent audio louder than this (RMS on 16-bit samples) counts as speech.
SPEECH_RMS = 500.0
#: Once the agent listens again, how long the caller leaves before speaking, as a person does.
LISTENING_GRACE_SECONDS = 0.4
#: Silence that separates two parts of an answer: the waiting line, then the reply.
PART_GAP_SECONDS = 0.6
#: The attribute where the agent says whether it listens, thinks or speaks.
AGENT_STATE = "lk.agent.state"
#: The attribute where the agent says the restaurant needs the caller's number: "open", then "closed".
KEYPAD = "maitre.keypad"
#: Where the call's recording and its result are written: beside this file, or where MAITRE_BENCH_OUT says, for a
#: container that can only read its own files.
OUT = Path(os.environ.get("MAITRE_BENCH_OUT") or Path(__file__).with_name("runs"))
#: The topic on which the agent sends what is said as text, the call page's captions, and the attribute that marks
#: the last hearing of the caller's words.
CAPTIONS = "lk.transcription"
CAPTION_IS_FINAL = "lk.transcription_final"


def ready_to_write() -> None:
    """Makes the folder for the recording and the result before the call: a call whose result cannot be written is lost."""
    try:
        OUT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=OUT):
            pass
    except OSError as error:
        raise SystemExit(f"{OUT} cannot be written ({type(error).__name__}): name another folder in MAITRE_BENCH_OUT") from error


def caller_voice(voice: str, language: str) -> str:
    """Deepgram's own Aura-2 voice with Deepgram's key, else the same voice through LiveKit Inference."""
    return f"deepgram:aura-2-{voice}-{language}" if os.environ.get("DEEPGRAM_API_KEY") else f"inference:deepgram/aura-2:{voice}"


async def synthesize_lines(lines: list[str], language: str = LANGUAGE, voice: str = CALLER_VOICE) -> list[np.ndarray]:
    """The caller's lines as 48 kHz mono 16-bit samples, said by a voice native to their language."""
    engine = build_tts(caller_voice(voice, language), language)
    clips = []
    async with http_context.open():
        for line in lines:
            frames = [audio.frame async for audio in engine.synthesize(line)]
            samples = np.concatenate([np.frombuffer(bytes(frame.data), dtype=np.int16) for frame in frames])
            rate = frames[0].sample_rate
            if rate != SAMPLE_RATE:
                positions = np.linspace(0, len(samples) - 1, int(len(samples) * SAMPLE_RATE / rate))
                samples = np.interp(positions, np.arange(len(samples)), samples).astype(np.int16)
            clips.append(samples)
        await engine.aclose()
    return clips


class Ear:
    """Listens to the agent's audio, keeps when it made a sound, and follows what it says it is doing."""

    def __init__(self) -> None:
        self.last_sound = 0.0
        self.first_sound_after: dict[float, float] = {}
        self._waiting: list[float] = []
        self.recording: list[np.ndarray] = []
        #: When each part of the agent's speech started: parts are apart by a silence.
        self.parts: list[float] = []
        self.agent_state = "initializing"
        self.state_since = time.monotonic()
        #: Every change of the agent's state, with when the caller learnt of it.
        self.states: list[tuple[float, str]] = []

    def agent_is(self, state: str) -> None:
        if state != self.agent_state:
            self.agent_state = state
            self.state_since = time.monotonic()
            self.states.append((self.state_since, state))

    async def listen(self, track: rtc.Track) -> None:
        async for event in rtc.AudioStream.from_track(track=track, sample_rate=SAMPLE_RATE, num_channels=1):
            samples = np.frombuffer(bytes(event.frame.data), dtype=np.int16)
            self.recording.append(samples)
            if np.sqrt(np.mean(samples.astype(np.float64) ** 2)) > SPEECH_RMS:
                now = time.monotonic()
                if now - self.last_sound > PART_GAP_SECONDS:
                    self.parts.append(now)
                self.last_sound = now
                for since in self._waiting:
                    self.first_sound_after.setdefault(since, now)
                self._waiting.clear()

    def expect_answer(self, since: float) -> None:
        self._waiting.append(since)

    async def answer(self, since: float, limit: float = 30.0) -> float | None:
        """Waits for the agent to start answering after `since`, then to listen again.

        A person who hears "Je regarde." waits for the reply: the silence after it is not the end of the answer.
        """
        started = time.monotonic()
        while since not in self.first_sound_after:
            if time.monotonic() - started >= limit:
                return None
            await asyncio.sleep(0.05)
        # The state and the silence are read off the clock, not signalled: polling is the point here.
        while time.monotonic() - started < limit and not self._listening_again():  # noqa: ASYNC110
            await asyncio.sleep(0.05)
        return self.first_sound_after[since]

    def _listening_again(self) -> bool:
        quiet_since = max(self.state_since, self.last_sound)
        return self.agent_state == "listening" and time.monotonic() - quiet_since >= LISTENING_GRACE_SECONDS

    def parts_after(self, since: float, until: float) -> list[float]:
        """When each part of the answer started, in seconds after `since`."""
        return [round(start - since, 2) for start in self.parts if since <= start < until]

    def states_after(self, since: float, until: float) -> list[str]:
        """The agent's states in the answer, each with the seconds after `since` it began."""
        return [f"{state}@{at - since:.2f}" for at, state in self.states if since <= at < until]


def trailing_silence(samples: np.ndarray) -> float:
    """Seconds of silence at the end of a clip: synthesized speech ends with some, after the last word."""
    per_frame = SAMPLE_RATE * FRAME_MS // 1000
    end = len(samples)
    while end > 0 and np.sqrt(np.mean(samples[max(0, end - per_frame) : end].astype(np.float64) ** 2)) <= SPEECH_RMS:
        end -= per_frame
    return (len(samples) - max(end, 0)) / SAMPLE_RATE


async def speak(source: rtc.AudioSource, samples: np.ndarray) -> float:
    """Plays a clip into the room in real time. Returns when the last word left the microphone, silence after it aside."""
    per_frame = SAMPLE_RATE * FRAME_MS // 1000
    for start in range(0, len(samples), per_frame):
        chunk = samples[start : start + per_frame]
        if len(chunk) < per_frame:
            chunk = np.pad(chunk, (0, per_frame - len(chunk)))
        frame = rtc.AudioFrame(chunk.tobytes(), SAMPLE_RATE, 1, per_frame)
        await source.capture_frame(frame)
    await source.wait_for_playout()
    return time.monotonic() - trailing_silence(samples)


def line_pass() -> dict[str, str]:
    """A pass to call the restaurant's own line, signed here as the Worker signs a visitor's.

    LiveKit sends the agent the environment names to the room and tells it the caller's language, nothing else:
    with no demo restaurant in the pass, the agent takes the call for the restaurant itself.
    """
    session = secrets.token_urlsafe(9)
    agent = api.RoomAgentDispatch(agent_name=os.environ["MAITRE_AGENT_NAME"], metadata=json.dumps({"language": LANGUAGE}))
    token = (
        # The key and the secret are read from LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
        api.AccessToken()
        .with_identity(f"bench-{session}")
        .with_ttl(dt.timedelta(minutes=10))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=f"bench-{session}",
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
                can_publish_sources=["microphone"],
            )
        )
        .with_room_config(api.RoomConfiguration(agents=[agent]))
        .to_jwt()
    )
    return {"url": os.environ["LIVEKIT_URL"], "token": token}


async def line_log(http: aiohttp.ClientSession, job: str) -> tuple[dict, list[dict]] | None:
    """The call and its turns as the restaurant logged them, read with the staff's token, or None when they cannot be.

    The agent names a call to the restaurant's line after its LiveKit job, the one it is in the room as: "agent-<job>".
    """
    restaurant = f"{os.environ.get('MAITRE_API_URL', API).rstrip('/')}/v1/restaurants/{os.environ.get('MAITRE_RESTAURANT_ID', 'demo')}"
    headers = {"authorization": f"Bearer {os.environ['MAITRE_STAFF_TOKEN']}"}
    timeout = aiohttp.ClientTimeout(total=10)
    try:
        async with http.get(f"{restaurant}/calls?limit=20", headers=headers, timeout=timeout) as response:
            if response.status != 200:
                print(f"The restaurant's log was not read: it answered {response.status}.")
                return None
            calls = await response.json()
        call = next((call for call in calls if call.get("sessionId") == f"call_{job}"), None)
        if call is None:
            print("The restaurant's log was read, and this call is not in it.")
            return None
        async with http.get(f"{restaurant}/conversations?limit=50", headers=headers, timeout=timeout) as response:
            turns = await response.json() if response.status == 200 else []
    except (aiohttp.ClientError, TimeoutError) as error:
        print(f"The restaurant's log was not read: {type(error).__name__}.")
        return None
    return call, [turn for turn in reversed(turns) if turn.get("sessionId") == call["sessionId"]]


def keep_awake() -> None:
    """Asks Windows not to go to standby while the call runs, until this program ends.

    A laptop that went to standby mid-call froze the agent, the Worker and this caller for three minutes,
    and the measurements with them.
    """
    if sys.platform == "win32":
        import ctypes

        es_continuous, es_system_required, es_display_required = 0x80000000, 0x00000001, 0x00000002
        ctypes.windll.kernel32.SetThreadExecutionState(es_continuous | es_system_required | es_display_required)


async def main() -> None:
    keep_awake()
    load_dotenv(".env.local")
    # Only a call to the demo has an evening to book and a restaurant of the visitor's own.
    evening = sandbox = ""
    if ON_THE_LINE:
        missing = [name for name in LINE_SETTINGS if not os.environ.get(name)]
        if missing:
            raise SystemExit(f"to call the restaurant's line, the environment must set {', '.join(missing)}")
        script = QUESTIONS[LANGUAGE]
        print(f"A call to the restaurant's own line, for the agent {os.environ['MAITRE_AGENT_NAME']} to take: nothing is booked.")
    else:
        # The evening a guest could still book now, as the demo suggests it: the caller asks for that one.
        async with aiohttp.ClientSession() as http, http.get(f"{API}/v1/demo") as response:
            demo = await response.json()
        evening = str(demo["suggestion"]["date"])
        script = [line.format(when=evening_of(str(demo["today"]), evening)) if line else None for line in SCRIPT]
        print(f"The restaurant's today is {demo['today']}; the caller asks for {evening}.")
    lines = [line for line in script if line]
    print("Synthesizing the caller's lines…")
    synthesized = await synthesize_lines(lines)
    print("  silence after the last word of each line:", [f"{trailing_silence(clip):.2f} s" for clip in synthesized])
    clips = iter(synthesized)
    thanks = (await synthesize_lines([THANKS[THANKS_IN]], THANKS_IN, CALLS[THANKS_IN][2]))[0]

    async with aiohttp.ClientSession() as http:
        if ON_THE_LINE:
            call_pass = line_pass()
        else:
            async with http.post(f"{API}/v1/demo/sandboxes", json={"turnstile": "local-test-token"}) as response:
                sandbox = (await response.json())["sandbox"]
            async with http.post(f"{API}/v1/demo/sandboxes/{sandbox}/calls", json={"language": LANGUAGE}) as response:
                call_pass = await response.json()
                if response.status != 201:
                    raise SystemExit(f"no pass to call: {call_pass}")

        room = rtc.Room()
        ear = Ear()
        listening: list[asyncio.Task[None]] = []
        # What is said, as the agent's captions give it: its own words, and the caller's as recognition heard them.
        # Each with when it began and who said it.
        captions: list[tuple[float, str, str]] = []

        def _on_caption(reader: rtc.TextStreamReader, speaker: str) -> None:
            began = time.monotonic()

            async def read() -> None:
                text = ""
                try:
                    async for chunk in reader:
                        text += chunk
                except rtc.StreamError:
                    # The line hung up in the middle of a sentence: what came of it is kept.
                    pass
                by_caller = speaker == room.local_participant.identity
                # The caller's words come once for each hearing of them: the last one, marked final, is the one kept.
                if text.strip() and (not by_caller or (reader.info.attributes or {}).get(CAPTION_IS_FINAL) == "true"):
                    captions.append((began, "caller" if by_caller else "restaurant", text.strip()))

            listening.append(asyncio.ensure_future(read()))

        room.register_text_stream_handler(CAPTIONS, _on_caption)

        @room.on("track_subscribed")
        def _on_track(track: rtc.Track, publication: rtc.RemoteTrackPublication, *_args: object) -> None:
            # The typing heard while the agent thinks is not an answer: only its voice is timed.
            if track.kind == rtc.TrackKind.KIND_AUDIO and publication.name != "background_audio":
                listening.append(asyncio.ensure_future(ear.listen(track)))

        keypad: list[str] = []
        hung_up = asyncio.Event()

        @room.on("disconnected")
        def _on_disconnected(*_args: object) -> None:
            hung_up.set()

        @room.on("participant_attributes_changed")
        def _on_attributes(changed: dict[str, str], _participant: rtc.Participant) -> None:
            if AGENT_STATE in changed:
                ear.agent_is(changed[AGENT_STATE])
            # The browser's call page opens its keypad on this: the restaurant needs the number.
            if KEYPAD in changed:
                keypad.append(changed[KEYPAD])

        await room.connect(call_pass["url"], call_pass["token"])
        for participant in room.remote_participants.values():
            if AGENT_STATE in participant.attributes:
                ear.agent_is(participant.attributes[AGENT_STATE])
        source = rtc.AudioSource(SAMPLE_RATE, 1)
        track = rtc.LocalAudioTrack.create_audio_track("caller", source)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        print("Connected; waiting for the greeting…")
        rang = time.monotonic()
        ear.expect_answer(rang)
        greeting_after = await ear.answer(rang, limit=40)
        print(f"  greeting started {greeting_after - rang:.2f} s after joining" if greeting_after else "  no greeting heard")
        if greeting_after is None:
            # Nobody took the call: saying the lines to an empty room would only cost their minutes.
            await room.disconnect()
            await source.aclose()
            for task in listening:
                task.cancel()
            raise SystemExit("FAIL: no agent answered the call")
        # The agent is in the room as "agent-<its LiveKit job>": the restaurant's log names the line's calls after that job.
        agent_job = next((identity.removeprefix("agent-") for identity in room.remote_participants), "")

        waits = []
        turns = []
        for step in script:
            if step is None:
                for digit in f"{NUMBER}#":
                    await room.local_participant.publish_dtmf(code=DTMF_CODES.get(digit, int(digit) if digit.isdigit() else 0), digit=digit)
                    await asyncio.sleep(0.25)
                said = time.monotonic()
                label = f"typed {NUMBER}#"
            else:
                said = await speak(source, next(clips))
                label = step
            # The same moment on the wall clock, to set against the agent's own log.
            said_at = time.time() - (time.monotonic() - said)
            ear.expect_answer(said)
            answered = await ear.answer(said)
            wait = (answered - said) if answered else None
            if wait is not None and step is not None:
                waits.append(wait)
            parts = ear.parts_after(said, time.monotonic())
            states = ear.states_after(said, time.monotonic())
            turns.append(
                {
                    "caller": label,
                    "firstSoundSeconds": round(wait, 2) if wait is not None else None,
                    "partsStartSeconds": parts,
                    "agentStates": states,
                }
            )
            print(
                f"  caller: {label} (last word at {time.strftime('%H:%M:%S', time.localtime(said_at))}.{int(said_at % 1 * 1000):03d})\n"
                f"    agent started {wait:.2f} s later; its parts started at {parts} s; states {states}"
                if wait is not None
                else f"  caller: {label}\n    no answer heard"
            )

        # The caller's last line is a goodbye: the restaurant answers it and hangs up, as a restaurant does. The caller
        # says thanks back first, in the pause the line leaves: that is no turn, and the restaurant says nothing more.
        thanked: float | None = None
        if not hung_up.is_set():
            try:
                thanked = await speak(source, thanks)
                print(f"  caller, back to the goodbye, in {THANKS_IN}: {THANKS[THANKS_IN]}")
            except Exception as error:
                # The line may hang up while the caller is still speaking: the room is gone, and the microphone with it.
                print(f"  the caller's thanks was cut: {type(error).__name__}")
        last_word = said if thanked is None else thanked
        try:
            await asyncio.wait_for(hung_up.wait(), timeout=20)
            hung_up_after: float | None = time.monotonic() - last_word
            print(f"  the restaurant hung up {hung_up_after:.1f} s after the caller's last word")
        except TimeoutError:
            hung_up_after = None
            print("  the restaurant did not hang up after the goodbye")
        # What the restaurant said once it had been thanked: nothing, when the thanks is taken for what it is.
        spoke_again = [] if thanked is None else ear.parts_after(thanked, time.monotonic())
        if thanked is None:
            print("  the thanks was not said: the line had hung up")
        else:
            print(
                f"  the restaurant spoke again after the thanks, at {spoke_again} s"
                if spoke_again
                else "  the restaurant said nothing after the thanks"
            )
        # Released by hand, whoever hung up: left to the garbage collector, LiveKit's handles fail their checks at exit.
        await room.disconnect()
        await source.aclose()
        for task in listening:
            task.cancel()

        stamp = time.strftime("%Y%m%d-%H%M%S")
        if ear.recording:
            with wave.open(str(OUT / f"call-{stamp}.wav"), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(SAMPLE_RATE)
                out.writeframes(np.concatenate(ear.recording).tobytes())

        await asyncio.sleep(3)  # the agent logs the call's end
        caller_side = {
            "callerSideWaitsSeconds": [round(wait, 2) for wait in waits],
            "turns": turns,
            "captions": [{"from": who, "text": text, "atSeconds": round(began - rang, 1)} for began, who, text in sorted(captions)],
            "thanksAfterTheGoodbye": {
                "said": THANKS[THANKS_IN] if thanked is not None else None,
                "language": THANKS_IN,
                "restaurantSpokeAgainAtSeconds": spoke_again,
            },
            "restaurantHungUpAfterSeconds": round(hung_up_after, 2) if hung_up_after is not None else None,
        }
        if ON_THE_LINE:
            # Every line was answered, the restaurant ended the call after the goodbye, and the thanks got no answer.
            ended_well = len(waits) == len(lines) and hung_up_after is not None and thanked is not None and not spoke_again
            logged = await line_log(http, agent_job) if os.environ.get("MAITRE_STAFF_TOKEN") else None
            return report_line_call(stamp, {"greetingAfterSeconds": round(greeting_after - rang, 2), **caller_side}, ended_well, logged)
        async with http.get(f"{API}/v1/demo/sandboxes/{sandbox}/day?date={evening}&language=fr") as response:
            day = await response.json()
        async with http.get(f"{API}/v1/demo/sandboxes/{sandbox}/calls") as response:
            calls = await response.json()
        async with http.get(f"{API}/v1/demo/sandboxes/{sandbox}/conversations?limit=20") as response:
            heard_by_the_restaurant = list(reversed(await response.json()))

    # The evening already has voice bookings of its own: this call's is the one with the number typed on the keypad.
    # Not the one under the name: speech recognition may write a name as it sounds ("Clark" for Clarke).
    booked = [b for b in day["bookings"] if "".join(char for char in str(b.get("phone", "")) if char.isdigit()).endswith(NUMBER[1:])]
    result = {
        "booking": booked[0] if booked else None,
        **caller_side,
        "callLog": calls,
        "restaurantTurns": heard_by_the_restaurant,
        "keypadAttribute": keypad,
    }
    (OUT / f"call-{stamp}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\nBooking:", json.dumps(result["booking"], ensure_ascii=False) if booked else "NONE")
    if waits:
        print(f"Caller-side wait: median {statistics.median(waits):.2f} s, longest {max(waits):.2f} s")
    print(f"Call log: {json.dumps(calls, ensure_ascii=False)}")
    print("What the restaurant heard and answered:")
    for turn in heard_by_the_restaurant:
        flags = " ".join(name for name in ("unheardBefore", "phoneEntered", "fellBack") if turn.get(name))
        heard = turn.get("guest") or "(keypad)"
        print(f"  [{turn.get('language')}] {heard!r} -> {turn.get('working', '')} {str(turn.get('reply', ''))[:90]!r} {flags}")
    # The keypad opened when the number was asked for, and closed once it was typed.
    print(f"Keypad attribute: {keypad or 'never set'}")
    ok = (
        bool(booked)
        and booked[0].get("phoneSource") == "keypad"
        and booked[0].get("partySize") == 4
        and booked[0].get("time") == "21:30"
        and keypad[:1] == ["open"]
        and keypad[-1:] == ["closed"]
        # The restaurant, not the caller, ended the call after the goodbye.
        and hung_up_after is not None
        and any(call.get("endedBy") == "goodbye" for call in calls)
        # The thanks said back to the goodbye got no answer, and the call stayed in its language to the end.
        and thanked is not None
        and not spoke_again
        and all(turn.get("language") == LANGUAGE for turn in heard_by_the_restaurant)
    )
    if booked and GUEST not in str(booked[0].get("guestName", "")).lower():
        print(f"Name heard as {booked[0].get('guestName')!r}, said as {GUEST.title()!r}: a recognition note, not a failure")
    print("PASS" if ok else "FAIL")
    raise SystemExit(0 if ok else 1)


def report_line_call(stamp: str, caller_side: dict, ended_well: bool, logged: tuple[dict, list[dict]] | None) -> None:
    """Writes and prints what the call to the restaurant's own line showed, and passes or fails it."""
    call, restaurant_turns = logged or (None, [])
    result = {
        "line": {"language": LANGUAGE, "agent": os.environ["MAITRE_AGENT_NAME"]},
        **caller_side,
        "callLog": call,
        "restaurantTurns": restaurant_turns,
    }
    (OUT / f"call-{stamp}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    # Printed whole as well: on a server the file goes with the container that wrote it.
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print("\nWhat was said, as the line's captions gave it:")
    for caption in caller_side["captions"]:
        print(f"  {caption['atSeconds']:>6} s  {caption['from']}: {caption['text']}")
    if call is None:
        print("The restaurant's own log is not part of this result: the languages are the ones heard above.")
    else:
        print(f"The restaurant's log says the call ended by {call.get('endedBy')!r} after {call.get('seconds')} s, with these turns:")
        for turn in restaurant_turns:
            print(f"  [{turn.get('language')}] {turn.get('guest')!r} -> {turn.get('working', '')} {str(turn.get('reply', ''))[:90]!r}")
    # By the restaurant's own log, when it was read, the call stayed in its language and ended on the goodbye.
    logged_well = call is None or (
        bool(restaurant_turns) and all(turn.get("language") == LANGUAGE for turn in restaurant_turns) and call.get("endedBy") == "goodbye"
    )
    ok = ended_well and logged_well
    print("PASS" if ok else "FAIL")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    ready_to_write()
    asyncio.run(main())
