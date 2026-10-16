"""The agent's word on itself to the Worker: there, and with speech that works.

The demo shows its call button only while an agent checks in every minute
with speech that works, and a call that fails on its speech turns calls off at
once. Without this, a visitor could call a line nobody answers, or one that
cannot speak: on 15 October LiveKit's free allowance ran out, every speech
request answered 429, and the button still showed. Speech is tried again every
hour while it works, so an allowance spent in the middle of the month turns
calls off within the hour rather than failing a caller every quarter of an hour.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Awaitable, Callable

import aiohttp
from livekit import rtc
from livekit.agents.utils import http_context

from .config import Settings
from .speech import build_stt, build_tts

logger = logging.getLogger("maitre.voice")

#: How often the agent checks in: the Worker stops offering calls after two missed check-ins.
CHECK_IN_SECONDS = 60.0
#: While speech fails, how often it is tried again. One word each time: the allowance it waits for is not spent on it.
RETRY_SECONDS = 30 * 60.0
#: While speech works, how often it is tried anyway: a call that fails turns calls off for a quarter of an hour only.
RECHECK_SECONDS = 60 * 60.0
#: Silence handed to speech recognition to see that it opens, in seconds.
PROBE_SILENCE_SECONDS = 0.2
PROBE_SAMPLE_RATE = 16_000


def failure_reason(error: BaseException) -> str:
    """A speech failure as a word for the Worker, never the provider's message: 429 is the allowance spent, 401 or 403 a key."""
    status = _status(error)
    if status == 429:
        return "speech_quota"
    if status in (401, 403):
        return "speech_key"
    return "speech_error"


def _status(error: BaseException | None) -> int | None:
    """The HTTP status behind an error, wherever it sits in its chain of causes."""
    for _ in range(5):
        if error is None:
            return None
        for name in ("status_code", "status"):
            value = getattr(error, name, None)
            if isinstance(value, int):
                return value
        error = error.__cause__ or error.__context__
    return None


async def speech_works(settings: Settings) -> str | None:
    """Says one word with the French voice and opens speech recognition, as a call does: None when both work, or why not."""
    try:
        engine = build_tts(settings.voice_for("fr"), "fr")
        try:
            async for _ in engine.synthesize("Oui."):
                break
        finally:
            await engine.aclose()
        listener = build_stt(settings.stt, "fr")
        stream = listener.stream()
        try:
            samples = int(PROBE_SAMPLE_RATE * PROBE_SILENCE_SECONDS)
            silence = rtc.AudioFrame(data=bytes(samples * 2), sample_rate=PROBE_SAMPLE_RATE, num_channels=1, samples_per_channel=samples)
            stream.push_frame(silence)
            stream.end_input()
            async for _ in stream:
                pass
        finally:
            await stream.aclose()
            await listener.aclose()
    except Exception as error:  # whatever failed, no call should be offered: the reason says which kind
        return failure_reason(error)
    return None


async def report(http: aiohttp.ClientSession, settings: Settings, kind: str, body: dict[str, object]) -> None:
    """Tells the Worker. One that cannot be reached hears again at the next check-in."""
    url = f"{settings.api_url}/v1/demo/voice/{kind}"
    headers = {"Authorization": f"Bearer {settings.agent_token}"}
    try:
        async with http.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as response:
            if response.status != 200:
                logger.warning("the Worker did not take the voice report", extra={"kind": kind, "status": response.status})
    except (aiohttp.ClientError, TimeoutError) as error:
        logger.warning("the Worker could not be reached", extra={"kind": kind, "error": type(error).__name__})


async def check_in_forever(
    settings: Settings,
    probe: Callable[[Settings], Awaitable[str | None]] = speech_works,
    *,
    every: float = CHECK_IN_SECONDS,
    retry_after: float = RETRY_SECONDS,
    recheck_after: float = RECHECK_SECONDS,
) -> None:
    """Checks in every minute, saying whether speech works: tried at the start, then hourly while it works, half-hourly while not."""
    async with http_context.open(), aiohttp.ClientSession() as http:
        problems = settings.problems()
        failing = "not_configured" if problems else await probe(settings)
        tried = time.monotonic()
        while True:
            if not problems and time.monotonic() - tried >= (retry_after if failing is not None else recheck_after):
                failing = await probe(settings)
                tried = time.monotonic()
            await report(http, settings, "check-in", {"ready": failing is None, **({"reason": failing} if failing else {})})
            await asyncio.sleep(every)


def start_checking_in(settings: Settings) -> threading.Thread:
    """In a thread of its own, beside the agent's: the loop that answers calls is not this one's to share."""
    thread = threading.Thread(target=lambda: asyncio.run(check_in_forever(settings)), name="maitre-check-in", daemon=True)
    thread.start()
    return thread
