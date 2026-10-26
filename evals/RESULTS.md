# Evaluation results

How the model behind Maître was chosen, run by run: what each run measured, what it found, and what changed because of it. The transcripts stay out of git (`evals/runs/` is ignored); the figures here are copied from each run's summary.

## How a model is evaluated

- **41 conversations written in advance** (`evals/scenarios.ts`; 19 until run G, 41 since run N), in French, English and Spanish, over WhatsApp, the web chat and the phone as text: bookings, relative dates ("après-demain", "the 24th"), a closed day, a full evening, a party too large to seat, allergen questions the kitchen's sheet answers and one it does not, a phone number dictated aloud, an attempt to override the rules, a cancellation, a change, opening hours and a question the restaurant has answered in writing. Twenty of them happen over WhatsApp, fifteen in the restaurant website's chat, where the guest types the number in the chat's own field, and six on the phone. The phone set (`MAITRE_EVAL_SET=voice`) plays twenty-six as calls: the WhatsApp ones with the number from caller ID, and the six written for the phone.
- **"Right" is written as checks on the outcome, never as an opinion:** the booking made (day, time, party size, name, the number the channel gave, the allergies), nothing booked, a request for the team to call back and its reason, a cancellation, a move, a tool used, a reply that must or must not say something.
- **Every reply of every conversation is checked as well:** the allergen sheet repeated word for word, no internal names, plain text, the guest's language, never the guest's phone number, and no title guessed in front of the guest's name.
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

**The new rule was wrong.** It asked about allergies in the same message as a question answered with yes or no: "a table for 2 on the 24th, does anyone have an allergy?". A guest answering "Yes, that's right" had answered both, and the models, rightly careful, asked which allergy instead of booking. The question now goes only with the question for the name, which cannot be answered with a yes, and a guest who gives the name without mentioning allergies is booked without being asked twice. Of the four models measured, only Gemini was unaffected by the ambiguous rule.

### Run E: commit ac58952, the final code

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Cost | Per conversation |
|---|---|---|---|---|---|---|---|
| **Claude Haiku 5.5** | **19/19** | **57/57** | 3.1 s | 5.7 s | 3/117 turns | $0.119 | $0.0021 |
| GPT-6 Luna | 19/19 | 57/57 | 3.5 s | 7.3 s | 0/117 | $0.015 | $0.0003 |
| GPT-5.6 Luna | 19/19 | 57/57 | 3.0 s | 6.1 s | 0/117 | $0.030 | $0.0005 |
| Gemini 3.1 Flash Lite | 17/19 | 55/57 | 1.8 s | 2.8 s | 0/117 | $0.140 | $0.0025 |
| Mistral Medium 3.1 | 18/19 | 56/57 | 1.6 s | 2.7 s | 0/117 | $0.058 | $0.0010 |

- **Gemini's two failures are both real.** Once it asked about allergies although the guest had already given the name, and as a question answered with yes or no, which the rule forbids; the guest's "Oui, parfait" was ambiguous again and nothing was booked. Once it sent a hold it had made up to the booking tool: the engine refused it, so no wrong booking was made, but the conversation ended without one.
- Mistral Medium still asked twice before moving a booking, in one run of three.
- When the guard stepped in for Haiku, the reply now reads cleanly: the exact sentences first, then what the model added, said once.

### Run F: the chosen model on the final code, for the demo

Claude Haiku 5.5 alone, on commit b85dfe6 with the demo restaurant renamed Merrain: the code after the floor plan was added, and the name the demo shows. Right in all 57 conversations again (19/19), with a p50 of 3.0 s, a p95 of 6.6 s, the guard stepping in on 2 turns of 117, and $0.118 spent. The demo's recorded conversations came from this run until run G.

### Run G: the site's chat, and the guest's title (12 October)

Claude Haiku 5.5 alone, on 31 scenarios: the 19 before, and 12 in the chat of the restaurant's website (channel `web`), the ones the public demo plays.
- Four book for the demo evening, Friday 16 October at dinner, at times that evening still has a table for.
- Two pass a large party to the team, and six are questions.
- They are in French, English and Spanish.

The web chat brings no number. The assistant asks for it in the chat's own field, the guest types it there (`fieldPhone` in the scenario), and the harness, like the site's Worker, gives it to the session and to the requests already passed to the team. Replays do the same, and say when the chat shows the field.

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Cost |
|---|---|---|---|---|---|---|
| **Claude Haiku 5.5** | **31/31** | **93/93** | 3.2 s | 6.4 s | 28/195 turns | $0.194 |

