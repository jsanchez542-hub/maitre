"""Speech recognition and speech synthesis, chosen by name so the benchmark can swap them without code changes.

A name is "provider:model", with ":voice" for synthesis. "inference:" goes
through LiveKit Inference with the LiveKit project's own key; the other
providers need their own key in the environment.
"""

from __future__ import annotations

from dataclasses import dataclass

from livekit.agents import inference, stt, tts
from livekit.plugins import cartesia, deepgram, elevenlabs, mistralai

#: Words speech recognition should expect on any restaurant's line, by language: what callers ask about.
#: The restaurant's own name and dishes come from the restaurant, at the start of each call.
KEYTERMS = {
    "fr": ["allergie", "allergies", "intolérance", "gluten", "arachides", "fruits à coque", "réservation", "couverts"],
    "en": ["allergy", "allergies", "intolerance", "gluten", "peanuts", "tree nuts", "booking", "reservation"],
    "es": ["alergia", "alergias", "intolerancia", "gluten", "cacahuetes", "frutos secos", "reserva", "comensales"],
}


def keyterms_for(language: str, restaurant: tuple[str, ...] = ()) -> list[str]:
    """The restaurant's words first, then the line's own, without repeats."""
    return list(dict.fromkeys([*restaurant, *KEYTERMS.get(language, KEYTERMS["fr"])]))


#: Callers give names, numbers and allergies: Deepgram is told not to keep their audio or text to train its models.
DEEPGRAM_PRIVACY = {"mip_opt_out": True}


@dataclass(frozen=True)
class EndOfTurn:
    """How sure Flux must be that the caller has finished, and how long after their last word it decides anyway.

    None keeps Deepgram's own default (0.7, and 3 to 5 seconds).
    """

    threshold: float | None = None
    timeout_ms: int | None = None

    def options(self) -> dict[str, float | int]:
        chosen = {"eot_threshold": self.threshold, "eot_timeout_ms": self.timeout_ms}
        return {name: value for name, value in chosen.items() if value is not None}


def _split(spec: str, parts: int) -> list[str]:
    pieces = spec.split(":", parts - 1)
    return pieces + [""] * (parts - len(pieces))


def build_stt(spec: str, language: str, end_of_turn: EndOfTurn | None = None, restaurant_terms: tuple[str, ...] = ()) -> stt.STT:
    provider, model = _split(spec, 2)
    end_of_turn = end_of_turn or EndOfTurn()
    terms = keyterms_for(language, restaurant_terms)
    if provider == "deepgram" and model.startswith("flux"):
        # Flux decides when the caller has finished speaking from how they speak, not only from silence.
        return deepgram.STTv2(
            model=model,
            keyterm=terms,
            **({"language_hint": ["fr", "en", "es"]} if model.endswith("multi") else {}),
            **DEEPGRAM_PRIVACY,
            **end_of_turn.options(),
        )
    if provider == "deepgram":
        return deepgram.STT(model=model or "nova-3", language="multi", keyterm=terms, **DEEPGRAM_PRIVACY)
    if provider == "mistral":
        return mistralai.STT(model=model or "voxtral-mini-latest", language=language)
    if provider == "elevenlabs":
        return elevenlabs.STT(model_id=model or "scribe_v2_realtime", language_code=language)
    if provider == "inference" and model.startswith("deepgram/flux"):
        return inference.STT(model=model, extra_kwargs={"keyterm": terms, **DEEPGRAM_PRIVACY, **end_of_turn.options()})
    if provider == "inference" and model.startswith("deepgram/"):
        return inference.STT(model=model, language="multi", extra_kwargs={"keyterm": terms, **DEEPGRAM_PRIVACY})
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
        return deepgram.TTS(model=model or "aura-2-agathe-fr", **DEEPGRAM_PRIVACY)
    if provider == "inference":
        # Through LiveKit Inference, paid from the LiveKit project's own credit: no other provider's key needed.
        extra = {"extra_kwargs": DEEPGRAM_PRIVACY} if model.startswith("deepgram/") else {}
        return inference.TTS(model=model, language=language, **({"voice": voice} if voice else {}), **extra)
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
