"""The reply's audio: the short line said while the tools run is synthesized on its own, at once, without silence before it."""

import asyncio
from types import SimpleNamespace

import numpy as np
from livekit import rtc
from livekit.agents import APIConnectOptions

from maitre_voice.agent import RestaurantLine
from maitre_voice.brain import CallState

RATE = 24_000
#: The silence the fake voice puts before every sentence, as Aura-2 did before short ones.
LEADING_SILENT_FRAMES = 18


def frame(loud: bool) -> rtc.AudioFrame:
    """50 ms of a tone, or of near silence."""
    samples = (np.sin(np.arange(RATE // 20) / 4) * (8000 if loud else 40)).astype(np.int16)
    return rtc.AudioFrame(samples.tobytes(), RATE, 1, len(samples))


def is_loud(audio: rtc.AudioFrame) -> bool:
    return int(np.abs(np.frombuffer(audio.data, dtype=np.int16)).max()) > 1000


class FakeSynthesis:
    """Speaks the text it was given once its input ends: some silence, then a loud frame per word with a pause inside."""

    def __init__(self, spoken: list[str]) -> None:
        self.text = ""
        self._spoken = spoken
        self._ended = asyncio.Event()

    async def __aenter__(self) -> "FakeSynthesis":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    def push_text(self, chunk: str) -> None:
        self.text += chunk

    def end_input(self) -> None:
        self._spoken.append(self.text.strip())
        self._ended.set()

    def __aiter__(self):
        return self._frames()

    async def _frames(self):
        await self._ended.wait()
        for _ in range(LEADING_SILENT_FRAMES):
            yield SimpleNamespace(frame=frame(loud=False))
        for index, _word in enumerate(self.text.split()):
            if index:
                yield SimpleNamespace(frame=frame(loud=False))
            yield SimpleNamespace(frame=frame(loud=True))


class FakeEngine:
    capabilities = SimpleNamespace(streaming=True)

    def __init__(self) -> None:
        self.spoken: list[str] = []

    def stream(self, *, conn_options: APIConnectOptions) -> FakeSynthesis:
        return FakeSynthesis(self.spoken)


def line_with(*working: str) -> tuple[RestaurantLine, FakeEngine]:
    engine = FakeEngine()
    state = CallState(line=None, language="fr", working_lines=list(working))  # type: ignore[arg-type]
    return RestaurantLine(state, engine), engine  # type: ignore[arg-type]


async def text_of(*chunks: str, hold_before: int | None = None, released: asyncio.Event | None = None):
    for index, chunk in enumerate(chunks):
        if index == hold_before and released is not None:
            await released.wait()
        yield chunk


async def test_the_waiting_line_is_spoken_before_the_reply_arrives():
    agent, engine = line_with("Je regarde.")
    released = asyncio.Event()
    frames = agent._speak(text_of("Je regarde.", " ", "Nous avons une table.", hold_before=2, released=released), APIConnectOptions())

    first = await asyncio.wait_for(anext(frames), timeout=1)
    assert is_loud(first)
    assert engine.spoken == ["Je regarde."]
    assert not released.is_set()

    released.set()
    _rest = [audio async for audio in frames]
    assert engine.spoken == ["Je regarde.", "Nous avons une table."]


async def test_a_line_cut_into_pieces_is_still_found():
    agent, engine = line_with("Je m’en occupe.")
    _frames = [audio async for audio in agent._speak(text_of("Je", " m’en", " occupe.", " ", "C’est noté."), APIConnectOptions())]
    assert engine.spoken == ["Je m’en occupe.", "C’est noté."]


async def test_a_reply_without_a_waiting_line_is_one_synthesis():
    agent, engine = line_with("Je regarde.")
    _frames = [audio async for audio in agent._speak(text_of("Bonsoir, ", "que puis-je faire pour vous ?"), APIConnectOptions())]
    assert engine.spoken == ["Bonsoir, que puis-je faire pour vous ?"]


async def test_nothing_is_synthesized_for_the_blank_after_a_line_with_no_reply():
    agent, engine = line_with("Un instant.")
    _frames = [audio async for audio in agent._speak(text_of("Un instant.", " ", "  "), APIConnectOptions())]
    assert engine.spoken == ["Un instant."]


async def test_the_silence_before_each_part_is_cut_and_the_silence_inside_is_kept():
    agent, _engine = line_with("Je regarde.")
    frames = [audio async for audio in agent._speak(text_of("Je regarde.", " ", "Une table."), APIConnectOptions())]
    # Each part opens on its first word: "Je regarde." then "Une table.", two words each, one pause inside each.
    assert [is_loud(audio) for audio in frames] == [True, False, True, True, False, True]
