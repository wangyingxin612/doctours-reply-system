# Doctours reply system

A patient texts about a hair transplant. This system drafts the reply, or hands the conversation to a person.

The original system was one prompt of about 168,000 characters, sent whole for every message, with no way to hand off. This one splits the work in two. Code decides the route, which rules load, which tools run, and whether a person takes over. The model writes the reply.

## How to run

You need Node.js 22.12 or later (developed on Node 24) and an Anthropic API key with credit.

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
| `npm test` | 451 unit tests | No |
| `npm run eval` | Runs the 65 eval cases with real model calls and checks each reply. `--split dev` or `--split holdout` picks a part. `--repeat 3` also reports how often `escalate` flips. | Yes |
| `npm run eval -- --recheck <runDir>` | Checks the stored replies of a past run again, against the cases as they are now | No |
| `npm run baseline` | Runs the same cases through the original prompt, the way the packet's Flow section describes, for comparison | Yes |
| `npm run report -- <runDir> [<baselineRunDir>]` | The Monday escalation report for a run, with the change against a baseline | No |
| `npm run size -- <runDir>` | Prompt size of this system against the original prompt | No |
| `npm run smoke` | Checks the model settings with a few small real calls | Yes |

Optional settings are in `.env.example`: the two model ids, the responder's effort level, the retry count, the concurrency, and the refusal fallback, which is off by default.

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
| 5. Every message pays for the full prompt | A message the guard escalates uses no model at all. An answered message uses about 4,900 router tokens and 14,400 responder tokens, most of them a cached prefix. Measured on the same cases, the original prompt reads about 128,000 input tokens per message. |
| 6. A small policy change alters replies that never needed it | A rule lives in one skill. A reply that did not load the skill cannot be changed by it. Financing rules are also gated on the patient's flag, so a US patient's reply never sees the non-US branch. |
| 7. Conflicting rules, and nothing records which won | Precedence is code. Each trace has a precedence log, for example "self_serve_link beats no_next_step_cta, no_repeated_links". |
| 8. One behavior cannot be tested alone | The guard, the policy tables, each validator, the planner and the link rules each have unit tests. The eval tags each case by behavior. A wrong price fails `price_grounding`; a wrong tone fails `banned_phrases`. |

## What is loaded on every turn

For a message that reaches the responder, about 25,000 characters are always there: `core` (15,000), the stage skill (3,300), our own frame that explains the prompt (3,700), the patient context (1,200) and the packet's user-message template (1,900). Everything else loads only when needed.

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

1. **The patient asks for a human.** Explicit wording is caught by the guard with no model call. Looser wording is caught by the router.
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
- Asking whether they are talking to a bot. The router labels it an identity question, and a directive points the responder at the original prompt's identity rule. The reply gives the coordinator's name and role, and says it is an AI. A validator blocks any claim to be human.

If the router misses an action, the responder falls back to the original prompt's behavior: decline plainly and answer the rest. A validator blocks any promise that a person will follow up when `escalate` is false, so a miss cannot produce a false handoff.

## What else code decides

**Links.** Code fetches links and tells the responder which ones the reply must carry. The validator rejects any other URL.

- When the answer is about a step the patient can complete alone on a known page, and nothing on file shows the step is done, that page's link is part of the answer. Two cases today: paying from the assessment when there is no booking, and booking the consultation when none is on file.
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
- Cost per message and latency.
- Retried calls: how many model calls got through only after a retry, and what failed. API trouble that retries absorb shows up here and in latency. It never reaches the escalation rate.
- Against a baseline: the change split by reason code, and by intent into mix and rate. Both splits are exact. Their parts add up to the change with nothing left over.

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

Both systems were run on the 50 dev cases on 2026-10-07. `npm run baseline` runs the original prompt the way the packet's Flow section describes: the filled prompt as the system message, all 14 tools in the model's hands, one `Reply` back. It uses the same model and effort as this system's responder, and the same checks, except reason codes, which the original prompt does not have. All it is told about escalation is the packet's own note on the two output fields. Its prompt is cached, which is the cheapest way to run it.

| | Original prompt | This system |
| --- | --- | --- |
| Cases passed | 31 of 50 | 50 of 50 |
| The 14 cases that need a person | 2 | 14 |
| The 36 cases that need an answer | 29 | 36 |
| Input tokens per message | about 128,000 | about 15,500 |
| Model calls per message | 2.3 on average, 10 at most | 1.7 on average, 4 at most |
| Cost per message, cache warm | $0.034 | $0.011 |
| Cost per message, no caching | $0.26 | $0.029 |
| Latency, p50 and p95 | 4.8 s and 15.6 s | 6.0 s and 9.0 s |

How to read it:

- **The cases are mine, and 14 of them test escalation, which the original prompt was never written for.** Twelve of its 19 misses are those. The fairer comparison is the 36 answer cases: 29 against 36.
- **What the original prompt got wrong on answers.** Five replies left out a link. Two of those are packet messages whose expected replies include it. One reply repeated the last digits of the patient's card back to them. One told the patient "I can't match or confirm a direct quote", the cold refusal the original prompt itself forbids.
- **What it did on escalations.** It escalated 4 of the 14. Two of those kept answering after the handoff, with figures. One message got no reply at all: the model was still calling tools after ten model calls.
- **Tokens.** The original prompt and its tool definitions are 60,310 tokens, measured. Every model call reads them again. This system reads about 4,900 tokens in the router and about 14,400 in the responder for an answered message. The original prompt's token and cost figures leave out the one message that got no reply, because the runner did not record a failed call's usage at the time. The real figures are a little higher.
- **Cost.** A cold start costs this system $0.020 per message, because the first requests write the cache. Without any caching the gap is nine times.
- **Latency.** The original prompt is faster at the median: a simple question is one model call there and two here. It is slower at the tail, where it loops over tools. A guard escalation here takes about 2 ms, and an escalation the router finds takes about 4 s.
- **Writes.** In the baseline run the model made 25 write calls on its own judgment, 8 of them to the patient's clinic preferences. Here code does the writing, from ids a tool returned.
- One run of the baseline. I did not repeat it.

