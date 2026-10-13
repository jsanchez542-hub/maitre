"""The restaurant as LiveKit's language model: the caller's words go to the line, and what comes back is spoken."""

from livekit.agents import llm

from maitre_voice.agent import Dispatch
from maitre_voice.brain import TURN, UNREACHABLE, CallState, RestaurantBrain, Spoken
from maitre_voice.config import Settings
from maitre_voice.line import Answer, LineError, Working


class FakeLine:
    def __init__(self, events=(), error: LineError | None = None) -> None:
        self.events = list(events)
        self.error = error
        self.calls: list[tuple[str, str, str, str | None]] = []

    async def turn(self, turn_id, message, language, heard=None, unheard=None):
        self.calls.append((turn_id, message, language, heard, unheard))
        if self.error:
            raise self.error
        for event in self.events:
            yield event


def conversation(*messages: tuple[str, str, bool]) -> llm.ChatContext:
    chat = llm.ChatContext.empty()
    for role, text, interrupted in messages:
        chat.items.append(llm.ChatMessage(role=role, content=[text], interrupted=interrupted))
    return chat


async def spoken(brain: RestaurantBrain, chat: llm.ChatContext, turns: set[str] | None = None) -> str:
    """The reply's text; the turn each piece of it carries goes in `turns`."""
    text = ""
    async with brain.chat(chat_ctx=chat) as stream:
        async for chunk in stream:
            if chunk.delta and chunk.delta.content:
                text += chunk.delta.content
                if turns is not None:
                    turns.add((chunk.delta.extra or {}).get(TURN))
    return text


async def test_speaks_the_short_line_then_the_answer_as_one_reply():
    answers: list[Answer] = []
    line = FakeLine([Working("Je regarde."), Answer(reply="J’ai une table à 20 h.", outcome="answered")])
    state = CallState(line=line, language="fr", on_answer=answers.append)
    turns: set[str] = set()
    said = await spoken(RestaurantBrain(state), conversation(("user", "Une table pour quatre vendredi", False)), turns)
    assert said == "Je regarde. J’ai une table à 20 h."
    assert [answer.reply for answer in answers] == ["J’ai une table à 20 h."]
    assert state.working_lines == ["Je regarde."]
    assert line.calls[0][1:] == ("Une table pour quatre vendredi", "fr", None, None)
    # Every piece of the reply names its turn, so the agent learns what the caller heard of which turn.
    assert turns == {line.calls[0][0]} == {state.last_turn}


async def test_tells_the_restaurant_how_much_of_a_cut_reply_the_caller_heard():
    line = FakeLine([Answer(reply="Le dimanche, nous sommes fermés.", outcome="answered")])
    state = CallState(line=line, language="fr", working_lines=["Je regarde."], last_turn="turn_a")
    state.spoken["turn_a"] = Spoken("Je regarde. Nous sommes ouverts du mardi", cut_short=True)
    await spoken(RestaurantBrain(state), conversation(("user", "Et le dimanche ?", False)))
    assert line.calls[0][3:] == ("Nous sommes ouverts du mardi", None)


async def test_tells_the_restaurant_which_reply_the_caller_never_heard():
    # "Bonsoir." ended a turn, and the caller spoke on before its reply began: nothing of it played.
    line = FakeLine([Answer(reply="Pour combien de personnes ?", outcome="answered")])
    state = CallState(line=line, language="fr", last_turn="turn_a")
    await spoken(RestaurantBrain(state), conversation(("user", "Bonsoir.", False), ("user", "Je voudrais réserver.", False)))
    assert line.calls[0][3:] == (None, "turn_a")
    assert state.last_turn == line.calls[0][0]


def test_what_the_caller_heard_of_the_last_reply():
    state = CallState(line=FakeLine(), language="fr", working_lines=["Je regarde."])
    assert state.heard_of_last_reply() == (None, None)  # no turn yet
    state.last_turn = "turn_a"
    assert state.heard_of_last_reply() == (None, "turn_a")  # nothing of it played
    for heard_nothing in ("Je reg", "Je regarde."):
        state.spoken["turn_a"] = Spoken(heard_nothing, cut_short=True)
        assert state.heard_of_last_reply() == (None, "turn_a")
    state.spoken["turn_a"] = Spoken("Je regarde. Nous avons une table", cut_short=True)
    assert state.heard_of_last_reply() == ("Nous avons une table", None)
    state.spoken["turn_a"] = Spoken("Je regarde. Nous avons une table à 20 h.", cut_short=False)
    assert state.heard_of_last_reply() == (None, None)  # heard it all


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


def test_says_which_key_the_chosen_speech_is_missing_without_its_value():
    base = {"MAITRE_API_URL": "http://127.0.0.1:8787", "MAITRE_AGENT_TOKEN": "t"}
    assert Settings.from_env(base).problems() == [
        "LIVEKIT_API_KEY is missing, for inference:deepgram/nova-3",
        "LIVEKIT_API_SECRET is missing, for inference:deepgram/nova-3",
        "LIVEKIT_API_KEY is missing, for inference:deepgram/aura-2:agathe",
        "LIVEKIT_API_SECRET is missing, for inference:deepgram/aura-2:agathe",
    ]
    configured = Settings.from_env(base | {"LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s"})
    assert configured.problems() == []
    assert "secret" not in repr(configured.keys)
    direct = Settings.from_env(base | {"LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s", "VOICE_TTS": "cartesia:sonic-3"})
    assert direct.problems() == ["CARTESIA_API_KEY is missing, for cartesia:sonic-3"]
