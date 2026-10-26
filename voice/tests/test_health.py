"""The agent tells the Worker it is there, and whether its speech works, so the demo offers calls only then."""

import asyncio
import contextlib
from collections.abc import Callable

import pytest
from aiohttp import web

from maitre_voice.config import Settings
from maitre_voice.health import check_in_forever, failure_reason

TOKEN = "test-agent-token"


class Reports:
    def __init__(self) -> None:
        self.received: list[tuple[str, dict, str]] = []
        self.arrived = asyncio.Event()

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/v1/demo/voice/{kind}", self.handle)
        return app

    async def handle(self, request: web.Request) -> web.Response:
        authorization = request.headers.get("authorization", "")
        self.received.append((request.match_info["kind"], await request.json(), authorization))
        self.arrived.set()
        if authorization != f"Bearer {TOKEN}":
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"status": "ok", "calls": True})


@pytest.fixture
async def worker(aiohttp_server):
    reports = Reports()
    server = await aiohttp_server(reports.app())
    yield reports, str(server.make_url("")).rstrip("/")


def settings_for(url: str, token: str = TOKEN) -> Settings:
    return Settings.from_env({"MAITRE_API_URL": url, "MAITRE_AGENT_TOKEN": token, "DEEPGRAM_API_KEY": "d", "CARTESIA_API_KEY": "c"})


def check_ins(reports: Reports) -> list[dict]:
    return [body for kind, body, _authorization in reports.received if kind == "check-in"]


async def run_until(task: asyncio.Task, reports: Reports, condition: Callable[[], bool]) -> None:
    """Waits for what the test expects, not a fixed time: the first connection alone can take most of a fixed wait."""
    try:
        async with asyncio.timeout(10):
            while not condition():
                reports.arrived.clear()
                await reports.arrived.wait()
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


class Refused(Exception):
    def __init__(self, status: int) -> None:
        super().__init__("Invalid response status")
        self.status = status


def test_names_a_speech_failure_by_a_word_never_by_the_providers_message():
    class Gateway(Exception):
        status_code = 429

    assert failure_reason(Gateway("Too Many Requests at wss://agent-gateway.livekit.cloud")) == "speech_quota"
    # Speech recognition's 429 comes as the cause of a connection error, as on 15 October.
    try:
        try:
            raise Refused(429)
        except Refused as handshake:
            raise ConnectionError("failed to recognize speech after 3 attempts") from handshake
    except ConnectionError as error:
        assert failure_reason(error) == "speech_quota"
    assert failure_reason(Refused(401)) == "speech_key"
    assert failure_reason(RuntimeError("anything else")) == "speech_error"


async def test_checks_in_with_whether_speech_works_and_tries_again_while_it_fails(worker):
    reports, url = worker
    answers = iter(["speech_quota", None])
    tried = []

    async def probe(_settings: Settings) -> str | None:
        tried.append(True)
        return next(answers)

    task = asyncio.create_task(check_in_forever(settings_for(url), probe, every=0.02, retry_after=0.05, recheck_after=10))
    await run_until(task, reports, lambda: {"ready": True} in check_ins(reports))
    checks = check_ins(reports)
    assert checks[0] == {"ready": False, "reason": "speech_quota"}
    assert checks[-1] == {"ready": True}
    # Tried again after the half hour of a failure, then left for the hour of speech that works.
    assert len(tried) == 2


async def test_tries_speech_again_while_it_works_so_an_allowance_spent_turns_calls_off(worker):
    reports, url = worker
    answers = iter([None, "speech_quota"])
    tried = []

    async def probe(_settings: Settings) -> str | None:
        tried.append(True)
        return next(answers)

    task = asyncio.create_task(check_in_forever(settings_for(url), probe, every=0.02, retry_after=10, recheck_after=0.05))
    await run_until(task, reports, lambda: {"ready": False, "reason": "speech_quota"} in check_ins(reports))
    checks = check_ins(reports)
    assert checks[0] == {"ready": True}
    assert checks[-1] == {"ready": False, "reason": "speech_quota"}
    # Once at the start, once after the hour, and not again before the half hour of the failure.
    assert len(tried) == 2


async def test_an_agent_without_its_settings_says_so_and_never_tries_speech(worker):
    reports, url = worker
    tried = []

    async def probe(_settings: Settings) -> str | None:
        tried.append(True)
        return None

    unconfigured = Settings.from_env({"MAITRE_API_URL": url, "DEEPGRAM_API_KEY": "d", "CARTESIA_API_KEY": "c"})
    task = asyncio.create_task(check_in_forever(unconfigured, probe, every=0.02, retry_after=0.01))
    # Several reports, so a probe that would come after the first one would have had its chance.
    await run_until(task, reports, lambda: len(reports.received) >= 3)
    assert tried == []
    assert reports.received
    # Without its token the Worker refuses them, and calls stay off either way.
    assert all(body == {"ready": False, "reason": "not_configured"} for _kind, body, _authorization in reports.received)
