# Evaluation results

How the model behind Maître was chosen, run by run: what each run measured, what it found, and what changed because of it. The transcripts stay out of git (`evals/runs/` is ignored); the figures here are copied from each run's summary.

## How a model is evaluated

- **19 conversations written in advance** (`evals/scenarios.ts`), in French, English and Spanish, over WhatsApp, the web chat and the phone as text: bookings, relative dates ("après-demain", "the 24th"), a closed day, a full evening, a party too large to seat, allergen questions the kitchen's sheet answers and one it does not, a phone number dictated aloud, an attempt to override the rules, a cancellation, a change, opening hours and a question the restaurant has answered in writing.
- **"Right" is written as checks on the outcome, never as an opinion:** the booking made (day, time, party size, name, the number the channel gave, the allergies), nothing booked, a request for the team to call back and its reason, a cancellation, a move, a tool used, a reply that must or must not say something.
- **Every reply of every conversation is checked as well:** the allergen sheet repeated word for word, no internal names, plain text, the guest's language, and never the guest's phone number.
- **Each conversation runs three times and passes only if all three pass.** A booking assistant that is right two times out of three is wrong for one guest in three.
- **Same prompt, tools, restaurant and clock for every model:** Wednesday 14 October 2026, 10:00 in Paris. Models are called through OpenRouter, routed only to providers that neither store nor train on prompts.
- **Latency** runs from the guest's message to the reply, tool calls included, measured from France. **Cost** is what OpenRouter reports for each call.

## Run by run

### Run A: the first run

| Model | Scenarios passed |
|---|---|
| Claude Haiku 5.5 | 17/19 |
| GPT-6 Luna | 18/19 |
| Gemini 3.1 Flash Lite | 18/19 |
| Mistral Medium 3.1 | 17/19 |
| Mistral Small | 0/19, every request refused by the provider |

What it found, and what changed:

- Haiku rephrased the allergen sheet once, faithfully but not word for word. **A guard now puts the exact sentences in the reply** whatever the model wrote.
- GPT-6 Luna filled a date field with the wrong month. **The model no longer handles dates at all:** it copies the day as the guest said it ("friday", "24") and the code works it out.
- Gemini booked without passing the allergy it had just been told about, and told the guest it had noted it. **Allergies became a field the model must fill**, even if only with an empty list.
- Mistral Medium asked for the same confirmation twice. The prompt's rule on confirming became explicit: one yes, then act.
- Two mistakes of the evaluation itself: a language detector that counted "la" as French in a Spanish reply, and a pattern that took "I cannot confirm it is safe" for a claim that a dish was safe. Both fixed, each with the real reply as a test.

### Run B: commit c9e5c3e, seven models

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Provider errors | Cost |
|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5 | 19/19 | 57/57 | 2.8 s | 5.5 s | 1/117 turns | 0/117 | $0.113 |
| GPT-6 Luna | 19/19 | 57/57 | 3.5 s | 6.4 s | 0/117 | 0/117 | $0.015 |
| GPT-5.6 Luna | 18/19 → **19/19** | 55/57 → **57/57** | 3.2 s | 6.0 s | 0/117 | 0/117 | $0.029 |
| Gemini 3.1 Flash Lite | 19/19 | 57/57 | 1.8 s | 3.5 s | 0/117 | 0/117 | $0.136 |
| Mistral Medium 3.1 | 17/19 | 53/57 | 1.6 s | 2.4 s | 2/117 | 0/117 | $0.057 |
| Mistral Small (2603) | 2/19 | 6/57 | 2.3 s | 3.1 s | 0/117 | **98/117** | $0.004 |
| Claude Sonnet 5.5 | 19/19 | 57/57 | 4.1 s | 10.2 s | 0/117 | 0/117 | $2.330 |

- **GPT-5.6 Luna's two failures were the evaluation's.** "No, el domingo no abrimos por la noche" was marked wrong because the check looked for "domingo", "abrimos" and "noche" in one sentence and missed the "no". The check was rewritten with the real replies as tests, and the run scored again from its recordings without calling any model (`npm run eval:rescore`): only those two verdicts changed.
- **Mistral Medium's failures were real, and the worst kind: a promise without the action.** It told a guest with a severe nut allergy "I will ask them to call you back" and recorded nothing; to move a booking it said "I will do it now" and did not. The allergen sheet's own sentence promises the team will be told, so **the code now tells the team itself** instead of trusting the model to. A second request of the same kind in a conversation joins the first, so a model that also asks does not create a duplicate, and a web guest without a number is asked to type one in the chat's own field.
- **Mistral Small could not be measured.** 98 of 117 turns were refused by the provider (HTTP 429) with prompt collection denied, as in run A. It is left out of the next runs.
- **Claude Sonnet 5.5 was right every time, and twenty times the cost of Haiku**, at about 4 cents a conversation, with a p95 of 10 s. It is left out of the next runs.

### Run C: commit 732a503, five models

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Cost |
|---|---|---|---|---|---|---|
| Claude Haiku 5.5 | 19/19 | 57/57 | 2.9 s | 5.4 s | 2/117 turns | $0.114 |
| GPT-6 Luna | 19/19 | 57/57 | 3.4 s | 7.5 s | 0/117 | $0.014 |
| GPT-5.6 Luna | 19/19 | 57/57 | 3.1 s | 5.2 s | 0/117 | $0.029 |
| Gemini 3.1 Flash Lite | 19/19 | 57/57 | 1.8 s | 2.9 s | 0/117 | $0.135 |
| Mistral Medium 3.1 | 18/19 | 54/57 | 1.5 s | 2.4 s | 0/117 | $0.053 |

