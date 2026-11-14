from types import SimpleNamespace

from maitre_voice.agent import PhoneCall
from maitre_voice.keypad import Keypad


def test_sends_the_number_when_the_hash_key_ends_it():
    keypad = Keypad()
    assert [keypad.press(key) for key in "0612345678"] == [None] * 10
    assert keypad.typing
    assert keypad.press("#") == "0612345678#"
    assert not keypad.typing


def test_starts_again_on_the_star_key_and_ignores_anything_else():
    keypad = Keypad()
    for key in "0699":
        keypad.press(key)
    keypad.press("*")
    for key in "06A1234-5678":
        keypad.press(key)
    assert keypad.press("#") == "0612345678#"


def test_sends_a_number_typed_without_the_hash_key_only_when_it_can_be_one():
    keypad = Keypad()
    for key in "0612":
        keypad.press(key)
    assert keypad.flush() is None
    for key in "345678":
        keypad.press(key)
    assert keypad.flush() == "0612345678#"
    assert keypad.flush() is None


def test_a_hash_key_alone_sends_nothing_and_a_short_number_is_still_sent_for_the_restaurant_to_refuse():
    keypad = Keypad()
    assert keypad.press("#") is None
    keypad.press("1")
    keypad.press("2")
    # The restaurant answers that it cannot read it, in words the caller hears.
    assert keypad.press("#") == "12#"


def test_keeps_at_most_twenty_digits():
    keypad = Keypad()
    for _ in range(30):
        keypad.press("1")
    assert keypad.press("#") == "1" * 20 + "#"


def at_the_keypad(shown: str) -> tuple[SimpleNamespace, list[str]]:
    """A call as its keypad sees it: whether the restaurant waits for a number, and the numbers sent to it."""
    sent: list[str] = []
    call = SimpleNamespace(_keypad=Keypad(), _keypad_timer=None, _keypad_shown=shown)
    call._send_number = sent.append
    call._spawn = lambda number: None
    call._keypad_paused = lambda: None
    return call, sent


def type_number(call: SimpleNamespace, keys: str) -> None:
    for key in keys:
        PhoneCall._on_key(call, SimpleNamespace(digit=key))


async def test_keys_are_a_number_only_while_the_restaurant_waits_for_one():
    # With the phone network's number, or one already typed, the restaurant asks for none: keys change nothing.
    call, sent = at_the_keypad("closed")
    type_number(call, "0699999999#")
    assert sent == [] and not call._keypad.typing
    # Asked for the number, the caller types it and the hash key sends it.
    call, sent = at_the_keypad("open")
    type_number(call, "0622222222#")
    assert sent == ["0622222222#"]