That is the last of seven runs of the whole suite that day; two shorter ones repeated a single scenario. On the way:

- **The replies guessed the guest's gender.** Read as a guest would, the first run said "monsieur Mercier", "Mr or Ms Clarke" and "señor Navarro", and once called a woman who had mentioned her husband "monsieur". A new universal check, "guesses no title for the guest", found it in 16 of the 84 comparable conversations when that run was scored again.
- **The prompt did not fix it.**
  - With the wrong form as an example, the model started the habit and corrected itself halfway through the reply: "De nada, señor Navarro… perdón, me he equivocado".
  - With only right examples, it still put a title in all three English bookings, or wrote around the name: "Thank you, Clarke's table is all set".
- **So the code keeps it, as with the allergen sheet.**
  - One guard takes a title and the name out when they address the guest: "Merci, monsieur Mercier." becomes "Merci.".
  - Another takes out the bare surname the guest booked under: "Thank you, Clarke.".
  - Both count as corrections, which is why the guard column rose. The prompt is the one of runs E and F.
- **Two failures were the evaluator's.** The check against saying the mousse has no nuts caught "nut-free" in an offer to check the menu, then in "don't order it unless they confirm it is nut-free". It now counts only claims about the dish, outside a condition, with both replies among its tests, and those runs were scored again.
- The scripted guest of the scenarios for large groups answered "yes, call me back" to a question about the time. The time is now in the first message.
- `npm run eval:rescore` read `meta.json` as a model's results and stopped. It skips it now.
- For each scenario, the export takes a run where no reply was corrected, when there is one.

**One slip came back, about once in ten.**
- In `day-after-tomorrow-fr` the guest gives the name in the first message. Now and then the model still asks about allergies as a yes-or-no question, and the guest's "Oui, parfait" leaves the booking unmade: the failure of run D.
- It happened in 4 of the 37 runs of that scenario that day, with the title rule or without it (3 of 23 with it, 1 of 14 without), and in none of the 6 of runs E and F.
- It is the next thing to work on. Meanwhile the demo plays a run where the booking was made.

### Run H: the number carries the turn on (12 October, night)

In the web chat, the phone field now sets the turn going by itself. The code hands the model a note that the guest has typed their number (`PHONE_ENTERED`), and the booking or the request goes through in the same answer, with nothing more for the guest to write. The Worker does the same once the number arrives, and its answers now say what the turn did, read from the engine: the bookings made or moved, a request passed to the team, the field to show. The seven site conversations with the field lost their "C'est fait", "Done" and "Ya está".

| Model | Scenarios passed | Runs passed | Latency p50 | p95 | Guard fired | Cost |
|---|---|---|---|---|---|---|
| **Claude Haiku 5.5** | **31/31** | **93/93** | 3.0 s | 6.6 s | 29/195 turns | $0.197 |

The demo's recorded conversations come from this run.

### Run I: the same conversations on the phone (12 October, night)

The phone needs its own choice: the caller hears every second of silence. `MAITRE_EVAL_SET=voice` plays the eighteen conversations that do not need the web chat on the voice channel, with the number from caller ID, and every reply must also read no booking reference aloud. The summary gains a column: when the model first answers, which on the phone is when the caller hears something, the reply or the short line said while the tools run. Commit e38f58e.

| Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|
| **Claude Haiku 5.5, fastest provider** (`@latency`) | **18/18** | **54/54** | 2.3 s | 5.7 s | 1.2 s | 2.2 s | $0.113 |
| Claude Haiku 5.5 | 18/18 | 54/54 | 2.8 s | 6.7 s | 1.5 s | 2.5 s | $0.113 |
| GPT-5.6 Luna | 17/18 | 53/54 | 3.3 s | 5.7 s | 2.0 s | 2.7 s | $0.027 |
| Gemini 3.1 Flash Lite | 16/18 | 52/54 | 1.6 s | 2.4 s | 0.8 s | 1.3 s | $0.134 |
| Mistral Medium 3.1 | 12/18 | 37/54 | 1.5 s | 2.9 s | 0.7 s | 2.7 s | $0.049 |
| gpt-oss-120b on Groq | 9/18 | 44/54 | 1.1 s | 2.1 s | 0.5 s | 0.9 s | $0.074 |

