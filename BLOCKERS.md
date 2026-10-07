# Blockers

Things that need you. Each entry says what is blocked, what I did instead, and what to run once it is cleared.

## 1. The Anthropic API account is out of credit

Open since 2026-10-07.

**What happened.** Partway through the third full eval run, every model call started to fail with HTTP 400: "Your credit balance is too low to access the Anthropic API." Nothing that calls a model can run until the account has credit. By my estimate the build had used about $4 by then, over roughly 110 answered messages.

**What I need from you.** Add credit to the account behind the key in `.env`. About $20 covers everything listed below with room to spare.

**What is blocked.**

- Confirming the last batch of fixes with live calls. The last full eval run that completed is `eval-m7-2`: 47 of 50 cases passed, and escalation precision and recall were both 100%. The three failures each have a fix in commit `dd2eaae`. The fixes that are code have unit tests. The two that are prompt wording (the router setting instruction-like text aside, and the plain-sentences line in the responder's frame) are not yet confirmed live.
- The stability run: `npm run eval -- --repeat 3`, which reports the flip rate for `escalate`.
- The comparison of responder effort `low` against `medium`.
- The holdout run. I read the outputs of the first fifty cases while fixing bugs, so they all count as dev cases. I have since added fifteen holdout cases (ids starting `h-`) that have never been run. They should be run once and reported, not tuned on.
- The full baseline run of the original prompt (M9). I am using the fallback you named instead: a static size comparison.

**What I did instead.**

- Running out of credit used to turn every message into a `SYSTEM_FAILURE` escalation. That is exactly the false escalation you warned about, so it is now a fatal error: the run stops with "The API account is out of credit" and exit code 2, and writes no replies. It is treated the same way as a missing or rejected key.
- I moved on to work that needs no model: the Monday report (built on the traces of the two completed eval runs), the README, and the stage skills.

**What to run once there is credit, in this order.**

```
npm run smoke
npm run eval -- --split dev --run-id after-fixes
npm run eval -- --split dev --repeat 3 --run-id stability
RESPONDER_EFFORT=medium npm run eval -- --split dev --run-id effort-medium
npm run eval -- --split holdout --run-id holdout
npm run report -- traces/after-fixes traces/eval-m7-2
```

One full run of the fifty cases costs about $1 to $1.50. If `after-fixes` shows a failure, send me the output and I will fix it before the other runs.
