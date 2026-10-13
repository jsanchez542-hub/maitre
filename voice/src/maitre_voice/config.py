"""The voice agent's settings, read once from the environment (voice/.env.local on a developer's machine)."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .speech import EndOfTurn

LANGUAGES = ("fr", "en", "es")


@dataclass(frozen=True)
class Settings:
    #: The Maître Worker, and the token of its "agent" routes.
    api_url: str
    agent_token: str
    #: The name LiveKit sends calls to: the Worker's passes ask for it by name.
    agent_name: str
    #: The restaurant a call to the restaurant's own number is for.
    restaurant_id: str
    #: Speech recognition and speech synthesis, as "provider:model[:voice]".
    stt: str
    tts: str
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

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        token = values.get("MAITRE_AGENT_TOKEN", "")
        return cls(
            api_url=values.get("MAITRE_API_URL", "http://127.0.0.1:8787"),
            agent_token=token,
            agent_name=values.get("MAITRE_AGENT_NAME", "maitre-voice"),
            restaurant_id=values.get("MAITRE_RESTAURANT_ID", "demo"),
            stt=values.get("VOICE_STT", "deepgram:flux-general-multi"),
            tts=values.get("VOICE_TTS", "cartesia:sonic-3"),
            end_of_turn=EndOfTurn(
                threshold=float(values["VOICE_EOT_THRESHOLD"]) if values.get("VOICE_EOT_THRESHOLD") else None,
                timeout_ms=int(values["VOICE_EOT_TIMEOUT_MS"]) if values.get("VOICE_EOT_TIMEOUT_MS") else None,
            ),
            silence_seconds=float(values.get("VOICE_SILENCE_SECONDS", "20")),
            max_call_seconds=float(values.get("VOICE_MAX_CALL_SECONDS", "900")),
            usage_every_seconds=float(values.get("VOICE_USAGE_EVERY_SECONDS", "30")),
            thinking_sound=values.get("VOICE_THINKING_SOUND", "on") != "off",
        )

    def problems(self) -> list[str]:
        """What keeps the agent from answering calls, without saying any secret's value."""
        found = []
        if not self.agent_token:
            found.append("MAITRE_AGENT_TOKEN is missing")
        if not self.api_url.startswith(("http://127.0.0.1", "http://localhost", "https://")):
            found.append("MAITRE_API_URL must be https, or the local Worker")
        return found
