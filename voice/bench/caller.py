"""A real call to the demo restaurant, made by a program: the end-to-end test of the voice channel.

    uv run python bench/caller.py

It does what a visitor's browser does. It opens a demo restaurant on the local
Worker, asks for the pass to call, and joins the LiveKit room as the caller; the
voice agent must be running (python -m maitre_voice.agent dev). Then it speaks
French lines through a microphone of its own (speech synthesized once with a
voice unlike the agent's), types the number on the keypad as DTMF tones, and
listens. From the caller's side it measures, for every answer, the time from its
last word to the agent's first sound. At the end it checks the restaurant's
evening: the booking must be there, with the number from the keypad.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time
import wave
from pathlib import Path

import aiohttp
import numpy as np
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents.utils import http_context

from maitre_voice.speech import build_tts

API = "http://127.0.0.1:8787"
EVENING = "2026-10-16"
#: The caller's lines, said in turn once the agent has finished speaking. None means: type the number.
SCRIPT: list[str | None] = [
    "Bonsoir, je voudrais réserver une table pour quatre personnes ce soir à vingt et une heures trente.",
    "Au nom de Dupont, et personne n'a d'allergie.",
    None,
    "Merci beaucoup, au revoir.",
]
NUMBER = "0612345678"
DTMF_CODES = {"*": 10, "#": 11}
#: The caller's voice: a synthesized voice that is not the agent's, so the recognition is tested on someone else.
CALLER_VOICE = "inference:deepgram/aura-2:hector"
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
OUT = Path(__file__).with_name("runs")


async def synthesize_lines(lines: list[str]) -> list[np.ndarray]:
    """The caller's lines as 48 kHz mono 16-bit samples."""
    engine = build_tts(CALLER_VOICE, "fr")
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
    lines = [line for line in SCRIPT if line]
    print("Synthesizing the caller's lines…")
    synthesized = await synthesize_lines(lines)
    print("  silence after the last word of each line:", [f"{trailing_silence(clip):.2f} s" for clip in synthesized])
    clips = iter(synthesized)

    async with aiohttp.ClientSession() as http:
        async with http.post(f"{API}/v1/demo/sandboxes", json={"turnstile": "local-test-token"}) as response:
            sandbox = (await response.json())["sandbox"]
        async with http.post(f"{API}/v1/demo/sandboxes/{sandbox}/calls", json={"language": "fr"}) as response:
            call_pass = await response.json()
            if response.status != 201:
                raise SystemExit(f"no pass to call: {call_pass}")

        room = rtc.Room()
        ear = Ear()
        listening: list[asyncio.Task[None]] = []

        @room.on("track_subscribed")
        def _on_track(track: rtc.Track, publication: rtc.RemoteTrackPublication, *_args: object) -> None:
            # The typing heard while the agent thinks is not an answer: only its voice is timed.
            if track.kind == rtc.TrackKind.KIND_AUDIO and publication.name != "background_audio":
                listening.append(asyncio.ensure_future(ear.listen(track)))

        @room.on("participant_attributes_changed")
        def _on_attributes(changed: dict[str, str], _participant: rtc.Participant) -> None:
            if AGENT_STATE in changed:
                ear.agent_is(changed[AGENT_STATE])

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

        waits = []
        turns = []
        for step in SCRIPT:
            if step is None:
                for digit in f"{NUMBER}#":
                    await room.local_participant.publish_dtmf(code=DTMF_CODES.get(digit, int(digit) if digit.isdigit() else 0), digit=digit)
                    await asyncio.sleep(0.25)
                said = time.monotonic()
                label = f"typed {NUMBER}#"
            else:
                said = await speak(source, next(clips))
                label = step
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
                f"  caller: {label}\n    agent started {wait:.2f} s later; its parts started at {parts} s; states {states}"
                if wait is not None
                else f"  caller: {label}\n    no answer heard"
            )

        await asyncio.sleep(2)
        await room.disconnect()
        for task in listening:
            task.cancel()

        OUT.mkdir(exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        if ear.recording:
            with wave.open(str(OUT / f"call-{stamp}.wav"), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(SAMPLE_RATE)
                out.writeframes(np.concatenate(ear.recording).tobytes())

        await asyncio.sleep(3)  # the agent logs the call's end
        async with http.get(f"{API}/v1/demo/sandboxes/{sandbox}/day?date={EVENING}&language=fr") as response:
            day = await response.json()
        async with http.get(f"{API}/v1/demo/sandboxes/{sandbox}/calls") as response:
            calls = await response.json()

    # The evening already has voice bookings of its own: this call's is the one under its name.
    booked = [b for b in day["bookings"] if b.get("channel") == "voice" and "dupont" in str(b.get("guestName", "")).lower()]
    result = {
        "booking": booked[0] if booked else None,
        "callerSideWaitsSeconds": [round(wait, 2) for wait in waits],
        "turns": turns,
        "callLog": calls,
    }
    (OUT / f"call-{stamp}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\nBooking:", json.dumps(result["booking"], ensure_ascii=False) if booked else "NONE")
    if waits:
        print(f"Caller-side wait: median {statistics.median(waits):.2f} s, longest {max(waits):.2f} s")
    print(f"Call log: {json.dumps(calls, ensure_ascii=False)}")
    ok = bool(booked) and booked[0].get("phoneSource") == "keypad" and booked[0].get("partySize") == 4
    print("PASS" if ok else "FAIL")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
