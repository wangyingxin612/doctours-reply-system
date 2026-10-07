import { describe, expect, it } from "vitest";
import { buildPacketContext } from "../../src/context/fixture";
import { loadSkills, parseSkill, renderSkillBody } from "../../src/skills/loader";

const skills = loadSkills("hair");

function file(frontmatter: string[], body = "Body text."): string {
  return ["---", ...frontmatter, "---", "", body, ""].join("\n");
}

const valid = [
  "name: sample",
  "description: A sample skill: with a colon in it.",
  "loadedBy: router",
  "tools: [getClinicPackagesTool, getAllClinicsTool]",
  "prefetch: [getClinicPackagesTool]",
  "staticLinks: [https://www.doctours.com/consultation]",
  "policyAmounts: [25]",
  "version: 1",
  "source:",
  "  - SOME SECTION (HARD RULE)",
  "  - Another: section",
];

describe("skill loader", () => {
  it("loads the hair vertical with a core skill and a stage skill", () => {
    expect(skills.core.loadedBy).toBe("always");
    expect(skills.stage("PRE_CLINICAL_SENT")?.name).toBe("stage-pre-clinical-sent");
    expect(skills.stage("SOME_OTHER_STATUS")).toBeNull();
  });

  it("offers the router only router-loaded skills, each with a one-line description", () => {
    expect(skills.routable.length).toBeGreaterThanOrEqual(4);
    for (const skill of skills.routable) {
      expect(skill.loadedBy).toBe("router");
      expect(skill.description).not.toContain("\n");
      expect(skill.description.length).toBeGreaterThan(30);
    }
    expect(skills.routable.map((skill) => skill.name)).not.toContain("core");
  });

  it("keeps the always-loaded core within its size budget", () => {
    // About 4,000 tokens at 4 characters per token. The original prompt is about 40,000.
    expect(skills.core.body.length).toBeLessThanOrEqual(16_000);
  });

  it("fails loudly for an unknown skill or vertical", () => {
    expect(() => skills.get("no-such-skill")).toThrow(/Unknown skill/);
    expect(() => loadSkills("no-such-vertical")).toThrow(/No skills folder/);
  });

  it("fills the coordinator name and leaves other placeholders alone", () => {
    const body = renderSkillBody(skills.core, buildPacketContext());
    expect(body).toContain("I'm Alex, your Patient Care Coordinator at Doctours.");
    expect(body).not.toContain("{{COORDINATOR_DISPLAY_NAME}}");
  });

  it("shows only the financing branch that matches the patient's flag", () => {
    const base = buildPacketContext();
    const withFlag = (financingEligible: "yes" | "no" | "unknown") =>
      renderSkillBody(skills.get("financing-insurance"), { ...base, patient: { ...base.patient, financingEligible } });

    const markers = { yes: "- **yes (US or Canada):**", no: "- **no (known outside the US and Canada):**", unknown: "- **unknown:**" };
    for (const flag of ["yes", "no", "unknown"] as const) {
      const body = withFlag(flag);
      for (const [branch, marker] of Object.entries(markers)) {
        expect(body.includes(marker), `${flag} patient, ${branch} branch`).toBe(branch === flag);
      }
      // The gate markers are for code. The model never sees them.
      expect(body).not.toContain("<!--");
      // Rules outside the gates are always there.
      expect(body).toContain("# HEALTH INSURANCE (HARD RULE)");
      expect(body).toContain("# CARECREDIT / CHERRY (HARD RULE)");
    }
    // A patient sees one branch of each rule, not three.
    expect(withFlag("yes").length).toBeLessThan(skills.get("financing-insurance").body.length * 0.85);
  });

  it("declares the cancellation fee as the only policy amount", () => {
    const amounts = skills.skills.flatMap((skill) => skill.policyAmounts.map((amount) => `${skill.name}:${amount}`));
    expect(amounts).toEqual(["deposit-terms:25"]);
  });

  it("parses frontmatter lists, numbers and values that contain colons", () => {
    const skill = parseSkill(file(valid), "sample.md");
    expect(skill).toMatchObject({
      name: "sample",
      description: "A sample skill: with a colon in it.",
      tools: ["getClinicPackagesTool", "getAllClinicsTool"],
      prefetch: ["getClinicPackagesTool"],
      staticLinks: ["https://www.doctours.com/consultation"],
      policyAmounts: [25],
      version: 1,
      source: ["SOME SECTION (HARD RULE)", "Another: section"],
      body: "Body text.",
    });
  });

  it("rejects a skill that breaks the rules for tools", () => {
    const withLine = (index: number, line: string) => valid.map((original, i) => (i === index ? line : original));

    expect(() => parseSkill(file(withLine(3, "tools: [noSuchTool]")), "x")).toThrow(/unknown tool/);
    expect(() => parseSkill(file(withLine(3, "tools: [getPaymentLinkTool]")), "x")).toThrow(/may not call/);
    expect(() => parseSkill(file(withLine(3, "tools: [updateUserTool]")), "x")).toThrow(/may not call/);
    expect(() => parseSkill(file(withLine(4, "prefetch: [updateUserTool]")), "x")).toThrow(/only read/);
    expect(() => parseSkill(file(withLine(2, "loadedBy: status")), "x")).toThrow(/needs a status/);
    expect(() => parseSkill("no frontmatter here", "x")).toThrow(/missing frontmatter/);
    expect(() => parseSkill(file([...valid, "extra: 1"]), "x")).toThrow();
  });
});
