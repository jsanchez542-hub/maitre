"""The language a call is held in, and when it follows the caller into another."""

from __future__ import annotations

from .config import LANGUAGES
from .courtesy import only_courtesy

#: Words in a row in another language before the call follows the caller into it. Speech recognition names a
#: language for every few words it hears, and a name, a dish or a short "OK, thank you" is often named wrongly:
#: three words were enough, and one such phrase moved a whole call, its voice and its answers, to another language.
WORDS_TO_FOLLOW = 5


class CallerLanguage:
    """The call's language. It changes once the caller has kept to another one for a few words."""

    def __init__(self, language: str) -> None:
        self.language = language
        self._other: str | None = None
        self._words = 0

    def heard(self, language: str, said: str) -> bool:
        """What recognition heard, and the language it heard it in. Whether the call's language has changed.

        The words add up across what the caller says in a row in the other language, and start again as soon as
        they say something in the call's own.
        """
        words = len(said.split())
        # One word, a thanks or a goodbye tell nothing of the language a caller wants: "OK" and "bye" are said on any line.
        if language not in LANGUAGES or words < 2 or only_courtesy(said):
            return False
        if language == self.language:
            self._other, self._words = None, 0
            return False
        if language != self._other:
            self._other, self._words = language, 0
        self._words += words
        if self._words < WORDS_TO_FOLLOW:
            return False
        self.language, self._other, self._words = language, None, 0
        return True
