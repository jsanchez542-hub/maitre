"""A call's turns against the real Worker and the real model, without LiveKit: the restaurant's side of a phone call.

Runs a short French booking call on the local Worker's restaurant line and prints,
for each turn, when the short line arrived and when the answer did. The model is
the Worker's own (VOICE_MODEL, or MODEL), so this costs a few tenths of a cent.

    uv run python bench/line_check.py
"""

from __future__ import annotations

import asyncio
import secrets
import time

import aiohttp
from dotenv import load_dotenv

from maitre_voice.config import Settings
from maitre_voice.line import Answer, Call, Line, Working, new_turn_id

CALLER = [
    "Bonsoir, je voudrais réserver une table pour quatre personnes vendredi prochain vers vingt heures.",
    "Au nom de Dupont, et non, pas d'allergie.",
    "Est-ce que la mousse au chocolat contient des fruits à coque ?",
]


async def main() -> None:
    load_dotenv(".env.local")
    settings = Settings.from_env()
    if settings.problems():
        raise SystemExit("; ".join(settings.problems()))
    session_id = f"call_check_{secrets.token_hex(6)}"
    async with aiohttp.ClientSession() as http:
        line = Line(http, Call.restaurant(settings.api_url, settings.restaurant_id, session_id), settings.agent_token)
        started = await line.start("fr")
        print(f"greeting: {started.greeting}\n")
        began = time.monotonic()
        for message in CALLER:
            await say_and_hear(line.turn(new_turn_id(), message, "fr"), f"caller: {message}")
            answer = last_answer
            if answer and answer.ask_for_phone:
                await say_and_hear(line.keypad(new_turn_id(), "0612345678#"), "caller types 06 12 34 56 78 #")
        await line.end("caller", time.monotonic() - began, [])


last_answer: Answer | None = None


async def say_and_hear(events, label: str) -> None:
    global last_answer
    print(label)
    sent = time.monotonic()
    async for event in events:
        elapsed = (time.monotonic() - sent) * 1000
        if isinstance(event, Working):
            print(f"  {elapsed:6.0f} ms  short line: {event.say}")
        else:
            last_answer = event
            extra = f"  booked {event.booked[0].date} {event.booked[0].time}" if event.booked else ""
            print(f"  {elapsed:6.0f} ms  answer: {event.reply}{extra}{'  [asks for the keypad]' if event.ask_for_phone else ''}")
    print()


if __name__ == "__main__":
    asyncio.run(main())
