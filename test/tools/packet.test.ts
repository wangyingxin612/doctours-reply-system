import { describe, expect, it } from "vitest";
import * as tools from "../../src/tools/packet";

describe("ported tools", () => {
  it("lists two active clinics", () => {
    const { clinics } = tools.getAllClinics();
    expect(clinics.map((clinic) => clinic.name)).toEqual(["Heva Clinic", "Dr. Hakan Clinic"]);
    expect(clinics.map((clinic) => clinic.slug)).toEqual(["heva", "dr-hakan"]);
  });

  it("resolves a clinic by exact name, partial name, or id", () => {
    expect(tools.getClinicPackages({ clinicName: "Heva Clinic" })?.clinicName).toBe("Heva Clinic");
    expect(tools.getClinicPackages({ clinicName: "heva" })?.clinicName).toBe("Heva Clinic");
    expect(tools.getClinicPackages({ clinicName: "I like Dr. Hakan Clinic best" })?.clinicName).toBe(
      "Dr. Hakan Clinic",
    );
    expect(tools.getClinicPackages({ clinicId: tools.HAKAN_CLINIC_ID })?.clinicName).toBe("Dr. Hakan Clinic");
  });

  it("returns null when it has no data for the arguments", () => {
    expect(tools.getClinicPackages({ clinicName: "Unknown Clinic" })).toBeNull();
    expect(tools.getClinicPackages({})).toBeNull();
    expect(tools.getClinicDoctors({ clinicId: "not-an-id" })).toBeNull();
    expect(tools.getPaymentLink({ type: "checkout", clinicId: "not-an-id" })).toBeNull();
    expect(tools.getPaymentLink({ type: "something-else" })).toBeNull();
    expect(tools.updateUserClinicPreferences({ clinicSelection: { selectedClinicId: "not-an-id" } })).toBeNull();
  });

  it("returns each clinic's packages with price and deposit", () => {
    const heva = tools.getClinicPackages({ clinicId: tools.HEVA_CLINIC_ID });
    expect(heva?.packages.map((pkg) => [pkg.name, pkg.basePrice, pkg.depositAmount, pkg.currency])).toEqual([
      ["Silver", 3000, 500, "USD"],
      ["Gold", 4500, 600, "USD"],
    ]);

    const hakan = tools.getClinicPackages({ clinicId: tools.HAKAN_CLINIC_ID });
    expect(hakan?.packages.map((pkg) => [pkg.name, pkg.basePrice, pkg.depositAmount, pkg.currency])).toEqual([
      ["Sapphire", 3200, 500, "USD"],
    ]);
  });

  it("returns one doctor per clinic", () => {
    expect(tools.getClinicDoctors({ clinicName: "Heva" })?.doctors.map((doctor) => doctor.name)).toEqual(["Dr. Sibel"]);
    expect(tools.getClinicDoctors({ clinicName: "Hakan" })?.doctors.map((doctor) => doctor.name)).toEqual(["Dr. Hakan"]);
  });

  it("builds a payment link for a package and a checkout link for a clinic", () => {
    const [silver] = tools.PACKAGES;
    const payment = tools.getPaymentLink({ type: "payment", clinicPackageId: silver?.id });
    expect(payment).toMatchObject({ status: "ready", linkType: "payment", clinicPackageName: "Silver" });
    expect(payment?.url).toBe(`https://www.doctours.com/payment/${silver?.id}`);

    const checkout = tools.getPaymentLink({ type: "checkout", clinicId: tools.HEVA_CLINIC_ID });
    expect(checkout).toMatchObject({ status: "ready", linkType: "checkout", clinicName: "Heva Clinic" });
    expect(checkout?.url).toBe("https://www.doctours.com/clinic/heva/checkout");
  });

  it("reports a missing package id instead of inventing a link", () => {
    expect(tools.getPaymentLink({ type: "payment" })).toMatchObject({ status: "missing_input", url: null });
  });

  it("returns the assessment link, no consultation on file, and all five photos", () => {
    expect(tools.getLatestAssessment({})).toMatchObject({ hasAssessment: true, shareStatus: "available" });
    expect(tools.getLatestAssessment({}).assessmentUrl).toMatch(/^https:\/\/www\.doctours\.com\/assessment\//);
    expect(tools.getConsultationRescheduleLink({})).toMatchObject({ status: "no_consultation", url: null });
    expect(tools.getPatientImages({})).toMatchObject({ allAnglesUploaded: true, imageCount: 5, missingAngles: [] });
  });

  it("saves a clinic selection when the id is one a tool returned", () => {
    const saved = tools.updateUserClinicPreferences({ clinicSelection: { selectedClinicId: tools.HEVA_CLINIC_ID } });
    expect(saved).toMatchObject({ updated: true, clinicSelection: { selectedClinicId: tools.HEVA_CLINIC_ID } });
  });

  it("reports no promo and a name already on file", () => {
    expect(tools.issuePromoCode({})).toMatchObject({ status: "not_on_list", code: null });
    expect(tools.updateUser({ firstName: "Jordan" })).toMatchObject({ updated: false, reason: "name_already_set" });
  });
});
