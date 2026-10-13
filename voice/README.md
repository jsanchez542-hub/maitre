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

- **Greets** with words written by the code, not the model, by the hour where the restaurant is: the assistant says it is an AI (art. 50 of the EU AI Act). The greeting cannot be interrupted.
- **Never leaves the caller in silence**: as soon as the model reaches for a tool, the Worker sends a short line ("Je regarde.", "Je regarde la fiche de la cuisine.") that is spoken while the tool and the reply run. Before that, the caller hears soft typing, as at a real desk.
- **Takes the phone number from caller ID or the keypad**, never from what speech recognition heard. The browser's keypad sends real DTMF tones, as a phone does.
- **Never reads a booking reference out**: letters and digits nobody can note while listening.
- **Follows a caller who switches language**, once a sentence of three words or more is heard in French, English or Spanish, and answers with that language's own voice: a synthesized voice speaks the one language it was made for (Aura-2's Agathe, asked for Spanish, left every call in Spanish silent).
- **Remembers a reply cut short as far as the caller heard it**, and forgets one they heard none of: a caller who speaks on after a pause, before the reply begins, is heard as one message, and a booking that reply confirmed is told again.
- **Never makes a turn of an unfinished sentence**: LiveKit's preemptive generation is off, because every turn reaches the restaurant, which may set a table aside.
- **Hangs up after its goodbye** when the caller ends the call: they say goodbye, or that they will call back. The model says the goodbye with `end_call`, and the line hangs up 1.2 s after it has been heard; a caller who speaks over it, or says more in that pause, keeps the line open. A reply that asks something never ends a call.
- **Hangs up on its own** after 20 seconds of silence, at the call's longest, or when the public demo's budget runs out, after saying why in the caller's language.
- **Keeps callers' words out of anyone's training**: the call's audio is never recorded, and Deepgram is told not to keep the audio or the text it is sent (`mip_opt_out`).
- **Logs each call** with the Worker: its length, how it ended and, for every answer, the time from the caller's last word to the agent's first.

A dropped connection during a turn is asked again with the same turn id, and the Worker answers it once: retrying never books twice.

## How fast it answers

Measured on real calls through LiveKit Cloud with `bench/caller.py`, from the caller's last word to the agent's first sound, 13 October:

| | Median wait | What changed |
|---|---|---|
| First call of the day | 5.1 s | |
| The short line spoken at once | 3.6 s | "Je regarde." ends a synthesis of its own; the silence some voices put before a sentence is cut. |
| The conversation stays cached | | The time sat before the conversation in the prompt and spoiled its cache every minute. |
| The model answers from the EU | 3.3 s | Vertex in Europe ended a call in 0.77 s where "fastest now" routing took 1.13 s (`npm run eval:providers`). |
| Nova-3 with LiveKit's turn detector | 2.6 to 3.0 s | Flux took 1.0 to 2.1 s to hear that a sentence was over; LiveKit's detector, from the voice, about 0.9 s, and cut fewer sentences in two. |

Where the time goes now, per answer: the end of the caller's turn (0.9 s, up to 1.8 s when the detector hears an unfinished sentence), the restaurant's first words (about 1 s: a model call), the first audio (0.2 s), and the network to the caller (0.4 s from this laptop; less from a server next to LiveKit's region). The agent logs that breakdown at the end of every call ("call latencies").

Turn detection is the one setting to revisit with real callers rather than a synthetic voice: `VOICE_STT=inference:deepgram/flux-general-multi` lets Flux decide instead, tuned with `VOICE_EOT_THRESHOLD` and `VOICE_EOT_TIMEOUT_MS`.

## Running it

Needs Python 3.13 and [uv](https://docs.astral.sh/uv/), the Worker running (`npm run dev` in `worker/`), and a LiveKit Cloud project.

```bash
cp .env.example .env.local        # then fill in the keys; .env.local is never committed
uv sync
uv run python -m maitre_voice.agent download-files   # the models the agent runs itself; again when VOICE_STT changes
uv run python -m maitre_voice.agent dev
```

On Windows, set `PYTHONUTF8=1`: replies contain French typography (narrow no-break spaces) that the console's default code page cannot print.

| Variable | What it is |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The LiveKit project. The Worker needs the same three to sign the browser's pass. |
| `MAITRE_API_URL`, `MAITRE_AGENT_TOKEN` | The Worker and the token of its "agent" routes. |
| `VOICE_STT` | Speech recognition as `provider:model`. By default Nova-3 through LiveKit Inference, paid from the LiveKit project's credit. |
| `VOICE_TTS`, `VOICE_TTS_EN`, `VOICE_TTS_ES` | The voice for French, English and Spanish, as `provider:model:voice`, all from one provider. By default Aura-2's Agathe, Athena and Carina, through LiveKit Inference. |
| `VOICE_EOT_THRESHOLD`, `VOICE_EOT_TIMEOUT_MS` | With Flux only: when it decides the caller has finished. |
| `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `MISTRAL_API_KEY`, `ELEVEN_API_KEY` | Only for a provider called directly. The agent refuses calls, and says which key is missing, when the chosen speech lacks one. |

## Tests

```bash
uv run pytest                        # the line, the keypad and the brain, against a stand-in Worker
uv run ruff check .
uv run python bench/line_check.py    # a French booking call against the local Worker and the real model, without LiveKit
uv run python bench/caller.py es     # a real call through LiveKit, made by a program, in fr (default), en or es: it books the evening the demo suggests, types the number, says goodbye, and passes when the restaurant hangs up
uv run python dev/serve.py           # a call page on http://127.0.0.1:8790, to call the local demo restaurant yourself
```

The model the phone uses is chosen with the evaluation's phone set (`MAITRE_EVAL_SET=voice`, see `evals/RESULTS.md`, run I).

## Credits

The typing heard while the agent thinks is LiveKit's built-in clip: "keyboard-typing" by Anton, [freesound.org/s/137](https://freesound.org/s/137/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
