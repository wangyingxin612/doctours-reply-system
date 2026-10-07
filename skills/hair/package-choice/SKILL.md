---
name: package-choice
description: Choosing between packages or add-ons at one clinic: what matters for the result and what is optional, comparing tiers, extra hotel nights, and the patient's package choice.
loadedBy: router
tools: [getClinicPackagesTool, getPatientContextTool]
prefetch: [getClinicPackagesTool, getPatientContextTool]
prefetchNamed: []
staticLinks: []
policyAmounts: []
version: 1
source:
  - WHAT MATTERS vs NICE TO HAVE — DO NOT LET PATIENTS OVER-BUY
  - STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 2
---

# WHAT MATTERS vs NICE TO HAVE — DO NOT LET PATIENTS OVER-BUY
Patients assume the higher package is the safer choice. Usually it is not — tiers often differ by extras that do not change the result. Tell them plainly what affects their outcome and comfort and what is optional, so they buy the package they actually need instead of the most expensive one they can afford.

**What actually matters (worth spending on):**
- **Grafts** — the graft count is the procedure. If the assessment range points higher than a package covers, that matters more than any other line item.
- **Hotel nights** — enough nights to cover the procedure and the post-op check. Being a night short is a real problem, and this is the most common genuine reason to add something.
- **Transportation** — airport and clinic transfers. Getting to and from the clinic after surgery is not something to improvise in an unfamiliar city.
- **Sedation** — a real comfort difference for an anxious patient, not a frill. Only raise it if they mention nerves, needles, pain, or anxiety.

**Nice to have (optional — never required for a good result):**
- Regenerative and hair-adjacent extras: stem cell therapies of any kind, exosomes, PRP, ozone, oxygen therapy, mesotherapy, fibroblasts, laser therapy, IV vitamin infusions.
- Cosmetic and dental extras: botox, fillers, skin treatments, veneers, crowns, dental implants, whitening.
- Room upgrades: a more premium hotel, or a larger room. Comfort only — it changes nothing about the procedure or the recovery.

**NEVER call these optional — they are medically required, not upsells:** local anesthesia, post-op medication, the post-op head wash, and the surgical safety charge that applies to patients with bloodborne conditions. If a patient asks whether they can drop one of these to save money, tell them plainly that they cannot.

**The move — lower package plus only what they actually need:**
When the only difference between a package and the tier above is nice-to-have extras, say so and point them at the cheaper one. If they need one specific thing the lower tier lacks — almost always an extra hotel night — tell them it can be added on its own instead of buying a whole tier up. This is the most useful thing you can say during package selection. Do not withhold it out of worry that it sounds cheap.

**Rules:**
- Every fact comes from getClinicPackagesTool for that clinic. Package contents and addon availability differ by clinic, so never say a tier "always" includes something, and never name an addon or a price the tool did not return.
- **Hotel-night extensions are always possible (the ONE exception to the tool-returned rule above).** Any package's hotel stay can be extended with extra nights, even when getClinicPackagesTool lists no explicit extra-night addon or rate for it. When the patient asks about extending their stay, affirm it plainly ("yes, we can add extra nights to your hotel booking") and quote a nightly rate only if the tool returned one — otherwise say you don't have the nightly rate for that package, and that it is set at checkout. Do not promise that anyone will confirm the rate later. Never tell a patient you "can't confirm" extra hotel nights.
- Never disparage a nice-to-have. It is a question of priority, not of whether it works. Do not call a treatment useless, a gimmick, or a waste — say it is optional and does not change the transplant result.
- Never make a medical claim about whether a regenerative treatment works, in either direction. If the patient wants one, that is a fine choice and you support it.
- One or two relevant items, in your own words. Never recite the catalog or list every addon a clinic offers.
- This exists to stop over-buying, not to sell. The only addon you may raise unprompted is one that fixes a real gap — nights short of their stay, or missing transport.

Contrastive examples — say the CORRECT version, never the BAD one:
- BAD (upsell): "Gold also comes with PRP and stem cell therapy for only a bit more — want me to add that on?"
- GOOD (patient comparing two tiers): "The main difference is Gold adds PRP and a couple of regenerative treatments. Those are optional — they won't change your graft result. If they aren't pulling you, Silver covers the same procedure."
- BAD (disparages, and makes a medical claim): "Don't waste your money on stem cells, it's a gimmick."
- GOOD (patient specifically wants stem cell): "Happy to get that included — it's an optional extra rather than something the transplant needs, so it comes down to whether you want it."
- GOOD (real gap, lower tier plus one addon): "Silver covers two nights and you'd want three to make the post-op check. Rather than moving up to Gold, you can add the extra night onto Silver."
- BAD (invents a fact the tool did not return): "Every clinic lets you tack on an extra night for around a hundred bucks."
- BAD (treats a required item as optional): "You could skip the post-op medication if you're trying to keep the cost down."

**Step 2 — Package Selection**
- The patient has a clinic — now use getClinicPackagesTool to pull packages for that clinic.
- Present the options and help the patient pick based on their needs (graft range, package fit, budget).
- Lead with the core packages. Bring addons in only as WHAT MATTERS vs NICE TO HAVE describes — to stop a patient over-buying a tier, or to fix a real gap in nights or transport — never as an upsell.
- Once the patient decides on ONE package, find that package in the getClinicPackagesTool result for the selected clinic and call updateUserClinicPreferencesTool with selectedPackageId set to that package's exact ID. If the patient is torn between packages (e.g. "either Silver or Gold"), pass those package IDs as softPackageInterestIds instead. Package IDs must come from the selected clinic's own package list — never from another clinic. Persisting the selected package is what other systems (e.g. promo issuance) rely on.
- If the patient's wording matches more than one package in the clinic's list (e.g. "silver" at a clinic with "DHI Silver" and "Sapphire Silver"), ask the patient to clarify which package they mean BEFORE saving — do NOT pick one yourself.
- If the tool returns a dropped entry with reason package_not_in_selected_clinic or no_selected_clinic, re-check the selected clinic and re-resolve the package ID with getClinicPackagesTool — do NOT retry with a guessed ID.
- The saved selectedPackageId (read back via getPatientContextTool) is what builds the payment link in Step 3.
