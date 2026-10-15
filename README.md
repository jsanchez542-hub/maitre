# Maître

A booking assistant for restaurants and other businesses that take appointments. Guests book by phone, web chat or WhatsApp; the rules (tables, opening hours, dates, allergens) are decided by code, and the language model only does the talking.

> **Status: working end to end, not yet published.** The booking engine, the conversation layer and its evaluation against real models, the Cloudflare Worker, the web chat, the voice line and the restaurant's dashboard are built and tested, and the public demo runs live on them. WhatsApp comes next.

## Why it is built this way

Voice agents that take bookings are often shown working once, on a live call, and declared done. In one such demo the agent repeats the caller's phone number back with a digit wrong and books the table under it. Nothing notices, because nothing checks.

Maître starts from the other end. These are guarantees of the engine, each covered by tests:

- **A guest is never told a table is free unless it has been set aside for them.** What they hear stays true while they give their name.
- **Two guests can never get the last table.** Checking for a table and taking it is one atomic step.
- **Every booking has a real table, and no booking is lost to the order bookings came in.** Capacity is counted by table size, which is exact; the plan of real tables comes after it and rearranges bookings not yet seated when a new one only fits that way. A table the staff fixed by hand never moves.
- **The model never works out a date.** It says how the guest put it ("vendredi", "le 11", "après-demain") and the code turns that into a day in the restaurant's time zone. Every answer reads the full date back.
- **The phone number comes from the channel**: caller ID, WhatsApp, a keypad or a form, never from what speech recognition heard. The model never sees it.
- **Allergen answers come from the kitchen's sheet,** as sentences to repeat word for word. The code puts them in the reply when the model does not, and drops any sentence of the model's own about that dish and that allergen. When the sheet does not cover an allergen the answer is "we do not know", never "it is fine".
- **A promise made to a guest is kept by code.** When the sheet cannot answer, the question goes to the team without waiting for the model to pass it on, and a guest the team has no number for is asked for one.
- **Asking twice books once.** A model that calls the same tool twice does not create two bookings.

## What is in the repository

| Path | What it does |
|---|---|
| `src/calendar.ts`, `src/dates.ts` | Wall-clock dates and times in the business's time zone, and the dates guests say |
| `src/config.ts`, `src/schedule.ts` | The business: services, weekly hours, closures, tables, how long each party stays. Validated at startup |
| `src/availability.ts` | Which tables are free, from the length of every stay, not only its start |
| `src/seating.ts` | The floor plan: which real table each booking sits at, and when a table fixed by hand leaves no room |
| `src/engine.ts` | Finding, holding, booking, changing, cancelling and confirming; the staff's view of the day, arrivals, seating and departures, and their own changes; requests to call back |
| `src/activity.ts` | What the assistant did for the restaurant over a day, a week or a month, for the dashboard |
| `src/store.ts` | The storage interface, with all-or-nothing transactions, and an in-memory store |
| `src/allergens.ts`, `src/menu.ts` | The fourteen allergens EU law requires restaurants to declare, and what the menu says about them |
| `src/i18n/` | Everything the engine says, in French, English and Spanish |
| `src/tools.ts` | The tools the language model calls, with their input checked before anything runs |
| `src/agent/` | One turn of the conversation: the prompt, the providers (Anthropic, OpenAI and any model on OpenRouter), and the code that cleans each reply and enforces the allergen sentences |
| `src/demo/` | The invented restaurant of the demo and the evaluation, and the replay of recorded conversations on the real engine |
| `evals/` | The evaluation against real models: the conversations, their checks, scoring a recorded run again and exporting it for the demo |
| `worker/` | The Cloudflare Worker: one Durable Object per restaurant, kept in the EU, with its HTTP API |
| `voice/` | The voice agent, on LiveKit Agents (Python): it hears and speaks, and every turn is answered by the restaurant's Durable Object, as the chat's are |
| `web/` | The restaurant's site and its dashboard: static pages in French, English and Spanish, live against the Worker |

The engine has no dependency on Node or on a browser: the same code runs on a server, in a Cloudflare Worker and in a web page.

## The assistant, measured

Conversations written in advance, in French, English and Spanish, are played against real models: forty-one today, twenty-six of them also on the phone. What must happen is written as checks on the outcome: the booking made, with its day, time, party size, name and phone number; nothing booked; the team asked to call back; replies that must or must not say something. Every reply is also checked for the allergen sentences word for word, internal names, formatting, language, and the guest's number. Each conversation runs three times and passes only if all three pass.

