"""Maître's voice agent: answers the restaurant's phone with the same assistant as the web chat.

LiveKit sends it a call: from the public demo, where a visitor calls their own
restaurant from the browser, or on the restaurant's own number. It hears the
caller, speaks the restaurant's answers, takes the number from the keypad, and
hangs up when the caller has gone quiet, when the call reaches its longest, or
when the demo's budget says so.

    uv run python -m maitre_voice.agent dev     # on a developer's machine
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass

import numpy as np
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    APIConnectOptions,
    JobContext,
    JobProcess,
    ModelSettings,
    cli,
    inference,
    llm,
    room_io,
    tts,
    utils,
)
from livekit.agents.voice.background_audio import AudioConfig, BackgroundAudioPlayer, BuiltinAudioClip
from livekit.agents.voice.events import CloseEvent, ConversationItemAddedEvent, UserInputTranscribedEvent, UserStateChangedEvent
from livekit.plugins import noise_cancellation, silero

from .brain import TURN, UNREACHABLE, CallState, RestaurantBrain, Spoken
from .config import LANGUAGES, Settings
from .keypad import Keypad
from .line import Answer, Call, EndedBy, Line, LineError, Started, Working, new_turn_id
from .speech import build_stt, build_tts, ends_turns_itself, follow_language

load_dotenv(".env.local")
logger = logging.getLogger("maitre.voice")
settings = Settings.from_env()
server = AgentServer()

#: Seconds without a key before a number typed without the hash key is sent anyway.
KEYPAD_PAUSE_SECONDS = 4.0
#: Words a transcript needs before the conversation follows it into another language: "OK" is not a switch.
WORDS_TO_SWITCH = 3
#: Seconds after the caller's last word before the turn is theirs no more, when the turn detector hears that they have
#: finished; on top of what Flux decides, when it decides.
ENDPOINTING_SECONDS = 0.25
#: The longest silence the line waits for more words when the detector hears an unfinished sentence. LiveKit's 2.5 s
#: left a caller 4.5 s without an answer after "Au nom de Dupont, et personne n'a d'allergie."; a caller who goes on
#: after a longer pause is heard as one message all the same, by the restaurant's handling of a reply nobody heard.
LONGEST_TURN_WAIT_SECONDS = 1.5
#: Below this peak (16-bit samples, about -44 dBFS) a frame of synthesized speech is silence.
SILENT_PEAK = 200


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@dataclass(frozen=True)
class Dispatch:
    """What the call is: a visitor's demo restaurant, from the pass the Worker signed, or the restaurant's own line."""

    call: Call
    language: str

    @classmethod
    def from_job(cls, metadata: str, job_id: str, settings: Settings) -> Dispatch:
        details: dict[str, str] = {}
        if metadata:
            try:
                parsed = json.loads(metadata)
                details = parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                details = {}
        language = details.get("language") if details.get("language") in LANGUAGES else "fr"
        if details.get("sandbox") and details.get("sessionId"):
            return cls(Call.demo_sandbox(settings.api_url, str(details["sandbox"]), str(details["sessionId"])), language)
        # A call to the restaurant's number: the job's id names the conversation.
        session_id = "call_" + "".join(char if char.isalnum() or char in "-_" else "_" for char in job_id)[:59]
        return cls(Call.restaurant(settings.api_url, settings.restaurant_id, session_id), language)


class RestaurantLine(Agent):
    """The agent of the call: the restaurant's line answers every turn, through the brain."""

    def __init__(self, state: CallState, engine: tts.TTS) -> None:
        super().__init__(instructions="The restaurant's line answers every turn.")
        self._state = state
        self._engine = engine

    async def tts_node(self, text: AsyncIterable[str], model_settings: ModelSettings) -> AsyncIterable[rtc.AudioFrame]:
        """As the framework's own, except that the short line said while the tools run is spoken at once.

        Speech synthesis gathers text into sentences and holds the last one back until the next one starts:
        "Je regarde." was spoken with the reply, seconds later, which defeated its purpose. The line now ends
        a synthesis of its own, and the reply opens the next one when it comes. Flushing a single synthesis
        instead would leave its connection waiting on the restaurant, and it gives up after ten seconds.
        """
        if not self._engine.capabilities.streaming:
            async for frame in Agent.default.tts_node(self, text, model_settings):
                yield frame
            return
        async for frame in self._speak(text, self.session.conn_options.tts_conn_options):
            yield frame

    async def _speak(self, text: AsyncIterable[str], conn_options: APIConnectOptions) -> AsyncIterator[rtc.AudioFrame]:
        """The reply's audio, one synthesis per part: a waiting line ends one."""
        source = aiter(text)
        more = True
        while more and (first := await _next_words(source)) is not None:
            async with self._engine.stream(conn_options=conn_options) as stream:
                forward = asyncio.create_task(self._forward_part(first, source, stream))
                try:
                    async for frame in _audible(stream):
                        yield frame
                    more = await forward
                finally:
                    await utils.aio.cancel_and_wait(forward)

    async def _forward_part(self, first: str, source: AsyncIterator[str], stream: tts.SynthesizeStream) -> bool:
        """Hands the synthesis the text up to the end of a waiting line, or to the end. Whether more may follow."""
        said = ""
        chunk: str | None = first
        while chunk is not None:
            stream.push_text(chunk)
            said += chunk
            # The text arrives cut where the markdown filter cut it: the line is looked for at the end of all of it.
            if said.rstrip().endswith(tuple(self._state.working_lines)):
                stream.end_input()
                return True
            chunk = await anext(source, None)
        stream.end_input()
        return False


