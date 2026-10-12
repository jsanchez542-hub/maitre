# Maître voice agent

Answers the restaurant's phone with the same assistant as the web chat. It runs on [LiveKit Agents](https://docs.livekit.io/agents/) (Python) and only hears and speaks: every turn goes to the restaurant's Durable Object in the Worker, which answers with the same engine, prompt, guards and log as the chat.

```
caller (browser or phone) ──► LiveKit ──► this agent: speech recognition, turn detection,
                                          speech synthesis, interruptions, keypad
                                               │  each turn, over HTTP, as JSON lines
                                               ▼
                                          Worker: the restaurant's Durable Object
                                          (engine, prompt, guards, the model, the log)
```

## What a call does

- **Greets** with words written by the code, not the model: the assistant is an AI and the call may be recorded (art. 50 of the EU AI Act). The greeting cannot be interrupted.
- **Never leaves the caller in silence**: as soon as the model reaches for a tool, the Worker sends a short line ("Je regarde.", "Je regarde la fiche de la cuisine.") that is spoken while the tool and the reply run.
- **Takes the phone number from caller ID or the keypad**, never from what speech recognition heard. The browser's keypad sends real DTMF tones, as a phone does.
- **Never reads a booking reference out**: letters and digits nobody can note while listening.
- **Follows a caller who switches language**, once a sentence of three words or more is heard in French, English or Spanish.
- **Remembers a reply cut short as far as the caller heard it.**
- **Never makes a turn of an unfinished sentence**: LiveKit's preemptive generation is off, because every turn reaches the restaurant, which may set a table aside.
- **Hangs up on its own** after 20 seconds of silence, at the call's longest, or when the public demo's budget runs out, after saying why in the caller's language.
- **Logs each call** with the Worker: its length, how it ended and, for every answer, the time from the caller's last word to the agent's first.

A dropped connection during a turn is asked again with the same turn id, and the Worker answers it once: retrying never books twice.

## Running it

Needs Python 3.13 and [uv](https://docs.astral.sh/uv/), the Worker running (`npm run dev` in `worker/`), and a LiveKit Cloud project.

```bash
cp .env.example .env.local        # then fill in the keys; .env.local is never committed
uv sync
uv run python -m maitre_voice.agent dev
```

On Windows, set `PYTHONUTF8=1`: replies contain French typography (narrow no-break spaces) that the console's default code page cannot print.

| Variable | What it is |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The LiveKit project. The Worker needs the same three to sign the browser's pass. |
| `MAITRE_API_URL`, `MAITRE_AGENT_TOKEN` | The Worker and the token of its "agent" routes. |
| `VOICE_STT`, `VOICE_TTS` | Speech recognition and synthesis as `provider:model[:voice]`, chosen with the benchmark. |
| `DEEPGRAM_API_KEY`, `MISTRAL_API_KEY`, `ELEVEN_API_KEY` | Only for the providers in use. |

## Tests

```bash
uv run pytest                        # the line, the keypad and the brain, against a stand-in Worker
uv run ruff check .
uv run python bench/line_check.py    # a French booking call against the local Worker and the real model, without LiveKit
```
