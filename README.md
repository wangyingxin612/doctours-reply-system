# Doctours reply system

A patient texts about a hair transplant. This system drafts the reply, or hands the conversation to a person.

The original system was one prompt of about 166 KB, sent whole for every message, with no way to hand off. This one splits the work in two. Code decides the route, which rules load, which tools run, and whether a person takes over. The model writes the reply.

This README is a short version. The full write-up comes with the last milestone. `PLAN.md` has the design and the reasons for it.

## How to run

You need Node.js 22.12 or later (developed on Node 24) and an Anthropic API key.

```
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY in .env
npm run respond -- --in eval/packet/messages.json --out replies.json
```

The command reads a JSON array of `{ "id", "text" }` and writes a JSON array of `Reply` objects, one per message, in the same order. With no `--in` it reads stdin. With no `--out` it writes stdout. Logs go to stderr.

Options: `--concurrency <n>` (default 4), `--trace-dir <dir>` (default `traces`), `--run-id <id>`, `--no-trace`.

Other commands:

- `npm test` runs the unit tests. They need no key.
- `npm run eval` runs the eval cases with real model calls and checks each reply.
- `npm run smoke` checks the model settings with a few small real calls.

Optional settings are listed in `.env.example`.

## What happens to a message

1. **Guard.** Code removes card data from the text. It also escalates two cases with no model call: an explicit request for a human, and an instruction to charge a card.
2. **Router.** A small model classifies the message: intents, the skills it needs, any actions the patient asks for, and the clinics it mentions. It does not decide what to do.
3. **Policy.** Two tables in code decide. The action catalog maps each kind of action to a tool, a rule, or an escalation reason. The escalation table says how each reason is answered.
4. **Planner.** Code loads the selected skills, runs their tools, saves what the patient told us, and decides which link the reply carries.
5. **Responder.** The main model writes the reply from the rules, facts and directives that code chose.
6. **Validators.** Code checks the draft: the output shape, where links sit and where they came from, every money amount against tool data, no markdown, no card data. One repair attempt. If it still fails, the message goes to a person.
7. **Trace.** Each message leaves a trace under `traces/<run>/` with every decision and its cost.

## What is loaded on every turn

Only `core` (identity, voice, grounding, output fields), the skill for the patient's stage, and the patient context. Every other skill loads when the router selects it. A message the guard escalates loads nothing.

Skills live in `skills/hair/`. Each one is text copied from the original prompt with nothing added: `scripts/split-prompt.ts` builds them from line numbers, and a test fails if a skill contains a word the original prompt does not.

## How escalation works

`escalate` is true when a person must take over:

- The patient asks for a human.
- The patient asks for an action that no tool and no rule can perform, such as charging a card, moving or refunding money already paid, or contacting a clinic to hold a date.
- The system could not produce a reply that passes its own checks.

A question that a rule or tool can answer gets answered. A question about an action is still a question. If any part of a message needs a person, the whole message gets the short reply: one handoff sentence, with one decline sentence before it for an action. Then the system stops.

The reason codes and reply templates are in `src/policy/escalation.ts`. The action catalog is in `src/policy/actions.ts`.

## Status

Built so far: the guard, the policy tables, six validators, the router, the planner, the responder with repair, traces, the eval runner, and six skills (`core`, `stage-pre-clinical-sent`, `clinic-packages`, `clinic-specialty`, `payment-deposit`, `consultation`). The five messages in the packet pass.

Still to come, in the order `PLAN.md` gives: the remaining skills, the full planner, the remaining validators, the larger eval set, and the Monday report. Until the remaining skills land, a question outside the six topics above is answered from `core` alone, or with "I don't have that detail".
