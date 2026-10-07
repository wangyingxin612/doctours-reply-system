import { describe, expect, it } from "vitest";
import { TurnLedger } from "../../src/tools/ledger";
import { isModelCallable, TOOL_NAMES, TOOL_REGISTRY } from "../../src/tools/registry";

describe("tool registry", () => {
  it("exposes the packet's fourteen tools under the prompt's names", () => {
    expect(TOOL_NAMES).toHaveLength(14);
    expect(TOOL_NAMES.every((name) => name.endsWith("Tool"))).toBe(true);
  });

  it("keeps write tools and payment links away from the model", () => {
    const codeOnly = TOOL_NAMES.filter((name) => !isModelCallable(name)).sort();
    expect(codeOnly).toEqual([
      "getPaymentLinkTool",
      "issuePromoCodeTool",
      "updateUserClinicPreferencesTool",
      "updateUserTool",
      "updateWorkingMemoryTool",
    ]);
  });

  it("accepts an empty input for every tool", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_REGISTRY[name].inputSchema.safeParse({}).success).toBe(true);
    }
  });
});

describe("turn ledger", () => {
  it("records each call with its source, input and output", () => {
    const ledger = new TurnLedger();
    const output = ledger.call("getClinicPackagesTool", { clinicName: "Heva" }, "prefetch");

    expect(ledger.calls).toEqual([
      { name: "getClinicPackagesTool", kind: "read", source: "prefetch", input: { clinicName: "Heva" }, output },
    ]);
  });

  it("collects money amounts with their clinic, currency and label", () => {
    const ledger = new TurnLedger();
    ledger.call("getClinicPackagesTool", { clinicName: "Heva" }, "prefetch");

    expect(ledger.money()).toEqual([
      { amount: 3000, currency: "USD", clinicName: "Heva Clinic", label: "Silver.basePrice" },
      { amount: 500, currency: "USD", clinicName: "Heva Clinic", label: "Silver.depositAmount" },
      { amount: 4500, currency: "USD", clinicName: "Heva Clinic", label: "Gold.basePrice" },
      { amount: 600, currency: "USD", clinicName: "Heva Clinic", label: "Gold.depositAmount" },
    ]);
  });

  it("collects only URLs a tool returned this turn", () => {
    const ledger = new TurnLedger();
    expect(ledger.urls().size).toBe(0);

    ledger.call("getLatestAssessmentTool", {}, "prefetch");
    expect([...ledger.urls()]).toEqual([
      "https://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333",
    ]);
    expect(ledger.imageUrls().size).toBe(0);
  });

  it("keeps photo URLs apart, because only those may be attached", () => {
    const ledger = new TurnLedger();
    ledger.call("getPatientImagesTool", {}, "prefetch");
    ledger.call("getLatestAssessmentTool", {}, "prefetch");

    expect(ledger.imageUrls().size).toBe(5);
    expect(ledger.urls().size).toBe(6);
  });

  it("finds no money in a null result", () => {
    const ledger = new TurnLedger();
    ledger.call("getClinicPackagesTool", { clinicName: "Unknown Clinic" }, "responder");
    expect(ledger.money()).toEqual([]);
    expect(ledger.urls().size).toBe(0);
  });
});
