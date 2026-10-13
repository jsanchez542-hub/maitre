"""The restaurant's line: how the voice agent reaches the Maître Worker.

Every turn of a call goes to the restaurant's Durable Object, which answers with
the same engine, prompt and guards as the web chat. The agent only hears and
speaks. A turn comes back as JSON lines: maybe a short line to say while the
assistant checks something, then always the answer.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

import aiohttp

EndedBy = Literal["caller", "goodbye", "silence", "time_limit", "paused", "error"]


@dataclass(frozen=True)
class Booked:
    reference: str
    date: str
    time: str
    party_size: int


@dataclass(frozen=True)
class Working:
    """A few words to say at once, while the assistant checks something."""

    say: str


@dataclass(frozen=True)
class Answer:
    reply: str
    outcome: str
    booked: tuple[Booked, ...] = ()
    passed_to_team: bool = False
    #: The caller should now type their number on the keypad.
    ask_for_phone: bool = False
    #: The caller was ending the call: the line hangs up once this reply has been heard.
    hang_up: bool = False


Event = Working | Answer


@dataclass(frozen=True)
class Started:
    greeting: str
    language: str
    #: Words speech recognition should expect on this restaurant's line: its name and its dishes.
    keyterms: tuple[str, ...] = ()


@dataclass(frozen=True)
class Usage:
    carry_on: bool
    reason: Literal["time_limit", "paused"] | None = None


class LineError(Exception):
    """The line did not answer, or answered with a refusal the agent must act on."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        #: The Worker's name for the refusal: "call_time_limit", "live_paused", "rate_limited"...
        self.code = code


@dataclass(frozen=True)
class Call:
    """Where a call's steps go: a restaurant's own line, or a visitor's demo restaurant."""

    base_url: str
    session_id: str
    demo: bool

    @classmethod
    def restaurant(cls, api_url: str, restaurant_id: str, session_id: str) -> Call:
        return cls(f"{api_url.rstrip('/')}/v1/restaurants/{restaurant_id}/calls/{session_id}", session_id, demo=False)

    @classmethod
    def demo_sandbox(cls, api_url: str, sandbox: str, session_id: str) -> Call:
        return cls(f"{api_url.rstrip('/')}/v1/demo/sandboxes/{sandbox}/calls/{session_id}", session_id, demo=True)


def new_turn_id() -> str:
    """An id for a turn, chosen by the line: asking again with it never makes a second turn."""
    return f"turn_{secrets.token_urlsafe(12)}"


def _event(line: dict[str, Any]) -> Event:
    if line.get("type") == "working":
        return Working(say=str(line["say"]))
    if line.get("type") == "answer" and line.get("status") == "ok":
        return Answer(
            reply=str(line["reply"]),
            outcome=str(line["outcome"]),
            booked=tuple(
                Booked(str(made["reference"]), str(made["date"]), str(made["time"]), int(made["partySize"]))
                for made in line.get("booked", [])
            ),
            passed_to_team=bool(line.get("passedToTeam")),
            ask_for_phone=bool(line.get("askForPhone")),
            hang_up=bool(line.get("hangUp")),
        )
    raise LineError(f"unreadable line from the restaurant: {str(line)[:200]}")


class Line:
    """The steps of one call. The token is the Worker's agent token, never the visitor's."""

    def __init__(
        self,
        http: aiohttp.ClientSession,
        call: Call,
        token: str,
        *,
        turn_timeout: float = 25.0,
        step_timeout: float = 8.0,
        retries: int = 1,
    ) -> None:
        self._http = http
        self._call = call
        self._headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
        self._turn_timeout = turn_timeout
        self._step_timeout = step_timeout
        self._retries = retries

    @property
    def call(self) -> Call:
        return self._call

    async def start(self, language: str, caller_id: str | None = None) -> Started:
        body: dict[str, Any] = {"language": language}
        if caller_id:
            body["callerId"] = caller_id
        answer = await self._post_json("start", body)
        keyterms = answer.get("keyterms")
        return Started(
            greeting=str(answer["greeting"]),
            language=str(answer["language"]),
            keyterms=tuple(str(term) for term in keyterms) if isinstance(keyterms, list) else (),
        )

    def turn(self, turn_id: str, message: str, language: str, heard: str | None = None, unheard: str | None = None) -> AsyncIterator[Event]:
        """A turn of the caller's. `heard`: the part of the last reply they heard, when they cut it short;
        `unheard`: the last turn's id, when they heard none of its reply."""
        body: dict[str, Any] = {"turnId": turn_id, "message": message, "language": language}
        if heard:
            body["heard"] = heard
        if unheard:
            body["unheard"] = unheard
        return self._stream("turns", body)

    def keypad(self, turn_id: str, digits: str) -> AsyncIterator[Event]:
        return self._stream("keypad", {"turnId": turn_id, "digits": digits})

    async def usage(self, seconds: float) -> Usage:
        answer = await self._post_json("usage", {"seconds": round(seconds, 1)})
        return Usage(carry_on=bool(answer["carryOn"]), reason=answer.get("reason"))

    async def end(self, ended_by: EndedBy, seconds: float, voice_to_voice_ms: list[float]) -> str:
        """Logs the end of the call. Returns the last words to say, when the line hangs up on its own."""
        answer = await self._post_json(
            "end",
            {"endedBy": ended_by, "seconds": round(seconds, 1), "voiceToVoiceMs": [round(ms) for ms in voice_to_voice_ms]},
        )
        return str(answer.get("say", ""))

    async def _post_json(self, step: str, body: dict[str, Any]) -> dict[str, Any]:
        timeout = aiohttp.ClientTimeout(total=self._step_timeout)
        try:
            async with self._http.post(f"{self._call.base_url}/{step}", json=body, headers=self._headers, timeout=timeout) as response:
                payload = await response.json(content_type=None)
                if response.status >= 400:
                    raise LineError(f"{step} refused", status=response.status, code=_code(payload))
                return payload
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError) as error:
            raise LineError(f"{step} failed: {type(error).__name__}") from error

    async def _stream(self, step: str, body: dict[str, Any]) -> AsyncIterator[Event]:
        """The JSON lines of a turn. A dropped connection is retried with the same turn id: the Worker answers it once."""
        timeout = aiohttp.ClientTimeout(total=self._turn_timeout, sock_connect=5)
        said_working = False
        for attempt in range(self._retries + 1):
            try:
                async with self._http.post(f"{self._call.base_url}/{step}", json=body, headers=self._headers, timeout=timeout) as response:
                    if response.status >= 400:
                        raise LineError(f"{step} refused", status=response.status, code=_code(await _json_or_none(response)))
                    async for raw in response.content:
                        text = raw.decode("utf-8").strip()
                        if not text:
                            continue
                        event = _event(json.loads(text))
                        if isinstance(event, Working):
                            # A retry may send the short line again: it is said once.
                            if said_working:
                                continue
                            said_working = True
                        yield event
                        if isinstance(event, Answer):
                            return
                raise LineError(f"{step} ended without an answer")
            except LineError as error:
                if error.status is not None or attempt == self._retries:
                    raise
            except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
                if attempt == self._retries:
                    raise LineError(f"{step} failed: {type(error).__name__}") from error


async def _json_or_none(response: aiohttp.ClientResponse) -> dict[str, Any] | None:
    try:
        return await response.json(content_type=None)
    except (aiohttp.ContentTypeError, json.JSONDecodeError, ValueError):
        return None


def _code(payload: Any) -> str | None:
    return str(payload["error"]) if isinstance(payload, dict) and "error" in payload else None
