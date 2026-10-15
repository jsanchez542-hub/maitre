"""The line's voice in each language it speaks, checked without a listener: what speech recognition hears.

    uv run python bench/tts_languages.py es "inference:cartesia/sonic-3.5:<voice>" "inference:cartesia/sonic-3.5:<voice>" ...

The French voice was chosen by ear, in French. The English and Spanish ones
follow from it, and nobody can listen again each time a voice changes. Each
candidate reads what the restaurant really says in that language; LiveKit
Inference's speech recognition, told the language, writes down what it heard,
and the script prints both, with the share of words heard as written. A voice
that slips into another accent, swallows words or misreads a time shows there.
Time to first audio is measured too. The audio, and a page to listen to it, go
to bench/audio/tts-<language>/.
"""

from __future__ import annotations

import asyncio
import re
import statistics
import sys
import time
import unicodedata
import wave
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import inference, stt
from livekit.agents.utils import http_context

from maitre_voice.speech import DEEPGRAM_PRIVACY, build_tts

#: What the restaurant says on the phone, as the Worker words it: the greeting, a waiting line, an offer, an
#: allergen question passed to the team, the read-back, and the keypad request.
LINES = {
    "fr": [
        "Merrain, bonsoir. Je suis l’assistant de réservation, une intelligence artificielle. Que puis-je faire pour vous ?",
        "Je regarde.",
        "J’ai une table pour quatre personnes le vendredi 16 octobre à 20 h 30. À quel nom dois-je réserver, "
        "et est-ce que quelqu’un a une allergie ou une intolérance ?",
        "La fiche du plat « Mousse au chocolat » ne précise pas s’il contient des fruits à coque. "
        "Je préfère transmettre votre question à l’équipe plutôt que de deviner.",
        "C’est noté au nom de Dupont : vendredi 16 octobre à 20 h 30, pour quatre personnes. À vendredi !",
        "Pour finaliser, pouvez-vous taper votre numéro de téléphone sur le clavier, puis la touche dièse ?",
    ],
    "en": [
        "Merrain, good evening. This is the booking assistant, an AI. How can I help you?",
        "Let me check.",
        "I have a table for four on Friday 16 October at 8:30 pm. What name should I put it under, "
        "and does anyone have an allergy or an intolerance?",
        "The kitchen’s sheet for the chocolate mousse does not say whether it contains tree nuts. "
        "I would rather pass your question on to the team than guess.",
        "That’s booked under the name Clarke: Friday 16 October at 8:30 pm, for four people. See you on Friday!",
        "To finish, could you type your phone number on the keypad, then the hash key?",
    ],
    "es": [
        "Merrain, buenas noches. Le atiende el asistente de reservas, una inteligencia artificial. ¿En qué puedo ayudarle?",
        "Ahora lo miro.",
        "Tengo una mesa para cuatro personas el viernes 16 de octubre a las 20:30. ¿A qué nombre la reservo, "
        "y alguien tiene alguna alergia o intolerancia?",
        "La ficha de la mousse de chocolate no indica si contiene frutos secos. Prefiero pasar su pregunta al equipo antes que adivinar.",
        "Queda anotada a nombre de Ortega: viernes 16 de octubre a las 20:30, para cuatro personas. ¡Hasta el viernes!",
        "Para terminar, ¿puede marcar su número de teléfono en el teclado y después la tecla almohadilla?",
    ],
}
#: Speech recognition that writes down what each voice said, in the language it was asked to speak.
LISTENER = "deepgram/nova-3"
#: Silence after each line, so recognition hears the end of it.
TAIL_SECONDS = 1.0


def words(text: str) -> list[str]:
    """Words to compare: lower case, without punctuation or accents, and without numbers, which recognition may
    write as digits or as words ("20:30", "veinte treinta"): the transcript printed beside it shows those."""
    plain = unicodedata.normalize("NFKD", text.lower())
    plain = "".join(char for char in plain if not unicodedata.combining(char))
    return [word for word in re.findall(r"[a-z']+", plain.replace("’", "'")) if word not in {"'", "pm", "h"}]


