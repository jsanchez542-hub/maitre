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


async def test_a_caller_who_asks_something_in_the_pause_keeps_the_line_open():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.played("turn_bye", interrupted=False)
    goodbye.caller_speaking(True)
    assert goodbye.caller_said("Ah, une dernière chose : vous avez un parking ?") is True
    goodbye.caller_speaking(False)
    await pause_passes()
    assert hung_up == []


async def test_a_goodbye_said_back_in_the_pause_gets_no_answer_and_the_line_hangs_up():
    # As people do when they are told goodbye, in any of the line's languages, whatever language the call is in.
    for said in ("Muchas gracias, adiós.", "Merci, bonne soirée à vous aussi.", "Okay, thank you, bye bye."):
        goodbye, hung_up = line()
        goodbye.answered("turn_bye", ends_call=True)
        goodbye.played("turn_bye", interrupted=False)
        goodbye.caller_speaking(True)
        assert goodbye.caller_said(said) is False
        await pause_passes()
        assert hung_up == []  # not while they are still heard
        goodbye.caller_speaking(False)
        await pause_passes()
        assert hung_up == ["hung up"]


async def test_a_goodbye_said_over_the_lines_own_ends_the_call_too():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.caller_speaking(True)
    # Their words cut the goodbye short: they heard some of it, and that was their answer to it.
    goodbye.played("turn_bye", interrupted=True)
    assert goodbye.caller_said("Gracias, hasta luego.") is False
    goodbye.caller_speaking(False)
    await pause_passes()
    assert hung_up == ["hung up"]


async def test_a_question_asked_over_the_goodbye_keeps_the_line_open():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.caller_speaking(True)
    goodbye.played("turn_bye", interrupted=True)
    assert goodbye.caller_said("Perdone, ¿tienen terraza?") is True
    goodbye.caller_speaking(False)
    await pause_passes()
    assert hung_up == []


async def test_a_thanks_before_any_of_the_goodbye_was_heard_is_a_turn_like_any_other():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    # Said while the goodbye was on its way, which then never played: the restaurant answers, and says it again.
    assert goodbye.caller_said("Merci.") is True
    goodbye.played("turn_bye", interrupted=True, heard=False)
    assert goodbye.caller_said("Merci.") is True
    await pause_passes()
    assert hung_up == []


async def test_a_thanks_heard_while_the_goodbye_plays_ends_the_call_once_it_has_played():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    # Recognition hands over the caller's "gracias" before the goodbye has finished playing.
    assert goodbye.caller_said("Gracias.") is True
    goodbye.played("turn_bye", interrupted=False)
    # By the time the restaurant would be asked, the goodbye has been heard: the thanks was its answer.
    assert goodbye.caller_said("Gracias.") is False
    await pause_passes()
    assert hung_up == ["hung up"]


async def test_a_reply_that_comes_after_the_goodbye_is_heard_before_the_line_hangs_up():
    goodbye, hung_up = line()
    goodbye.answered("turn_bye", ends_call=True)
    goodbye.played("turn_bye", interrupted=False)
    # A number typed on the keypad in the pause: the restaurant answers it, and that reply does not end the call.
    goodbye.answered("turn_keypad", ends_call=False)
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