async def _audible(stream: AsyncIterable[tts.SynthesizedAudio]) -> AsyncIterator[rtc.AudioFrame]:
    """The frames of one synthesis, from its first sound on: some voices open short sentences with silence.

    Aura-2 put 0.9 s of it before "Je regarde." and 1.2 s before "Je m’en occupe.": the line meant to be heard
    at once was heard a second late. Silences inside the speech are kept.
    """
    heard = False
    async for event in stream:
        if not heard:
            samples = np.frombuffer(event.frame.data, dtype=np.int16)
            if samples.size == 0 or int(np.abs(samples).max()) < SILENT_PEAK:
                continue
            heard = True
        yield event.frame


async def _next_words(source: AsyncIterator[str]) -> str | None:
    """The next piece of text with something to say, or None once the text is over."""
    async for chunk in source:
        if chunk.strip():
            return chunk
    return None


class PhoneCall:
    """One call, from the greeting to the hang-up."""

    def __init__(self, ctx: JobContext, line: Line, started: Started, vad: silero.VAD) -> None:
        self._ctx = ctx
        self._line = line
        self._began = time.monotonic()
        self._ending = False
        self._keypad = Keypad()
        self._keypad_timer: asyncio.TimerHandle | None = None
        self._keypad_shown = "closed"
        self._tasks: set[asyncio.Task[None]] = set()
        self._state = CallState(line=line, language=started.language, on_answer=self._on_answer, on_refusal=self._on_refusal)
        self._tts = build_tts(settings.tts, started.language)
        self.session: AgentSession = AgentSession(
            stt=build_stt(settings.stt, started.language, settings.end_of_turn),
            tts=self._tts,
            vad=vad,
            llm=RestaurantBrain(self._state),
            turn_handling={
                # Flux decides the end of a turn itself; with any other recognition, LiveKit's detector hears it in the voice.
                "turn_detection": "stt" if ends_turns_itself(settings.stt) else inference.TurnDetector(version="v1"),
                # Never on a phrase the caller has not finished: every turn reaches the restaurant, which may set a table aside.
                "preemptive_generation": {"enabled": False},
                # Flux already hears when the caller has finished, from how they speak: the extra wait on top stays short.
                "endpointing": {"min_delay": ENDPOINTING_SECONDS, "max_delay": LONGEST_TURN_WAIT_SECONDS},
            },
            user_away_timeout=settings.silence_seconds,
        )
        self._greeting = started.greeting

    async def run(self, caller: rtc.RemoteParticipant) -> None:
        telephone = caller.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
        await self.session.start(
            RestaurantLine(self._state, self._tts),
            room=self._ctx.room,
            room_options=room_io.RoomOptions(
                audio_input=room_io.AudioInputOptions(
                    noise_cancellation=noise_cancellation.BVCTelephony() if telephone else noise_cancellation.BVC(),
                ),
                participant_identity=caller.identity,
                close_on_disconnect=True,
            ),
            # Audio is not kept: the conversation's text is, in the restaurant's own log.
            record=False,
        )
        self.session.on("user_input_transcribed", self._on_transcript)
        self.session.on("user_state_changed", self._on_user_state)
        self.session.on("close", self._on_close)
        self.session.on("conversation_item_added", self._on_item)
        self._ctx.room.on("sip_dtmf_received", self._on_key)
        if settings.thinking_sound:
            # While the restaurant works out its answer, the caller hears someone typing, as at a real desk, not silence.
            await BackgroundAudioPlayer(
                thinking_sound=[
                    AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.45, fade_in=0.15, fade_out=0.25),
                    AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=0.4, fade_in=0.15, fade_out=0.25),
                ],
            ).start(room=self._ctx.room, agent_session=self.session)
        # The law asks the caller to hear it all: that this is an AI, and that the call may be recorded.
        self.session.say(self._greeting, allow_interruptions=False)
        self._spawn(self._watch_the_clock())

    # Events from the call.

    def _on_transcript(self, event: UserInputTranscribedEvent) -> None:
        language = (event.language or "")[:2].lower()
        if not event.is_final or language not in LANGUAGES or language == self._state.language:
            return
        if len(event.transcript.split()) < WORDS_TO_SWITCH:
            return
        self._state.language = language
        follow_language(self._tts, language)

    def _on_user_state(self, event: UserStateChangedEvent) -> None:
        if event.new_state == "away":
            self._spawn(self.end("silence"))

    def _on_close(self, _event: CloseEvent) -> None:
        if not self._ending:
            self._spawn(self.end("caller"))

    def _on_item(self, event: ConversationItemAddedEvent) -> None:
        # A reply of the brain's names its turn: the framework keeps it with what played of the reply.
        item = event.item
        if item.type == "message" and item.role == "assistant" and isinstance(turn := item.extra.get(TURN), str):
            self._remember(turn, [item], item.interrupted)

    def _on_key(self, dtmf: rtc.SipDTMF) -> None:
        if self._keypad_timer:
            self._keypad_timer.cancel()
        digits = self._keypad.press(dtmf.digit)
        if digits:
            self._spawn(self._send_number(digits))
        elif self._keypad.typing:
            self._keypad_timer = asyncio.get_running_loop().call_later(KEYPAD_PAUSE_SECONDS, self._keypad_paused)

    def _keypad_paused(self) -> None:
        digits = self._keypad.flush()
        if digits:
            self._spawn(self._send_number(digits))

    def _on_answer(self, answer: Answer) -> None:
        if answer.booked:
            logger.info("booked during the call", extra={"bookings": len(answer.booked)})
        # A browser shows its keypad when the restaurant asks for a number; a phone has one anyway.
        keypad = "open" if answer.ask_for_phone else "closed"
        if keypad != self._keypad_shown:
            self._keypad_shown = keypad
            self._spawn(self._ctx.room.local_participant.set_attributes({"maitre.keypad": keypad}))

    def _on_refusal(self, error: LineError) -> None:
        self._spawn(self.end("time_limit" if error.code == "call_time_limit" else "paused" if error.status in (429, 503) else "error"))

    # What the agent does on its own.

    async def _send_number(self, digits: str) -> None:
        """The number from the keypad goes to the restaurant, and its answer is spoken like any other."""
        turn_id = new_turn_id()

        async def words():
            self._state.last_turn = turn_id
            try:
                async for event in self._line.keypad(turn_id, digits):
                    if isinstance(event, Working):
                        self._state.working_lines.append(event.say)
                        yield f"{event.say} "
                    else:
                        self._on_answer(event)
                        yield event.reply
            except LineError as error:
                if error.status is not None:
                    self._on_refusal(error)
                    return
                yield UNREACHABLE.get(self._state.language, UNREACHABLE["fr"])

        # Said as words, not as a reply of the brain's: what played of it is learnt from the speech itself.
        self.session.say(words()).add_done_callback(lambda speech: self._remember(turn_id, speech.chat_items, speech.interrupted))

    def _remember(self, turn_id: str, items: list[llm.ChatItem], interrupted: bool) -> None:
        """What played of a reply, for the next turn to tell the restaurant: nothing is kept when nothing played."""
        text = " ".join(item.text_content or "" for item in items if item.type == "message" and item.role == "assistant").strip()
        if text:
            self._state.spoken[turn_id] = Spoken(text, cut_short=interrupted)

    async def _watch_the_clock(self) -> None:
        """A demo call tells the Worker how long it has lasted, which the demo's budget pays for; any call has a longest."""
        while not self._ending:
            await asyncio.sleep(settings.usage_every_seconds)
            seconds = self.seconds
            if seconds >= settings.max_call_seconds:
                await self.end("time_limit")
                return
            if not self._line.call.demo:
                continue
            try:
                usage = await self._line.usage(seconds)
            except LineError as error:
                logger.warning("usage not counted", extra={"error": str(error)})
                if error.status is not None:
                    await self.end("paused")
                    return
                continue
            if not usage.carry_on:
                await self.end(usage.reason or "paused")
                return

    @property
    def seconds(self) -> float:
        return time.monotonic() - self._began

    def voice_to_voice_ms(self) -> list[float]:
        """For each answer, from the caller's last word to the agent's first, as LiveKit measured it."""
        measured = []
        for item in self.session.history.items:
            if item.type == "message" and item.role == "assistant":
                latency = item.metrics.get("e2e_latency")
                if latency is not None:
                    measured.append(latency * 1000)
        return measured

    def latencies(self) -> list[dict[str, int]]:
        """For each answer, where its time went, in milliseconds, as LiveKit measured it.

        endOfTurn: from the caller's last word to the turn being theirs no more; transcript: to the final words;
        firstWords: from the turn to the restaurant's first words (the waiting line, when there is one);
        firstSound: from those words to the first audio; total: from the caller's last word to the agent's first.
        """
        report = []
        heard: dict[str, float] = {}
        for item in self.session.history.items:
            if item.type != "message":
                continue
            if item.role == "user":
                heard = dict(item.metrics)
            elif item.role == "assistant" and "e2e_latency" in item.metrics:
                measured = {
                    "endOfTurn": heard.get("end_of_turn_delay"),
                    "transcript": heard.get("transcription_delay"),
                    "firstWords": item.metrics.get("llm_node_ttft"),
                    "firstSound": item.metrics.get("tts_node_ttfb"),
                    "total": item.metrics.get("e2e_latency"),
                }
                report.append({name: round(value * 1000) for name, value in measured.items() if value is not None})
                heard = {}
        return report

    async def end(self, ended_by: EndedBy) -> None:
        """Logs the call with the restaurant, says the last words when the line hangs up on its own, and hangs up."""
        if self._ending:
            return
        self._ending = True
        logger.info("call latencies", extra={"turns": self.latencies(), "endedBy": ended_by})
        try:
            last_words = await self._line.end(ended_by, self.seconds, self.voice_to_voice_ms())
        except LineError as error:
            logger.warning("the end of the call was not logged", extra={"error": str(error)})
            last_words = ""
        if ended_by != "caller":
            if last_words:
                try:
                    await self.session.say(last_words, allow_interruptions=False).wait_for_playout()
                except RuntimeError:
                    pass
            await self._ctx.delete_room()

    def _spawn(self, work) -> None:
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


@server.rtc_session(agent_name=settings.agent_name)
async def answer_call(ctx: JobContext) -> None:
    problems = settings.problems()
    if problems:
        logger.error("the voice agent is not configured", extra={"problems": problems})
        return
    dispatch = Dispatch.from_job(ctx.job.metadata, ctx.job.id, settings)
    await ctx.connect()
    caller = await ctx.wait_for_participant()
    caller_id = caller.attributes.get("sip.phoneNumber") if caller.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP else None
    line = Line(utils.http_context.http_session(), dispatch.call, settings.agent_token)
    try:
        started = await line.start(dispatch.language, caller_id)
    except LineError as error:
        # Without the restaurant there is nothing to answer with: better no call than a made-up one.
        logger.error("the restaurant did not take the call", extra={"code": error.code, "status": error.status})
        await ctx.delete_room()
        return
    call = PhoneCall(ctx, line, started, ctx.proc.userdata["vad"])
    await call.run(caller)


if __name__ == "__main__":
    cli.run_app(server)
