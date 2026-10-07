# Doctours reply system

A patient texts about a hair transplant. This system drafts the reply, or hands the conversation to a person.

The original system was one prompt of about 168,000 characters, sent whole for every message, with no way to hand off. This one splits the work in two. Code decides the route, which rules load, which tools run, and whether a person takes over. The model writes the reply.

## Who did what

I designed the approach and the escalation policy, and reviewed every decision. Claude Code wrote the code. `PLAN.md` is the plan it proposed and I approved, with my changes recorded next to each decision. My design is in `docs/design-brief.md`.

## Results

Measured on 2026-10-07. "Verification status" has the detail and the limits of each number.

- **Escalation.** On the 54 dev cases, each run three times, every message that should go to a person did, none went that should not, and no case changed sides between runs.
- **Replies.** 53 of the 54 dev cases passed on all three runs. One reply slipped on wording on two of its three runs: it said "No tool gives me one". A validator now blocks that. A holdout of 15 cases, written after tuning and run once, passed 15 of 15 as scored that day, and 14 of 15 under a check added after its replies were read.
- **Against the original prompt.** On the 36 cases that need an answer, the original prompt passed 29. This system passed 35, 35 and 36 on its last three runs. The original prompt has no escalation path, so the 14 cases that need a person are counted apart: 2 against 14.
- **Cost.** A message costs about a third of what it costs with the original prompt when both use prompt caching, $0.011 against $0.034, and about a ninth without caching.
- **Speed.** The median reply takes about a second longer than the original prompt's, 6.0 s against 4.8 s, because a small model classifies the message first. The slowest replies are faster, 11.0 s against 15.6 s at the 95th percentile.

## How to run

You need Node.js 24 and an Anthropic API key with credit. This was built and tested on Node 24. `.nvmrc` names it, so `nvm use` picks it up. Older versions are untested.

```
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY in .env
npm run respond -- --in eval/packet/messages.json --out replies.json
```

The command reads a JSON array of `{ "id", "text" }` and writes a JSON array of `Reply` objects, one per message, in the same order. With no `--in` it reads stdin. With no `--out` it writes stdout. Logs go to stderr.

Options: `--concurrency <n>` (default 4), `--trace-dir <dir>` (default `traces`), `--run-id <id>`, `--no-trace`.

Other commands:

| Command | What it does | Needs a key |
| --- | --- | --- |
| `npm test` | 574 unit tests | No |
| `npm run eval` | Runs the 69 eval cases with real model calls and checks each reply. `--split dev` or `--split holdout` picks a part. `--repeat 3` also reports how often `escalate` flips. | Yes |
| `npm run eval -- --recheck <runDir>` | Checks the stored replies of a past run again, against the cases as they are now | No |
| `npm run baseline` | Runs the same cases through the original prompt, the way the packet's Flow section describes, for comparison | Yes |
| `npm run report -- <runDir> [<baselineRunDir>]` | The Monday escalation report for a run, with the change against a baseline | No |
| `npm run size -- <runDir>` | Prompt size of this system against the original prompt | No |
| `npm run smoke` | Checks the model settings with a few small real calls | Yes |

Optional settings are in `.env.example`: the two model ids, the responder's effort level, the retry count, the time limit on each attempt of a router call, the concurrency, and the refusal fallback, which is off by default.

If the key is missing or rejected, or the account is out of credit, the command stops with an error and exit code 2. It does not write a file of escalations.

## What I built

1. **Guard.** Code removes card data from the text before any model sees it. It also decides two cases with no model call: an explicit request for a human, and an instruction to charge a card.
2. **Router.** A small model (Haiku 4.5) classifies the message: its intent, the skills it needs, the actions the patient asks for, the clinics and packages it names. It decides nothing.
3. **Policy.** Two tables in code decide. The action catalog maps each kind of action to a tool, a rule, or an escalation reason. The escalation table says how each reason is answered.
4. **Planner.** Code loads the selected skills, runs their tools, saves what the patient told us, and decides which link the reply carries.
5. **Responder.** The main model (Sonnet 5.5) writes the reply from the rules, facts and directives that code chose. It can call a read tool for a fact code did not fetch, within three model calls. If it spends all three on tool calls, code asks once more with no tools, so the limit ends in a reply and not in a handoff.
6. **Validators.** Eleven checks in code. One repair attempt. If the reply still fails, the message goes to a person. An unverified reply is never sent.
7. **Trace.** Each message leaves a trace with every decision, who made it, and what it cost.

