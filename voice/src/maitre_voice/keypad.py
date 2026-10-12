"""The phone's keypad: where the caller's number comes from, never from what speech recognition heard."""

from __future__ import annotations

#: Long enough for any international number with its 00 prefix.
MAX_DIGITS = 20
#: Fewer digits than this is not a phone number, even if the caller stops typing.
MIN_DIGITS = 9


class Keypad:
    """Collects the keys a caller presses. The hash key sends them; the star key starts again."""

    def __init__(self) -> None:
        self._digits = ""

    @property
    def typing(self) -> bool:
        return self._digits != ""

    def press(self, key: str) -> str | None:
        """One key. Returns what to send to the restaurant once the hash key ends the number, else None."""
        if key == "*":
            self._digits = ""
        elif key == "#":
            return self.flush(force=True)
        elif len(key) == 1 and key.isdigit() and len(self._digits) < MAX_DIGITS:
            self._digits += key
        return None

    def flush(self, *, force: bool = False) -> str | None:
        """The number so far, for a caller who stopped typing without the hash key: sent only when it can be one."""
        if not self._digits or (not force and len(self._digits) < MIN_DIGITS):
            return None
        digits, self._digits = self._digits, ""
        return f"{digits}#"
