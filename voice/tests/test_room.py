"""How the agent sits in a call's room: it takes the caller's voice, and never text typed into the room."""

from types import SimpleNamespace

from livekit import rtc

from maitre_voice import agent


def test_a_call_takes_the_callers_voice_and_no_typed_text():
    for kind in (rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD, rtc.ParticipantKind.PARTICIPANT_KIND_SIP):
        room = agent.call_room(SimpleNamespace(kind=kind, identity="visitor-1"))
        # LiveKit's own reading of the options: None is no text input at all.
        assert room.get_text_input_options() is None
        assert room.participant_identity == "visitor-1"
        assert room.close_on_disconnect is True