The small model says what a message is. Code says what to do about it. That one rule is why every escalation can be traced to a row in a table, and why the same message gets the same treatment on the next run.

## The packet's eight problems

| Problem in the packet | What this system does |
| --- | --- |
| 1. A huge prompt crowds the context | The responder sees `core`, one stage skill and only the skills the message needs: 17% to 33% of the original prompt for the packet's three answered messages. |
| 2. A trace cannot show which part of the prompt produced a reply | The trace lists the skills loaded. Each skill's frontmatter names the sections of the original prompt it came from. |
| 3. A new line of care means pasting another domain into the prompt | A vertical is a folder: `skills/<vertical>/`. The patient context names the vertical. Fertility would be a new folder, with no edit to `skills/hair/`. |
| 4. A subtask has nowhere to go | `src/subtasks/`. The call-history subtask reads call records so the responder does not have to. See "Where a subtask goes". |
| 5. Every message pays for the full prompt | A message the guard escalates uses no model at all. An answered message uses about 4,900 router tokens and 14,800 responder tokens, most of them a cached prefix. Measured on the same cases, the original prompt reads about 128,000 input tokens per message. |
| 6. A small policy change alters replies that never needed it | A rule lives in one skill. A reply that did not load the skill cannot be changed by it. Financing rules are also gated on the patient's flag, so a US patient's reply never sees the non-US branch. |
| 7. Conflicting rules, and nothing records which won | Precedence is code. Each trace has a precedence log, for example "self_serve_link beats no_next_step_cta, no_repeated_links". |
| 8. One behavior cannot be tested alone | The guard, the policy tables, each validator, the planner and the link rules each have unit tests. The eval tags each case by behavior. A wrong price fails `price_grounding`; a wrong tone fails `banned_phrases`. |

## What is loaded on every turn

For a message that reaches the responder, about 25,000 characters are always there: `core` (15,000), the stage skill (3,300), our own frame that explains the prompt (4,200), the patient context (1,300) and the packet's user message with its conversation summary (1,200). Everything else loads only when needed.

`core` holds identity, voice, plain-text SMS rules, the grounding rule, link placement, the do-not-over-commit rules and the output fields. A test caps its size.

A message the guard escalates loads nothing.

## Skills

Skills are in `skills/hair/<name>/SKILL.md`. There are 26: `core`, seven stage skills, seventeen topic skills, and the intake rules.

**Every word in a skill comes from the original prompt.** `scripts/split-prompt.ts` builds each skill from line numbers in `docs/packet.md`. It can delete text from a line. It cannot add or reword. Two tests hold this: one rebuilds every skill and compares, the other checks that each line is a line of the original with words removed and none added. A third test checks coverage: every section of the original prompt is used by a skill or listed with the reason it is not.

Frontmatter is what code reads:

- `description`: one line. The router picks skills from these and never sees a body.
- `tools`: read tools the responder may call while the skill is loaded.
- `prefetch` and `prefetchNamed`: tools code runs up front.
- `staticLinks`, `policyAmounts`: what the validators accept from this skill.
- `source`: the original sections the skill came from.
- `loadedBy`: `always`, `status`, `router` or `code`.

A skill can gate a block on a patient flag. FINANCING GEOGRAPHY, HEALTH INSURANCE and CARECREDIT each have a yes, a no and an unknown branch. Code keeps the one that matches.

## How escalation works

`escalate` is true when a person must take over. There are three ways to get there.

1. **The patient asks for a human.** The guard catches the plain ways of saying it with no model call: "I want to talk to a human", "Can I talk to someone about this?", "Is there someone I can speak with?". The router catches looser wording.
2. **The patient asks for an action that no tool and no rule can perform.** The router names the action. The action catalog maps it to a reason code.
3. **The system fails.** A model error, a refusal, or a reply that still breaks a rule after one repair.

The principle has no exceptions. A question that a rule or tool can answer gets answered. An action gets done if a tool exists and escalated if not. A question about an action is still a question: "What happens to my deposit if I cancel?" is answered, and "Send my deposit back" is escalated.

