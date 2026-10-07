# A sample Monday report

This is the output of `npm run report -- traces/release traces/stability-final`, unedited below the line. Both runs are real: the dev eval cases, each run three times, on 2026-10-07. `stability-final` came first. `release` is the last full run before this was handed in. The traces themselves are not in the repository.

## How to read this one

The escalation rate went from 26.9% to 27.8%. The report says three things about that.

1. **It is not a real change.** The two intervals overlap, and the report says so before anything else.
2. **Nothing avoidable.** Every escalation is in the policy-required category. No message was handed over because the system failed.
3. **Where the 0.9 points came from.** By reason code it is all `HUMAN_REQUESTED`, up 1.6 points, with every other code down a little. That is a change in what was asked: between the runs two cases were added to the eval set, and one of them asks for a person. The other codes fell only because the same number of messages is now a smaller share of a larger run.

The split by intent needs one more fact. A message the guard decides never reaches the router, so its intent comes from the guard's code. Between the runs the guard started to decide "Is there someone I can speak with about the payment plans?", which the router used to label as a financing question. That one message moved from `financing_insurance` to `human_request`. So the table shows financing escalating less (a rate effect of -1.7) and more human requests arriving (a mix effect of +3.6). Neither happened in the world. The message was relabeled. A change in who decides a message can look like a change in what patients ask, and the "By who decided" table is where to check: the guard's share is up.

Two other things to notice.

- **Repairs.** 4 of 117 drafts needed one. Three are the same case, a message that tries to give the system instructions, which is why `pricing_promos` shows a 50% repair rate on 6 drafts.
- **Retries.** Four model calls got through only after a retry. They were the first four requests of the run, and they are why the 95th percentile is 10.8 seconds.

---

# Escalation report: release

162 messages. Policy version 2026-10-07.1+2f65019a3e38. Models: claude-haiku-4-5-20251001, claude-sonnet-5-5 (effort low).

## Escalation rate

27.8% of messages were handed to a person (45 of 162). At this volume the true rate is probably between 21.5% and 35.1%.

| Category | Messages | Rate | What it means |
| --- | --- | --- | --- |
| Policy required | 45 | 27.8% | The patient asked for a person, or for an action no tool can do. Moves with what patients ask. |
| Avoidable | 0 | 0.0% | The system failed, or could not map a request. This is the number to push down. |

By reason code. One code per message, so the rates add up to the total.

| Reason code | Category | Messages | Rate |
| --- | --- | --- | --- |
| HUMAN_REQUESTED | policy_required | 12 | 7.4% |
| PAYMENT_ACTION_NO_TOOL | policy_required | 9 | 5.6% |
| MONEY_MOVE_OR_REFUND_ACTION | policy_required | 6 | 3.7% |
| DATE_HOLD_OR_AVAILABILITY_ACTION | policy_required | 6 | 3.7% |
| CLINIC_CONTACT_ACTION | policy_required | 3 | 1.9% |
| PRICE_NEGOTIATION | policy_required | 3 | 1.9% |
| CALL_REQUEST | policy_required | 3 | 1.9% |
| BOOKING_CHANGE_ACTION | policy_required | 3 | 1.9% |

By who decided. guard: patterns in code, no model call. router_policy: the router classified and the policy tables decided. validator_fallback: the system could not produce a reply that passed its checks.

| Decided by | Messages | Rate |
| --- | --- | --- |
| router_policy | 24 | 14.8% |
| guard | 21 | 13.0% |

## Answered messages

117 of 162 messages were answered without a person.

Coverage is what the model said about its own reply. It is a proxy, not a measurement. Watch it next to the escalation rate: if escalations fall while "none" rises, the system is saying "I don't have that" instead of handing off.

| Answered | Messages | Share of answered |
| --- | --- | --- |
| everything asked | 108 | 92.3% |
| part of it | 9 | 7.7% |

4 message(s) needed a repair attempt. 4 validator warning(s) were logged.

## Repairs

4 of 117 drafted messages needed a repair (3.4%). A repair is a second model call, made when a validator blocks the first draft. It costs money and time even when it ends well.

By what blocked the first draft. A draft can be blocked by more than one check, so the rows can add up to more than the repairs.

| Validator | First drafts blocked | Share of drafts |
| --- | --- | --- |
| no_internal_tokens | 3 | 2.6% |
| url_provenance | 1 | 0.9% |

By intent. Intents with no repair are left out.

| Intent | Drafted | Repaired | Repair rate |
| --- | --- | --- | --- |
| pricing_promos | 6 | 3 | 50.0% |
| payment | 9 | 1 | 11.1% |

## Cost and latency

The run cost $2.27, or $0.0140 per message. A message the guard escalates costs nothing.

