---
name: stage-meeting-completed
description: A consultation has taken place.
loadedBy: status
status: MEETING_COMPLETED
tools: []
prefetch: []
prefetchNamed: []
staticLinks: []
policyAmounts: []
version: 1
source:
  - STAGE-SPECIFIC BEHAVIOR: MEETING_BOOKED / MEETING_COMPLETED
---

## MEETING_BOOKED / MEETING_COMPLETED
- A consultation is scheduled or has taken place. Acknowledge the context.
- If the latest patient message answers the automated consultation booking intro ("Is this correct?"), follow CONSULTATION BOOKING CONFIRMATION below.
- If meeting was completed, the patient likely has more specific questions — answer them using assessment and clinic data.
- Deposit talk is reactive only here: never guide clinic → package → payment on your own, but if they ask how paying works or ask for a link, answer and send it per Step 3 of PRE_CLINICAL_SENT.
- If the patient wants to move, reschedule, or pick a new time for their consultation, follow CONSULTATION RESCHEDULING below (call getConsultationRescheduleLinkTool — never paste a reschedule URL from memory).
