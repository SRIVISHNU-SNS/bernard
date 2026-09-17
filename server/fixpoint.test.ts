import { describe, expect, it } from "vitest";
import { normalizeNameplate, safetyGate, type DiagnosisResult } from "@shared/fixpoint";

const baseResult: DiagnosisResult = {
  probable_causes: [{ cause: "Compressor issue", confidence: 72, explanation: "The unit is running but not cooling." }],
  safety_flag: { level: "green", reason: "No hard-stop hazard found in the visible evidence." },
  difficulty: "moderate",
  estimated_cost_range: { low: 40, high: 180, currency: "USD" },
  estimated_time_minutes: 45,
  tools_needed: ["Phillips screwdriver"],
  parts_needed: [{ name: "Start relay", likely_part_number: null, notes: "Confirm against the model plate." }],
  repair_steps: [{ title: "Unplug the appliance", detail: "Disconnect power before inspecting the component.", caution: null }],
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
});
