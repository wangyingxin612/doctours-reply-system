# Plan: Doctours reply system

Status: approved on 2026-10-06. Built on the `build` branch. Section 10 has the state of each milestone. `BLOCKERS.md` has what is waiting on the owner.

I read `docs/packet.md` and `docs/design-brief.md` in full, including the whole original system prompt. The packet wins on hard requirements. Sections 6 and 7 record each review decision next to the reasoning. Section 9 lists what the review added.

## 1. Summary

The plan follows the brief. Code decides the route, which rules load, which tools run, and whether to escalate. The model writes the reply.

Numbers that shaped the plan:

- The original prompt is about 166 KB, roughly 40,000 tokens at 4 characters per token. The old flow sends all of it on every turn, and again on every tool round trip inside a turn.
- Measured in M3 on the packet's messages: an answered message sends 11,000 to 19,000 input tokens to the responder and about 3,700 to the router. Of the responder's tokens, 10,000 to 16,000 are a stable prefix that prompt caching reads back at a tenth of the price. A message the guard escalates uses no model tokens.
- My first estimates were lower, because they assumed 4 characters per token. This text measures about 2.6. At that rate the original prompt is roughly 60,000 tokens, not 40,000. The baseline run in M9 will measure it.

Terms I use below:

- **Turn ledger**: the record of every tool call made for one message, with the URLs and money amounts the tools returned. Validators check the reply against it.
- **Action catalog**: a table in code that maps each kind of requested action to a tool, a skill, or an escalation reason code.
- **Link plan**: code's decision about which URL, if any, the reply may or must contain.
- **Directives**: the short block code hands the responder: collection anchor, link plan, pause interval, funnel step.
- **Self-serve step**: something the patient can complete alone on a known page, such as paying from the assessment or booking the consultation.

## 2. Milestones

For every milestone: small commits, `npm test` and a typecheck before each commit, and a 3 to 5 sentence summary of the decisions when it ends.

The order puts a thin end-to-end path first. From the end of M3, the branch is a working submission at every commit.

**M0. Scaffold and SDK check**
- Builds: `package.json`, TypeScript, vitest, `.env.example`, `.nvmrc`. Installs `ai` 7, `@ai-sdk/anthropic` 4, `zod` 4. `src/llm/client.ts`, the one file that imports the model SDK. `npm run smoke` makes live calls and runs the checks listed in 6.1. Scripts are added to `package.json` as their entry points land.
- Done when: `npm test` passes and the smoke check passes on both models. If a check fails I stop and say so.

**M1. Contract and data**
- Builds: the `Reply` schema with exactly the packet's ten keys. A typed `PatientContext` fixture from the packet constants, including "now" (September 27, 2026). The packet's tool functions, ported verbatim. A tool registry (name, read or write) and the turn ledger.
- Done when: unit tests show the ported tools return the packet's values, including the `null` cases.

**M2. Deterministic control plane**
- Builds: the guard. The escalation table and action catalog. The validators the packet's hard rules need: `shape`, `url_last_line`, `url_provenance`, `price_grounding`, `no_markdown`, `no_card_echo`. The CLI with bounded concurrency (default 4, set with `--concurrency` or `CONCURRENCY`). The trace writer.
- Done when: `npm run respond` returns correct escalations for guard-decided messages with zero model calls, keeps input order, and turns any per-message failure into `SYSTEM_FAILURE`. Until M3, every other message returns `SYSTEM_FAILURE`.

**M3. Vertical slice: the five packet messages**
- Builds: a thin router, planner and responder with one repair attempt. Retries with exponential backoff for transient API errors. `core`, `stage-pre-clinical-sent`, and the four skills the packet messages need: `clinic-packages`, `clinic-specialty`, `payment-deposit`, `consultation`. The skill loader. The isolation and leak tests. `eval/packet/` and a first `npm run eval` that checks those five messages. A short README with the run command.
- Done when: all five packet messages meet the packet's checks through `npm run respond`. First measured tokens, cost and latency.

**M4. Remaining skills**
- Builds: the rest of the reachable skills in section 4.2, flag-gated blocks, the router index, and the `policyVersion` hash.
- Done when these tests pass: every skill parses; core stays under its size budget; coverage (every section of the original prompt is mapped to a skill, to code, or to the dropped list). The packet five still pass.

**M5. Full router and planner**
- Builds: the complete action catalog with its boundary definitions. The deterministic clinic-name backstop. Prefetch for every skill. Side effects: clinic lean, package choice, tentative dates, name, and the `revision_request` stub (7.5). The full link plan: the rule in 6.4, payment versus checkout versus the assessment, and first ask versus repeat ask for a clinic website. Stage and collection anchor. The precedence log. The `call-history` subtask (7.4).
- Done when: unit tests pass over fixture variants: financing yes, no and unknown; package already selected; photos missing; link already sent; consultation on file; booking on file.

**M6. Remaining validators and failure handling**
- Builds: two-level banned phrases (6.3). No handoff promise when `escalate` is false. No assessment turnaround window. No internal tokens. No claim to be human. At most one payment or checkout link. A refusal becomes `SYSTEM_FAILURE`. `failure.cause` values: `transient_api`, `model_error`, `refusal`, `invalid_output`, `validator`. The self-reported coverage field (7.7). The refusal fallback flag, off by default (7.6).
- Done when: every validator has unit tests with passing and failing examples.

