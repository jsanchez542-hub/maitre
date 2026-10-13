"""The line's own hang-up after its goodbye: once the goodbye has been heard, and never on a caller who goes on."""

import asyncio

from maitre_voice.brain import Goodbye

PAUSE = 0.05


def line() -> tuple[Goodbye, list[str]]:
    hung_up: list[str] = []
    return Goodbye(lambda: hung_up.append("hung up"), PAUSE), hung_up


async def pause_passes() -> None:
    await asyncio.sleep(PAUSE * 3)


async def test_hangs_up_once_the_goodbye_has_been_heard_and_the_pause_has_passed():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    await pause_passes()
    assert hung_up == []  # said, not heard yet
    goodbye.played("turn_bye", interrupted=False)
    assert hung_up == []  # the pause first
    await pause_passes()
    assert hung_up == ["hung up"]


async def test_never_hangs_up_after_a_reply_that_does_not_end_the_call():
    goodbye, hung_up = line()
    goodbye.answered("turn_a", ends_call=False)
    goodbye.played("turn_a", interrupted=False)
    goodbye.answered("turn_b", ends_call=True)
    # An earlier reply that finishes playing is not the goodbye.
    goodbye.played("turn_a", interrupted=False)
    await pause_passes()
    assert hung_up == []


async def test_a_caller_who_speaks_over_the_goodbye_keeps_the_line_open():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.played("turn_bye", interrupted=True)
    await pause_passes()
    assert hung_up == []


async def test_a_caller_who_says_more_in_the_pause_keeps_the_line_open():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.played("turn_bye", interrupted=False)
    goodbye.caller_speaking(True)
    goodbye.caller_said()
    goodbye.caller_speaking(False)
    await pause_passes()
    assert hung_up == []


async def test_a_noise_in_the_pause_only_delays_the_hang_up():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.played("turn_bye", interrupted=False)
    goodbye.caller_speaking(True)
    await pause_passes()
    assert hung_up == []  # not while the caller is heard
    goodbye.caller_speaking(False)
    await pause_passes()
    assert hung_up == ["hung up"]