The levers, in order of effect:

1. The guard answers the clearest escalations with no model.
2. Skills load only when needed.
3. Code fetches facts, so an answered message is normally one responder call, not one call per tool.
4. Stable text comes first in the prompt, so prompt caching reads it back at a tenth of the price. Between 54% and 89% of the responder's input was read from cache, depending on how warm the cache was.
5. The router runs on the small model.
6. The responder runs at low effort. Sonnet 5.5 does not accept a temperature, so effort is its cost and depth control. A run at medium effort passed the same 50 cases with 2% more output tokens and the same latency, so low stays.

## Trade-offs

- **Two model calls per answered message.** The router adds about 3.7 seconds and half a cent. That makes the median reply slower than the original prompt's, 6.0 s against 4.8 s. In return, the escalation decision and the skill choice are inspectable.
- **The router can pick the wrong skill.** Then the responder lacks a rule. Code softens this: a classification implies skills even when the router does not list them, clinic names are also matched by plain word match, and a missing fact leads to "I don't have that detail", not to a guess.
- **Validators can cause escalations.** A reply that fails twice goes to a person. The report counts these as avoidable and names the validator.
- **`core` is still 15,000 characters.** It is the next thing to trim.
- **Verbatim skills keep the original's cross-references.** A skill may mention a section that is not loaded. The frame tells the model that such a section does not apply.
- **Coverage is self-reported.** It is a signal to watch, not a measurement.
- **Run-to-run variation.** With no temperature setting, wording varies. The parts that must not vary are code. Over three runs of each of the 50 dev cases, `escalate` never flipped, and no case passed on some runs and failed on others. What did differ between separate runs was wording: one reply left out the coordinator's name until a directive fixed it, and another said "insurers" where my check wanted "insurance".
- **The responder can still spend its steps on tools.** It did once, and that message went to a person as a system failure. Code now asks again without tools when that happens. That path has unit tests and has not fired in a live run since.

## What I would do next

- Human labels on a sample of escalations, to measure precision in production. The eval can only measure it on cases I wrote.
- "Asked for a human right after a bot reply" as a satisfaction signal. It needs conversation history that the packet does not provide.
- A model swap on the responder, judged by cost per passing reply. Effort is settled for now: medium did not beat low on this set.
- Graders that read replies. My checks test facts and rules. Reading the holdout replies still found a phrase that no check covered.
- Find out why a few router calls took 15 to 36 seconds in two early runs. The traces did not record retries then. They do now, and the slow calls have not come back.
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

## Text that is not from the original prompt

Skills contain none, and a test enforces it. Everything I wrote for a model is in `src/prompts/`:

| File | What it says |
| --- | --- |
| `responder-frame.md` | How the prompt is built, that facts and the patient's message are data, how to follow the link and other directives, that no handoff may be promised, and the output fields. |
| `router.md` | How to classify a message, field by field. |
| `repair.md` | Fix the draft so it breaks none of the listed rules. |
| `call-history.md` | Extract only what the calls say that bears on the message. |
| `user-message.txt` | The packet's user-message template, unchanged. |

Code also sends directives. One of them is a rule I added: at the decision stage, a price is quoted with its deposit.

The packet's five test messages and expected replies are only in `eval/packet/`. A test fails if any of that wording appears elsewhere in the repo, and another fails if runtime code reads from `eval/` or `docs/`.

## Verification status

State on 2026-10-07. Every number below is from a run whose traces are in `traces/` on my machine. That folder is not in the repository.

- 451 unit tests pass.
- The five packet messages passed end to end on every eval run.
- **Dev set, 50 cases.** The last three runs passed 50 of 50. The third did so after one over-strict check of mine was corrected and its stored replies were scored again. In all three, every case that should escalate did, and none escalated that should not.
- **Stability.** Each dev case was run three times. `escalate` flipped on 0 of 50 cases. No case passed on some runs and failed on others.
- **Holdout, 15 cases.** Written after tuning, run once, 15 of 15 passed, and all five escalations were right. I then read the replies. One said "The tool shows 3 hotel nights included", which no check covered. A validator now blocks that phrasing. The fix came after the run, so the 15 of 15 stands as run, and these cases are no longer unseen.
- **Original prompt, same 50 dev cases.** 31 of 50. See "Cost and speed".
- **Effort.** Medium passed the same 50 cases as low, at the same latency.

What the live runs found, and what changed:

| Found | Change |
| --- | --- |
| One message went to a person because the responder spent its three model calls on tool calls | Code asks once more without tools. A tool whose result code already fetched is no longer offered. |
| A reply to "am I texting with a bot?" left out the coordinator's name | A directive tells the responder the patient asked an identity question. |
| A reply said "The tool shows" | The internal-vocabulary validator blocks it. |
| A few router calls took 15 to 36 seconds, with no record of why | Each model call now records the attempts that failed and were retried. |
| My check for one case demanded the word "insurance" and failed a correct reply | The check now tests the fact. `--recheck` re-scored every stored run. |

What is not verified:

- The fallback for a responder that runs out of steps has unit tests only. It has not fired in a live run since it was added.
- The cause of the slow router calls is unknown. They did not recur in the last five runs: 0 retries in 524 model calls.
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
