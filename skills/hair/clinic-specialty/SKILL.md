---
name: clinic-specialty
description: Whether a clinic suits a hair type or need: afro, 4C, curly or textured hair, a clinic's speciality and practice type, its doctors, and which procedure areas clinics handle.
loadedBy: router
tools: [getAllClinicsTool, getClinicDoctorsTool]
prefetch: [getAllClinicsTool]
staticLinks: []
policyAmounts: []
version: 1
source:
  - PACKAGE & CLINIC FACTS (hair type is a clinic_flags fact)
  - Clinic flags (workflow prompt)
  - OPERATIONAL KNOWLEDGE 2 and 4
  - TOOL USAGE (getAllClinicsTool, getClinicDoctorsTool)
---

- **Hair type / afro capability is a clinic_flags fact, not a package fact:** whether a clinic can do afro, 4C, curly, textured, or Black / African-American hair comes from **clinic_flags** in the Clinic flags section of this prompt (and on clinic tools). Speciality value **"Afro Hair"** means that clinic is an afro-hair specialist. Answer "is this clinic a ___ specialty?" from those flags. Do NOT call getClinicPackagesTool to answer hair-type or specialty questions, and do NOT infer this from package names: a package titled "Afro Hair Transplant" is not the clinic flag, and a clinic whose packages are named Silver/Gold/Diamond can still specialize in afro hair. If Speciality is not "Afro Hair", say you do not have that clinic flagged for afro hair rather than guessing from package copy.

# Clinic flags
These flags are already loaded. They are the source of truth for clinic Speciality, Practice type, and other profile tags. Hair type (afro / 4C / curly / textured / Black hair) is Speciality — never infer it from package names (Silver/Gold/Diamond/VIP). Speciality "Afro Hair" means that clinic is an afro-hair specialist. Answer "is this clinic a ___ specialty?" from this list. You do not need a tool call when the named clinic is here.

2. **Procedure Areas and Clinics:** All partner clinics handle hair (hairline/crown/both), beard transplants, and eyebrow transplants. Veneers: only if the patient explicitly raises it.
Use the Clinic flags section (and clinic_flags on tools) for Speciality / afro / hair-type fit, clinic.ai_context.bestFor/badFor/ranking for additional fit notes, and CLINIC STATUS TIERS for whether a clinic may be offered at all.
- Use getAllClinicsTool for basic clinic information (name, id, slug, address, clinic_flags, ai_context). Speciality / Practice type / other flags are already in the Clinic flags section of context — answer those from there. Package names are not capability.
- Use getClinicDoctorsTool to fetch doctors for a specific clinic. Accepts either a clinic ID or clinic name.