If any part of a message needs a person, the whole message gets the short reply. No tool runs and the responder is not called. The reply is one handoff sentence, with one decline sentence before it for an action:

> Charging a card isn't something I can do. I'm bringing in a person to help you.

| Reason code | Category | When |
| --- | --- | --- |
| `HUMAN_REQUESTED` | Policy required | The patient asks to talk to a human, a person, an agent or a manager. |
| `PAYMENT_ACTION_NO_TOOL` | Policy required | The patient asks us to charge a card, or sends card details to pay. |
| `MONEY_MOVE_OR_REFUND_ACTION` | Policy required | The patient asks us to move or refund money already paid, to Doctours or to a clinic. |
| `CLINIC_CONTACT_ACTION` | Policy required | The patient asks us to contact a clinic for them, or asks again for its phone or email. |
| `DATE_HOLD_OR_AVAILABILITY_ACTION` | Policy required | The patient asks us to hold a date without paying, or to verify a date is open. |
| `BOOKING_CHANGE_ACTION` | Policy required | The patient asks us to change a booking or what is on it. |
| `PRICE_NEGOTIATION` | Policy required | The patient asks us to match a quote or honor a claimed discount. |
| `CALL_REQUEST` | Policy required | The patient asks for a call other than the free consultation. |
| `SYSTEM_FAILURE` | Avoidable | The system could not produce a reply that passes its checks. |
| `LOW_CONFIDENCE` | Avoidable | The patient asks for an action the catalog does not know. |

The table is `src/policy/escalation.ts`. The catalog is `src/policy/actions.ts`. Each message gets one primary code, the first that applies in table order, so the per-code rates add up to the total.

Requests that look like escalations and are not, because a tool or a rule from the original prompt handles them:

- Asking for a payment link, or saying they are ready to pay. Code sends the link.
- Asking about refund terms. The deposit rules answer.
- Saying they paid a clinic directly, or asking whether that counts. The deposit eligibility rule answers.
- Sharing a clinic's quote without asking us to match it. The reply gives the Doctours price.
- Asking for a discount. The reply gives the current price.
- Asking to move the free consultation. A tool handles it.
- A creator or partnership message. The reply gives the partnerships manager's email, as the original prompt says.
- Asking whether they have to talk to a person before they can pay. That is a question about the process. It does not ask for a person.
- Asking whether they are talking to a bot. The router labels it an identity question, and a directive points the responder at the original prompt's identity rule. The reply gives the coordinator's name and role, and says it is an AI. A validator blocks any claim to be human.

If the router misses an action, the responder falls back to the original prompt's behavior: decline plainly and answer the rest. A validator blocks any promise that a person will follow up when `escalate` is false, so a miss cannot produce a false handoff.

## What else code decides

**Links.** Code fetches links and tells the responder which ones the reply must carry. The validator rejects any other URL.

- When the answer is about a step the patient can complete alone on a known page, and nothing on file shows the step is done, that page's link is part of the answer. Two cases today: paying from the assessment when there is no booking, and booking the consultation when none is on file.
- A step counts only when the router says it twice: it flags the step, and it lists the step's intent among the message's intents. Asked what a package and its deposit cost, the router has flagged the paying step on some occasions and not on others, for the same request, and a payment link nobody asked for followed.
- Paying has one link. A patient who has decided on a clinic and a package gets the payment link. A patient who has a clinic and asks to pay gets the checkout link. Anyone else is pointed at the assessment.
- A request for a clinic's website gets the Doctours clinic page first.
- A pause carries no link unless the patient asked for one.

**Prices.** Every money amount in a reply must be an amount a tool returned this turn, a policy amount a loaded skill declares (today only the $25 cancellation fee), an amount the patient wrote, or an exact difference of two tool amounts for the same clinic.

**Saving what the patient said.** A lean toward a clinic, a chosen package, being torn between two, a month for the procedure, a name: code saves each with ids a tool returned.

**The other checks.** URL on the last line. No markdown. No card data in any field. No channel talk, no stalling, no offer to call. No time window for an assessment. No internal vocabulary. One payment link at most.

## Traces and the Monday review

