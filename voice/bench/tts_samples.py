"""Speech synthesis compared by ear, blind, on what the restaurant really says.

    uv run python bench/tts_samples.py "elevenlabs:eleven_flash_v2_5:<voice>" "inference:cartesia/sonic-3:<voice>" ...

Each candidate reads the same French lines (the greeting, the short line said
while checking, a read-back, an allergen answer, the keypad request). The audio
goes to bench/audio/tts/<letter>/, with a page to listen to them side by side
under letters only; which letter is which provider is kept in key.json, to be
opened after choosing. Time to first audio is measured for each line.
"""

from __future__ import annotations

import asyncio
import json
import random
import statistics
import sys
import time
import wave
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents.utils import http_context

from maitre_voice.speech import build_tts

LINES = [
    "Bonjour, vous êtes bien chez Merrain. Je suis l’assistant vocal de réservation, un programme d’intelligence artificielle, "
    "et cet appel peut être enregistré. Que puis-je faire pour vous ?",
    "Je regarde.",
    "J’ai une table pour quatre personnes le vendredi 16 octobre à 20 h 30. À quel nom dois-je réserver, "
    "et est-ce que quelqu’un a une allergie ou une intolérance ?",
    "La fiche du plat « Mousse au chocolat » ne précise pas s’il contient des fruits à coque. "
    "Je préfère transmettre votre question à l’équipe plutôt que de deviner.",
    "C’est noté au nom de Dupont : vendredi 16 octobre à 20 h 30, pour quatre personnes. À vendredi !",
    "Pour finaliser, pouvez-vous taper votre numéro de téléphone sur le clavier, puis la touche dièse ?",
]

OUT = Path(__file__).with_name("audio") / "tts"


async def synthesize(spec: str, folder: Path) -> list[float]:
    """Writes one WAV per line and returns the time to first audio of each, in milliseconds."""
    engine = build_tts(spec, "fr")
    firsts: list[float] = []
    for index, line in enumerate(LINES, start=1):
        started = time.monotonic()
        first: float | None = None
        frames = []
        async for audio in engine.synthesize(line):
            if first is None:
                first = (time.monotonic() - started) * 1000
            frames.append(audio.frame)
        firsts.append(first or 0.0)
        with wave.open(str(folder / f"{index}.wav"), "wb") as out:
            out.setnchannels(frames[0].num_channels)
            out.setsampwidth(2)
            out.setframerate(frames[0].sample_rate)
            for frame in frames:
                out.writeframes(bytes(frame.data))
    await engine.aclose()
    return firsts


def listening_page(letters: list[str]) -> str:
    rows = "\n".join(
        f"<tr><th>{line[:70]}{'…' if len(line) > 70 else ''}</th>"
        + "".join(f'<td><audio controls preload="none" src="{letter}/{index}.wav"></audio></td>' for letter in letters)
        + "</tr>"
        for index, line in enumerate(LINES, start=1)
    )
    heads = "".join(f"<th>Voix {letter}</th>" for letter in letters)
    style = (
        "body{font:15px system-ui;margin:24px;background:#f6f6f4}table{border-collapse:collapse}"
        "th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:middle}th{font-weight:600;max-width:320px}"
    )
    intro = "Écoutez chaque phrase avec chaque voix. Notez la meilleure et celle à écarter. Les lettres ne disent pas qui est qui."
    return (
        f'<!doctype html><html lang="fr"><meta charset="utf-8"><title>Maître | voix à l’aveugle</title><style>{style}</style>'
        f"<h1>Quelle voix pour Merrain ?</h1><p>{intro}</p><table><tr><th>Phrase</th>{heads}</tr>{rows}</table></html>"
    )


async def main(specs: list[str]) -> None:
    load_dotenv(".env.local")
    if not specs:
        raise SystemExit("name the candidates: provider:model:voice ...")
    letters = [chr(ord("A") + index) for index in range(len(specs))]
    shuffled = specs[:]
    random.shuffle(shuffled)
    key = {}
    async with http_context.open():
        for letter, spec in zip(letters, shuffled, strict=True):
            folder = OUT / letter
            folder.mkdir(parents=True, exist_ok=True)
            try:
                firsts = await synthesize(spec, folder)
            except Exception as error:  # a candidate that fails is reported, the others still run
                print(f"{letter}: failed ({type(error).__name__}: {str(error)[:120]})")
                key[letter] = {"spec": spec, "error": str(error)[:200]}
                continue
            key[letter] = {"spec": spec, "firstAudioMs": [round(ms) for ms in firsts]}
            print(f"{letter}: first audio p50 {statistics.median(firsts):.0f} ms, max {max(firsts):.0f} ms")
    (OUT / "key.json").write_text(json.dumps(key, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "listen.html").write_text(listening_page([letter for letter in letters if "error" not in key[letter]]), encoding="utf-8")
    print(f"Listen: {OUT / 'listen.html'}  (the key is in key.json: open it after choosing)")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