**M7. Eval and tuning**
- Builds: `eval/cases.json` with the 5 packet cases plus about 30 of my own, tagged by behavior. About half of my cases sit on the escalation boundary, in positive and negative pairs, in my own wording. Negative link cases. `npm run eval -- --repeat 3`, which reports a per-case flip rate for `escalate`. I tune on a dev split only and report the held-out split. I also compare responder effort `low` and `medium`.
- Done when: the run prints pass or fail by behavior tag, the escalation rate, the precision and recall of escalation on the set, and the flip rate.

**M8. Monday report**
- Builds: `npm run report -- <runDir> [<baselineRunDir>]` and the pricing map. The report counts `transient_api` failures apart from policy, and labels the coverage rate as a self-reported proxy.
- Math: by reason code, the change in rate is the sum over codes of the change in (count for that code ÷ messages). By intent, the change is the sum of (change in share × average rate) plus the sum of (change in rate × average share). Both are exact.
- Done when: unit tests on synthetic traces prove the parts add up to the total change.

**M9. README and wrap-up**
- Builds: the README the brief lists. The baseline comparison (7.3). A final test and eval run.
- Done when: a fresh clone runs with the README's commands.

**M10. Unreachable stages**
- Builds: the stage and intake skills the packet's context cannot reach, ported verbatim, with no eval coverage (7.2).

Cut line if time runs short, in this order: M10; the full baseline run in M9 (keep the static token count); the refusal fallback flag in M6. M8 is not cut.

## 3. File layout

```
.
├── README.md
├── PLAN.md
├── package.json  package-lock.json  tsconfig.json  vitest.config.ts
├── .env.example  .gitignore  .nvmrc
├── docs/                     packet.md, design-brief.md. Never read at runtime.
├── config/
│   ├── models.ts             ROUTER_MODEL, RESPONDER_MODEL, RESPONDER_EFFORT from env
│   └── pricing.ts            dollars per million tokens, by model and token class
├── skills/
│   └── hair/
│       ├── core/SKILL.md
│       ├── stage-pre-clinical-sent/SKILL.md
│       └── <one folder per skill in section 4>/SKILL.md
├── scripts/
│   └── smoke.ts              the M0 live check
├── src/
│   ├── cli/                  respond.ts, report.ts
│   ├── schema/               zod: reply, router output, responder output, trace
│   ├── context/              types.ts, fixture.ts (packet constants), snapshot.ts
│   ├── tools/                data.ts and functions.ts (verbatim port), registry.ts, ledger.ts
│   ├── llm/                  client.ts. The only file that imports a model SDK. Retries live here.
│   ├── skills/               loader.ts, index.ts (router index), version.ts (policyVersion)
│   ├── prompts/              router.md, responder-frame.md, repair.md
│   ├── policy/               escalation.ts (table and templates), actions.ts (catalog), decide.ts
│   ├── pipeline/             run.ts, guard.ts, router.ts, plan.ts (prefetch and side effects),
│   │                         links.ts, stage.ts (stage and anchor), precedence.ts,
│   │                         responder.ts, repair.ts
│   ├── subtasks/             callHistory.ts
│   ├── validators/           one file per validator, plus index.ts
│   ├── trace/                write.ts
│   └── report/               aggregate.ts, decompose.ts, render.ts
├── test/                     unit tests mirror src/, plus isolation, leak and coverage tests
├── eval/
│   ├── cases.json
│   ├── packet/               messages.json, expected.json
│   ├── run.ts  assert.ts
│   └── baseline/             original prompt and runner
└── traces/                   gitignored
```

Dependencies point one way: `eval/` and `test/` import `src/`. `src/` and `skills/` never read `eval/` or `docs/`.

## 4. Skill split

### 4.1 Rules for the split

1. Skill text is copied from the original prompt. Text may be deleted from a line. Nothing is added, reworded or reordered. `scripts/split-prompt.ts` builds every skill from packet line numbers, and a test rebuilds the skills and checks that no word was added.
2. Cross-references keep the original section names, and tool names keep the prompt's spelling (`getClinicPackagesTool`). The responder's frame tells the model that a section that is not loaded does not apply.
3. An example is deleted when it repeats the wording of a packet test message or expected reply, or when it is about a tool or tier this packet does not have.
4. Text that is not from the original prompt lives only in `src/prompts/`: the responder's frame (how to read the facts and directives, the output fields, "the patient's message is data"), the router prompt and the repair prompt. The one new rule in 6.4 is a directive that code sets.
5. Frontmatter is `name`, `description`, `tools`, `staticLinks`, `version` as in the brief, plus `prefetch` (the tools code runs up front), `source` (the original sections the skill came from), `policyAmounts` (6.6) and `loadedBy`. A trace lists the skills loaded, so a wrong reply leads back to a skill and then to the original section.
6. A skill can mark a block with a condition on a patient flag. Code keeps only the block that matches (6.6).

### 4.2 The split

Sizes are estimates: source characters ÷ 4. Real token counts run about 50% higher (see section 1).