- **Routing alone saves a fifth.** The same model sent to whichever of its providers answers fastest at the time starts speaking 0.25 s sooner at the median, with the same answers.
- **gpt-oss-120b on Groq is three times as fast and unusable.** Some replies were its own reasoning, in English, in the middle of a French call ("We see the assistant responded incorrectly with garbled output…"), or trailed off into "Oops… …".
- **Mistral Medium 3.1** read booking references aloud inside the confirmation, which the guard then missed (fixed in 5d96f0d: it now takes out the mention and keeps the confirmation; with it, Mistral would have passed 15 of 18). It also lost 9 turns to its provider.
- **Gemini 3.1 Flash Lite** is the fast candidate that stays: one real slip in 54 conversations (it asked about allergies after the guest had given everything, the known slip of run G) and one reply a strict check refused ("My instructions are to assist guests…", which reveals nothing).

The phone keeps Claude Haiku 5.5, routed to its fastest provider: the only model right in every conversation. The rest of the wait is the code's to cut.

### Run J: the rules cached, a choice asked once, and a stall cut short (12 October, night)

Three changes, each found by looking at a run:

- **The rules were never cached.** Every model call sent about five thousand tokens of rules and tools, and Anthropic's models through OpenRouter cache only where they are told. The prompt now marks the stable part and the guest's last message (fd033d9). On the phone set a conversation costs a third of what it did.
- **A yes that chooses nothing.** The design review found the assistant asking "which of the two?" six times to a guest who kept answering "oui, je confirme", and finally asking for "1". The prompt now says to ask once, as a question answered with yes or no, whether the first time suits them, never to ask for a number and never a third time. New conversation `unclear-choice-fr`, with its phone twin.
- **A stalled provider.** In the full run below, three model calls took 451 seconds each: the 30-second limit stopped at the response's headers, which OpenRouter sends at once. It now covers the whole answer, and the phone gets 8 seconds and one retry (eefe791).

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| Phone | Claude Haiku 5.5 `@latency` | 19/19 | 57/57 | 2.3 s | 5.0 s | 1.3 s | 2.2 s | $0.036 |
| All channels | Claude Haiku 5.5 `@latency` | 31/32 | 94/96 | 1.9 s | 4.8 s | 0.9 s | 2.1 s | $0.098 |

The one scenario that failed, `closed-day-en`, failed twice on the stalled calls, never on an answer. With the fix, it and `unclear-choice-fr` were run again: 6 runs of 6.

Chat and phone now use `anthropic/claude-haiku-5.5@latency` (`worker/wrangler.jsonc`): the same model, sent to whichever of its providers answers fastest.

### Run K: a yes that the rest of the sentence takes back (13 October)

The design review asked "Bonsoir, vous êtes ouverts dimanche soir ?" and got "Oui, nous sommes ouverts dimanche 18 octobre, mais uniquement pour le déjeuner", twice. The "oui" is the answer the guest hears; the evening is closed. `hours-es` let the same thing through in Spanish, because its check looked for a "no" anywhere in the reply. The prompt now says to answer exactly what was asked first, and to start with no when closed at the time asked about. New conversation `closed-evening-fr`, and `hours-es` now refuses a reply that opens with "sí".

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| All channels | Claude Haiku 5.5 `@latency` | 32/33 | 98/99 | 2.5 s | 5.4 s | 1.3 s | 2.6 s | $0.063 |
| Phone | Claude Haiku 5.5 `@latency` | 20/20 | 60/60 | 2.4 s | 5.6 s | 1.3 s | 2.6 s | $0.037 |

All three answers now open with "Non, le dimanche 18 octobre nous ne sommes ouverts que le midi…". The one failure is the slip described in run G, in `day-after-tomorrow-fr`: given the name unasked, the model still asked about allergies as a yes-or-no question, and the guest's "Oui, parfait" left the booking unmade. It is the next thing to work on.

### Run L: the slip of run G, found in a tool's own words (13 October)