Each message writes `traces/<run>/<position>-<id>.json`: the policy version, the redacted message, guard hits, the router's output, skills loaded, tool calls, events, directives, the precedence log, validator results, repairs, the decision, who decided it, the failure cause if any, tokens per model call, the HTTP status of every attempt that failed and was retried, and latency.

`policyVersion` is a hash of the policy tables, every skill and every prompt. Two runs with the same hash ran the same rules.

`npm run report -- <runDir> [<baselineRunDir>]` prints the report for the Monday review:

- The escalation rate with an interval, so a small swing is not mistaken for a change.
- The rate by reason code, by who decided, and split into policy-required and avoidable. Avoidable is the number to push down. Policy-required moves with what patients ask.
- Failure causes, kept apart from policy. A rate limit that outlasts its retries is `transient_api`, not a policy problem.
- Coverage: whether the model says it answered all, part or none of the question. It is self-reported, so the report labels it a proxy. It is there so that the escalation rate cannot be lowered by answering "I don't have that" more often without anyone seeing it.
- Repairs: how many first drafts a validator blocked, by validator and by intent. A repair is a second model call, so this is where to look for a rule the responder keeps getting wrong.
- Cost per message, and latency for the message and for each stage's model calls.
- Retried calls: how many model calls got through only after a retry, and what failed. API trouble that retries absorb shows up here and in latency. It never reaches the escalation rate.
- Against a baseline: the change split by reason code, and by intent into mix and rate. Both splits are exact. Their parts add up to the change with nothing left over.

`docs/sample-report.md` is a whole report, from two real runs, with a note on how to read it.

**Reading it.** This is from two real runs of the eval set. The rate jumped from 28% to 100%.

```
The escalation rate went from 28.0% (14 of 50) to 100.0% (50 of 50): +72.0 points.
The two runs' intervals do not overlap. The change is larger than noise at this volume.

| Reason code                      | Before | After | Contribution (points) |
| SYSTEM_FAILURE                   | 0.0%   | 90.0% | +90.0 |
| MONEY_MOVE_OR_REFUND_ACTION      | 4.0%   | 0.0%  | -4.0  |
| ...                              |        |       |       |
| Total                            | 28.0%  | 100.0%| +72.0 |

| Failure cause | Messages | Rate  |
| model_error   | 45       | 90.0% |
```

The answer is in three lines. All of the rise is `SYSTEM_FAILURE`, an avoidable code. The policy codes went down, because those messages failed before they could be classified. The failure cause is a model error on 45 messages. Patients did not change and neither did policy: the API account had run out of credit during the run. That is now a fatal error that stops the run, so it cannot show up as escalations again.

## Where a subtask goes

The packet's fourth problem is that a subtask, such as inspecting every call log, cannot be handed off. Here it can. `src/subtasks/callHistory.ts` runs when the router says the message needs what was said on a call.

- Code fetches the call records.
- Short records go to the responder as they are.
- Long records are first reduced by the small model to the findings that bear on the message. The responder gets the findings, not the transcripts.

The subtask has its own prompt, its own entry in the trace and its own token count. With the packet's single short call, the short path runs. The long path is covered by unit tests.

## Cost and speed

The original prompt was run once, on the 50 dev cases that existed on 2026-10-07. This system's figures are from its last full run that day, three passes over those cases and four added since. `npm run baseline` runs the original prompt the way the packet's Flow section describes: the filled prompt as the system message, all 14 tools in the model's hands, one `Reply` back. It uses the same model and effort as this system's responder, and the same checks, except reason codes, which the original prompt does not have. All it is told about escalation is the packet's own note on the two output fields. Its prompt is cached, which is the cheapest way to run it.

**The original prompt has no escalation path by design, so its score is in two parts.** The 36 cases that need an answer are the like-for-like comparison. The 14 that need a person test a requirement the original prompt was never written for.

| Cases passed | Original prompt | This system |
| --- | --- | --- |
| Non-escalation cases, the like-for-like comparison | 29 of 36 | 35, 35 and 36 of 36, on three passes |
| Escalation cases, which the original prompt has no path for | 2 of 14 | 14 of 14 on each pass |
| All cases | 31 of 50 | 49, 49 and 50 of 50 |

