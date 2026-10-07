# Design brief: Doctours reply system take-home

Read this together with `docs/packet.md` (the assignment). The packet wins on any hard requirement. This brief is my design; if you think part of it is wrong, say so with a reason before changing it.

Updated 2026-10-06 after the plan review. `PLAN.md` sections 6 and 7 record each change and the reason for it.

## Goal

Replace the single monolithic system prompt with a structured pipeline. Control plane in code, data plane in the model: code decides the route, which rules load, which tools run, and whether we escalate. The model writes the reply.

Business goals from the team:
- Keep the escalation rate low and the cost per message low, while keeping patients satisfied.
- Escalation rate is reviewed every Monday. Any rise or swing must be explainable from data.

## Hard constraints (from the packet)

- CLI reads a JSON array of `{ id, text }` and writes a JSON array of `Reply`, one per message, same order.
- `Reply` shape exactly as in the packet. `templateId` is always null. `attachmentUrls` holds at most 3 URLs, only URLs a tool returned this turn, otherwise null. `escalationReason` is null unless `escalate` is true. If `response` contains a URL, it is the last line. Plain text, no markdown.
- Escalate when the patient asks for a human, or asks for an action no tool and no rule can perform (charge a card number, move money already paid, contact a clinic to hold a date). The escalation reply is one short handoff sentence, optionally preceded by one short decline sentence. Then stop. Never repeat card numbers.
- Never put the packet's `EXPECTED_REPLIES`, or the wording of the five `HUMAN_MESSAGES`, into runtime prompts, skills, few-shots, router rules or code branches. They may only live in `eval/` fixtures. This includes the escalation reply templates: they use our own wording. Add a test that fails if anything under `src/` or `skills/` reads from `eval/`, and a test that fails if packet wording appears outside `docs/` and `eval/`.
- Do not add business facts that are not in the original system prompt or in tool data. Example: the expected consultation reply mentions "15 to 20 minutes", which the source prompt never states. Do not add it. Note it in the README instead.

## Stack

