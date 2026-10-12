"""Speech recognition and speech synthesis, chosen by name so the benchmark can swap them without code changes.

A name is "provider:model", with ":voice" for synthesis. "inference:" goes
through LiveKit Inference with the LiveKit project's own key; the other
providers need their own key in the environment.
"""

from __future__ import annotations

from livekit.agents import inference, stt, tts
from livekit.plugins import cartesia, deepgram, elevenlabs, mistralai

#: Words speech recognition should expect on a restaurant's line: the name, and what callers ask about.
KEYTERMS = ["Merrain", "allergie", "allergies", "gluten", "arachides", "fruits à coque", "réservation", "couverts"]


def _split(spec: str, parts: int) -> list[str]:
    pieces = spec.split(":", parts - 1)
    return pieces + [""] * (parts - len(pieces))


def build_stt(spec: str, language: str) -> stt.STT:
    provider, model = _split(spec, 2)
    if provider == "deepgram" and model.startswith("flux"):
        # Flux decides when the caller has finished speaking from how they speak, not only from silence.
        return deepgram.STTv2(model=model, keyterm=KEYTERMS, **({"language_hint": ["fr", "en", "es"]} if model.endswith("multi") else {}))
    if provider == "deepgram":
        return deepgram.STT(model=model or "nova-3", language="multi", keyterm=KEYTERMS)
    if provider == "mistral":
        return mistralai.STT(model=model or "voxtral-mini-latest", language=language)
    if provider == "elevenlabs":
        return elevenlabs.STT(model_id=model or "scribe_v2_realtime", language_code=language)
    if provider == "inference":
        return inference.STT.from_model_string(model)
    raise ValueError(f"unknown speech recognition: {spec}")


def build_tts(spec: str, language: str) -> tts.TTS:
    provider, model, voice = _split(spec, 3)
    if provider == "cartesia":
        return cartesia.TTS(model=model or "sonic-3", language=language, **({"voice": voice} if voice else {}))
    if provider == "elevenlabs":
        return elevenlabs.TTS(model=model or "eleven_flash_v2_5", language=language, **({"voice_id": voice} if voice else {}))
    if provider == "mistral":
        return mistralai.TTS(model=model or "voxtral-tts", **({"voice": voice} if voice else {}))
    if provider == "deepgram":
        return deepgram.TTS(model=model or "aura-2-agathe-fr")
    if provider == "inference":
        return inference.TTS.from_model_string(f"{model}:{voice}" if voice else model)
    raise ValueError(f"unknown speech synthesis: {spec}")


def ends_turns_itself(spec: str) -> bool:
    """Whether speech recognition says when the caller has finished, so no separate turn detector is needed."""
    provider, model = _split(spec, 2)
    return (provider == "deepgram" and model.startswith("flux")) or (provider == "inference" and "/flux" in model)


def follow_language(engine: tts.TTS, language: str) -> None:
    """Speaks the caller's language after they switch, when the synthesis can be told."""
    update = getattr(engine, "update_options", None)
    if update is None:
        return
    try:
        update(language=language)
    except TypeError:
        # This synthesis reads the language from the text itself.
        pass