The slip came from `find_table` itself: on "available" it told the model to read back the table and ask for the name, even when the guest had just given it, and rule 4 says to ask about allergies with the name. The model asked the allergy question alone, as a yes or no. The tool now says: when the name is already given, book at once with the allergies mentioned or an empty list, and ask nothing more. `book_table` no longer asks for the reference to be read on the phone, which the guard then had to take out.

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| The three allergy conversations, 10 runs each | Claude Haiku 5.5 `@latency` | 3/3 | 30/30 | 3.7 s | 5.7 s | 1.5 s | 2.6 s | $0.027 |
| All channels | Claude Haiku 5.5 `@latency` | **33/33** | **99/99** | 2.5 s | 5.0 s | 1.3 s | 2.4 s | $0.062 |
| Phone | Claude Haiku 5.5 `@latency` | **20/20** | **60/60** | 2.6 s | 5.5 s | 1.4 s | 2.6 s | $0.037 |

The first full run with no failure at all. On the phone the guard fired on 32 turns of 126 instead of 41: the model reads fewer references aloud now that no tool asks it to.

### Run M: a hello, a promise, a goodbye, and a fallback that did not pass (13 October)

Miguel used the chat in Spanish and found two things; a third came from the fallback test.

- **A hello alone got the welcome again.** To "Hola", the assistant listed what the welcome had just said. The prompt now says to answer a hello in a few words. New conversations `hello-fr` (and its phone twin) and `web-hello-es`: "¿En qué puedo ayudarle?", "Bonjour, que puis-je faire pour vous ?".
- **"Buenas noches" in the afternoon.** The demo restaurant lives on its own evening, 20:05, which the chat did not show; it now does. A rule against wishing any time of day was tried and dropped: a person on a restaurant's phone says "bonne soirée" by the restaurant's hour too, and the model did not keep the rule (2 runs of 3 still said "que tenga un buen día"). `web-goodbye-es` now checks what would be wrong: a good night at 10 am, the restaurant's hour in the evaluation.
- **A promise kept by code.** GPT-5.6 Luna, tried as a fallback, told a party of twelve "je transmets votre demande à notre équipe" without calling `hand_over`, in one run of three: the team would never have known. Luna is not switched on. And the agent now keeps such a promise itself: a reply that tells the guest the team has their request, with nothing passed on in the conversation, passes it on (`kept_promise`). It never fired on Claude in 171 conversations.

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| All channels | Claude Haiku 5.5 `@latency` | **36/36** | **108/108** | 2.5 s | 5.1 s | 1.3 s | 2.2 s | $0.073 |
| Phone | Claude Haiku 5.5 `@latency` | **21/21** | **63/63** | 2.6 s | 5.6 s | 1.5 s | 2.2 s | $0.038 |
| All channels, as a fallback | GPT-5.6 Luna | 31/33 | 97/99 | 3.8 s | 6.3 s | 2.3 s | 3.2 s | $0.054 |
| Phone, as a fallback | GPT-5.6 Luna | 19/20 | 59/60 | 4.3 s | 6.9 s | 2.6 s | 3.4 s | $0.035 |

### Run N: the sheet speaks alone, French spacing, and the phone field (15 October)

Three things seen in the dashboard's conversations, from live use.

- **The allergen answer said it twice.** Besides the sheet's «La fiche du plat « Mousse au chocolat » ne précise pas s’il contient des fruits à coque», the model wrote «La fiche de la mousse au chocolat ne précise pas…»: 87 % of the sheet's words, under the 90 % the guard asked of a restatement. The guard now lets only the sheet speak for a dish and an allergen it was asked about. Any sentence of the model's that names them both goes, a restatement or a claim of its own, and what followed it goes on from the sheet's sentences.
- **French spacing.** A sentence of the engine's already had its narrow spaces inside « », and the cleaning added a second one after «. A time copied with the spaces that keep it on one line lost the space after it: «21 h 30est disponible». Both are fixed in `frenchSpacing`.
- **«et non dans le chat».** Told not to ask for the number "in the conversation", the model said so, and the field is in the chat. The tool now says "the phone number field at the bottom of the chat, rather than in a message".

The one failure, `web-allergen-unknown-en` run 2, was the evaluator's: «I cannot confirm the mousse is nut-free» counted as a claim. The check now reads a doubt like a condition, and the run was scored again without calling a model.

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| All channels | Claude Haiku 5.5 | **41/41** | **123/123** | 2.8 s | 5.8 s | 1.6 s | 2.5 s | $0.080 |
| Phone | Claude Haiku 5.5, Vertex Europe first | **26/26** | **78/78** | 1.7 s | 3.7 s | 0.9 s | 2.1 s | $0.057 |
| All channels, as a fallback | GPT-6 Luna | 41/41 | 123/123 | 3.4 s | 6.7 s | 1.8 s | 3.7 s | $0.037 |

