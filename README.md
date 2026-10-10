# Maître

A booking assistant for restaurants and other businesses that take appointments. Guests book by phone, web chat or WhatsApp; the rules (tables, opening hours, dates, allergens) are decided by code, and the language model only does the talking.

> **Status: in development.** The booking engine described here is complete and tested. The conversation layer, the voice and WhatsApp channels and the dashboard come next.

## Why it is built this way

Voice agents that take bookings are often shown working once, on a live call, and declared done. In one such demo the agent repeats the caller's phone number back with a digit wrong and books the table under it. Nothing notices, because nothing checks.

Maître starts from the other end. These are guarantees of the engine, each covered by tests:

- **A guest is never told a table is free unless it has been set aside for them.** What they hear stays true while they give their name.
- **Two guests can never get the last table.** Checking for a table and taking it is one atomic step.
- **The model never works out a date.** It says how the guest put it ("vendredi", "le 11", "après-demain") and the code turns that into a day in the restaurant's time zone. Every answer reads the full date back.
- **The phone number comes from the channel**: caller ID, WhatsApp, a keypad or a form, never from what speech recognition heard. The model never sees it.
- **Allergen answers come from the kitchen's sheet,** as sentences to repeat word for word. When the sheet does not cover an allergen the answer is "we do not know", never "it is fine", and the question goes to a person.
- **Asking twice books once.** A model that calls the same tool twice does not create two bookings.

## What is in the repository

| Path | What it does |
|---|---|
| `src/calendar.ts`, `src/dates.ts` | Wall-clock dates and times in the business's time zone, and the dates guests say |
| `src/config.ts`, `src/schedule.ts` | The business: services, weekly hours, closures, tables, how long each party stays. Validated at startup |
| `src/availability.ts` | Which tables are free, from the length of every stay, not only its start |
| `src/engine.ts` | Finding, holding, booking, changing, cancelling and confirming |
| `src/store.ts` | The storage interface, with all-or-nothing transactions, and an in-memory store |
| `src/allergens.ts`, `src/menu.ts` | The fourteen allergens EU law requires restaurants to declare, and what the menu says about them |
| `src/i18n/` | Everything the engine says, in French, English and Spanish |
| `src/tools.ts` | The tools the language model calls, with their input checked before anything runs |

The engine has no dependency on Node or on a browser: the same code runs on a server, in a Cloudflare Worker and in a web page.

## Tests

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Beyond the usual unit tests:

- **A randomised test** plays 40 seeded sequences of 300 steps by six guests at once (finding, booking, changing, cancelling, letting holds expire) and checks after every step, with code independent from the engine, that no group of tables is ever used more times than it exists. A failing sequence can be replayed exactly from its seed.
- **A typography check** fails if any sentence the engine can say contains a dash that reads as machine text, or French punctuation without its non-breaking space.

## Languages

French by default, English and Spanish. Dates, times and prices follow each language's conventions: "vendredi 1er octobre à 20 h 30", "Friday 1 October at 8:30 pm", "viernes 1 de octubre a las 20:30".

## Known limits

- Tables of the same size are interchangeable. The engine decides how many of each size are taken at any moment; the staff decide which one. It does not join tables: parties larger than the biggest table are passed to a person.
- Phone numbers are read in French national format or in international format.
- Opening hours that span the night the clocks change (between 2 and 3 am) are not supported.
