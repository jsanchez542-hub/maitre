"""The line against a stand-in Worker that speaks the same HTTP: JSON lines for turns, JSON for the other steps."""

import json

import aiohttp
import pytest
from aiohttp import web

from maitre_voice.line import Answer, Booked, Call, Line, LineError, Working

TOKEN = "test-agent-token"


class FakeWorker:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.answers: dict[str, int] = {}
        self.drop_first_turn = False
        self.refuse: tuple[int, str] | None = None

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/v1/demo/sandboxes/{sandbox}/calls/{session}/{step}", self.handle)
        app.router.add_post("/v1/restaurants/{restaurant}/calls/{session}/{step}", self.handle)
        return app

    async def handle(self, request: web.Request) -> web.StreamResponse:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        body = await request.json()
        step = request.match_info["step"]
        self.requests.append((step, body))
        if self.refuse:
            status, code = self.refuse
            return web.json_response({"error": code}, status=status)
        if step == "start":
            return web.json_response(
                {
                    "status": "ok",
                    "sessionId": request.match_info["session"],
                    "language": body["language"],
                    "greeting": "Bonjour",
                    "keyterms": ["Merrain", "Soupe à l’oignon gratinée"],
                }
            )
        if step == "usage":
            return web.json_response(
                {"status": "ok", "carryOn": body["seconds"] < 240, **({} if body["seconds"] < 240 else {"reason": "time_limit"})}
            )
        if step == "end":
            return web.json_response({"status": "ok", "say": "Au revoir." if body["endedBy"] == "silence" else ""})
        response = web.StreamResponse(headers={"content-type": "application/x-ndjson"})
        await response.prepare(request)
        await response.write(json.dumps({"type": "working", "say": "Je regarde."}).encode() + b"\n")
        if self.drop_first_turn:
            # The connection drops after the short line: the line must ask again with the same turn id.
            self.drop_first_turn = False
            request.transport.close()
            return response
        self.answers[body["turnId"]] = self.answers.get(body["turnId"], 0) + 1
        answer = {
            "type": "answer",
            "status": "ok",
            "reply": "C’est réservé.",
            "outcome": "answered",
            "booked": [{"reference": "ACDEFH", "date": "2026-10-16", "time": "20:00", "partySize": 4}],
            "passedToTeam": False,
            "askForPhone": False,
        }
        await response.write(json.dumps(answer).encode() + b"\n")
        await response.write_eof()
        return response


@pytest.fixture
async def worker(aiohttp_server):
    fake = FakeWorker()
    server = await aiohttp_server(fake.app())
    yield fake, str(server.make_url(""))


@pytest.fixture
async def http():
    async with aiohttp.ClientSession() as session:
        yield session


async def test_a_turn_gives_the_short_line_first_then_the_answer(worker, http):
    fake, url = worker
    line = Line(http, Call.demo_sandbox(url, "sandbox-0000000000000000", "call_1"), TOKEN)
    events = [event async for event in line.turn("turn_a", "Une table pour 4 vendredi", "fr")]
    assert events == [
        Working(say="Je regarde."),
        Answer(reply="C’est réservé.", outcome="answered", booked=(Booked("ACDEFH", "2026-10-16", "20:00", 4),)),
    ]
    assert fake.requests == [("turns", {"turnId": "turn_a", "message": "Une table pour 4 vendredi", "language": "fr"})]


async def test_a_dropped_turn_is_asked_again_with_the_same_id_and_its_short_line_said_once(worker, http):
    fake, url = worker
    fake.drop_first_turn = True
    line = Line(http, Call.restaurant(url, "demo", "call_2"), TOKEN)
    events = [event async for event in line.turn("turn_b", "Allô", "fr", heard="Nous sommes ouverts")]
    assert [type(event) for event in events] == [Working, Answer]
    assert [body["turnId"] for step, body in fake.requests] == ["turn_b", "turn_b"]
    assert fake.requests[0][1]["heard"] == "Nous sommes ouverts"


async def test_names_the_turn_whose_reply_the_caller_never_heard(worker, http):
    fake, url = worker
    line = Line(http, Call.restaurant(url, "demo", "call_3"), TOKEN)
    _events = [event async for event in line.turn("turn_c", "Je voudrais réserver.", "fr", unheard="turn_b")]
    body = fake.requests[-1][1]
    assert body["unheard"] == "turn_b"
    assert "heard" not in body


async def test_a_refusal_carries_the_workers_name_for_it_and_is_not_retried(worker, http):
    fake, url = worker
    fake.refuse = (409, "call_time_limit")
    line = Line(http, Call.demo_sandbox(url, "sandbox-0000000000000000", "call_3"), TOKEN)
    with pytest.raises(LineError) as refused:
        async for _ in line.turn("turn_c", "Allô", "fr"):
            pass
    assert (refused.value.status, refused.value.code) == (409, "call_time_limit")
    assert len(fake.requests) == 1


async def test_start_usage_and_end(worker, http):
    fake, url = worker
    line = Line(http, Call.demo_sandbox(url, "sandbox-0000000000000000", "call_4"), TOKEN)
    started = await line.start("en", caller_id=None)
    assert (started.greeting, started.language) == ("Bonjour", "en")
    assert started.keyterms == ("Merrain", "Soupe à l’oignon gratinée")
    assert (await line.usage(30.04)).carry_on
    stopped = await line.usage(240)
    assert (stopped.carry_on, stopped.reason) == (False, "time_limit")
    assert await line.end("silence", 95.44, [820.4, 1190.0]) == "Au revoir."
    assert fake.requests[-1] == ("end", {"endedBy": "silence", "seconds": 95.4, "voiceToVoiceMs": [820, 1190]})


async def test_an_unreachable_restaurant_is_a_line_error_without_a_status(http):
    line = Line(http, Call.restaurant("http://127.0.0.1:9", "demo", "call_5"), TOKEN, step_timeout=2, turn_timeout=2)
    with pytest.raises(LineError) as unreachable:
        await line.start("fr")
    assert unreachable.value.status is None
