# Maître

A booking assistant for restaurants and other businesses that take appointments. Guests book by phone, web chat or WhatsApp; the rules (tables, opening hours, dates, allergens) are decided by code, and the language model only does the talking.

> **Status: in development.** The booking engine, the conversation layer, its evaluation against real models and the Cloudflare Worker are built and tested, and so is the dashboard's first screen, the service of the day. The web chat, the rest of the dashboard, the voice channel and WhatsApp come next.

## Why it is built this way

Voice agents that take bookings are often shown working once, on a live call, and declared done. In one such demo the agent repeats the caller's phone number back with a digit wrong and books the table under it. Nothing notices, because nothing checks.

Maître starts from the other end. These are guarantees of the engine, each covered by tests:

- **A guest is never told a table is free unless it has been set aside for them.** What they hear stays true while they give their name.
- **Two guests can never get the last table.** Checking for a table and taking it is one atomic step.
- **Every booking has a real table, and no booking is lost to the order bookings came in.** Capacity is counted by table size, which is exact; the plan of real tables comes after it and rearranges bookings not yet seated when a new one only fits that way. A table the staff fixed by hand never moves.
- **The model never works out a date.** It says how the guest put it ("vendredi", "le 11", "après-demain") and the code turns that into a day in the restaurant's time zone. Every answer reads the full date back.
- **The phone number comes from the channel**: caller ID, WhatsApp, a keypad or a form, never from what speech recognition heard. The model never sees it.
- **Allergen answers come from the kitchen's sheet,** as sentences to repeat word for word, and the code puts them in the reply when the model does not. When the sheet does not cover an allergen the answer is "we do not know", never "it is fine".
- **A promise made to a guest is kept by code.** When the sheet cannot answer, the question goes to the team without waiting for the model to pass it on, and a guest the team has no number for is asked for one.
- **Asking twice books once.** A model that calls the same tool twice does not create two bookings.

## What is in the repository

| Path | What it does |
|---|---|
| `src/calendar.ts`, `src/dates.ts` | Wall-clock dates and times in the business's time zone, and the dates guests say |
| `src/config.ts`, `src/schedule.ts` | The business: services, weekly hours, closures, tables, how long each party stays. Validated at startup |
| `src/availability.ts` | Which tables are free, from the length of every stay, not only its start |
| `src/seating.ts` | The floor plan: which real table each booking sits at, and when a table fixed by hand leaves no room |
| `src/engine.ts` | Finding, holding, booking, changing, cancelling and confirming; the staff's view of the day, arrivals, seating and departures; requests to call back |
| `src/store.ts` | The storage interface, with all-or-nothing transactions, and an in-memory store |
| `src/allergens.ts`, `src/menu.ts` | The fourteen allergens EU law requires restaurants to declare, and what the menu says about them |
| `src/i18n/` | Everything the engine says, in French, English and Spanish |
| `src/tools.ts` | The tools the language model calls, with their input checked before anything runs |
| `src/agent/` | One turn of the conversation: the prompt, the providers (Anthropic, OpenAI and any model on OpenRouter), and the code that cleans each reply and enforces the allergen sentences |
| `src/demo/` | The invented restaurant of the demo and the evaluation, and the replay of recorded conversations on the real engine |
| `evals/` | The evaluation against real models: the conversations, their checks, scoring a recorded run again and exporting it for the demo |
| `worker/` | The Cloudflare Worker: one Durable Object per restaurant, kept in the EU, with its HTTP API |
| `web/` | The public demo and the dashboard: static pages in French, English and Spanish that run the engine in the visitor's browser |

The engine has no dependency on Node or on a browser: the same code runs on a server, in a Cloudflare Worker and in a web page.

## The assistant, measured

Nineteen conversations written in advance, in French, English and Spanish, are played against real models. What must happen is written as checks on the outcome: the booking made, with its day, time, party size, name and phone number; nothing booked; the team asked to call back; replies that must or must not say something. Every reply is also checked for the allergen sentences word for word, internal names, formatting, language, and the guest's number. Each conversation runs three times and passes only if all three pass.

The final comparison, on commit ac58952:

| Model | Conversations right, all three times | Latency p50 | p95 | Per conversation |
|---|---|---|---|---|
| **Claude Haiku 5.5** (chosen) | **19/19** | 3.1 s | 5.7 s | $0.0021 |
| GPT-5.6 Luna | 19/19 | 3.0 s | 6.1 s | $0.0005 |
| GPT-6 Luna | 19/19 | 3.5 s | 7.3 s | $0.0003 |
| Mistral Medium 3.1 | 18/19 | 1.6 s | 2.7 s | $0.0010 |
| Gemini 3.1 Flash Lite | 17/19 | 1.8 s | 2.8 s | $0.0025 |