GPT-6 Luna passed everything as a fallback, which GPT-5.6 Luna did not in run M. Mistral Small 2603 got 429 from OpenRouter on 216 turns of 255: no verdict on the model.

### Run O: complete allergen sheets (16 October)

The demo restaurant's sheets now declare all 14 allergens of every dish, as a French kitchen must keep them. One gap stays on purpose: nuts in the chocolate mousse, which the chocolate's specification does not state. The scenarios that ask about allergens ask about gluten, which every sheet already declared, and about the mousse's nuts, so none of their expectations changed.

- **The one failure was the evaluator's.** In `voice-closed-day-en` run 2, «Monday 19 October is unavailable at that time» matched the check against saying Monday is open: «available» inside «unavailable». The check now reads «unavailable», «not available» and «isn't available» as what they are, with that reply in its test, and the run was scored again without calling a model. The rescore also learned to find the phone's scenarios, whose ids start with `voice-`.
- **The conversations the demo plays while it is paused were recorded again** from this run: 35 of them, chat and WhatsApp. Calls are not played in the demo, and hanging up belongs to the line, not to the engine a replay runs on.

| Set | Model | Scenarios passed | Runs passed | Turn p50 | p95 | First answer p50 | p95 | Cost |
|---|---|---|---|---|---|---|---|---|
| All channels | Claude Haiku 5.5, Vertex Europe first | **41/41** | **123/123** | 1.6 s | 4.3 s | 0.9 s | 2.0 s | $0.102 |
| Phone | Claude Haiku 5.5, Vertex Europe first | **26/26** | **78/78** | 1.6 s | 3.6 s | 0.9 s | 2.1 s | $0.058 |

## The choice: Claude Haiku 5.5

The rule:

1. Every conversation right in all three runs, in the final run and in the previous full one.
2. Among those, the shortest wait for the guest at the 95th percentile, as long as a conversation costs under half a cent.
3. Within half a second, the better score on [τ²-Bench Airline](https://openrouter.ai/benchmarks), an independent test of conversations over several turns, with tools: Claude Haiku 5.5 75.3 %, Gemini 3.1 Flash Lite 72.0 %, GPT-5.6 Luna 70.0 %, GPT-6 Luna 67.3 % (OpenRouter, 10 October 2026).

Haiku, GPT-5.6 Luna and GPT-6 Luna were right in every conversation of runs B, C and E. Haiku and GPT-5.6 Luna were within half a second of each other at the 95th percentile in both runs (5.4 s against 5.2 s, then 5.7 s against 6.1 s), and Haiku scores higher on τ²-Bench. It also held up best of the three under the ambiguous rule of run D. A conversation costs about two tenths of a cent, so about 2 dollars for a thousand.

- **Gemini 3.1 Flash Lite** waits half as long, 2.8 s against 5.7 s at the 95th percentile, and was the only model that asked about allergies unprompted. But in the final run it broke an explicit rule and made up an identifier. It stays the first candidate for the voice channel, where every second counts, and that choice will be made with its own test.
- **GPT-6 Luna** costs an eighth of Haiku and was right every time, but it is the slowest at the 95th percentile, it sometimes speaks of the restaurant in the third person ("abren", "no aparece servicio por la noche"), and it was the most affected by the ambiguous rule.
- **Claude Sonnet 5.5** was right every time in run B, at twenty times the cost and with a 95th percentile of 10 s.

The model is set in `worker/wrangler.jsonc`. It can be changed there without touching code; any change should come with a new run.

## Limits of this evaluation

- Thirty-one conversations is a regression suite and a comparison, not a proof. A model that slips once in a hundred conversations still passes all 93 about two times in five; run G found a slip of about one in ten only by repeating one scenario.
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

Runs A to F and a few test calls cost $4.19. Run B accounts for $2.69 of it, $2.33 of that for Claude Sonnet 5.5 alone. Run G, with its six earlier passes and two repeats, cost $1.44 more, and run H $0.20. Run I cost $0.51, run J $0.14, run K $0.10, run L $0.13, run M, with the fallback's test and the rule that was dropped, $0.31, run N $0.19, and run O $0.16: $7.37 in all.
