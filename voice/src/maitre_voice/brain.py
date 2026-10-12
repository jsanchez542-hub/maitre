"""The restaurant as the voice framework's language model.

LiveKit runs speech recognition, turn detection, speech synthesis and
interruptions. Where it would call a language model, it calls this instead:
the caller's words go to the restaurant's line, and what comes back is spoken.
The short line the restaurant sends while it checks something is spoken first,
as the start of the same reply.
"""

from __future__ import annotations

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


def heard_of_last_reply(chat_ctx: llm.ChatContext, working_lines: list[str]) -> str | None:
    """What the caller heard of the last reply, when they cut it short: the restaurant remembers only that much."""
    messages = [item for item in chat_ctx.items if item.type == "message"]
    if len(messages) < 2 or messages[-1].role != "user":
        return None
    previous = messages[-2]
    if previous.role != "assistant" or not previous.interrupted:
        return None
    heard = (previous.text_content or "").strip()
    for line in working_lines:
        if heard.startswith(line):
            heard = heard[len(line) :].strip()
            break
    return heard or None


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
        heard = heard_of_last_reply(self._chat_ctx, self._state.working_lines)
        try:
            async for event in self._state.line.turn(self._turn_id, message, self._state.language, heard):
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
        self._event_ch.send_nowait(llm.ChatChunk(id=self._turn_id, delta=llm.ChoiceDelta(role="assistant", content=text)))