Claude Haiku 5.5 was then run again on the final code, with the demo restaurant under its final name, Merrain: right in all 57 conversations again. The demo's recorded conversations come from that run.

Six runs, what each one found and what changed because of it, are in [evals/RESULTS.md](evals/RESULTS.md). Three of the failures they found were mistakes of the evaluation itself, and one came from a rule of the prompt that stopped bookings going through; each was fixed where it started, with the real reply as a test. No check was relaxed to make a model pass.

```bash
# Needs OPENROUTER_API_KEY in .env. Costs a few cents per model.
MAITRE_EVAL_MODELS="anthropic/claude-haiku-5.5" npm run eval
# Scores a recorded run again with the current checks, without calling any model.
MAITRE_EVAL_RESCORE=evals/runs/<run> npm run eval:rescore
```

The public demo needs no model at all: it plays conversations recorded in the final run back on the real engine (`maitre/demo`), so the bookings it shows are made by the engine, live, in the visitor's browser.

## Tests

```bash
npm ci
npm test
npm run typecheck
npm run build

cd worker
npm ci
npm test
npm run typecheck

cd ../web
npm ci
npm run check
npm test
npm run build
npx playwright install --only-shell chromium
npm run test:pages
```

Beyond the usual unit tests:

- **A randomised test** plays 40 seeded sequences of 300 steps by six guests at once (finding, booking, changing, cancelling, letting holds expire) while the staff move bookings to tables of their choice, and checks after every step, with code independent from the engine, that no group of tables is ever used more times than it exists, that no two parties share a table at the same moment, and that a table fixed by hand never moves. A failing sequence can be replayed exactly from its seed.
- **A typography check** fails if any sentence the engine can say contains a dash that reads as machine text, or French punctuation without its non-breaking space.
- **The Worker is tested inside workerd**, the Workers runtime, with a real Durable Object and its SQLite database and the network cut off: two guests asking for the last table at the same moment, a transaction undone halfway, the alarm that clears expired holds and old data, and whole conversations with the model played by the test.
- **Every recorded conversation of the demo is replayed** on the engine in the test suite. A change that would make the engine answer differently from the recording fails there, before a visitor could read a reply that is no longer true.
- **Every page is checked in a browser**, on a phone screen and a desktop one. In each language, axe finds nothing to report in the plan or in the list, and the page's content security policy lets no script run but its own. On the French page, the staff seat a party and a walk-in through the engine, axe checks the open table, and no phone number is shown whole.

## The Worker

Each restaurant is one Durable Object, which handles one request at a time: that is what makes a double booking impossible rather than unlikely. Its data is pinned to the European Union. An alarm clears expired holds, and deletes conversations, bookings and requests to call back after 90 days.

| Route, under `/v1/restaurants/:id/` | Who calls it |
|---|---|
| `POST chat` | The services that talk on the guest's behalf: one turn of a web or WhatsApp conversation |
| `POST sessions/:session/phone` | Same: the number typed in the web chat's own field |
| `POST tools/:name` | Same: one tool call from the voice agent |
| `GET day`, `GET conversations` | The restaurant's dashboard: the service of the day, and every turn with its latency and cost |
| `POST staff/bookings`, `…/cancel`, `…/no-show`, `POST staff/callbacks/:id/done` | The dashboard: bookings taken by hand, parties on the spot, and requests dealt with |
| `POST staff/bookings/:ref/arrived`, `…/seated`, `…/left`, `…/table` | The dashboard during service: a party at the door, at its table, gone (its table is free again at once), or moved to another table |

Each group has its own bearer token. A route whose secret is not set answers 503 instead of running open, and so does every route if the deployment does not say where data may live.

To run it locally, copy `worker/.dev.vars.example` to `worker/.dev.vars`, fill it in and run `npm run dev` in `worker/`. The Worker also serves the pages built in `web/`: run `npm run build` there first, locally as before a deploy.

## Languages

French by default, English and Spanish. Dates, times and prices follow each language's conventions: "vendredi 1er octobre à 20 h 30", "Friday 1 October at 8:30 pm", "viernes 1 de octubre a las 20:30".

## Known limits

- The engine does not join tables: parties larger than the biggest table are passed to a person.
- A party that arrives late keeps the stay it was booked for: the plan does not lengthen it. A party that leaves early frees its table at once.
- Phone numbers are read in French national format or in international format.
- Opening hours that span the night the clocks change (between 2 and 3 am) are not supported.
- The evaluation is nineteen written conversations, in text. It catches regressions and compares models; it does not prove the assistant right in every conversation, and speech recognition errors will be measured separately with the voice channel.
- Data cannot be pinned to the EU when running locally, because workerd does not implement jurisdictions; the local configuration has to say so explicitly.
- The dashboard's routes share one token. A real deployment puts Cloudflare Access in front of them.
