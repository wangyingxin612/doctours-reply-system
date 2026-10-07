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
