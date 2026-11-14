"""The calls the agent answers at once: it tells LiveKit how full it is, and LiveKit sends no call to a full agent."""

from dataclasses import replace
from types import SimpleNamespace

from livekit.agents import AgentServer

from maitre_voice import agent
from maitre_voice.config import Settings


def answering(calls: int, starting: int = 0) -> SimpleNamespace:
    """An agent as LiveKit's availability rule reads it: the calls it answers, and those accepted and not yet begun."""
    line = SimpleNamespace(
        active_jobs=[object()] * calls,
        _reserved_slots=starting,
        _draining=False,
        _simulation=False,
        _devmode=False,
        _load_threshold=agent.server._load_threshold,
        _num_idle_processes=agent.server._num_idle_processes,
    )
    line._worker_load = agent.call_load(line)
    line._get_effective_load = lambda: AgentServer._get_effective_load(line)
    return line


def takes_one_more(calls: int, starting: int = 0) -> bool:
    """LiveKit's own rule, not a copy of it: a change of theirs that lets a call too many through fails here."""
    return AgentServer._is_available(answering(calls, starting))


def test_the_agent_says_how_full_it_is_by_the_calls_it_answers(monkeypatch):
    monkeypatch.setattr(agent, "settings", replace(agent.settings, max_calls=2))
    assert [agent.call_load(SimpleNamespace(active_jobs=[object()] * calls)) for calls in range(4)] == [0.0, 0.5, 1.0, 1.0]
    monkeypatch.setattr(agent, "settings", replace(agent.settings, max_calls=3))
    assert agent.call_load(SimpleNamespace(active_jobs=[object()] * 2)) < 1.0


def test_livekit_sends_no_call_to_an_agent_that_answers_all_it_can(monkeypatch):
    monkeypatch.setattr(agent, "settings", replace(agent.settings, max_calls=2))
    assert takes_one_more(calls=0)
    assert takes_one_more(calls=1)
    assert not takes_one_more(calls=2)
    # Two callers at the same instant: a call accepted and not yet begun holds its place too.
    assert takes_one_more(calls=0, starting=1)
    assert not takes_one_more(calls=0, starting=2)
    assert not takes_one_more(calls=1, starting=1)


def test_the_agent_is_built_to_count_its_calls_not_its_processor():
    assert agent.server.load_fnc is agent.call_load
    assert agent.server._load_threshold == 1.0


def test_the_calls_at_once_are_a_setting_of_one_at_least():
    base = {"MAITRE_AGENT_TOKEN": "t", "DEEPGRAM_API_KEY": "d", "CARTESIA_API_KEY": "c"}
    assert Settings.from_env(base).max_calls == 2
    assert Settings.from_env(base).problems() == []
    assert Settings.from_env(base | {"VOICE_MAX_CALLS": "3"}).max_calls == 3
    assert Settings.from_env(base | {"VOICE_MAX_CALLS": "0"}).problems() == ["VOICE_MAX_CALLS must be at least 1"]