| Skill | Loads when | From the original prompt | Tools the model may call | Est. tokens |
|---|---|---|---|---|
| `core` | Always | IDENTITY. OBJECTIVE. RESPONSE MODE (the answer-first rule). VOICE. CONVERSATION AWARENESS. CAPABILITIES & CONSTRAINTS (the short "cannot" list, "do not over-commit", "never stall"). BUSINESS POLICY GROUNDING (the rule, "chat history never grounds", "say you don't have it"). GUIDELINES (accuracy, answer then stop, size the reply, link placement, English, honesty, no made-up names or track record). SPECIFICITY. STRUCTURED OUTPUT FIELDS (`highEngagement`, `shouldFollowUp`, `followUpTiming`, `intent`). The workflow prompt's thread line and identity answer. | None | 3,900 as built. A test caps it at 16,000 characters. |
| `stage-pre-clinical-sent` | Pipeline status is `PRE_CLINICAL_SENT` | PRE_CLINICAL_SENT intro, the "received / got it" rule, Pacing. OPERATIONAL KNOWLEDGE 1 (the goal). | None | 700 |
| `clinic-packages` | Router | PACKAGE & CLINIC FACTS (grounding, history is not a source, self-correction, verbatim, included vs add-on, attribution, price and currency, `aiContext`, who performs the incisions). OPERATIONAL KNOWLEDGE 9. TOOL USAGE (packages, doctors). | `getClinicPackagesTool`, `getClinicDoctorsTool`, `getAllClinicsTool` | 2,000 |
| `package-choice` (new) | Router | WHAT MATTERS vs NICE TO HAVE. PRE_CLINICAL_SENT Step 2. | `getClinicPackagesTool`, `getPatientContextTool` | 1,700 |
| `clinic-specialty` | Router | PACKAGE & CLINIC FACTS (hair type is a `clinic_flags` fact). The Clinic flags preamble. OPERATIONAL KNOWLEDGE 2. | `getAllClinicsTool`, `getClinicDoctorsTool` | 600 |
| `clinic-selection` | Router | PRE_CLINICAL_SENT Step 1. CLINIC STATUS TIERS. OPERATIONAL KNOWLEDGE 4 and 7. | `getSavedClinicsTool`, `getAllClinicsTool`, `getClinicPackagesTool`, `getClinicDoctorsTool`, `getPatientContextTool` | 2,700 |
| `payment-deposit` | Router | PRE_CLINICAL_SENT Step 0 (pay from the assessment) and Step 3 (the two paths, which link). OPERATIONAL KNOWLEDGE 6 (deposit only, methods, cash, deposit paid in full, all payments through Doctours, the two links). DEPOSIT ELIGIBILITY RULE. STRUCTURED OUTPUT FIELDS (payment links). CAPABILITIES ("allowed and expected"). | `getLatestAssessmentTool`, `getPatientContextTool`, `getClinicPackagesTool`, `getAllClinicsTool` | 2,400 |
| `deposit-terms` (new) | Router | REVERSIBILITY. The refund, transfer, lock-in and price-lock lines from Step 3 and OPERATIONAL KNOWLEDGE 6. | None | 1,700 |
| `financing-insurance` | Router | FINANCING GEOGRAPHY. HEALTH INSURANCE. CARECREDIT / CHERRY. OPERATIONAL KNOWLEDGE 6 (insurance, CareCredit, Klarna account holder, balance options, layaway). The Step 3 financing line. BUSINESS POLICY GROUNDING (no financing math). | None | 2,400 after gating |
| `consultation` | Router | OPERATIONAL KNOWLEDGE 8. CONSULTATION RESCHEDULING. PHONE CONTACT. | `getConsultationRescheduleLinkTool`, `getFullCallsTool` | 800 |
| `assessment` | Router | PRE_CLINICAL_SENT Step 0 (what the assessment is). OPERATIONAL KNOWLEDGE 3. CAPABILITIES (assessment edits vs revisions). GUIDELINES (no turnaround promises). | `getLatestAssessmentTool`, `getSavedClinicsTool`, `getPatientContextTool` | 1,500 |
| `photos-intake` | Router | IMAGE GUIDANCE. IMAGE DELAY HANDLING. CAPABILITIES (attaching the patient's own photos). STRUCTURED OUTPUT FIELDS (`attachmentUrls`). | `getPatientImagesTool` | 3,300 |
| `pause-followup` | Router, or code when the message is a pause | TIME-BOUND PAUSE. GUIDELINES (confirming a requested follow-up). | None | 1,200 |
| `dates-availability` (new) | Router | OPERATIONAL KNOWLEDGE 5 and 10. TOOL USAGE (tentative procedure dates). GUIDELINES (no invented weekday and date pairs). | `getClinicPackagesTool`, `getPatientContextTool` | 800 |
| `travel` | Router | TRAVEL READINESS. OPERATIONAL KNOWLEDGE 1 (flight help, travel timing). PACKAGE & CLINIC FACTS (own hotel and transport, standard vs upgraded hotels, why the passport). TOOL USAGE (airports, hotels). BUSINESS POLICY GROUNDING (no drive times, transfer coverage). | `getClinicPackagesTool` | 2,600 |
| `clinic-website-contact` | Router | CLINIC WEBSITE. PACKAGE & CLINIC FACTS ("can they message the clinic themselves"). OPERATIONAL KNOWLEDGE 11 (clinic pages). | `getAllClinicsTool`, `getSavedClinicsTool` | 700 |
| `pricing-promos` | Router | ACTIVE PROMO OFFER. DIRECT-FROM-CLINIC PRICE QUOTES. The Step 3 discount lines. CAPABILITIES (discounts). | `getClinicPackagesTool` | 1,000 |
| `creator-partnership` | Router | CREATOR / PARTNERSHIP BUSINESS. | None | 600 |
| `aftercare-meds` | Router | PACKAGE & CLINIC FACTS (finasteride and minoxidil). GUIDELINES (no head-covering advice). | None | 300 |

Not reachable with the packet's context. These are M10, the first thing cut:

| Skill | Loads when | From the original prompt | Est. tokens |
|---|---|---|---|
| `intake-collection` | Code, when a collection anchor is due or on first contact | INFORMATION COLLECTION. CONCERN REFLECTION. COLLECTION PERSISTENCE (how to phrase an anchor). FIRST-CONTACT INTRODUCTION. INSTANT FORM AREA CONFIRMATION. | 3,000 |
| `stage-lead`, `stage-prep-pre-clinical`, `stage-meeting`, `stage-waiting` | Pipeline status | LEAD. PREP_PRE_CLINICAL. MEETING_BOOKED / MEETING_COMPLETED with CONSULTATION BOOKING CONFIRMATION. MEETING_MISSED. WAITING. PRE-ASSESSMENT LENGTH CAP. | 1,800 in total |

Static links: `consultation` has the consultation page. `photos-intake` has the image-upload page. `clinic-website-contact` has the clinic page, built from a slug a tool returned this turn. `aftercare-meds` has the two pharmacy domains the prompt names.

The responder sees, in this order: core, the stage skill, the selected skills sorted by name, the patient context, this turn's tool results, the directives. The user message uses the packet's template unchanged. Stable content comes first so prompt caching can reuse it.

### 4.3 What moves into code

- RESPONSE MODE exceptions 1 to 4, and the counting and priority rules of COLLECTION PERSISTENCE: the anchor logic and precedence.
- "No repeated links", first ask versus repeat ask for a clinic website, payment link versus checkout link versus the assessment, and the self-serve rule in 6.4: the link plan.
- DATA COLLECTION and the save rules in Step 1, Step 2 and TOOL USAGE (clinic lean, package choice, tentative dates, name): side effects.
- Every "routed to a person before they reach you": the escalation policy.
- WORKING_MEMORY_SYSTEM_INSTRUCTION: the responder returns `workingMemoryUpdates`, and code writes it with `updateWorkingMemoryTool`.
- Patient Summary, Clinic flags, Available Context, Recent Calls, Recent Conversation: the context block.
- Link placement, markdown, URL and price grounding: validators. The one-line rule stays in core too, so the first draft is usually right.

### 4.4 What is dropped, and why

- `# Message Classification`. It is hard-coded to "pricing, high" for every message. The router replaces it.
- The note about Mastra memory. There is no Mastra here.
- Rules that need tools the packet does not provide: booked-patient package details, the trip and flight tools, the booking-documents link and leave letters, the personal-info, medical-history and flight-upload links, driver details.
- Examples removed under rule 3 in 4.1. This includes the two examples named in 6.2.

## 5. Escalation policy

### 5.1 How a decision is made

1. A guard hit escalates. No model is called.
2. Otherwise the router reports `humanRequested` and a list of requested actions, each with a `type` from a fixed list. Code looks each type up in the action catalog. The result is one of three: a tool performs it, a skill answers it, or it maps to a reason code.
3. The table below says whether that reason code escalates.
4. If several codes apply, the first one in table order is the primary code. One code per message keeps the per-code rates adding up to the total.
5. A model error, a refusal, or a validator failure after one repair becomes `SYSTEM_FAILURE`. Transient API errors are retried with backoff first.

If any part of a message escalates, the whole message gets the short reply. On escalation there is no prefetch, no side effect and no responder call.

The principle has no exceptions. A question that a rule or tool can answer gets answered. A request for a concrete action gets done if a tool exists and escalated if not. A policy or hypothetical question counts as a question even when it names an action: "What is your refund policy?" is answered, "Refund my deposit." is escalated.

The guard matches a request frame plus a human target ("I want / can I / let me" with "talk, speak, chat" and "human, person, agent, representative, someone real"). A negation near the match, or a question about what people do, goes to the router instead. The unit tests use positives and negatives in my own words.

### 5.2 Reply shape

One short handoff sentence. For action codes, one short decline sentence comes first. No digits, no URL, no question. The handoff sentence is the same everywhere:

> I'm bringing in a person to help you.

The wording is mine. Section 6.2 explains why it is not the wording the brief first gave.

### 5.3 Reason codes

Table order is priority order.

| Code | Category | Set by | Escalate when | Reply | `escalationReason` |
|---|---|---|---|---|---|
| `HUMAN_REQUESTED` | Policy required | Guard, router | The patient asks or demands to talk to a human, person, agent, representative or manager. | Handoff sentence. | Patient asked for a person |
| `PAYMENT_ACTION_NO_TOOL` | Policy required | Guard (a charge instruction plus a card reference or card data), router | The patient asks us to charge, run or bill a card, or sends card details to pay. | "Charging a card isn't something I can do." Then the handoff sentence. | Patient asked us to charge a card |
| `MONEY_MOVE_OR_REFUND_ACTION` | Policy required | Router | The patient asks us to move, transfer or refund money already paid. It does not matter whether it was paid through Doctours or directly to a clinic. | "Moving or refunding a payment isn't something I can do myself." Then the handoff sentence. | Patient asked us to move or refund money already paid |
| `CLINIC_CONTACT_ACTION` | Policy required | Router | The patient asks us to contact the clinic or another third party for them, including to hold a date. Or they ask a second time for the clinic's phone, WhatsApp or email. | "Contacting the clinic for you isn't something I can do." Then the handoff sentence. | Patient asked us to contact the clinic |
| `DATE_HOLD_OR_AVAILABILITY_ACTION` | Policy required | Router | The patient asks us to hold or reserve a specific date without paying, or to verify that a specific date is open. | "Holding or checking a specific date isn't something I can do." Then the handoff sentence. | Patient asked us to hold or verify a date |
| `BOOKING_CHANGE_ACTION` | Policy required | Router | The patient asks us to change, cancel or move an existing booking or procedure date. | "Changing a booking isn't something I can do directly." Then the handoff sentence. | Patient asked us to change a booking |
| `PRICE_NEGOTIATION` | Policy required | Router | The patient asks us to match a clinic's direct quote, or to honor a price or discount they claim. | Handoff sentence only. The prompt says not to announce that we cannot apply a discount. | Patient asked us to match or honor a price |
| `CALL_REQUEST` | Policy required | Router | The patient asks for a callback, or a call with the coordinator, a surgeon or the clinic. | "A call outside the free consultation isn't something I can set up." Then the handoff sentence. | Patient asked for a call outside the consultation |
| `SYSTEM_FAILURE` | Avoidable | Pipeline | A model error, a refusal, invalid output, a validator failure after one repair, or a transient API error that outlasted its retries. | Handoff sentence. | Automated reply failed checks |
| `LOW_CONFIDENCE` | Avoidable | Router | The patient asks for a concrete action that matches nothing in the action catalog. | Handoff sentence. | Could not map the requested action |

Fields set on every escalation: `escalate: true`; `workingMemoryUpdates: { escalationFlags: <code> }`; `shouldFollowUp: false`; `followUpTiming: null`; `attachmentUrls: null`; `templateId: null`; `intent: "hand off to a person"`. `highEngagement` is `true` for `PAYMENT_ACTION_NO_TOOL` and `DATE_HOLD_OR_AVAILABILITY_ACTION`, because the patient is trying to pay or book, and `false` for the rest.

The table and the catalog carry a version string and are hashed into `policyVersion`. Changing one row is a one-line, versioned change that the Monday report can point to.

### 5.4 Requests that are not escalations

These sit in the action catalog too, so the choice is visible and easy to flip.

| Request | Handled by | Rule in the original prompt |
|---|---|---|
| Asks for a payment, deposit or checkout link, or says they are ready to pay | `payment-deposit` and the link plan | "Do NOT route to human just because the patient asks for a payment link" |
| Asks about refund, transfer or change-of-mind terms | `deposit-terms` | Step 3, REVERSIBILITY |
| Says they paid a clinic directly, or asks whether that counts or whether they must pay again | `payment-deposit` | DEPOSIT ELIGIBILITY RULE |
| Shares a clinic's direct quote without asking us to match it; asks whether a discount exists; asks for a discount | `pricing-promos` | DIRECT-FROM-CLINIC PRICE QUOTES, ACTIVE PROMO OFFER |
| Asks general availability or timing questions | `dates-availability` | OPERATIONAL KNOWLEDGE 5 and 10 |
| Books or reschedules the free consultation | `consultation` | CONSULTATION RESCHEDULING |
| Asks once for a clinic contact, or asks whether they can message the clinic themselves | `clinic-website-contact` | PACKAGE & CLINIC FACTS |
| Asks for a document, email or form, or asks us to add a note to the assessment | Decline wording in `core` and `assessment` | CAPABILITIES & CONSTRAINTS |
| Asks to change the hairline or the plan | `assessment`. Code records a `revision_request` event in the trace. | OPERATIONAL KNOWLEDGE 3 |
| Sends a creator or partnership message | `creator-partnership`, which gives Molly's email | CREATOR / PARTNERSHIP, and the brief |
| Asks whether they are talking to a real person | Identity answer in `core`. A validator blocks any claim to be human. | Workflow prompt |
| Asks a question that no rule or tool can answer | The reply says it does not have that detail | GUIDELINES |

If the router misses an action, the responder falls back to the prompt's own behavior: decline plainly and answer the rest. A validator blocks any promise that a person will follow up when `escalate` is false, so a miss never produces a false handoff.

## 6. Changes to the brief, with the decisions

All seven were approved on 2026-10-06. `docs/design-brief.md` is updated to match.

### 6.1 Temperature 0 on the responder

- Brief said: temperature 0 for both models.
- Problem: `claude-sonnet-5-5` rejects any non-default `temperature` with a 400. It also rejects `thinking: disabled` and a forced `tool_choice`, and it can stop with `refusal`. `claude-haiku-4-5` still accepts temperature 0.
- Proposal: the router runs on Haiku 4.5 with temperature 0. The responder runs on Sonnet 5.5 with no temperature and `effort: "low"` set explicitly, configurable as `RESPONDER_EFFORT`. The API default is `high` and thinking is billed as output, so this is also a cost setting. Structured output goes through the API's native JSON output, not the forced-tool fallback. A refusal becomes `SYSTEM_FAILURE`. Stability then comes from the code layers and the fixture clock. The eval checks facts, not wording.
- M0 confirms with live calls on the installed SDK:
  1. The router call on Haiku 4.5 returns schema-valid output with temperature 0.
  2. The responder call on Sonnet 5.5 works with no temperature and `effort: "low"`.
  3. Structured output and tool calls work in one `generateText` call on Sonnet 5.5, with a step limit.
  4. `cacheControl` on system blocks is accepted, and `usage` reports cache read and write tokens.
  5. A refusal is visible in the result.
  6. The `ai/test` mock models work in vitest.
- If check 2 or 3 fails, the fallback is the official `@anthropic-ai/sdk` behind `src/llm/client.ts`. I would ask first.
- **Decision: approved.** Stability comes from the code layers. The smoke check verifies the facts live.

### 6.2 The escalation reply templates

- Brief said: fixed reply text for `HUMAN_REQUESTED` and `PAYMENT_ACTION_NO_TOOL`.
- Problem: both were word for word the packet's expected `response` for its two escalation cases. Putting them in the policy table puts expected replies in code. The packet, the brief and the session rules all forbid that. The packet does not require the wording: for those two cases it checks `escalate`, that no sales question is answered, and that the card number is not repeated.
- Proposal: my own wording, in section 5, with the same shape. The same goes for `escalationReason`. The leak test then needs no exceptions.
- Related: the original prompt itself has three examples that overlap packet wording. They are the example question in GUIDELINES "Size the reply", the CORRECT line of the hair-type example in PACKAGE & CLINIC FACTS, and one phrase in the Step 1 list of "selected" examples.
- **Decision: approved.** Own wording. Drop the first two overlapping examples and keep their rules. Keep the third, which is a generic phrase with a `{clinic}` placeholder. The two templates are removed from the brief.

### 6.3 `banned_phrases`

- Brief said: block "I'll send", "I'll check", "I'll call", "let me look into", and assessment turnaround windows.
- Problem: the original prompt requires some of these.
  - TIME-BOUND PAUSE models its required close on "I'll check in after a month".
  - IMAGE GUIDANCE says "send done and I'll check it".
  - Flight help says "I'll send you a link with flight options".
  - A revision request is answered with "I'll get the hairline redrawn lower and send you the updated plan".
  A blanket block fails correct replies, spends a repair call, and ends as `SYSTEM_FAILURE`. That is an avoidable escalation we cause ourselves. Time windows have the same problem: "within 24 hours" is correct for the clinic confirming a date.
- Proposal: two levels.
  - Block: channel talk; stalls ("let me look into", "I'll get back to you", "I'll find out"); "I'll call"; claimed lookups ("I checked our system"); any promise that another person will follow up when `escalate` is false.
  - Warn only: "I'll send" and "I'll check". Warnings are logged and counted in the report.
  - The turnaround rule fires only in a sentence about the assessment being ready.
- **Decision: approved.**

### 6.4 Two expected behaviors the original prompt does not state

- Deposits. Both pricing replies in the packet give the deposit with the price, and the packet lists deposits as required facts. The prompt has no rule for this, and it also says to answer only what was asked. Proposal: one presentation rule at the decision stage: when you state a package's price, state its deposit too. The amount still comes from tool data. This is the only new rule added, and the README will say so. As built, code sets it as a directive (`quoteDepositWithPrice`) when the pipeline status is `PRE_CLINICAL_SENT`, so the skill files stay pure original text.
- Links. Two packet replies include a link the prompt would hold back. The first includes the assessment link, which was already sent earlier in the thread and which the patient did not ask for. The third includes the consultation link, although GUIDELINES says a simple factual question gets "no next-step CTA".
- **Decision: approved, with one wider link rule that covers both.** When the answer is about a step the patient can complete themselves on a known page, and nothing on file shows the step is done, that page's link is part of the answer. It is not a CTA. Two cases exist today: paying from the assessment when there is no booking, and booking the consultation when none is on file.
  - The router says which self-serve step a message is about. Code checks the record and decides. A message whose primary intent is the consultation counts as being about that step.
  - The precedence log records that this rule beat "no next-step CTA" in GUIDELINES and, where it applies, "no repeated links".
  - An explicit request for a link still wins, as in the brief.
  - Negative cases check that the link stays out when it should. Eval cases cover messages that are not about the step. Unit tests over fixture variants cover a step that is already done.
- Neither rule is a special case for a test message. Both apply to every message.

### 6.5 What the router decides

- Brief said: the router returns `requestedActions` "each with whether a tool can perform it", and `escalation.needed` with a `reasonCode`.
- Problem: that asks the small model to know the tool inventory and to apply policy. Those two judgments are the most likely to drift between runs, and drift there moves the escalation rate.
- Proposal: the router only classifies. It returns `humanRequested` and the actions with a `type` each. Code owns the catalog and the table. Every escalation then traces to a catalog row and a table row.
- Two additions the report needs:
  - `primaryIntent`, one label per message. A mix-versus-rate split needs each message counted once, and `intents` is multi-label.
  - One primary reason code per escalated message. Per-code rates add up to the total only if each message has one code.
- **Decision: approved.** This is the core of the design: the small model says what a message is, and code says what to do about it.

### 6.6 Skill split

- The PRE_CLINICAL_SENT section is about 3,600 tokens. As one stage skill it would be the largest block loaded on every turn. The stage skill keeps its intro, the "got it" rule and Pacing. Steps 0 to 3 move into the topical skills.
- Three new skills:
  - `deposit-terms`: REVERSIBILITY plus the refund, transfer and price-lock lines. It gives the $25 fee wording one home.
  - `dates-availability`: OPERATIONAL KNOWLEDGE 5 and 10 and tentative dates. They have no home in the suggested list.
  - `package-choice`: WHAT MATTERS vs NICE TO HAVE plus Step 2. Without it, a one-line price question loads about 3,700 tokens of package rules instead of 2,000.
- Flag-gated blocks. FINANCING GEOGRAPHY, HEALTH INSURANCE and CARECREDIT each have a yes, a no and an unknown branch. Code knows the flag, so the model sees only the branch that applies.
- `price_grounding`. The brief accepted "an amount stated in a loaded skill". Skill examples contain many made-up amounts, so that would accept them. Each skill lists its real policy amounts in frontmatter as `policyAmounts`. Today that is only the $25 cancellation fee.
- **Decision: all four approved.**

### 6.7 Node version

- Brief said: Node 20+.
- Problem: the current AI SDK (`ai` 7.0.130, `@ai-sdk/anthropic` 4.0.74) declares `node >= 22`. `vitest` 5.0.3 declares 22.12+, 24, or 26+. The dev machine had only Node 25.3.0, which vitest 5 does not list.
- **Decision: approved.** Require Node 22.12 or later. Develop and test on Node 24 LTS (`nvm install 24`, pinned in `.nvmrc`).

## 7. Questions, with the decisions

**7.1 Branch.** Commit to a `build` branch. No push. The owner merges after review.

**7.2 Unreachable stages.** The packet's context is fixed at `PRE_CLINICAL_SENT`. The rules for LEAD, PREP_PRE_CLINICAL, the MEETING stages, WAITING, first contact and the instant form can never load in a graded run. Decision: port them verbatim at the very end (M10), with no eval coverage and a note in the README. This is the first thing cut.

**7.3 Baseline.** Decision: run the original prompt, filled as the packet's Flow section describes, over the same eval set once in M9, and report tokens, latency and pass rate side by side. It lives under `eval/baseline/`. If time is short, fall back to a static token count of the old prompt against the new assembled prompts, which is free.

**7.4 Subtasks.** The packet's reason 4 is that a subtask, such as inspecting every call log, has nowhere to go. The brief missed it. Decision: build a small `call-history` subtask. When the router says the question needs call history, code fetches the calls. Short transcripts go to the responder as they are. Past a size limit, the router model extracts only what answers the question and returns that. The README answers reason 4 with it.

**7.5 Three boundary calls.**
- Money paid directly to a clinic. Decision: no exception to the principle. If the patient asks us to move or transfer money they paid a clinic directly, that is `MONEY_MOVE_OR_REFUND_ACTION` and it escalates. If they only tell us they paid the clinic, or ask whether it counts or whether they must pay again, the DEPOSIT ELIGIBILITY RULE answers.
- A request to change the hairline or the plan. Decision: follow the prompt and confirm the revision. In production a detector files the request, and that detector is not in this repo. So code emits a stub side effect, a `revision_request` event in the trace, and the README says production's detector would consume it. The promise is traceable.
- "Are you a real person?" Decision: the prompt's identity answer. A validator blocks any claim to be human. A request to talk to a person still escalates.

**7.6 Refusal fallback.** Anthropic's guidance for `claude-sonnet-5-5` is to turn on server-side fallback, a beta flag that retries some refused requests on the previous Sonnet. It retries only two refusal categories, and neither should occur in this domain. Decision: off by default, behind an env variable, and documented. A refusal that is not retried is `SYSTEM_FAILURE`.

**7.7 A satisfaction signal.** Decision: the responder also reports, for the trace only, whether it answered all, part or none of what was asked. The report prints that rate next to the escalation rate and labels it a self-reported proxy. It stops the system from lowering the escalation rate by saying "I don't have that" more often without anyone seeing it.

**7.8 Date codes.** Decision: keep `DATE_HOLD_OR_AVAILABILITY_ACTION` as one code.

## 8. Smaller decisions

All accepted in review.

- Output objects have exactly the ten `Reply` keys. There is no `id`: the interface has none, and the packet says order is the join key.
- The five packet inputs live only in `eval/packet/messages.json`. The README's example command points at that file.
- The leak test scans every tracked file outside `docs/` and `eval/`, including this file and the README.
- Traces store the redacted message and the type and count of redactions. They never store the redacted tokens.
- Payment and checkout links are fetched by code, from the link plan. `getPaymentLinkTool` and the three write tools are never exposed to the model. `issuePromoCodeTool` is not exposed while the patient has no promo.
- "Step cap 3" means at most two tool rounds plus the final structured answer. The AI SDK counts the structured-output step.
- A repair is a fresh single-turn request with the draft and the validator errors. It is not a continuation of the first call.
- Entities are the router's entities plus a deterministic match of clinic names from tool data. A router miss on a clinic name does not lose the prefetch.
- `price_grounding` accepts amounts from this turn's tool data, the loaded skills' `policyAmounts`, amounts the patient wrote, and exact differences of two tool amounts for the same clinic (a remaining balance, a gap between tiers).
- Validators added to the brief's seven: no handoff promise when `escalate` is false, no internal tokens (UUIDs, tool names, status labels, reason codes), no claim to be human, and at most one payment or checkout link.
- Caching. Breakpoints go after core plus stage and after the skill bodies. The router prompt is below Haiku 4.5's 4,096-token cache minimum, so it is not cached. Tools render before the system prompt, so a cached prefix is shared only by requests with the same tool list. I will measure the hit rate before doing anything about that.
- `decidedBy` keeps the brief's four values. A separate `failure.cause` field says which kind of failure it was. It has one value the brief did not list, `internal_error`, for a bug or a bad input item on our side.
- Trace files are named by position and id, for example `0003-demand-human.json`. Ids in a grader's input may repeat or contain characters a file name cannot.
- The report prints a confidence interval for the escalation rate, so a swing inside the noise is labelled as noise.
- A missing API key makes the CLI exit with a clear error. It does not escalate every message.
- `.env` is loaded with Node's built-in env-file support. No `dotenv` dependency.
- Prices for `config/pricing.ts`, per million tokens, from Anthropic's model reference dated 2026-09-25: Sonnet 5.5 is $2 input, $10 output, $2.50 cache write, $0.20 cache read. Haiku 4.5 is $1 input, $5 output. I confirm them against the pricing page in M8.

## 9. What the review added

1. **Vertical slice first.** Right after M2, a thin router, planner and responder with core and only the skills the five packet messages need, until those five pass. The remaining skills, planner rules and validators follow. Section 2 is reordered for this.
2. **Transient API errors retry.** A 429, a 5xx, an overloaded response or a network error retries with exponential backoff before anything becomes `SYSTEM_FAILURE`. The CLI bounds concurrency: default 4, configurable. If retries run out, the trace records `failure.cause = transient_api`, and the report does not count it against policy. A rate-limited batch must not turn into false escalations, because `escalate` is graded exactly.
3. **Boundary pairs in the eval.** About half of my custom cases sit on the escalation boundary, in positive and negative pairs: a refund request against a refund-policy question; asking us to call the clinic about a date against asking whether a month is busy; asking to talk to someone about financing against asking whether they will talk to the surgeon; a card with an instruction to charge it against a declined card and a question about other options; asking us to match a clinic's quote against only sharing it. The wording is mine.
4. **Flip rate.** `npm run eval -- --repeat 3` runs each case three times and reports how often `escalate` flips. It shows how much of a Monday swing is noise.
5. **The brief is corrected.** `docs/design-brief.md` matches these decisions, and the two copied reply templates are gone from it.
6. **Cut line.** If time runs short: M10 first, then the full baseline run (the token count stays), then the refusal fallback flag. M8 stays.

## 10. Status on 2026-10-07

| Milestone | State |
| --- | --- |
| M0 Scaffold and SDK check | Done. The smoke check passed on both models. |
| M1 Contract and data | Done. |
| M2 Deterministic control plane | Done. |
| M3 Vertical slice | Done. The five packet messages pass. |
| M4 Remaining skills | Done. 26 skills, every one built by `scripts/split-prompt.ts`. |
| M5 Full router and planner | Done. |
| M6 Remaining validators and failure handling | Done. Eleven validators. |
| M7 Eval and tuning | Done. 50 dev cases and 15 holdout cases. The last three dev runs passed 50 of 50. Over three runs per case on the final code, `escalate` flipped on 0 of 52. The holdout ran once: 15 of 15. Medium effort did not beat low. |
| M8 Monday report | Done, and run on real traces. |
| M9 README and wrap-up | Done. The full baseline ran once (`npm run baseline`): the original prompt passed 31 of the 50 dev cases. The static size comparison (`npm run size`) is kept. |
| M10 Unreachable stages | Done. No eval coverage, as planned. |

The API account ran out of credit during the third full eval run. It was topped up the same day and every waiting run was done. `BLOCKERS.md` has the list, with each result.

What the build changed from this plan, beyond what earlier sections already record:

- Skills are generated, not hand-edited. That made "original wording only" a tested property instead of a promise.
- The always-loaded part is larger than planned: about 25,000 characters, of which `core` is 15,000. The plan said 3,000 tokens for `core`. Real token counts also run higher than characters ÷ 4.
- The consultation link is decided by code from the primary intent, after the router missed the self-serve flag on the first live run.
- A reply carries one self-serve link, for the step the message is mainly about.
- `prefetchNamed` was added to frontmatter, so a skill that only needs clinic data for a named clinic does not fetch it for every recommended clinic.
- A validator blocks a reply that announces a price cannot be matched. The original prompt bans that sentence, and the model kept writing it.
- An out-of-credit API account is a fatal error. Before the fix it produced a run of 50 escalations.
- Asked directly whether it is a bot, the model says it is an AI. The validator only blocks a claim to be human.
- The first 50 eval cases are dev cases. Fifteen holdout cases were written after tuning and run once.

What the live runs after the top-up changed:

- The responder gets one more model call, with no tools, when it spends its three calls on tool calls. The brief's "one repair, then a person" did not cover a draft that never arrives. Without this, such a message is a false escalation caused by the system.
- A tool whose one possible result code already fetched is not offered to the model.
- A directive, `identityQuestion`, carries the router's label to the responder, so the original prompt's identity rule, name and role, is applied when the patient asks whether they are talking to a bot.
- The internal-vocabulary validator also blocks talk about the machinery, such as "the tool shows". The eval fails any reply that does it, on every case, with a check of its own. Both came from reading the holdout replies after their one run, so the holdout is no longer blind.
- Each model call in a trace records the HTTP status of every attempt that failed and was retried.
- `npm run eval -- --recheck <runDir>` scores a past run again from its traces, with no model call.
- The eval has two more kinds of text check: one on the first sentence, and one that bans a pattern inside sentences about a subject. The Medicaid, CareCredit and Cherry cases use them. `test/eval/textChecks.test.ts` runs the checks of those cases, and of the monthly-payment case, on replies known to be good and bad.
- `npm run baseline` exists and has run. Its output schema makes the working-memory fields optional and not nullable, because the API accepts at most 16 nullable fields in one schema.