- With the callback in the code, Mistral Medium's allergen conversation passes; it still asks twice before moving a booking, in all three runs.
- **In English, models wrote "the chocolate mousse" for the dish named "Chocolate mousse"**, so the sentence was no longer word for word and the guard put the exact one in front of a reply that already said it: the guest read it twice. English dish names now go in quotation marks, as the French and Spanish ones already did, and when the guard steps in it drops the model's sentences that only restate the sheet.
- Scored again against a new question (did the assistant ask about allergies before booking?), **only Gemini had asked, in all nine bookings, without being told to.** A good maître d' asks, so the prompt now does too.

### Run D: commit 110e5f3, stopped after four models

| Model | Runs passed |
|---|---|
| Claude Haiku 5.5 | 46/57 |
| GPT-6 Luna | 31/57 |
| GPT-5.6 Luna | 35/57 |
| Gemini 3.1 Flash Lite | 57/57 |

**The new rule was wrong.** It asked about allergies in the same message as a yes-or-no question: "a table for 2 on the 24th, does anyone have an allergy?". A guest answering "Yes, that's right" had answered both, and the models, rightly careful, asked which allergy instead of booking. The question now goes only with the question for the name, which cannot be answered with a yes, and a guest who gives the name without mentioning allergies is booked without being asked twice. Of the four models measured, only Gemini was unaffected by the ambiguous rule.

### Run E: commit ac58952, the final code

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Cost | Per conversation |
|---|---|---|---|---|---|---|---|
| **Claude Haiku 5.5** | **19/19** | **57/57** | 3.1 s | 5.7 s | 3/117 turns | $0.119 | $0.0021 |
| GPT-6 Luna | 19/19 | 57/57 | 3.5 s | 7.3 s | 0/117 | $0.015 | $0.0003 |
| GPT-5.6 Luna | 19/19 | 57/57 | 3.0 s | 6.1 s | 0/117 | $0.030 | $0.0005 |
| Gemini 3.1 Flash Lite | 17/19 | 55/57 | 1.8 s | 2.8 s | 0/117 | $0.140 | $0.0025 |
| Mistral Medium 3.1 | 18/19 | 56/57 | 1.6 s | 2.7 s | 0/117 | $0.058 | $0.0010 |

- **Gemini's two failures are both real.** Once it asked about allergies although the guest had already given the name, and as a yes-or-no question, which the rule forbids; the guest's "Oui, parfait" was ambiguous again and nothing was booked. Once it sent a hold it had made up to the booking tool: the engine refused it, so no wrong booking was made, but the conversation ended without one.
- Mistral Medium still asked twice before moving a booking, in one run of three.
- When the guard stepped in for Haiku, the reply now reads cleanly: the exact sentences first, then what the model added, said once.

## The choice: Claude Haiku 5.5

The rule:

1. Every conversation right in all three runs, in the final run and in the previous full one.
2. Among those, the shortest wait for the guest at the 95th percentile, as long as a conversation costs under half a cent.
3. Within half a second, the better score on [τ²-Bench Airline](https://openrouter.ai/benchmarks), an independent test of multi-turn conversations with tools: Claude Haiku 5.5 75.3 %, Gemini 3.1 Flash Lite 72.0 %, GPT-5.6 Luna 70.0 %, GPT-6 Luna 67.3 % (OpenRouter, 10 October 2026).

Haiku, GPT-5.6 Luna and GPT-6 Luna were right in every conversation of runs B, C and E. Haiku and GPT-5.6 Luna were within half a second of each other at the 95th percentile in both runs (5.4 s against 5.2 s, then 5.7 s against 6.1 s), and Haiku scores higher on τ²-Bench. It also held up best of the three under the ambiguous rule of run D. A conversation costs about two tenths of a cent, so about 2 dollars for a thousand.

- **Gemini 3.1 Flash Lite** waits half as long, 2.8 s against 5.7 s at the 95th percentile, and was the only model that asked about allergies unprompted. But in the final run it broke an explicit rule and made up an identifier. It stays the first candidate for the voice channel, where every second counts, and that choice will be made with its own test.
- **GPT-6 Luna** costs an eighth of Haiku and was right every time, but it is the slowest at the 95th percentile, it sometimes speaks of the restaurant in the third person ("abren", "no aparece servicio por la noche"), and it was the most affected by the ambiguous rule.
- **Claude Sonnet 5.5** was right every time in run B, at twenty times the cost and with a 95th percentile of 10 s.

The model is set in `worker/wrangler.jsonc`. It can be changed there without touching code; any change should come with a new run.

## Limits of this evaluation

- Nineteen conversations is a regression suite and a comparison, not a proof. A model that slips once in a hundred conversations still passes all 57 more than half the time.
- Text only. Speech recognition errors will be measured with the voice channel.
- Latency was measured from France through OpenRouter, on an ordinary connection; it will differ in production.
- Models and prices change. These results are from 10 October 2026.

## Reproducing it

```bash
# Needs OPENROUTER_API_KEY in .env.
MAITRE_EVAL_MODELS="anthropic/claude-haiku-5.5" MAITRE_EVAL_RUNS=3 npm run eval
# Score a recorded run again with the current checks, without calling any model.
MAITRE_EVAL_RESCORE=evals/runs/<run> npm run eval:rescore
# Export one model's conversations of a run for the demo.
MAITRE_EVAL_EXPORT=evals/runs/<run>/<model>.json npm run eval:export
```

Each run writes `meta.json` next to its results: the commit, whether there were uncommitted changes, and a fingerprint of the restaurant. The export refuses a run made with another version of the restaurant.

## Spend

The five runs and a few test calls cost $4.09 in total. Run B accounts for $2.69 of it, $2.33 of that for Claude Sonnet 5.5 alone.
