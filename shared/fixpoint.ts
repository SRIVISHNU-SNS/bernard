export type SafetyLevel = "green" | "amber" | "red";
export type Difficulty = "easy" | "moderate" | "advanced" | "professional_only";

export type ProbableCause = {
  cause: string;
  confidence: number;
  explanation: string;
};

export type SafetyFlag = {
  level: SafetyLevel;
  reason: string;
};

export type PartNeeded = {
  name: string;
  likely_part_number: string | null;
  notes: string;
};

export type RepairStep = {
  title: string;
  detail: string;
  caution: string | null;
};

export type DiagnosisResult = {
  probable_causes: ProbableCause[];
  safety_flag: SafetyFlag;
  difficulty: Difficulty;
  estimated_cost_range: {
    low: number;
    high: number;
    currency: string;
  };
  estimated_time_minutes: number;
  tools_needed: string[];
  parts_needed: PartNeeded[];
  repair_steps: RepairStep[];
};

export type StoredDiagnosis = DiagnosisResult & {
  id: number;
  applianceType: string;
  modelNumber: string | null;
  notes: string | null;
  completedSteps: number[];
};

export type NameplateDetails = {
  appliance_type: string | null;
  brand: string | null;
  model_number: string | null;
  serial_number: string | null;
  confidence: number;
};

export const MAX_VIDEO_SECONDS = 30;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export const applianceOptions = [
  "Refrigerator",
  "Washing machine",
  "Dishwasher",
  "Dryer",
  "Oven / range",
  "Microwave",
  "Water heater",
  "Other appliance",
] as const;

export function matchApplianceType(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (/(refrigerator|fridge|freezer|ice maker|wine cooler)/.test(normalized)) return "Refrigerator";
  if (/(dishwasher|dish washer)/.test(normalized)) return "Dishwasher";
  if (/(^| )(washer|washing machine|laundry washer)( |$)/.test(normalized)) return "Washing machine";
  if (/(dryer|tumble dryer|clothes dryer)/.test(normalized)) return "Dryer";
  if (/(oven|range|stove|cooktop|hob|cooker)/.test(normalized)) return "Oven / range";
  if (/(microwave|convection oven)/.test(normalized)) return "Microwave";
  if (/(water heater|boiler|hot water tank)/.test(normalized)) return "Water heater";
  if (applianceOptions.some(option => option.toLowerCase() === normalized)) return value;
  return null;
}

export function safetyLabel(level: SafetyLevel) {
  if (level === "red") return "Don’t try this yourself";
  if (level === "amber") return "Only continue if you feel confident";
  return "Looks safe to try";
}

export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

export function partSearchUrl(part: PartNeeded) {
  const query = encodeURIComponent(`${part.name} ${part.likely_part_number ?? ""}`.trim());
  return `https://www.google.com/search?q=${query}+appliance+part`;
}

export function normalizeNameplate(value: unknown): NameplateDetails | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.confidence !== "number") return null;
  return {
    appliance_type: typeof candidate.appliance_type === "string" ? candidate.appliance_type : null,
    brand: typeof candidate.brand === "string" ? candidate.brand : null,
    model_number: typeof candidate.model_number === "string" ? candidate.model_number : null,
    serial_number: typeof candidate.serial_number === "string" ? candidate.serial_number : null,
    confidence: Math.max(0, Math.min(100, Math.round(candidate.confidence))),
  };
}

export function isSafetyLevel(value: unknown): value is SafetyLevel {
  return value === "green" || value === "amber" || value === "red";
}

