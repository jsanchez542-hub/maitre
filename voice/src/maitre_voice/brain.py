"""The restaurant as the voice framework's language model.

LiveKit runs speech recognition, turn detection, speech synthesis and
interruptions. Where it would call a language model, it calls this instead:
the caller's words go to the restaurant's line, and what comes back is spoken.
The short line the restaurant sends while it checks something is spoken first,
as the start of the same reply.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from livekit.agents import APIConnectOptions, llm
from livekit.agents.llm.tool_context import Tool
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr

from .line import Answer, Line, LineError, Working, new_turn_id

logger = logging.getLogger("maitre.voice")

#: Only for when the restaurant cannot be reached at all: every other word comes from the restaurant.
UNREACHABLE = {
    "fr": "Je suis désolé, je rencontre un problème technique. Pouvez-vous rappeler dans un instant ?",
    "en": "I am sorry, something went wrong on my side. Could you call back in a moment?",
    "es": "Lo siento, tengo un problema técnico. ¿Puede volver a llamar en un momento?",
}
#: Every piece of a reply carries its turn's id under this key, into the message the framework keeps of what played.
TURN = "maitre_turn"


@dataclass(frozen=True)
class Spoken:
    """What played of a reply: its words as far as the caller heard them, and whether they cut it short."""

    text: str
    cut_short: bool


@dataclass
class CallState:
    """What the agent knows about the call while it runs."""

    line: Line
    language: str
    #: Called with every answer: the agent shows the keypad when the restaurant asks for a number.
    on_answer: Callable[[Answer], None] = lambda _answer: None
    #: Called when the restaurant refuses a turn the call cannot go on after: the agent says goodbye.
    on_refusal: Callable[[LineError], None] = lambda _error: None
    #: The short line said in each turn, by the reply it started, to take it out of what the caller heard.
    working_lines: list[str] = field(default_factory=list)
    #: The id of the last turn the restaurant was asked to answer.
    last_turn: str | None = None
    #: What played of each reply that played at all, by turn.
    spoken: dict[str, Spoken] = field(default_factory=dict)

    def heard_of_last_reply(self) -> tuple[str | None, str | None]:
        """What the caller heard of the reply to the last turn: the restaurant remembers only that much.

        The part they heard, when they cut it short; or the turn's id, when they heard none of it: they spoke on
        before it began, or heard only the short line said while the tools ran. Neither, when they heard it all.
        """
        turn = self.last_turn
        if turn is None:
            return None, None
        spoken = self.spoken.get(turn)
        if spoken is None:
            return None, turn
        if not spoken.cut_short:
            return None, None
        heard = without_working_line(spoken.text, self.working_lines)
        return (heard, None) if heard else (None, turn)


class Goodbye:
    """The line's own hang-up, after the reply that ends the call.

    It waits for that reply to be heard to the end, then for a short pause. A caller who speaks over the goodbye, or
    says words in the pause, keeps the line open: the restaurant answers them, and says goodbye again if that is what
    they said. A noise in the pause, which recognition makes no words of, only delays the hang-up.
    """

    def __init__(self, hang_up: Callable[[], None], pause: float) -> None:
        self._hang_up = hang_up
        self._pause = pause
        #: The turn whose reply is the last of the call, until it has played.
        self._turn: str | None = None
        #: The goodbye was heard: the line hangs up once the caller is quiet for the pause.
        self._heard = False
        self._speaking = False
        self._timer: asyncio.TimerHandle | None = None

    def answered(self, turn_id: str | None, ends_call: bool) -> None:
        """The restaurant answered a turn, with the last reply of the call or not."""
        self._turn = turn_id if ends_call else None

    def played(self, turn_id: str, interrupted: bool) -> None:
        """A reply has finished playing, to its end or cut short."""
        if turn_id != self._turn:
            return
        self._turn = None
        if interrupted:
            return
        self._heard = True
        if not self._speaking:
            self._arm()

    def caller_speaking(self, speaking: bool) -> None:
        """The caller's voice, as voice activity hears it: the hang-up waits until they are quiet again."""
        self._speaking = speaking
        if speaking:
            self._disarm()
        elif self._heard:
            self._arm()

    def caller_said(self) -> None:
        """The caller said words: they are not done, and the restaurant answers them."""
        self._turn = None
        self._heard = False
        self._disarm()

    def _arm(self) -> None:
        self._disarm()
        self._timer = asyncio.get_running_loop().call_later(self._pause, self._fire)

    def _disarm(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def _fire(self) -> None:
        self._timer = None
        self._heard = False
        self._hang_up()


def without_working_line(text: str, working_lines: list[str]) -> str:
    """A reply as heard, without the short line it opened with: that line was never the answer."""
    heard = text.strip()
    for line in working_lines:
        if heard.startswith(line):
            return heard[len(line) :].strip()
        if line.startswith(heard):
            # Cut within the short line itself.
            return ""
    return heard


class RestaurantBrain(llm.LLM):
    def __init__(self, state: CallState) -> None:
        super().__init__()
        self._state = state

    @property
    def model(self) -> str:
        return "maitre"

    @property
    def provider(self) -> str:
        return "maitre-worker"

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        # The line retries a dropped turn itself, with the same id; the framework must not start another.
        return TurnStream(self, state=self._state, chat_ctx=chat_ctx, tools=tools or [], conn_options=APIConnectOptions(max_retry=0))


class TurnStream(llm.LLMStream):
    def __init__(
        self, brain: RestaurantBrain, *, state: CallState, chat_ctx: llm.ChatContext, tools: list[Tool], conn_options: APIConnectOptions
    ) -> None:
        super().__init__(brain, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._state = state
        # Chosen once per reply, so whoever asks again asks for the same turn.
        self._turn_id = new_turn_id()

    async def _run(self) -> None:
        message = next(
            (item.text_content for item in reversed(self._chat_ctx.items) if item.type == "message" and item.role == "user"),
            None,
        )
        if not message or not message.strip():
            return
        heard, unheard = self._state.heard_of_last_reply()
        self._state.last_turn = self._turn_id
        try:
            async for event in self._state.line.turn(self._turn_id, message, self._state.language, heard, unheard):
                if isinstance(event, Working):
                    self._state.working_lines.append(event.say)
                    self._say(f"{event.say} ")
                else:
                    self._say(event.reply)
                    self._state.on_answer(event)
        except LineError as error:
            if error.status is not None:
                # Past the call's time, the demo's budget or its pace: the agent ends the call with the restaurant's own words.
                logger.info("turn refused by the restaurant", extra={"code": error.code, "status": error.status})
                self._state.on_refusal(error)
                return
            logger.warning("restaurant unreachable during a turn", extra={"error": str(error)})
            self._say(UNREACHABLE.get(self._state.language, UNREACHABLE["fr"]))

    def _say(self, text: str) -> None:
        delta = llm.ChoiceDelta(role="assistant", content=text, extra={TURN: self._turn_id})
        self._event_ch.send_nowait(llm.ChatChunk(id=self._turn_id, delta=delta))
