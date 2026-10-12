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
CALLER_VOICE = "inference:cartesia/sonic-3"
SAMPLE_RATE = 48_000
FRAME_MS = 20
#: Agent audio louder than this (RMS on 16-bit samples) counts as speech.
SPEECH_RMS = 500.0
#: How long the agent must stay quiet before the caller speaks again.
AGENT_DONE_SECONDS = 1.2
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
    """Listens to the agent's audio and keeps when it last made a sound."""

    def __init__(self) -> None:
        self.last_sound = 0.0
        self.first_sound_after: dict[float, float] = {}
        self._waiting: list[float] = []
        self.recording: list[np.ndarray] = []

    async def listen(self, track: rtc.Track) -> None:
        async for event in rtc.AudioStream.from_track(track=track, sample_rate=SAMPLE_RATE, num_channels=1):
            samples = np.frombuffer(bytes(event.frame.data), dtype=np.int16)
            self.recording.append(samples)
            if np.sqrt(np.mean(samples.astype(np.float64) ** 2)) > SPEECH_RMS:
                now = time.monotonic()
                self.last_sound = now
                for since in self._waiting:
                    self.first_sound_after.setdefault(since, now)
                self._waiting.clear()

    def expect_answer(self, since: float) -> None:
        self._waiting.append(since)

    async def until_quiet(self, limit: float = 30.0) -> None:
        """Waits for the agent to speak and then go quiet."""
        started = time.monotonic()
        while time.monotonic() - started < limit:
            if self.last_sound and time.monotonic() - self.last_sound >= AGENT_DONE_SECONDS:
                return
            await asyncio.sleep(0.05)


async def speak(source: rtc.AudioSource, samples: np.ndarray) -> float:
    """Plays a clip into the room in real time. Returns when the last word left the microphone."""
    per_frame = SAMPLE_RATE * FRAME_MS // 1000
    for start in range(0, len(samples), per_frame):
        chunk = samples[start : start + per_frame]
        if len(chunk) < per_frame:
            chunk = np.pad(chunk, (0, per_frame - len(chunk)))
        frame = rtc.AudioFrame(chunk.tobytes(), SAMPLE_RATE, 1, per_frame)
        await source.capture_frame(frame)
    await source.wait_for_playout()
    return time.monotonic()


async def main() -> None:
    load_dotenv(".env.local")
    lines = [line for line in SCRIPT if line]
    print("Synthesizing the caller's lines…")
    clips = iter(await synthesize_lines(lines))

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

        await room.connect(call_pass["url"], call_pass["token"])
        source = rtc.AudioSource(SAMPLE_RATE, 1)
        track = rtc.LocalAudioTrack.create_audio_track("caller", source)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        print("Connected; waiting for the greeting…")
        rang = time.monotonic()
        ear.expect_answer(rang)
        await ear.until_quiet(limit=40)
        greeting_after = ear.first_sound_after.get(rang)
        print(f"  greeting started {greeting_after - rang:.2f} s after joining" if greeting_after else "  no greeting heard")

        waits = []
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
            await ear.until_quiet()
            answered = ear.first_sound_after.get(said)
            wait = (answered - said) if answered else None
            if wait is not None and step is not None:
                waits.append(wait)
            print(
                f"  caller: {label}\n    agent started {wait:.2f} s later"
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

    booked = [b for b in day["bookings"] if b.get("channel") == "voice"]
    result = {
        "booking": booked[0] if booked else None,
        "callerSideWaitsSeconds": [round(wait, 2) for wait in waits],
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
