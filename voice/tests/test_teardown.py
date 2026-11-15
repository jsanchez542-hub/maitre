"""The data channels a call's end closes: LiveKit's native SDK logs each as an error, and none is once the call is over."""

import logging
from types import SimpleNamespace

from maitre_voice import agent
from maitre_voice.agent import PhoneCall
from maitre_voice.teardown import HungUpChannels

CLOSED = [f"publisher data channel '{label}' closed unexpectedly" for label in ("_reliable", "_lossy", "_data_track")]
WHERE = "livekit::rtc_engine::rtc_session"


def sdk_line(message: str) -> logging.LogRecord:
    """A line of LiveKit's native SDK as LiveKit's library logs it: where in the SDK it comes from, then what it says."""
    return logging.LogRecord("livekit", logging.ERROR, __file__, 0, "%s:%s:%s - %s", (WHERE, 812, WHERE, message), None)


def kept(channels: HungUpChannels, message: str) -> bool:
    return bool(channels.filter(sdk_line(message)))


def test_the_channels_a_call_closes_stay_out_of_the_log_once_it_is_over():
    channels = HungUpChannels()
    channels.call_started("AJ_1")
    # While the call is going, a channel closed is the call losing it.
    assert all(kept(channels, line) for line in CLOSED)
    channels.call_over("AJ_1")
    assert not any(kept(channels, line) for line in CLOSED)
    # Anything else the SDK says stays.
    assert kept(channels, "connection lost")


def test_a_call_still_going_in_the_process_keeps_them_in():
    # On Windows LiveKit takes calls in threads of one process: the end of one is not the end of the other.
    channels = HungUpChannels()
    channels.call_started("AJ_1")
    channels.call_started("AJ_2")
    channels.call_over("AJ_1")
    assert kept(channels, CLOSED[0])
    channels.call_over("AJ_2")
    assert not kept(channels, CLOSED[0])


def test_the_process_that_takes_calls_filters_the_logger_of_livekits_library(monkeypatch, caplog):
    monkeypatch.setattr(agent.silero.VAD, "load", lambda: "vad")
    livekit = logging.getLogger("livekit")
    try:
        agent.prewarm(SimpleNamespace(userdata={}))
        with caplog.at_level(logging.ERROR):
            for message in (CLOSED[0], "connection lost"):
                livekit.error("%s:%s:%s - %s", WHERE, 812, WHERE, message)
    finally:
        livekit.removeFilter(agent.hung_up_channels)
    assert [record.args[-1] for record in caplog.records] == ["connection lost"]


def ending_call(channels: HungUpChannels, rooms_gone: list[bool]) -> SimpleNamespace:
    """A call as its end sees it, with a room whose deletion records whether the SDK's lines would be kept."""

    async def delete_room() -> None:
        rooms_gone.append(kept(channels, CLOSED[0]))

    async def end(ended_by: str, seconds: float, latencies: list[float]) -> str:
        return ""

    return SimpleNamespace(
        _ending=False,
        _ctx=SimpleNamespace(job=SimpleNamespace(id="AJ_1"), delete_room=delete_room),
        _line=SimpleNamespace(end=end),
        latencies=lambda: [],
        voice_to_voice_ms=lambda: [],
        seconds=40.0,
    )


async def test_a_call_is_over_for_the_log_before_its_room_goes(monkeypatch):
    channels = HungUpChannels()
    monkeypatch.setattr(agent, "hung_up_channels", channels)
    rooms_gone: list[bool] = []
    channels.call_started("AJ_1")
    await PhoneCall.end(ending_call(channels, rooms_gone), "goodbye")
    assert rooms_gone == [False]
    # A caller who hangs up leaves the room to LiveKit, which closes it later: the call is over all the same.
    channels.call_started("AJ_1")
    await PhoneCall.end(ending_call(channels, rooms_gone), "caller")
    assert rooms_gone == [False]
    assert not kept(channels, CLOSED[0])