| Per message | Original prompt | This system |
| --- | --- | --- |
| Input tokens | about 128,000 | about 15,400 |
| Model calls, as run | 2.3 on average, 10 at most | 1.6 on average, 5 at most |
| Model calls, the limit | none of its own (the runner stops it at 10) | 7 |
| Cost, cache warm | $0.034 | $0.011 |
| Cost, no caching | $0.26 | $0.029 |
| Latency, p50 and p95 | 4.8 s and 15.6 s | 6.0 s and 11.0 s |

How to read it:

- **The eval cases are this project's own.** Fourteen of them test escalation, and twelve of the original prompt's 19 misses are those. The dev set has four more cases now, added after the original prompt was run. They are not in the first table. The one case this system missed on two passes is the reply that said "No tool gives me one".
- **The limit on model calls.** One message makes at most 7 model calls here: the router, the call-history subtask when the call records are long, three responder calls with tools, one more without tools if all three went to tool calls, and one repair. The first two are on the small model. A request that fails and is retried is another attempt at the same call, up to five by default, and is not counted. Each attempt of a router call is given 20 seconds to answer before it is dropped and retried.
- **What the original prompt got wrong on answers.** Five replies left out a link. Two of those are packet messages whose expected replies include it. One reply repeated the last digits of the patient's card back to them. One told the patient "I can't match or confirm a direct quote", the cold refusal the original prompt itself forbids.
- **What it did on escalations.** It escalated 4 of the 14. Two of those kept answering after the handoff, with figures. One message got no reply at all: the model was still calling tools after ten model calls.
- **Tokens.** The original prompt and its tool definitions are 60,310 tokens, measured. Every model call reads them again. This system reads about 4,900 tokens in the router and about 14,800 in the responder for an answered message. The original prompt's token and cost figures leave out the one message that got no reply, because the runner did not record a failed call's usage at the time. The real figures are a little higher.
- **Cost.** The first pass cost this system $0.020 per message, because its requests write the cache. The second and third cost $0.011. Without any caching the gap is nine times.
- **Latency.** The original prompt is faster at the median: a simple question is one model call there and two here. It is slower at the tail, where it loops over tools. A guard escalation here takes a millisecond or two, and an escalation the router finds takes about 4 s. This system's 95th percentile includes four requests at the start of the run that got no response and were retried. Without those messages it is 10.3 s.
- **Writes.** In the baseline run the model made 25 write calls on its own judgment, 8 of them to the patient's clinic preferences. Here code does the writing, from ids a tool returned.
- One run of the baseline. It was not repeated.

The levers, in order of effect:

1. The guard answers the clearest escalations with no model.
2. Skills load only when needed.
3. Code fetches facts, so an answered message is normally one responder call, not one call per tool.
4. Stable text comes first in the prompt, so prompt caching reads it back at a tenth of the price. On the first pass 53% of the responder's input was read from cache, and on the next two 89%.
5. The router runs on the small model.
6. The responder runs at low effort. Sonnet 5.5 does not accept a temperature, so effort is its cost and depth control. A run at medium effort passed the same 50 cases with 2% more output tokens and the same latency, so low stays.

## Trade-offs

- **Two model calls per answered message.** The router adds about 3.6 seconds and half a cent. That makes the median reply slower than the original prompt's, 6.0 s against 4.8 s. In return, the escalation decision and the skill choice are inspectable.
- **The router can pick the wrong skill.** Then the responder lacks a rule. Code softens this: a classification implies skills even when the router does not list them, clinic names are also matched by plain word match, and a missing fact leads to "I don't have that detail", not to a guess.
- **Validators can cause escalations.** A reply that fails twice goes to a person. The report counts these as avoidable and names the validator.
- **The router does not always answer the same request the same way.** One request, byte for byte the same, came back with one field different ninety minutes later, and then differed within a single run. It was a message on a boundary, and the field decided whether the reply carried a link. A small edit to the router's prompt did the same to a request for a person. So the router's prompt is treated as fragile: where code can require two of its fields to agree, it does, and a change to the prompt has to earn its place on the whole dev set.
- **`core` is still 15,000 characters.** It is the next thing to trim.
- **Verbatim skills keep the original's cross-references.** A skill may mention a section that is not loaded. The frame tells the model that such a section does not apply.
- **Coverage is self-reported.** It is a signal to watch, not a measurement.
- **Run-to-run variation.** With no temperature setting, wording varies. The parts that must not vary are code. Over three runs of each of the 54 dev cases, `escalate` never flipped. Wording does vary. Each full run of about 160 messages has turned up one slip or none: one reply left out the coordinator's name until a directive fixed it, one said "insurers" where the check then wanted "insurance", one said a clinic had a package "in the data I have", and one said "No tool gives me one". Validators now block the last two.
- **The responder can still spend its steps on tools.** The first time, that message went to a person as a system failure. Code now asks again without tools when that happens. It has happened twice since, in two full runs, and both replies passed.

