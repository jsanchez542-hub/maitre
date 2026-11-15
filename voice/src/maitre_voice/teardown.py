"""What LiveKit's native SDK logs as a call's room goes away: errors that are no fault once the call is over."""

from __future__ import annotations

import logging

#: How the SDK reports each of its data channels found closed, '_reliable', '_lossy' and '_data_track': a line each.
CHANNEL_CLOSED = ("publisher data channel '", "' closed unexpectedly")


class HungUpChannels(logging.Filter):
    """Keeps the data channels a call's end closes out of the log, and keeps them in while a call is going.

    The line hangs up by deleting the call's room, and a room the caller has left is closed soon after. Either way the
    room takes the data channels of whoever is still in it with it, and LiveKit's native SDK logs an error for each of
    the three: at the end of every call, none of them a fault, and a real error goes unseen among them. While a call
    is going, the same lines mean that it is losing its channels: they stay errors.

    On a server LiveKit gives each call a process of its own; on Windows, a thread of one process. The lines are kept
    out only while no call of the process is going.
    """

    def __init__(self) -> None:
        super().__init__()
        self._going: set[str] = set()

    def call_started(self, call: str) -> None:
        self._going.add(call)

    def call_over(self, call: str) -> None:
        self._going.discard(call)

    def filter(self, record: logging.LogRecord) -> bool:
        if self._going:
            return True
        opening, ending = CHANNEL_CLOSED
        message = record.getMessage()
        return not (opening in message and message.endswith(ending))