export function normalizeDiagnosis(value: unknown): DiagnosisResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const causes = Array.isArray(candidate.probable_causes) ? candidate.probable_causes : [];
  const safety = candidate.safety_flag as Record<string, unknown> | undefined;
  const costs = candidate.estimated_cost_range as Record<string, unknown> | undefined;
  const tools = Array.isArray(candidate.tools_needed) ? candidate.tools_needed : [];
  const parts = Array.isArray(candidate.parts_needed) ? candidate.parts_needed : [];
  const steps = Array.isArray(candidate.repair_steps) ? candidate.repair_steps : [];

  if (!safety || !isSafetyLevel(safety.level) || typeof safety.reason !== "string") return null;
  if (!costs || typeof costs.low !== "number" || typeof costs.high !== "number" || typeof costs.currency !== "string") return null;
  if (typeof candidate.difficulty !== "string" || typeof candidate.estimated_time_minutes !== "number") return null;

  return {
    probable_causes: causes
      .filter(item => item && typeof item === "object")
      .map(item => item as Record<string, unknown>)
      .filter(item => typeof item.cause === "string" && typeof item.confidence === "number" && typeof item.explanation === "string")
      .map(item => ({
        cause: item.cause as string,
        confidence: Math.max(0, Math.min(100, Math.round(item.confidence as number))),
        explanation: item.explanation as string,
      }))
      .slice(0, 5),
    safety_flag: { level: safety.level, reason: safety.reason },
    difficulty: candidate.difficulty as Difficulty,
    estimated_cost_range: {
      low: Math.max(0, Math.round(costs.low as number)),
      high: Math.max(0, Math.round(costs.high as number)),
      currency: costs.currency as string,
    },
    estimated_time_minutes: Math.max(1, Math.round(candidate.estimated_time_minutes as number)),
    tools_needed: tools.filter(item => typeof item === "string").slice(0, 12) as string[],
    parts_needed: parts
      .filter(item => item && typeof item === "object")
      .map(item => item as Record<string, unknown>)
      .filter(item => typeof item.name === "string" && typeof item.notes === "string")
      .map(item => ({
        name: item.name as string,
        likely_part_number: typeof item.likely_part_number === "string" ? item.likely_part_number : null,
        notes: item.notes as string,
      }))
      .slice(0, 12),
    repair_steps: steps
      .filter(item => item && typeof item === "object")
      .map(item => item as Record<string, unknown>)
      .filter(item => typeof item.title === "string" && typeof item.detail === "string")
      .map(item => ({
        title: item.title as string,
        detail: item.detail as string,
        caution: typeof item.caution === "string" ? item.caution : null,
      }))
      .slice(0, 20),
  };
}

export function safetyGate(result: DiagnosisResult): DiagnosisResult {
  const serialized = JSON.stringify(result).toLowerCase();
  const hardStopPattern = /(gas\s+line|gas leak|refrigerant|sealed refrigeration|high[- ]voltage|exposed voltage|live wire|mains voltage)/i;
  if (!hardStopPattern.test(serialized)) return result;

  return {
    ...result,
    safety_flag: {
      level: "red",
      reason: "This diagnosis may involve gas, refrigerant, sealed refrigeration, or exposed high-voltage components. Do not open or repair it yourself; a qualified appliance professional should assess it.",
    },
    difficulty: "professional_only",
    repair_steps: [],
  };
}

export const diagnosisJsonSchema = {
  name: "fixpoint_diagnosis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      probable_causes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            cause: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 100 },
            explanation: { type: "string" },
          },
          required: ["cause", "confidence", "explanation"],
        },
      },
      safety_flag: {
        type: "object",
        additionalProperties: false,
        properties: {
          level: { type: "string", enum: ["green", "amber", "red"] },
          reason: { type: "string" },
        },
        required: ["level", "reason"],
      },
      difficulty: { type: "string", enum: ["easy", "moderate", "advanced", "professional_only"] },
      estimated_cost_range: {
        type: "object",
        additionalProperties: false,
        properties: {
          low: { type: "number" },
          high: { type: "number" },
          currency: { type: "string" },
        },
        required: ["low", "high", "currency"],
      },
      estimated_time_minutes: { type: "number" },
      tools_needed: { type: "array", items: { type: "string" } },
      parts_needed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            likely_part_number: { type: ["string", "null"] },
            notes: { type: "string" },
          },
          required: ["name", "likely_part_number", "notes"],
        },
      },
      repair_steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            caution: { type: ["string", "null"] },
          },
          required: ["title", "detail", "caution"],
        },
      },
    },
    required: ["probable_causes", "safety_flag", "difficulty", "estimated_cost_range", "estimated_time_minutes", "tools_needed", "parts_needed", "repair_steps"],
  },
} as const;

export const nameplateJsonSchema = {
  name: "fixpoint_nameplate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      appliance_type: { type: ["string", "null"] },
      brand: { type: ["string", "null"] },
      model_number: { type: ["string", "null"] },
      serial_number: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 100 },
    },
    required: ["appliance_type", "brand", "model_number", "serial_number", "confidence"],
  },
} as const;