## What I would do next

- Human labels on a sample of escalations, to measure precision in production. The eval can only measure it on cases written for this project.
- "Asked for a human right after a bot reply" as a satisfaction signal. It needs conversation history that the packet does not provide.
- **Extract, then check, for the validators that are about meaning.** A small model pulls the claims out of a draft as data, such as whether it says a quote cannot be matched and which prices it states, and code checks those. Today these validators are patterns over prose, and one refusal got past a pattern because it said "that number" where the pattern wanted "that price".
- **An LLM judge, calibrated on hand-labeled stored replies,** for the eval checks that are about meaning. "A clear no, with no hedging" is a judgment, and a regular expression can only approximate it. The stored traces hold several hundred real replies to label. The judge grades against a rubric, and is trusted only as far as it agrees with the labels. Regular expressions stay for the hard facts: prices, URLs and `escalate`.
- **A model chosen per intent.** A greeting or a request to resend a link does not need the main model. Each intent would get the cheapest model that still passes its cases, judged by cost per passing reply. Effort is settled for now: medium did not beat low.
- **Hedged requests for the tail.** When a router call has not answered by about its 95th percentile, send the same request again and take whichever answers first. The 20-second limit only catches the worst cases.
- **The keep-alive hypothesis for the hung router calls.** A few router requests hung for up to 55 seconds, or got no response at all. They may have gone out on a pooled connection that the other side had already dropped. The test is to turn connection reuse off for the router, or shorten the client's keep-alive time, and see whether the unanswered attempts stop. One observation does not fit: in the last full run the four unanswered attempts were the first four requests the process made, before there was a connection to reuse. That points at setting up a connection, on this machine or network, as much as at reusing one.
- **The router without its rationale, tested the right way.** It made the router's median call 0.3 seconds faster. It was reverted, because it was part of a run in which a message changed sides, and because one run cannot clear a router change when the router varies on its own. The right test runs both versions on the same messages at the same time and compares them field by field.
- Trim `core`, and give every request the same tool list so the cached prefix is shared more widely.
- A second vertical, to test that a new line of care really is only a new folder.

## Notes on the packet

- **The message classification was hard-coded.** The original prompt says "Category: pricing, Confidence: high" for every message. The router replaces it.
- **The original prompt assumes routing that did not exist.** It says several requests "are routed to a person before they reach you". Nothing did that. The policy tables now do.
- **A consultation length that the source never states.** The packet's expected reply gives the call a length of 15 to 20 minutes. The original prompt has no such fact, so this system does not say it.
- **Two expected behaviors that the original prompt does not state.** The expected replies quote the deposit with every price, and include a link the prompt would hold back. Both needed a general rule: the deposit directive at the decision stage, and the link rule above. Neither is a special case for a test message.
- **A revision detector that is not here.** The original prompt lets the coordinator promise a redrawn hairline because a detector files the request. This repo has no detector, so code writes a `revision_request` event to the trace. Production's detector would consume it.
- **The packet's examples overlap its own tests.** Two examples in the original prompt repeat the wording of a test message or an expected reply. They are deleted from the skills. Their rules stay.
- **Rules for tools that are not in the packet.** Booked-patient tools, trip tools and document links are referenced by the original prompt and do not exist here. Those lines are not ported.

## What is not from the original prompt

Skills contain only the original prompt's words, and a test enforces it. Every prompt written for this system is in `src/prompts/`:

