# Design brief: Doctours reply system take-home

Read this together with `docs/packet.md` (the assignment). The packet wins on any hard requirement. This brief is my design; if you think part of it is wrong, say so with a reason before changing it.

## Goal

Replace the single monolithic system prompt with a structured pipeline. Control plane in code, data plane in the model: code decides the route, which rules load, which tools run, and whether we escalate. The model writes the reply.

Business goals from the team:
- Keep the escalation rate low and the cost per message low, while keeping patients satisfied.
- Escalation rate is reviewed every Monday. Any rise or swing must be explainable from data.

## Hard constraints (from the packet)

- CLI reads a JSON array of `{ id, text }` and writes a JSON array of `Reply`, one per message, same order.
- `Reply` shape exactly as in the packet. `templateId` is always null. `attachmentUrls` holds at most 3 URLs, only URLs a tool returned this turn, otherwise null. `escalationReason` is null unless `escalate` is true. If `response` contains a URL, it is the last line. Plain text, no markdown.
- Escalate when the patient asks for a human, or asks for an action no tool and no rule can perform (charge a card number, move money already paid, contact a clinic to hold a date). The escalation reply is one short sentence, optionally preceded by one short "I can't X." sentence. Then stop. Never repeat card numbers.
- Never put the packet's `EXPECTED_REPLIES`, or the wording of the five `HUMAN_MESSAGES`, into runtime prompts, skills, few-shots, router rules or code branches. They may only live in `eval/` fixtures. Add a test that fails if anything under `src/` or `skills/` reads from `eval/`.
- Do not add business facts that are not in the original system prompt or in tool data. Example: the expected consultation reply mentions "15 to 20 minutes", which the source prompt never states. Do not add it. Note it in the README instead.

## Stack