- TypeScript, Node 22.12 or later (developed on Node 24 LTS), Vercel AI SDK 7 with `@ai-sdk/anthropic` 4, zod, vitest.
- `ANTHROPIC_API_KEY` from the environment. Ship `.env.example`. Never commit keys.
- Models configurable by env. `ROUTER_MODEL` (default `claude-haiku-4-5-20251001`) runs at temperature 0. `RESPONDER_MODEL` (default `claude-sonnet-5-5`) takes no temperature, because that model rejects non-default sampling parameters. It runs at `RESPONDER_EFFORT` (default `low`). Stability comes from the code layers, not from sampling settings.
- Check the installed AI SDK version's docs for exact APIs (structured output, tool calling, step limits, Anthropic prompt caching options). Do not guess signatures. A smoke script verifies them with live calls.
- All model calls go through `src/llm/client.ts`. Transient API errors (429, 5xx, overloaded, network) retry there with exponential backoff before anything becomes a failure.
- "Now" comes from the fixture (the packet's prompt says September 27, 2026), not the system clock, so runs are reproducible.

## Pipeline

1. **Context.** Turn the packet constants into a typed `PatientContext` fixture. Port the packet's tool functions verbatim into `src/tools` (pure functions, same data).

2. **Guard (deterministic, no LLM).**
   - Redact card data before any model sees the text: 12 to 19 digit sequences, "ending in NNNN", CVV and expiry patterns. Keep a `cardDataPresent` flag and the list of redacted tokens in memory. Traces store the type and count of redactions, never the tokens.
   - High-precision patterns for explicit human requests ("talk to a human / person / agent / representative", "real person") escalate as `HUMAN_REQUESTED`. Questions that merely mention people ("will a human do my surgery?") are not escalations. Leave anything ambiguous to the router.
   - An instruction to charge or take payment plus card data escalates as `PAYMENT_ACTION_NO_TOOL`.

3. **Router (small model, structured output with zod).** The router only classifies. It says what a message is. Code says what to do about it. It returns: `primaryIntent` (one label), `intents` (multi-label from a fixed list), `skills` (names from the skill index), `requestType` (`question | action | mixed | pause | chit_chat`), `humanRequested`, `requestedActions` (each with a `type` from the action catalog), `selfServe` (which self-serve step the message is about, if any), `entities` (clinic name, package name, clinic lean: `selected | torn | null`, stated timing, stated name, links asked for), a short rationale, and `confidence`.
   The router never decides whether a tool exists or whether to escalate.
   The router sees only: a short identity summary, the skill index (name plus one-line description per skill), the action catalog and escalation definitions, a compact patient snapshot, and the last few turns. Never skill bodies.

4. **Escalation policy (code).** Two versioned tables. The action catalog maps each action `type` to a tool, a skill, or a reason code. The escalation table maps `reasonCode -> { escalate, category: "policy_required" | "avoidable", replyTemplate, escalationReason }`.
   Final decision: guard hit, OR `humanRequested`, OR a requested action maps to a reason code that the table escalates. One primary reason code per message, the first in table order, so per-code rates add up to the total.
   Principle, with no exceptions: questions that a rule or tool can answer get answered. Actions get done if a tool exists, escalated if not. An explicit human request always escalates. If any part of a message needs escalation, the whole message gets the short escalation reply.
   Reason codes:
   - `HUMAN_REQUESTED`
   - `PAYMENT_ACTION_NO_TOOL` (charge a card, take card details)
   - `MONEY_MOVE_OR_REFUND_ACTION` (move, transfer or refund money already paid, whether it was paid through Doctours or directly to a clinic). Telling us they paid a clinic, or asking whether that counts, is a question; the deposit eligibility rule answers it.
   - `CLINIC_CONTACT_ACTION` (contact, call or message the clinic on the patient's behalf, including asking it to hold a date)
   - `DATE_HOLD_OR_AVAILABILITY_ACTION` (hold a date, verify specific open dates)
   - `BOOKING_CHANGE_ACTION`
   - `PRICE_NEGOTIATION` (match a clinic's direct quote, honor a claimed discount). Sharing a quote is not this; asking us to match it is.
   - `CALL_REQUEST` (any call other than the free consultation)
   - `SYSTEM_FAILURE` (model error, refusal, validation failure after repair, or a transient API error that outlasted its retries; category avoidable)
   - `LOW_CONFIDENCE` (an action request the router cannot map; category avoidable)
   Reply templates live in the policy table and use our own wording: one handoff sentence, with one decline sentence before it for action codes. `PLAN.md` section 5 has the table.
   Creator or partnership messages are not escalations. The skill replies with Molly's email, as the source prompt says. Document this choice.
   On escalation, set `workingMemoryUpdates.escalationFlags` to the reason code and `shouldFollowUp` to false.

5. **Prefetch and side effects (code).** Driven by router entities and the selected skills. Examples: a clinic is named, so resolve it and call `getClinicPackages`. Payment or assessment intent, so call `getLatestAssessment` and `getPatientContext`. A lean toward one clinic, so call `updateUserClinicPreferences` with a clinic id a tool returned. A stated name, so call `updateUser`. Record every call in the trace. Collect `toolUrls`, the set of URLs tools returned this turn.
   Payment and checkout links are fetched by code, never by the model.
   A request to revise the hairline or the plan emits a stub `revision_request` event in the trace. In production a detector files that request; here the event makes the promise traceable.
   A deterministic match of clinic names from tool data backs up the router's entities.

6. **Stage and collection logic (code).** Pipeline status selects the stage section (only `PRE_CLINICAL_SENT` is needed here). Compute from the collection status and working memory whether a collection anchor is allowed and which item. Pass the responder one directive, for example `anchor: none`.

7. **Responder (main model).** System content: `core.md` (always loaded), the selected skill bodies, the stage section, the compact patient snapshot and recent turns, prefetched tool results as JSON, allowed static links, and directives (anchor, link plan, precedence decisions). Read-only tools restricted to the union of the selected skills' allowlists, with a small step cap (3, which is two tool rounds plus the structured answer) for anything prefetch missed. Structured output via zod: `response`, `intent`, `shouldFollowUp`, `followUpTiming`, `highEngagement`, `workingMemoryUpdates`, `attachmentUrls`, plus a trace-only `coverage` field (all, part or none of the question answered). Use Anthropic prompt caching for the stable parts (core and skill bodies) if the SDK supports it.

8. **Validators (code).** One function each, each with unit tests:
   - `url_last_line`: every URL sits on the final line or lines, nothing after.
   - `url_provenance`: every URL is in `toolUrls` or in the static allowlist taken from the source prompt (consultation, image upload, clinic page built from a tool-returned slug). `attachmentUrls` is a subset of `toolUrls`, at most 3. At most one payment or checkout link.
   - `price_grounding`: every currency amount matches a price, deposit or addon amount from this turn's tool data, an amount listed in a loaded skill's `policyAmounts` (today only the $25 cancellation fee), an amount the patient wrote, or an exact difference of two tool amounts for the same clinic.
   - `no_markdown`.
   - `banned_phrases`, in two levels. Block: channel talk ("this chat", "over text", "this thread"), stalls ("let me look into", "I'll get back to you"), "I'll call", claimed lookups. Warn only: "I'll send" and "I'll check", because the source prompt requires them in some replies. Assessment turnaround windows are blocked only in a sentence about the assessment being ready.
   - `no_handoff_promise`: no promise that a person will follow up when `escalate` is false.
   - `no_internal_tokens`: no UUIDs, tool names, status labels or reason codes.
   - `no_human_claim`: the reply never claims to be a human.
   - `no_card_echo`: none of the redacted tokens appear in any output field.
   - `shape`: `escalationReason` is null exactly when `escalate` is false; `templateId` is null.
   On failure, one repair attempt with the validator errors fed back. If it still fails, escalate with `SYSTEM_FAILURE`. Never ship an unverified reply.

9. **Output and trace.**

## Skills

Layout: `skills/<vertical>/<name>/SKILL.md` with frontmatter: `name`, `description` (one line, used by the router), `tools` (allowlist), `staticLinks`, `version`, `source` (the original prompt sections it came from), `policyAmounts`, `loadedBy`.

Split the original system prompt into skills. Keep the original rule wording. Do not invent new rules. The one exception is a presentation rule in the stage skill: when you state a package's price, state its deposit too. The packet's expected replies need it, and the README documents it.

Split for vertical `hair`:
`core` (always loaded), `clinic-packages`, `package-choice`, `clinic-specialty`, `clinic-selection`, `payment-deposit`, `deposit-terms`, `financing-insurance`, `consultation`, `assessment`, `photos-intake`, `pause-followup`, `dates-availability`, `travel`, `clinic-website-contact`, `pricing-promos`, `creator-partnership`, `aftercare-meds`, and `stage-pre-clinical-sent` (loaded by pipeline status, not by the router).

The stage skill holds only the stage's intro, the "got it" rule and pacing. Its decision steps live in the topical skills, so they load only when needed.

A skill can gate a block on a patient flag (for example financing eligibility: yes, no, unknown). Code keeps only the block that applies.

Examples from the source prompt are removed, or have their specifics replaced by placeholders, when they repeat packet test wording, state a price for a real clinic, or concern a tool this packet does not have.

Keep `core.md` short: identity and voice, plain-text SMS, first person, no channel talk, the grounding rule, link placement, no over-committing, size the reply to the message, English only. A test enforces a size budget.

The vertical comes from patient context (default `hair`). Adding fertility means adding a folder, not editing hair skills.

Precedence lives in code: escalation > hard safety rules > time-bound pause > answer the question > funnel guidance and collection anchor. When two loaded rules conflict, resolve by this order and record the decision in the trace.

Link rule, part of "answer the question": when the answer is about a step the patient can complete themselves on a known page, and nothing on file shows the step is done, that page's link is part of the answer. It is not a CTA. Examples: paying from the assessment when there is no booking, booking the consultation when none is on file. This beats "no next-step CTA" and "don't repeat links". An explicit request for a link also beats "don't repeat links".

## Observability and the Monday review

Trace per message at `traces/<runId>/<id>.json`: `runId`, `policyVersion` (hash of skills, policy tables and prompts), models, guard hits, router output (including `primaryIntent`), skills loaded, tool calls (args and a result summary), side effects (including `revision_request` events), validator results, repair attempts, final decision, `decidedBy` (`guard | router_policy | validator_fallback | none`), `reasonCode`, escalation category, `failure.cause` (`transient_api | model_error | refusal | invalid_output | validator`), `coverage`, token usage per model call, `latencyMs`.

`npm run report -- <runDir> [<baselineRunDir>]` prints a short markdown summary for the Monday review:
- Escalation rate overall, by `reasonCode`, by `decidedBy`, and split into policy-required vs avoidable. Transient API failures are counted apart from policy.
- Cost per message (tokens times a price map in `config/pricing.ts`; fill it from Anthropic's current pricing page) and latency p50 / p95.
- The share of replies that answered all, part or none of the question. This is self-reported by the model and labelled as a proxy. It stops the escalation rate from being lowered by answering "I don't have that" more often.
- With a baseline: each reason code's contribution to the change in rate (exact, since per-code rates add up to the total), and an intent mix-vs-rate split: how much of the change comes from more messages of an intent, and how much from escalating that intent more often.
- `policyVersion` of both runs, so a jump can be tied to a policy or prompt change.

The KPI to push down is avoidable escalations. Policy-required escalations move with patient behavior. The report must make that split obvious.

## Tests and eval

- vitest unit tests: guard (redaction, human-request precision with negative cases), policy tables, every validator, the tool port, anchor logic, the link plan over fixture variants, the eval-isolation test and the leak test.
- `npm run eval` runs real model calls over `eval/cases.json`: the five packet cases plus about 30 custom cases, each tagged by behavior. About half of the custom cases sit on the escalation boundary, in positive and negative pairs written in our own wording. Also cover pricing per clinic, specialty, payment link vs assessment, financing / insurance / CareCredit, clinic website, pause, photos, consultation, flights, mixed question plus escalation, instruction-like text inside a patient message, and cases where a link must not appear.
- Assertions per behavior: `escalate` exact; required facts present (substring or regex); forbidden content absent (card digits, markdown, banned phrases); URL rules. Print pass/fail by behavior tag and the escalation rate on the eval set.
- `npm run eval -- --repeat 3` runs each case three times and reports a per-case flip rate for `escalate`. It shows how much of a swing is noise.
- Tune on a dev split only. Report the held-out split.

## CLI

`npm run respond -- --in messages.json --out replies.json`, also stdin to stdout. Preserves order. Bounded concurrency, default 4, configurable. A per-message failure becomes a `SYSTEM_FAILURE` escalation instead of crashing the run. A missing API key is an error, not an escalation.

## README

Plain English. Short sentences. No filler. Cover:
- What I built and why this structure; what stays loaded every turn; how routing and skills work.
- The escalation policy table and the question-vs-action principle.
- How the Monday escalation review works, with an example of reading the report.
- Where a subtask goes (the packet's reason 4): the call-history subtask.
- Cost levers; trade-offs; what I'd do next (for example, human labels on escalations to measure precision, "asked for a human after a bot reply" as a satisfaction signal).
- How to run: prerequisites, install, API key, the command. Optional env settings, including the refusal fallback, which is off by default.
- Notes on the packet: the hard-coded "Category: pricing" classification in the old prompt; the upstream routing the old prompt assumed but that did not exist; the consultation duration that the source never states; the deposit presentation rule and the link rule that the expected replies need; the revision detector that production has and this repo stubs.
- Every line in a prompt or skill that does not come from the source prompt.

## Working style

- The plan in `PLAN.md` is approved. Build a thin end-to-end path for the five packet messages first, then fill out the remaining skills, planner rules and validators. Keep a working submission at every point.
- Small commits with clear messages. Run unit tests before each commit.
- After each milestone, a 3 to 5 sentence summary of the decisions made and why.
- If time runs short, cut in this order: the unreachable stage skills, the full baseline run (keep the static token count), the refusal fallback. Keep the Monday report.