| File | What it says |
| --- | --- |
| `responder-frame.md` | How the prompt is built, that facts and the patient's message are data, how to follow the link and other directives, that no handoff may be promised, and the output fields. |
| `router.md` | How to classify a message, field by field. |
| `repair.md` | Fix the draft so it breaks none of the listed rules. |
| `call-history.md` | Extract only what the calls say that bears on the message. |
| `user-message.txt` | The packet's user-message template, unchanged. |

Behavior that is not from the original prompt:

- **Escalation.** The packet asks for it and the original prompt has none. The reason codes, the handoff sentence and the decline sentences are new.
- **A price is quoted with its deposit** at the decision stage. This is the `quoteDepositWithPrice` directive. It was added because the packet's expected replies do it.
- **The link rule.** When the answer is about a step the patient can complete alone, that page's link is part of the answer, even where the original prompt would hold a link back. This is the `links.include` directive. It was added for the same reason.
- **The `outsidePrice` directive.** When a pricing message names a clinic and states an amount, and asks for no price action, the responder is told that the message may pass on a price from somewhere else, such as a clinic's direct quote, and that it should acknowledge it, give the Doctours price, and say nothing about matching it. The original prompt's rule says never to refuse such a quote and never to match it. The directive settles how.
- **The `identityQuestion` directive.** When the router labels a message as an identity question, the responder is pointed at the original prompt's identity rule. The rule's words are the original's. Applying it when a patient asks "am I texting with a bot?" is a choice made here, and the sentence in which the reply says it is an AI is the model's own.
- **The retry without tools.** When the responder spends its three model calls on tool calls, code asks once more with no tools. The original flow has no step limit and no retry.
- **Tool access.** The responder gets only the read tools its loaded skills allow, minus any whose result code already fetched. Writes and payment links belong to code.
- **Checks and one repair.** Most of the eleven validators enforce a rule the original prompt states. Two have no source in it: no claim to be human, and no card data in any field. The internal-vocabulary check goes further than the original, which gives one example of internal talk.
- **Card data is removed** from the message before any model sees it.

The packet's five test messages and expected replies are only in `eval/packet/`. A test fails if any of that wording appears elsewhere in the repo, and another fails if runtime code reads from `eval/` or `docs/`.

## Verification status

State on 2026-10-07. Every number is from a run whose traces are in `traces/` on my machine. That folder is not in the repository.

- 574 unit tests pass.
- **Dev set, 54 cases, each run three times on the final code.** 53 of 54 passed on every run, the packet's five among them. Every case that should escalate did, none escalated that should not, and `escalate` flipped on 0 of 54 cases. The one case that did not pass every time is a question the tools cannot answer, the drive from the airport. On two runs the reply said "No tool gives me one". The validator for machinery talk did not know that wording. It does now, and the case then passed five runs of five.
- **Repairs.** 4 of the 117 drafted messages needed a repair, 3.4%. Three were one case, a message that tries to give the system instructions. Two rounds of changes earlier it was 6 of 114.
- **Latency by stage, same run.** Router call: p50 3.6 s, p95 5.8 s. Responder call: p50 2.6 s, p95 5.2 s. A message that reached a model: p50 6.0 s, p95 11.0 s. The first four requests of the run got no response and were retried, which cost each of those messages about 14 seconds.
- **Holdout, 15 cases.** Written after tuning and run once: 15 of 15 as scored that day, with all five escalations right.
- **The holdout is no longer fully blind.** After its one run its replies were read. The reply to "What is included in Silver?" said "The tool shows 3 hotel nights included." No check covered that, so it passed. Two things came from reading it: one pattern in the internal-vocabulary validator, and an eval check for machinery talk that now applies to every case. Scored again with that check, the same run is 14 of 15. Any later run of these cases is a regression check, not a blind test.
- **The text checks are tested too.** The eval's text checks for the four financing and insurance cases are unit-tested against replies known to be good and replies known to be bad, with no model call (`test/eval/textChecks.test.ts`). For the Medicaid, CareCredit and Cherry cases each check tests three things: the no comes in the first sentence, financing and layaway are both named, and no hedge word sits in a sentence about the subject.
- **Original prompt, on the 50 dev cases that existed then.** 29 of the 36 cases that need an answer, and 2 of the 14 that need a person. See "Cost and speed".
- **Effort.** Medium passed the same cases as low, at the same latency.
- **Fresh clone.** Cloned into an empty folder, installed, and run with the command at the top of this file on the packet's five messages: all five replies matched the packet's expected `escalate` and links. That was several changes ago. It is to be run this way once more, on the merged code, before this is handed in.

