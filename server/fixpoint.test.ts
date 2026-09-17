import { describe, expect, it } from "vitest";
import { formatInrRange, matchApplianceType, normalizeDiagnosis, normalizeNameplate, safetyGate, type DiagnosisResult } from "@shared/fixpoint";

const baseResult: DiagnosisResult = {
  probable_causes: [{ cause: "Compressor issue", confidence: 72, explanation: "The unit is running but not cooling." }],
  safety_flag: { level: "green", reason: "No hard-stop hazard found in the visible evidence." },
  difficulty: "moderate",
  estimated_cost_range: { low: 40, high: 180, currency: "USD" },
  estimated_time_minutes: 45,
  tools_needed: ["Phillips screwdriver"],
  parts_needed: [{ name: "Start relay", likely_part_number: null, notes: "Confirm against the model plate." }],
  repair_steps: [{ title: "Unplug the appliance", detail: "Disconnect power before inspecting the component.", caution: null }],
  error_code: null,
};

describe("Fixpoint safety gate", () => {
  it("forces red and removes DIY steps for refrigerant hazards", () => {
    const result = safetyGate({
      ...baseResult,
      probable_causes: [{ cause: "Refrigerant leak in sealed system", confidence: 80, explanation: "Cooling is weak and the sealed system may be compromised." }],
    });
    expect(result.safety_flag.level).toBe("red");
    expect(result.difficulty).toBe("professional_only");
    expect(result.repair_steps).toEqual([]);
  });

  it("preserves ordinary green diagnoses", () => {
    const result = safetyGate(baseResult);
    expect(result.safety_flag.level).toBe("green");
    expect(result.repair_steps).toHaveLength(1);
  });
});

describe("Bernard nameplate OCR", () => {
  it("normalizes extracted model and serial details", () => {
    const result = normalizeNameplate({
      appliance_type: "Refrigerator",
      brand: "Northstar",
      model_number: "RF28T5001SR",
      serial_number: "1A2B3C4D",
      confidence: 108,
    });
    expect(result).toEqual({
      appliance_type: "Refrigerator",
      brand: "Northstar",
      model_number: "RF28T5001SR",
      serial_number: "1A2B3C4D",
      confidence: 100,
    });
  });

  it("matches common appliance synonyms to the product categories", () => {
    expect(matchApplianceType("Front Load Washer")).toBe("Washing machine");
    expect(matchApplianceType("Réfrigérateur / Freezer")).toBe("Refrigerator");
    expect(matchApplianceType("Built-in gas range")).toBe("Oven / range");
    expect(matchApplianceType("E-Nr dishwasher")).toBe("Dishwasher");
    expect(matchApplianceType("iPhone 15 Pro")).toBe("Phone");
    expect(matchApplianceType("MacBook Air")).toBe("Laptop");
    expect(matchApplianceType("Bluetooth earbuds")).toBe("Headphones");
    expect(matchApplianceType("unknown hardware")).toBeNull();
  });
});

describe("Bernard local pricing", () => {
  it("formats INR estimates for Indian users", () => {
    expect(formatInrRange({ low: 1200, high: 4500, currency: "INR" })).toBe("₹1,200–₹4,500");
  });
});

describe("Bernard error-code results", () => {
  it("keeps a clear code and meaning while clamping confidence", () => {
    const result = normalizeDiagnosis({
      probable_causes: [],
      safety_flag: { level: "green", reason: "Looks safe." },
      difficulty: "moderate",
      estimated_cost_range: { low: 1000, high: 2000, currency: "INR" },
      estimated_time_minutes: 30,
      tools_needed: [],
      parts_needed: [],
      repair_steps: [],
      error_code: { code: "E15", meaning: "Water was detected where it should not be.", confidence: 120 },
    });
    expect(result?.error_code).toEqual({ code: "E15", meaning: "Water was detected where it should not be.", confidence: 100 });
  });
});
