"""The restaurant as LiveKit's language model: the caller's words go to the line, and what comes back is spoken."""

from livekit.agents import llm

from maitre_voice.agent import Dispatch
from maitre_voice.brain import UNREACHABLE, CallState, RestaurantBrain, heard_of_last_reply
from maitre_voice.config import Settings
from maitre_voice.line import Answer, LineError, Working


class FakeLine:
    def __init__(self, events=(), error: LineError | None = None) -> None:
        self.events = list(events)
        self.error = error
        self.calls: list[tuple[str, str, str, str | None]] = []

    async def turn(self, turn_id, message, language, heard=None):
        self.calls.append((turn_id, message, language, heard))
        if self.error:
            raise self.error
        for event in self.events:
            yield event


def conversation(*messages: tuple[str, str, bool]) -> llm.ChatContext:
    chat = llm.ChatContext.empty()
    for role, text, interrupted in messages:
        chat.items.append(llm.ChatMessage(role=role, content=[text], interrupted=interrupted))
    return chat


async def spoken(brain: RestaurantBrain, chat: llm.ChatContext) -> str:
    text = ""
    async with brain.chat(chat_ctx=chat) as stream:
        async for chunk in stream:
            if chunk.delta and chunk.delta.content:
                text += chunk.delta.content
    return text


async def test_speaks_the_short_line_then_the_answer_as_one_reply():
    answers: list[Answer] = []
    line = FakeLine([Working("Je regarde."), Answer(reply="J’ai une table à 20 h.", outcome="answered")])
    state = CallState(line=line, language="fr", on_answer=answers.append)
    said = await spoken(RestaurantBrain(state), conversation(("user", "Une table pour quatre vendredi", False)))
    assert said == "Je regarde. J’ai une table à 20 h."
    assert [answer.reply for answer in answers] == ["J’ai une table à 20 h."]
    assert state.working_lines == ["Je regarde."]
    assert line.calls[0][1:] == ("Une table pour quatre vendredi", "fr", None)


async def test_tells_the_restaurant_how_much_of_a_cut_reply_the_caller_heard():
    line = FakeLine([Answer(reply="Le dimanche, nous sommes fermés.", outcome="answered")])
    state = CallState(line=line, language="fr", working_lines=["Je regarde."])
    chat = conversation(
        ("user", "Vous êtes ouverts quand ?", False),
        ("assistant", "Je regarde. Nous sommes ouverts du mardi", True),
        ("user", "Et le dimanche ?", False),
    )
    await spoken(RestaurantBrain(state), chat)
    assert line.calls[0][3] == "Nous sommes ouverts du mardi"


def test_heard_nothing_to_report_when_the_reply_was_not_cut():
    chat = conversation(("user", "Bonsoir", False), ("assistant", "Bonsoir.", False), ("user", "Une table ?", False))
    assert heard_of_last_reply(chat, []) is None
    cut_in_the_short_line = conversation(("user", "Bonsoir", False), ("assistant", "Je regarde.", True), ("user", "Non", False))
    assert heard_of_last_reply(cut_in_the_short_line, ["Je regarde."]) is None


async def test_a_refused_turn_says_nothing_and_lets_the_agent_end_the_call():
    refusals: list[LineError] = []
    line = FakeLine(error=LineError("refused", status=409, code="call_time_limit"))
    state = CallState(line=line, language="fr", on_refusal=refusals.append)
    assert await spoken(RestaurantBrain(state), conversation(("user", "Allô ?", False))) == ""
    assert [refusal.code for refusal in refusals] == ["call_time_limit"]


async def test_an_unreachable_restaurant_gets_an_apology_in_the_callers_language():
    state = CallState(line=FakeLine(error=LineError("down")), language="es")
    assert await spoken(RestaurantBrain(state), conversation(("user", "¿Hola?", False))) == UNREACHABLE["es"]


async def test_says_nothing_to_silence():
    line = FakeLine([Answer(reply="?", outcome="answered")])
    state = CallState(line=line, language="fr")
    assert await spoken(RestaurantBrain(state), conversation(("user", "   ", False))) == ""
    assert line.calls == []


def test_a_demo_pass_goes_to_the_visitors_restaurant_and_anything_else_to_the_restaurants_own_line():
    settings = Settings.from_env({"MAITRE_API_URL": "http://127.0.0.1:8787", "MAITRE_AGENT_TOKEN": "t"})
    demo = Dispatch.from_job('{"sandbox": "abc", "sessionId": "call_x", "language": "en"}', "AJ_1", settings)
    assert (demo.call.base_url, demo.call.demo, demo.language) == ("http://127.0.0.1:8787/v1/demo/sandboxes/abc/calls/call_x", True, "en")
    own = Dispatch.from_job("", "AJ_+33/612", settings)
    assert (own.call.base_url, own.call.demo, own.language) == (
        "http://127.0.0.1:8787/v1/restaurants/demo/calls/call_AJ__33_612",
        False,
        "fr",
    )
    assert Dispatch.from_job("not json", "AJ_2", settings).call.session_id == "call_AJ_2"
    assert Dispatch.from_job('{"language": "de"}', "AJ_3", settings).language == "fr"