What the live runs found, and what changed:

| Found | Change |
| --- | --- |
| One message went to a person because the responder spent its three model calls on tool calls | Code asks once more without tools. A tool whose result code already fetched is no longer offered. |
| A reply to "am I texting with a bot?" left out the coordinator's name | A directive tells the responder the patient asked an identity question. |
| A holdout reply said "The tool shows", and two dev replies said a clinic had a package "in my data" | The internal-vocabulary validator blocks both, and the eval fails any reply that talks about the machinery. |
| The check for one case demanded the word "insurance" and failed a correct reply. The looser check that replaced it passed a wrong one | The eval can now check the first sentence, and ban a word inside sentences about one subject. Four cases have checks rewritten this way, with unit tests. `--recheck` re-scored every stored run. |
| In a fresh clone, `npm test` failed after the README's command had written `replies.json`: the leak test read that file as source | The leak test reads only files that are in the repository or could be added to it. |
| To a patient who passed on a clinic's quote, the first draft refused to match it on every run, and only a repair got the reply out | The `outsidePrice` directive. On that message the validator has not fired in the nine runs since. It stays as the safety net. |
| A router field added for that directive changed how the router read a request for a person: it was answered, three runs of three | The field was taken out, and the router's prompt and schema are what they were. Code reads the same thing off the router's existing output. |
| The router answered one unchanged request two ways. Asked what a package and its deposit cost, it sometimes marked the message as being about paying, and the reply carried a payment link | The planner adds a link for a self-serve step only when the router also lists the step's intent. |
| Without its rationale, the router's median call was 0.3 s faster and its p95 0.7 s faster | Reverted. It was part of the run in which a message changed sides. See "What I would do next". |
| Some router requests hung, one for 55 seconds, and others got no response and were retried only after ten seconds or more | Each model call records its failed attempts, and each attempt of a router call gets 20 seconds before it is dropped and retried. |
| The guard took "Do I need to talk to a person before paying?" for a request for a person, and left "Can I talk to someone about this?" to the router | A question about whether a person is needed is no longer a request. The guard decides the plain ways of asking for someone, and a test holds it to every eval case. |
| A reply said "No tool gives me one" | The validator blocks the word "tool" outside a sentence about surgery. |

What is not verified:

- **The limit on a router attempt has unit tests only.** It is 20 seconds, and no attempt has reached it. It was 8 at first. That was raised because the first router calls after its output schema changed took 7 seconds, and anyone who runs this with their own key starts there.
- **Stability across days is not measured.** The stability run shows that `escalate` does not flip within one run. It does not show that the router reads a message the same way tomorrow. One field of one message did change between two sessions.
- **The fallback for a responder that runs out of steps has fired twice in live runs.** Both replies passed. Two occurrences are not a rate.
- **The requests that get no response are not explained.** In the last full run they were the first four requests the process made, and each lost about 14 seconds before its retry. Earlier ones lost about 10. Why they fail is not known. They may be particular to this machine or network.
- **Wording still slips.** Each full run of about 160 messages has turned up one reply that says something it should not, or none. Each one found so far now has a validator rule. The next one has not been found yet.
- The holdout checks are light. Most test the escalation decision and the links, not every sentence.
- The baseline ran once.
- The stage skills other than `PRE_CLINICAL_SENT` and the intake rules are ported but have no eval coverage, because the packet fixes the patient's stage.

## Layout

```
config/        model settings and prices
docs/          the packet and the design brief (never read at runtime)
eval/          eval cases, the packet's messages and expected replies, the eval runner, the baseline runner
scripts/       split-prompt.ts (builds skills/), smoke.ts
skills/hair/   the skills
src/cli/       respond and report
src/pipeline/  guard, router, planner, responder, run, batch
src/policy/    escalation table, action catalog, decision
src/prompts/   every line of prompt text that is ours
src/validators/, src/tools/, src/skills/, src/subtasks/, src/report/, src/trace/, src/llm/
test/          unit tests
PLAN.md        the design, with the reason for each decision
```