The comparison that chose the model, on commit ac58952, when there were nineteen:

| Model | Conversations right, all three times | Latency p50 | p95 | Per conversation |
|---|---|---|---|---|
| **Claude Haiku 5.5** (chosen) | **19/19** | 3.1 s | 5.7 s | $0.0021 |
| GPT-5.6 Luna | 19/19 | 3.0 s | 6.1 s | $0.0005 |
| GPT-6 Luna | 19/19 | 3.5 s | 7.3 s | $0.0003 |
| Mistral Medium 3.1 | 18/19 | 1.6 s | 2.7 s | $0.0010 |
| Gemini 3.1 Flash Lite | 17/19 | 1.8 s | 2.8 s | $0.0025 |

In the latest run, on 15 October, Claude Haiku 5.5 was right in all forty-one conversations three times each, and in all twenty-six on the phone.

Fourteen runs, what each one found and what changed because of it, are in [evals/RESULTS.md](evals/RESULTS.md). Four of the failures they found were mistakes of the evaluation itself, and one came from a rule of the prompt that stopped bookings going through; each was fixed where it started, with the real reply as a test. No check was relaxed to make a model pass.

```bash
# Needs OPENROUTER_API_KEY in .env. Costs a few cents per model.
MAITRE_EVAL_MODELS="anthropic/claude-haiku-5.5" npm run eval
# Scores a recorded run again with the current checks, without calling any model.
MAITRE_EVAL_RESCORE=evals/runs/<run> npm run eval:rescore
```

The public demo is live: each visitor gets a restaurant of their own on the Worker, and the chat and the dashboard run the real assistant. When the live demo is paused, the chat plays conversations recorded in the final run back on the real engine, in the visitor's browser, and says so.

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

