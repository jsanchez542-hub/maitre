"""The agent tells the Worker it is there, and whether its speech works, so the demo offers calls only then."""

import asyncio

import pytest
from aiohttp import web

from maitre_voice.config import Settings
from maitre_voice.health import check_in_forever, failure_reason

TOKEN = "test-agent-token"


class Reports:
    def __init__(self) -> None:
        self.received: list[tuple[str, dict, str]] = []

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/v1/demo/voice/{kind}", self.handle)
        return app

    async def handle(self, request: web.Request) -> web.Response:
        authorization = request.headers.get("authorization", "")
        self.received.append((request.match_info["kind"], await request.json(), authorization))
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

    task = asyncio.create_task(check_in_forever(settings_for(url), probe, every=0.02, retry_after=0.05))
    await asyncio.sleep(0.3)
    task.cancel()
    checks = [body for kind, body, _authorization in reports.received if kind == "check-in"]
    assert checks[0] == {"ready": False, "reason": "speech_quota"}
    assert checks[-1] == {"ready": True}
    # Tried again only while it failed: once at the start, once after.
    assert len(tried) == 2


async def test_an_agent_without_its_settings_says_so_and_never_tries_speech(worker):
    reports, url = worker
    tried = []

    async def probe(_settings: Settings) -> str | None:
        tried.append(True)
        return None

    unconfigured = Settings.from_env({"MAITRE_API_URL": url, "DEEPGRAM_API_KEY": "d", "CARTESIA_API_KEY": "c"})
    task = asyncio.create_task(check_in_forever(unconfigured, probe, every=0.02, retry_after=0.01))
    await asyncio.sleep(0.3)
    task.cancel()
    assert tried == []
    assert reports.received
    # Without its token the Worker refuses them, and calls stay off either way.
    assert all(body == {"ready": False, "reason": "not_configured"} for _kind, body, _authorization in reports.received)