- TypeScript, Node 20+, Vercel AI SDK with `@ai-sdk/anthropic`, zod, vitest.
- `ANTHROPIC_API_KEY` from the environment. Ship `.env.example`. Never commit keys.
- Models configurable by env: `ROUTER_MODEL` (default `claude-haiku-4-5-20251001`), `RESPONDER_MODEL` (default `claude-sonnet-5-5`). Temperature 0.
- Check the installed AI SDK version's docs for exact APIs (structured output, tool calling, step limits, Anthropic prompt caching options). Do not guess signatures.
- "Now" comes from the fixture (the packet's prompt says September 27, 2026), not the system clock, so runs are reproducible.

## Pipeline

1. **Context.** Turn the packet constants into a typed `PatientContext` fixture. Port the packet's tool functions verbatim into `src/tools` (pure functions, same data).

2. **Guard (deterministic, no LLM).**
   - Redact card data before any model sees the text: 12 to 19 digit sequences, "ending in NNNN", CVV and expiry patterns. Keep a `cardDataPresent` flag and the list of redacted tokens.
   - High-precision patterns for explicit human requests ("talk to a human / person / agent / representative", "real person") escalate as `HUMAN_REQUESTED`. Questions that merely mention people ("will a human do my surgery?") are not escalations. Leave anything ambiguous to the router.
   - An instruction to charge or take payment plus card data escalates as `PAYMENT_ACTION_NO_TOOL`.

3. **Router (small model, structured output with zod).** Returns: `intents` (multi-label from a fixed list), `skills` (names from the skill index), `requestType` (`question | action | mixed | pause | chit_chat`), `requestedActions` (each with whether a tool can perform it), `entities` (clinic name, package name, clinic lean: `selected | torn | null`, stated timing, stated name), `escalation` (`needed`, `reasonCode`, short rationale), `confidence`.
   The router sees only: a short identity summary, the skill index (name plus one-line description per skill), the escalation policy table, a compact patient snapshot, and the last few turns. Never skill bodies.

4. **Escalation policy (code).** A versioned table: `reasonCode -> { escalate, category: "policy_required" | "avoidable", replyTemplate, escalationReason }`.
   Final decision: guard hit, OR router says escalation is needed AND the table says escalate.
   Principle: questions that a rule or tool can answer get answered. Actions get done if a tool exists, escalated if not. An explicit human request always escalates. If any part of a message needs escalation, the whole message gets the short escalation reply.
   Initial reason codes:
   - `HUMAN_REQUESTED`: "I'm getting a person for you."
   - `PAYMENT_ACTION_NO_TOOL` (charge a card, take card details): "I can't charge a card. I'm getting a person for you."
   - `MONEY_MOVE_OR_REFUND_ACTION` (move, transfer or refund money already paid)
   - `CLINIC_CONTACT_ACTION` (contact, call or message the clinic on the patient's behalf, including asking it to hold a date)
   - `DATE_HOLD_OR_AVAILABILITY_ACTION` (hold a date, verify specific open dates)
   - `BOOKING_CHANGE_ACTION`
   - `PRICE_NEGOTIATION` (match a clinic's direct quote, honor a claimed discount). Sharing a quote is not this; asking us to match it is.
   - `CALL_REQUEST` (any call other than the free consultation)
   - `SYSTEM_FAILURE` (model error or validation failure after repair; category avoidable)
   - `LOW_CONFIDENCE` (an action request the router cannot map; category avoidable)
   Creator or partnership messages are not escalations. The skill replies with Molly's email, as the source prompt says. Document this choice.
   On escalation, set `workingMemoryUpdates.escalationFlags` to the reason code and `shouldFollowUp` to false.

5. **Prefetch and side effects (code).** Driven by router entities and the selected skills. Examples: a clinic is named, so resolve it and call `getClinicPackages`. Payment or assessment intent, so call `getLatestAssessment` and `getPatientContext`. A lean toward one clinic, so call `updateUserClinicPreferences` with a clinic id a tool returned. A stated name, so call `updateUser`. Record every call in the trace. Collect `toolUrls`, the set of URLs tools returned this turn.

6. **Stage and collection logic (code).** Pipeline status selects the stage section (only `PRE_CLINICAL_SENT` is needed here). Compute from the collection status and working memory whether a collection anchor is allowed and which item. Pass the responder one directive, for example `anchor: none`.

7. **Responder (main model).** System content: `core.md` (always loaded), the selected skill bodies, the stage section, the compact patient snapshot and recent turns, prefetched tool results as JSON, allowed static links, and directives (anchor, precedence decisions). Read-only tools restricted to the union of the selected skills' allowlists, with a small step cap (3) for anything prefetch missed. Structured output via zod: `response`, `intent`, `shouldFollowUp`, `followUpTiming`, `highEngagement`, `workingMemoryUpdates`, `attachmentUrls`. Use Anthropic prompt caching for the stable parts (core and skill bodies) if the SDK supports it.

8. **Validators (code).** One function each, each with unit tests:
   - `url_last_line`: every URL sits on the final line or lines, nothing after.
   - `url_provenance`: every URL is in `toolUrls` or in the static allowlist taken from the source prompt (consultation, image upload, clinic page built from a tool-returned slug). `attachmentUrls` is a subset of `toolUrls`, at most 3.
   - `price_grounding`: every currency amount matches a price, deposit or addon amount from this turn's tool data, or an amount stated in a loaded skill (for example the $25 cancellation fee).
   - `no_markdown`.
   - `banned_phrases`: channel talk ("this chat", "over text", "this thread"), off-channel promises ("I'll send", "I'll check", "I'll call", "let me look into"), assessment turnaround windows.
   - `no_card_echo`: none of the redacted tokens appear in any output field.
   - `shape`: `escalationReason` is null exactly when `escalate` is false; `templateId` is null.
   On failure, one repair attempt with the validator errors fed back. If it still fails, escalate with `SYSTEM_FAILURE`. Never ship an unverified reply.

9. **Output and trace.**

## Skills

Layout: `skills/<vertical>/<name>/SKILL.md` with frontmatter: `name`, `description` (one line, used by the router), `tools` (allowlist), `staticLinks`, `version`.

Split the original system prompt into skills. Keep the original rule wording. Do not invent new rules. Suggested split for vertical `hair`:
`core` (always loaded), `clinic-packages`, `clinic-specialty`, `clinic-selection`, `payment-deposit`, `financing-insurance`, `consultation`, `assessment`, `photos-intake`, `pause-followup`, `travel`, `clinic-website-contact`, `pricing-promos`, `creator-partnership`, `aftercare-meds`, and `stage-pre-clinical-sent` (loaded by pipeline status, not by the router).

Keep `core.md` short: identity and voice, plain-text SMS, first person, no channel talk, the grounding rule, link placement, no over-committing, size the reply to the message, English only.

The vertical comes from patient context (default `hair`). Adding fertility means adding a folder, not editing hair skills.

Precedence lives in code: escalation > hard safety rules > time-bound pause > answer the question > funnel guidance and collection anchor. When two loaded rules conflict, resolve by this order and record the decision in the trace. Example: an explicit request for a link beats "don't repeat links".

## Observability and the Monday review

Trace per message at `traces/<runId>/<id>.json`: `runId`, `policyVersion` (hash of skills, policy table and prompts), models, guard hits, router output, skills loaded, tool calls (args and a result summary), side effects, validator results, repair attempts, final decision, `decidedBy` (`guard | router_policy | validator_fallback | none`), `reasonCode`, escalation category, token usage per model call, `latencyMs`.

`npm run report -- <runDir> [<baselineRunDir>]` prints a short markdown summary for the Monday review:
- Escalation rate overall, by `reasonCode`, by `decidedBy`, and split into policy-required vs avoidable.
- Cost per message (tokens times a price map in `config/pricing.ts`; fill it from Anthropic's current pricing page) and latency p50 / p95.
- With a baseline: each reason code's contribution to the change in rate (exact, since per-code rates add up to the total), and an intent mix-vs-rate split: how much of the change comes from more messages of an intent, and how much from escalating that intent more often.
- `policyVersion` of both runs, so a jump can be tied to a policy or prompt change.

The KPI to push down is avoidable escalations. Policy-required escalations move with patient behavior. The report must make that split obvious.

## Tests and eval

- vitest unit tests: guard (redaction, human-request precision with negative cases), policy table, every validator, the tool port, anchor logic, and the eval-isolation test.
- `npm run eval` runs real model calls over `eval/cases.json`: the five packet cases plus about 30 custom cases, each tagged by behavior. Cover escalation boundary positives and negatives, pricing per clinic, specialty, payment link vs assessment, financing / insurance / CareCredit, clinic website, pause, photos, consultation, flights, mixed question plus escalation, and instruction-like text inside a patient message.
- Assertions per behavior: `escalate` exact; required facts present (substring or regex); forbidden content absent (card digits, markdown, banned phrases); URL rules. Print pass/fail by behavior tag and the escalation rate on the eval set.

## CLI

`npm run respond -- --in messages.json --out replies.json`, also stdin to stdout. Preserves order. Bounded concurrency. A per-message failure becomes a `SYSTEM_FAILURE` escalation instead of crashing the run.

## README

Plain English. Short sentences. No filler. Cover:
- What I built and why this structure; what stays loaded every turn; how routing and skills work.
- The escalation policy table and the question-vs-action principle.
- How the Monday escalation review works, with an example of reading the report.
- Cost levers; trade-offs; what I'd do next (for example, human labels on escalations to measure precision, "asked for a human after a bot reply" as a satisfaction signal).
- How to run: prerequisites, install, API key, the command.
- Notes on the packet: the hard-coded "Category: pricing" classification in the old prompt; the upstream routing the old prompt assumed but that did not exist; the consultation duration that the source never states.

## Working style

- Plan first in `PLAN.md` and wait for approval before writing code.
- Small commits with clear messages. Run unit tests before each commit.
- After each milestone, a 3 to 5 sentence summary of the decisions made and why, so I can explain them in an interview.
