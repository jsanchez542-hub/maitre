"""The language a call is held in, and when it follows the caller into another."""

from __future__ import annotations

from .config import LANGUAGES
from .courtesy import only_courtesy, words_of

#: Words in a row in another language before the call follows the caller into it. Speech recognition names a
#: language for every few words it hears, and a name, a dish or a short "OK, thank you" is often named wrongly:
#: three words were enough, and one such phrase moved a whole call, its voice and its answers, to another language.
WORDS_TO_FOLLOW = 5
#: How a caller names each language the line speaks, in any of the three, without accents. The adjectives of
#: things are left out: "tortilla española" and "une tarte anglaise" name no language.
_NAMES = {
    "en": frozenset({"english", "ingles", "anglais"}),
    "es": frozenset({"spanish", "espanol", "castellano", "espagnol"}),
    "fr": frozenset({"french", "frances", "francais"}),
}
_SPEAKS = frozenset("speak speaks speaking habla hablas hablan hablar hablamos hablo parle parles parlez parler parlons parlent".split())


def asked_for(heard_in: str, said: str, current: str) -> str | None:
    """The language a caller asks for by name, or None: "Do you speak English?", "En español, por favor".

    It takes a word for speaking, or the name of the very language the words were heard in: "English, please".
    A language named any other way is a dish or a wine, "French onion soup", and asks for nothing.
    """
    words = words_of(said)
    named = {language for language, names in _NAMES.items() if any(word in names for word in words)}
    if not named or not (heard_in in named or any(word in _SPEAKS for word in words)):
        return None
    others = named - {current}
    if heard_in in others or len(others) != 1:
        # "I don't speak French" names the call's own language, and "English or Spanish?" two: they get the one they speak.
        return heard_in
    return next(iter(others))


class CallerLanguage:
    """The call's language. It changes when the caller asks for another, or has kept to another for a few words."""

    def __init__(self, language: str) -> None:
        self.language = language
        self._other: str | None = None
        self._words = 0

    def heard(self, language: str, said: str) -> bool:
        """What recognition heard, and the language it heard it in. Whether the call's language has changed.

        A caller who asks for a language by name gets it at once. Otherwise the words add up across what they
        say in a row in the other language, and start again as soon as they say something in the call's own.
        """
        if language not in LANGUAGES:
            return False
        if language != self.language and (asked := asked_for(language, said, self.language)) is not None:
            return self._move_to(asked)
        words = len(said.split())
        # One word, a thanks or a goodbye tell nothing of the language a caller wants: "OK" and "bye" are said on any line.
        if words < 2 or only_courtesy(said):
            return False
        if language == self.language:
            self._other, self._words = None, 0
            return False
        if language != self._other:
            self._other, self._words = language, 0
        self._words += words
        return self._words >= WORDS_TO_FOLLOW and self._move_to(language)

    def _move_to(self, language: str) -> bool:
        self.language, self._other, self._words = language, None, 0
        return True