| Stage | Calls | Uncached input | Cache read | Cache write | Output |
| --- | --- | --- | --- | --- | --- |
| router | 141 | 695292 | 0 | 0 | 22208 |
| responder | 118 | 182720 | 1336297 | 209768 | 24322 |
| repair | 4 | 10627 | 40796 | 11496 | 773 |

Latency: p50 5718 ms and p95 10764 ms over all messages. For answered messages, p50 6234 ms and p95 11737 ms.

Latency of each stage's model calls, in milliseconds. A message's latency is the sum of its stages, plus any wait between retries.

| Stage | Calls | p50 | p95 |
| --- | --- | --- | --- |
| router | 141 | 3573 | 5798 |
| responder | 118 | 2649 | 5237 |
| repair | 4 | 2992 | 3106 |

4 of 263 model calls got through only after a retry (failed attempts: no response: 4). A retry waits before it tries again, so API trouble that retries absorb shows up here and in the latency, not in the escalation rate.

## Change against stability-final

The escalation rate went from 26.9% (42 of 156) to 27.8% (45 of 162): +0.9 points.

The two runs' intervals overlap. At this volume a change of this size can be noise.

The rules changed between the runs: 2026-10-07.1+c29a3f6b5453 before, 2026-10-07.1+2f65019a3e38 now.

By reason code. The contributions add up to the change exactly.

| Reason code | Before | After | Contribution (points) |
| --- | --- | --- | --- |
| HUMAN_REQUESTED | 5.8% | 7.4% | +1.6 |
| PAYMENT_ACTION_NO_TOOL | 5.8% | 5.6% | -0.2 |
| MONEY_MOVE_OR_REFUND_ACTION | 3.8% | 3.7% | -0.1 |
| DATE_HOLD_OR_AVAILABILITY_ACTION | 3.8% | 3.7% | -0.1 |
| CLINIC_CONTACT_ACTION | 1.9% | 1.9% | -0.1 |
| PRICE_NEGOTIATION | 1.9% | 1.9% | -0.1 |
| CALL_REQUEST | 1.9% | 1.9% | -0.1 |
| BOOKING_CHANGE_ACTION | 1.9% | 1.9% | -0.1 |
| Total | 26.9% | 27.8% | +0.9 |

By intent, mix versus rate. Mix effect: the part of the change that comes from more or fewer messages of an intent. Rate effect: the part that comes from escalating that intent more or less often. Together they add up to the change exactly.

| Intent | Share before | Share after | Rate before | Rate after | Mix effect | Rate effect |
| --- | --- | --- | --- | --- | --- | --- |
| human_request | 3.8% | 7.4% | 100.0% | 100.0% | +3.6 | +0.0 |
| financing_insurance | 7.7% | 5.6% | 25.0% | 0.0% | -0.3 | -1.7 |
| payment | 11.5% | 11.1% | 50.0% | 50.0% | -0.2 | +0.0 |
| deposit_terms | 9.6% | 9.3% | 40.0% | 40.0% | -0.1 | +0.0 |
| dates_availability | 7.7% | 7.4% | 50.0% | 50.0% | -0.1 | +0.0 |
| package_choice | 5.8% | 5.6% | 33.3% | 33.3% | -0.1 | +0.0 |
| pricing_promos | 5.8% | 5.6% | 33.3% | 33.3% | -0.1 | +0.0 |
| unsupported_action | 1.9% | 1.9% | 100.0% | 100.0% | -0.1 | +0.0 |
| consultation | 7.7% | 9.3% | 25.0% | 20.0% | +0.4 | -0.4 |
| clinic_packages | 11.5% | 11.1% | 0.0% | 0.0% | +0.0 | +0.0 |
| clinic_specialty | 3.8% | 3.7% | 0.0% | 0.0% | +0.0 | +0.0 |
| clinic_website_contact | 5.8% | 5.6% | 0.0% | 0.0% | +0.0 | +0.0 |
| identity | 1.9% | 1.9% | 0.0% | 0.0% | +0.0 | +0.0 |
| pause_followup | 1.9% | 1.9% | 0.0% | 0.0% | +0.0 | +0.0 |
| photos | 1.9% | 1.9% | 0.0% | 0.0% | +0.0 | +0.0 |
| travel | 3.8% | 3.7% | 0.0% | 0.0% | +0.0 | +0.0 |
| assessment | 3.8% | 3.7% | 0.0% | 0.0% | +0.0 | +0.0 |
| chit_chat | 1.9% | 1.9% | 0.0% | 0.0% | +0.0 | +0.0 |
| creator_partnership | 1.9% | 1.9% | 0.0% | 0.0% | +0.0 | +0.0 |
| Total |  |  |  |  | +2.9 | -2.1 |

Of the +0.9 points, +2.9 come from a different mix of messages and -2.1 from escalating the same kinds of message at a different rate.
