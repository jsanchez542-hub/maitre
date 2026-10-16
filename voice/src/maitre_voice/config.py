"""The voice agent's settings, read once from the environment (voice/.env.local on a developer's machine)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .speech import EndOfTurn

LANGUAGES = ("fr", "en", "es")
#: A voice for each language the line speaks, native to it: Aura-2's Agathe, asked for Spanish, made every call in
#: Spanish silent (13 October). French is Cartesia's "French Conversational Lady", chosen by ear in a blind test
#: (15 October); Cartesia lists it as archived, and it still answers: were it retired, the hourly check (health.py)
#: would turn calls off until VOICE_TTS names another. English is "Fiona", British. Spanish is "Sofía - Digital
#: Concierge", Mexican, since 16 October: the first Spanish voice spoke 4.8 syllables a second on a booking line,
#: slow on the phone beside the French one's 7.3; Sofía speaks 6.8. Read back to speech recognition, each is heard
#: at 97 to 100 % of its words (bench/tts_languages.py).
#: With Cartesia's own key: LiveKit's free plan has $2.50 a month of Inference, a hard cap that testing spent on
#: 15 October. The same voices through LiveKit Inference are "inference:cartesia/sonic-3.5:<voice>".
DEFAULT_VOICES = {
    "fr": "cartesia:sonic-3.5:a249eaff-1e96-4d2c-b23b-12efa4f66f41",
    "en": "cartesia:sonic-3.5:a01c369f-6d2d-4185-bc20-b32c225eab70",
    "es": "cartesia:sonic-3.5:4663e61a-a9c2-40e1-94c5-c461ed9d3d31",
}
#: The keys each speech provider needs, by name. LiveKit Inference is paid from the LiveKit project's own credit.
PROVIDER_KEYS = {
    "inference": ("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"),
    "deepgram": ("DEEPGRAM_API_KEY",),
    "cartesia": ("CARTESIA_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "elevenlabs": ("ELEVEN_API_KEY",),
}


@dataclass(frozen=True)
class Settings:
    #: The Maître Worker, and the token of its "agent" routes.
    api_url: str
    agent_token: str
    #: The name LiveKit sends calls to: the Worker's passes ask for it by name.
    agent_name: str
    #: The restaurant a call to the restaurant's own number is for.
    restaurant_id: str
    #: Speech recognition, as "provider:model".
    stt: str
    #: When Flux decides the caller has finished; tuned from measured calls (VOICE_EOT_THRESHOLD, VOICE_EOT_TIMEOUT_MS).
    end_of_turn: EndOfTurn
    #: Seconds of silence from both sides before the line says goodbye and hangs up.
    silence_seconds: float
    #: The longest call on the restaurant's own line; the demo's limit comes from the Worker.
    max_call_seconds: float
    #: How often a demo call tells the Worker how long it has lasted, for the demo's budget.
    usage_every_seconds: float
    #: Soft typing while the restaurant works out its answer, instead of silence.
    thinking_sound: bool
    #: The speech providers' keys the environment has, by name only.
    keys: frozenset[str] = frozenset()
    #: The voice for each language, as "provider:model:voice" (VOICE_TTS for French, VOICE_TTS_EN, VOICE_TTS_ES).
    voices: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_VOICES))

    def voice_for(self, language: str) -> str:
        return self.voices.get(language, self.voices["fr"])

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        token = values.get("MAITRE_AGENT_TOKEN", "")
        return cls(
            api_url=values.get("MAITRE_API_URL", "http://127.0.0.1:8787"),
            agent_token=token,
            agent_name=values.get("MAITRE_AGENT_NAME", "maitre-voice"),
            restaurant_id=values.get("MAITRE_RESTAURANT_ID", "demo"),
            # With Deepgram's own key, as the voices with Cartesia's. Nova-3 with LiveKit's turn detector answered sooner
            # than Flux on measured calls and cut fewer sentences in two.
            stt=values.get("VOICE_STT", "deepgram:nova-3"),
            end_of_turn=EndOfTurn(
                threshold=float(values["VOICE_EOT_THRESHOLD"]) if values.get("VOICE_EOT_THRESHOLD") else None,
                timeout_ms=int(values["VOICE_EOT_TIMEOUT_MS"]) if values.get("VOICE_EOT_TIMEOUT_MS") else None,
            ),
            silence_seconds=float(values.get("VOICE_SILENCE_SECONDS", "20")),
            max_call_seconds=float(values.get("VOICE_MAX_CALL_SECONDS", "900")),
            usage_every_seconds=float(values.get("VOICE_USAGE_EVERY_SECONDS", "30")),
            thinking_sound=values.get("VOICE_THINKING_SOUND", "on") != "off",
            keys=frozenset(name for names in PROVIDER_KEYS.values() for name in names if values.get(name)),
            voices={
                "fr": values.get("VOICE_TTS") or DEFAULT_VOICES["fr"],
                "en": values.get("VOICE_TTS_EN") or DEFAULT_VOICES["en"],
                "es": values.get("VOICE_TTS_ES") or DEFAULT_VOICES["es"],
            },
        )

    def problems(self) -> list[str]:
        """What keeps the agent from answering calls, without saying any secret's value."""
        found = []
        if not self.agent_token:
            found.append("MAITRE_AGENT_TOKEN is missing")
        if not self.api_url.startswith(("http://127.0.0.1", "http://localhost", "https://")):
            found.append("MAITRE_API_URL must be https, or the local Worker")
        for spec in (self.stt, *self.voices.values()):
            provider = spec.split(":", 1)[0]
            if provider not in PROVIDER_KEYS:
                found.append(f"unknown speech provider in {spec}")
            found.extend(f"{name} is missing, for {spec}" for name in PROVIDER_KEYS.get(provider, ()) if name not in self.keys)
        # The voice changes when the caller changes language, within one provider: its options do not mix with another's.
        families = {voice_family(spec) for spec in self.voices.values()}
        if len(families) > 1:
            found.append(f"the voices must come from one provider, not {', '.join(sorted(families))}")
        return sorted(set(found), key=found.index)


def voice_family(spec: str) -> str:
    """The provider behind a voice: "inference:deepgram/aura-2:agathe" is Deepgram's."""
    provider, _, rest = spec.partition(":")
    return f"{provider}:{rest.split('/', 1)[0]}" if provider == "inference" else provider