cd ../voice
uv sync
uv run pytest
uv run ruff check .
```

Beyond the usual unit tests:

- **A randomised test** plays 40 seeded sequences of 300 steps by six guests at once (finding, booking, changing, cancelling, letting holds expire) while the staff move bookings to tables of their choice, and checks after every step, with code independent from the engine, that no group of tables is ever used more times than it exists, that no two parties share a table at the same moment, and that a table fixed by hand never moves. A failing sequence can be replayed exactly from its seed.
- **A typography check** fails if any sentence the engine can say contains a dash that reads as machine text, or French punctuation without its non-breaking space.
- **The Worker is tested inside workerd**, the Workers runtime, with a real Durable Object and its SQLite database and the network cut off: two guests asking for the last table at the same moment, a transaction undone halfway, the alarm that clears expired holds and old data, and whole conversations with the model played by the test.
- **Every recorded conversation of the demo is replayed** on the engine in the test suite. A change that would make the engine answer differently from the recording fails there, before a visitor could read a reply that is no longer true.
- **Every page is checked in a browser**, on a phone screen and a desktop one, against a stand-in for the Worker that runs the real engine. In each language axe finds nothing to report in any view, and the page's content security policy lets no script run but its own. The staff's work is driven end to end: seating, changing, confirming and moving bookings, editing the settings, and a Worker that stops answering mid-service.
- **The voice line is tested against a stand-in Worker**: turns as JSON lines, the keypad, the goodbye that hangs up, and the check-in that decides whether calls are offered. `voice/bench/caller.py` makes real calls through LiveKit, in each language, as a program.

## The Worker

Each restaurant is one Durable Object, which handles one request at a time: that is what makes a double booking impossible rather than unlikely. Its data is pinned to the European Union. An alarm clears expired holds, and deletes conversations, bookings and requests to call back after 90 days.

| Route, under `/v1/restaurants/:id/` | Who calls it |
|---|---|
| `POST chat` | The services that talk on the guest's behalf: one turn of a web or WhatsApp conversation |
| `POST sessions/:session/phone` | Same: the number typed in the web chat's own field |
| `POST tools/:name` | Same: one tool call from the voice agent |
| `POST calls/:session/start`, `…/turns`, `…/keypad`, `…/end` | The voice agent: one call, turn by turn, with the same guards and log as the chat |
| `GET day`, `GET conversations`, `GET calls`, `GET activity` | The restaurant's dashboard: the service of a day, every turn and call with its latency and cost, and what the assistant did over a day, a week or a month |
| `POST staff/bookings`, `…/cancel`, `…/no-show`, `POST staff/callbacks/:id/done` | The dashboard: bookings taken by hand, parties on the spot, and requests dealt with |
| `POST staff/bookings/:ref/change`, `…/confirm`, `GET …/tables` | The dashboard: a booking changed or confirmed for the guest, and the tables that would take it |
| `POST staff/bookings/:ref/arrived`, `…/seated`, `…/left`, `…/table` | The dashboard during service: a party at the door, at its table, gone (its table is free again at once), or moved to another table |
| `GET config`, `PUT config`, `GET outside-hours` | The dashboard's settings: hours, closures, booking rules, the menu and the practical answers, checked before they are kept, and the bookings new hours leave out |

Each group has its own bearer token. A route whose secret is not set answers 503 instead of running open, and so does every route if the deployment does not say where data may live.

The public demo has its own routes under `/v1/demo`. A visitor opens a restaurant of their own, a Durable Object deleted after a day, behind Turnstile, a daily limit per visitor and a spending cap that pauses the demo. They chat with it, call it and run its dashboard. Calls are offered only while a voice agent checks in every minute with speech that works, and not for a quarter of an hour after a call fails on its speech.

To run it locally, copy `worker/.dev.vars.example` to `worker/.dev.vars`, fill it in and run `npm run dev` in `worker/`. The Worker also serves the pages built in `web/`: run `npm run build` there first, locally as before a deploy.

## The site and the dashboard

`web/` is two sides of one invented restaurant, Merrain, a bistro in Bordeaux. A thin bar switches between them.

**The guest's side** is the restaurant's own site, with its menu, its hours and a «Réserver» that opens the chat. The chat books a table in the visitor's own restaurant, a Durable Object deleted after 24 hours. The phone number is typed in the chat's own field, never taken from the conversation. While a voice agent is available, the visitor can also call the restaurant from the browser.

**The restaurant's side** is the dashboard, in four sections:

- **Service:**
  - the plan of the room, drawn from the engine's floor plan, and the day's bookings;
  - each table's card, for arrivals, seating, walk-ins, and changing, confirming, moving or cancelling a booking;
  - bookings that new opening hours leave out, flagged so the staff can call those guests.
- **Conversations:** each conversation as a thread, with what it booked, changed or passed to the team, and the technical trace (tools, latency, cost) folded away.
- **Activity:** calls answered while the restaurant was closed, the time to answer, bookings by channel and conversations, over a day, a week or a month.
- **Settings:**
  - opening hours, closures and special days;
  - the booking rules;
  - the menu with its allergen sheet;
  - the answers to practical questions.

  The engine checks every change before it is saved. A renamed dish keeps its identifier, so the allergen sheet still finds it.

The pages are static (Astro), with Preact where they are live, and import the engine from source: the browser runs the code the tests check. Each page carries a content security policy with the hashes of its inline scripts. Nothing secret reaches the browser; the only key in it is Turnstile's public site key.

To run it locally:
- build `web/` with `npm run build`;
- start the Worker in `worker/` with `npx wrangler dev --port 8787`, which serves the pages and the API;
- or run `npm run dev` in `web/` with `web/.env` copied from `.env.example`, which passes `/v1` and `/media` to the Worker on port 8787.

## Languages

French by default, English and Spanish. Dates, times and prices follow each language's conventions: "vendredi 1er octobre à 20 h 30", "Friday 1 October at 8:30 pm", "viernes 1 de octubre a las 20:30".

## Known limits

- The engine does not join tables: parties larger than the biggest table are passed to a person.
- A party that arrives late keeps the stay it was booked for: the plan does not lengthen it. A party that leaves early frees its table at once.
- Phone numbers are read in French national format or in international format.
- Opening hours that span the night the clocks change (between 2 and 3 am) are not supported.
- The evaluation is forty-one written conversations, twenty-six of them also on the phone, in text. It catches regressions and compares models; it does not prove the assistant right in every conversation, and speech recognition errors are measured separately, with real calls made by a program.
- Data cannot be pinned to the EU when running locally, because workerd does not implement jurisdictions; the local configuration has to say so explicitly.
- The dashboard does not reply to guests on their channel: the staff call them.
- The dashboard's routes share one token, and there is no staff login. A real restaurant needs one, and a real deployment puts Cloudflare Access in front of them.
- The voice line needs speech recognition and synthesis with an allowance to spend. On LiveKit's free plan, the $2.50 a month of Inference ran out during testing on 15 October; calls are then not offered until it comes back or the providers' own keys are set.