def heard_share(said: list[str], heard: list[str]) -> float:
    """The share of the words said that recognition heard, in order. Words heard besides, such as a time
    spelled out ("vingt heures et demie"), do not count against the voice."""
    if not said:
        return 1.0
    previous = [0] * (len(heard) + 1)
    for word in said:
        current = [0]
        for position, other in enumerate(heard, start=1):
            current.append(previous[position - 1] + 1 if word == other else max(previous[position], current[position - 1]))
        previous = current
    return previous[-1] / len(said)


async def synthesize(spec: str, language: str, line: str) -> tuple[list[rtc.AudioFrame], float]:
    engine = build_tts(spec, language)
    started = time.monotonic()
    first: float | None = None
    frames = []
    async for audio in engine.synthesize(line):
        if first is None:
            first = (time.monotonic() - started) * 1000
        frames.append(audio.frame)
    await engine.aclose()
    return frames, first or 0.0


async def transcribe(frames: list[rtc.AudioFrame], language: str) -> str:
    listener = inference.STT(model=LISTENER, language=language, extra_kwargs=dict(DEEPGRAM_PRIVACY))
    stream = listener.stream()
    for frame in frames:
        stream.push_frame(frame)
    rate, channels = frames[0].sample_rate, frames[0].num_channels
    silence = int(rate * TAIL_SECONDS)
    tail = rtc.AudioFrame(data=bytes(silence * channels * 2), sample_rate=rate, num_channels=channels, samples_per_channel=silence)
    stream.push_frame(tail)
    stream.end_input()
    heard = [
        event.alternatives[0].text async for event in stream if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT and event.alternatives
    ]
    await stream.aclose()
    await listener.aclose()
    return " ".join(heard)


def save(frames: list[rtc.AudioFrame], path: Path) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(frames[0].num_channels)
        out.setsampwidth(2)
        out.setframerate(frames[0].sample_rate)
        for frame in frames:
            out.writeframes(bytes(frame.data))


def listening_page(language: str, specs: list[str]) -> str:
    def cells(index: int) -> str:
        return "".join(f'<td><audio controls preload="none" src="{n}/{index}.wav"></audio></td>' for n in range(1, len(specs) + 1))

    rows = "\n".join(f"<tr><th>{line}</th>{cells(index)}</tr>" for index, line in enumerate(LINES[language], start=1))
    heads = "".join(f"<th>{spec.rsplit(':', 1)[-1][:8]}</th>" for spec in specs)
    style = (
        "body{font:15px system-ui;margin:24px}table{border-collapse:collapse}"
        "th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}"
    )
    head = f'<!doctype html><html lang="{language}"><meta charset="utf-8"><title>Maître · {language}</title><style>{style}</style>'
    return f"{head}<table><tr><th></th>{heads}</tr>{rows}</table></html>"


async def main(language: str, specs: list[str]) -> None:
    load_dotenv(".env.local")
    # Accents and « » print as they are, whatever the console's own code page.
    sys.stdout.reconfigure(encoding="utf-8")
    if language not in LINES or not specs:
        raise SystemExit("usage: tts_languages.py fr|en|es provider:model:voice ...")
    out = Path(__file__).with_name("audio") / f"tts-{language}"
    async with http_context.open():
        for number, spec in enumerate(specs, start=1):
            folder = out / str(number)
            folder.mkdir(parents=True, exist_ok=True)
            firsts, shares, report = [], [], []
            try:
                for index, line in enumerate(LINES[language], start=1):
                    frames, first = await synthesize(spec, language, line)
                    save(frames, folder / f"{index}.wav")
                    heard = await transcribe(frames, language)
                    share = heard_share(words(line), words(heard))
                    firsts.append(first)
                    shares.append(share)
                    report.append(f"    {share:4.0%}  {heard}")
            except Exception as error:  # a candidate that fails is reported, the others still run
                print(f"{number}. {spec}: failed ({type(error).__name__}: {str(error)[:160]})")
                continue
            print(f"{number}. {spec}: heard {statistics.mean(shares):.0%}, first audio p50 {statistics.median(firsts):.0f} ms")
            print("\n".join(report))
    (out / "listen.html").write_text(listening_page(language, specs), encoding="utf-8")
    print(f"Listen: {out / 'listen.html'}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "", sys.argv[2:]))
