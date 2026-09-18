import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { diagnosisJsonSchema, errorCodeJsonSchema, matchApplianceType, nameplateJsonSchema, normalizeDiagnosis, normalizeNameplate, safetyGate, type DiagnosisResult } from "@shared/fixpoint";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { createDiagnosis, getLatestDiagnosis, updateDiagnosisProgress } from "./db";
import { storageGetSignedUrl } from "./storage";

const diagnosisInput = z.object({
  sessionId: z.string().min(8).max(80),
  applianceType: z.string().min(2).max(120).default("Auto-detect"),
  modelNumber: z.string().max(160).optional(),
  notes: z.string().max(1000).optional(),
  fileKey: z.string().min(1).max(500),
  fileMime: z.string().min(1).max(120),
  evidenceKeys: z.array(z.string().min(1).max(500)).max(4).optional(),
  frameKey: z.string().min(1).max(500).optional(),
  nameplateKey: z.string().min(1).max(500).optional(),
});

function readContent(response: Awaited<ReturnType<typeof invokeLLM>>) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
}

function parseStructuredJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  if (!cleaned) throw new Error("The diagnosis model returned an empty response.");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The diagnosis model returned an incomplete response.");
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new Error("The diagnosis model returned invalid JSON.");
  }
}

type DiagnosisImagePart =
  | { type: "file_url"; file_url: { url: string; mime_type: "video/mp4" } }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

async function requestDiagnosis(input: z.infer<typeof diagnosisInput>, signedImageUrls: string[], signedNameplateUrl?: string, includeVideo = true) {
  const primaryUrl = signedImageUrls[0];
  const imageParts: DiagnosisImagePart[] = input.fileMime.startsWith("video/")
    ? includeVideo
      ? [{ type: "file_url" as const, file_url: { url: primaryUrl, mime_type: "video/mp4" as const } }]
      : input.frameKey
        ? [{ type: "image_url" as const, image_url: { url: input.frameKey, detail: "high" as const } }]
        : []
    : signedImageUrls.map(url => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } }));
  if (input.fileMime.startsWith("video/") && signedImageUrls.length > 1) {
    imageParts.push(...signedImageUrls.slice(1).map(url => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })));
  }
  if (input.frameKey && !(input.fileMime.startsWith("video/") && !includeVideo)) {
    imageParts.push({ type: "image_url" as const, image_url: { url: input.frameKey, detail: "high" as const } });
  }
  if (signedNameplateUrl) imageParts.push({ type: "image_url" as const, image_url: { url: signedNameplateUrl, detail: "high" as const } });
  const response = await invokeLLM({
    model: "claude-sonnet-4-6",
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [
      {
        role: "system",
              content: `You are Bernard, a careful device diagnostic assistant. Analyze all supplied evidence images together for any household appliance, personal electronic, entertainment device, or other consumer hardware and return only the requested JSON schema. Automatically identify the device category from the evidence; never ask the user to choose it. Return detected_device_type as one concise category such as Refrigerator, Washing machine, Dishwasher, Dryer, Oven / range, Microwave, Water heater, Air conditioner, Coffee maker, Television, Laptop, Phone, Headphones, Tablet, Camera, Game console, Vacuum, or Other device. The images may show the full device, the problem area, a model label, or an error-code display. Explain the likely problem in plain language for a non-technical person. If a visible display shows an error code, populate error_code with the exact code and a short plain-language meaning; otherwise return error_code as null. Estimate repair cost in Indian rupees and set estimated_cost_range.currency to INR. Never invent a model-specific part number; use null when uncertain. Confidence is a calibrated estimate, not a promise. Any issue involving gas lines, refrigerant, sealed refrigeration systems, exposed mains voltage, swollen batteries, burning, smoke, or liquid near powered electronics MUST use safety_flag.level = red, explain the danger plainly, and return an empty repair_steps array. Do not provide DIY steps for those issues even if the user asks. For amber issues, include concise caution text on the affected steps.`,
      },
      {
        role: "user",
        content: [
          ...imageParts,
          {
            type: "text",
            text: `Device type hint: automatic detection required\nModel number: ${input.modelNumber || "Not provided"}\nEvidence order: ${signedImageUrls.map((_, index) => `${index + 1}`).join(", ")}\nUser notes: ${input.notes || "None"}\n\nReturn a ranked, useful diagnosis for this exact evidence.`,
          },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: diagnosisJsonSchema },
    maxTokens: 2400,
  });
  const parsed = normalizeDiagnosis(parseStructuredJson<unknown>(readContent(response)));
  if (!parsed) throw new Error("The diagnosis response did not match the required safety contract.");
  return safetyGate(parsed);
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  diagnosis: router({
    latest: publicProcedure
      .input(z.object({ sessionId: z.string().min(8).max(80) }))
      .query(async ({ input }) => {
        const row = await getLatestDiagnosis(input.sessionId);
        if (!row) return null;
        const diagnosis = normalizeDiagnosis(JSON.parse(row.diagnosisJson));
        if (!diagnosis) return null;
        let completedSteps: number[] = [];
        try {
          completedSteps = JSON.parse(row.repairProgress || "[]");
        } catch {
          completedSteps = [];
        }
        return { ...diagnosis, id: row.id, applianceType: row.applianceType, modelNumber: row.modelNumber, notes: row.notes, completedSteps };
      }),
    diagnose: publicProcedure.input(diagnosisInput).mutation(async ({ input, ctx }) => {
      const signedImageUrls = await Promise.all([input.fileKey, ...(input.evidenceKeys ?? [])].slice(0, 4).map(key => storageGetSignedUrl(key)));
      const signedNameplateUrl = input.nameplateKey ? await storageGetSignedUrl(input.nameplateKey) : undefined;
      if (input.frameKey) input.frameKey = await storageGetSignedUrl(input.frameKey);
      let diagnosis: DiagnosisResult;
      try {
        diagnosis = await requestDiagnosis(input, signedImageUrls, signedNameplateUrl);
      } catch (firstError) {
        console.warn("[Bernard] Diagnosis retry after malformed or unavailable response", firstError);
        diagnosis = await requestDiagnosis(input, signedImageUrls, signedNameplateUrl, false);
      }
      const detectedType = matchApplianceType(diagnosis.detected_device_type) ?? "Other device";
      const id = await createDiagnosis({
        userId: ctx.user?.id,
        sessionId: input.sessionId,
        applianceType: detectedType,
        modelNumber: input.modelNumber,
        notes: input.notes,
        diagnosisJson: JSON.stringify(diagnosis),
      });
      return { ...diagnosis, id, applianceType: detectedType, modelNumber: input.modelNumber ?? null, notes: input.notes ?? null, completedSteps: [] };
    }),
    ocrNameplate: publicProcedure
      .input(z.object({ fileKey: z.string().min(1).max(500) }))
      .mutation(async ({ input }) => {
        const imageUrl = await storageGetSignedUrl(input.fileKey);
        const response = await invokeLLM({
          model: "claude-sonnet-4-6",
          messages: [
            {
              role: "system",
              content: "Read this device label carefully. Return only the requested JSON. Look for common labels such as Model, Mod., Type, E-Nr, PNC, Service No., Serial, S/N, IMEI, FCC ID, or Seriennummer, even when the label is not in English. Transcribe model and serial characters exactly when legible; use null when a value cannot be read. Do not infer a model number from a partial character sequence. Normalize the device type into a plain category such as refrigerator, washing machine, dryer, oven, phone, laptop, headphones, tablet, television, camera, game console, coffee maker, air conditioner, or other device.",
            },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
                { type: "text", text: "Extract the device type, brand, model number, serial number, and your confidence in the read." },
              ],
            },
          ],
          response_format: { type: "json_schema", json_schema: nameplateJsonSchema },
          maxTokens: 400,
        });
        const content = response.choices?.[0]?.message?.content;
        const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
        const details = normalizeNameplate(parseStructuredJson<unknown>(raw));
        if (!details) throw new Error("The nameplate could not be read clearly.");
        return details;
      }),
    readErrorCode: publicProcedure
      .input(z.object({ fileKey: z.string().min(1).max(500) }))
      .mutation(async ({ input }) => {
        const imageUrl = await storageGetSignedUrl(input.fileKey);
        const response = await invokeLLM({
          model: "claude-sonnet-4-6",
          messages: [
            { role: "system", content: "Read the device display in this image. Return only JSON. Find an exact visible error or fault code such as E15, F21, 4C, OE, 0x80070057, or a similar code. Do not guess from a blurry screen. If there is no clear code, return code and meaning as null." },
            { role: "user", content: [{ type: "image_url", image_url: { url: imageUrl, detail: "high" } }, { type: "text", text: "Extract the exact code, explain it in one short sentence for a non-technical person, and give confidence from 0 to 100." }] },
          ],
          response_format: { type: "json_schema", json_schema: errorCodeJsonSchema },
          maxTokens: 240,
        });
        const raw = readContent(response);
        const value = parseStructuredJson<{ code: string | null; meaning: string | null; confidence: number }>(raw);
        if (!value.code || !value.meaning) return null;
        return { code: value.code.trim(), meaning: value.meaning.trim(), confidence: Math.max(0, Math.min(100, Math.round(value.confidence))) };
      }),
    updateProgress: publicProcedure
      .input(z.object({ diagnosisId: z.number().int().nonnegative(), sessionId: z.string().min(8).max(80), completedSteps: z.array(z.number().int().nonnegative()).max(50) }))
      .mutation(async ({ input }) => {
        if (input.diagnosisId > 0) await updateDiagnosisProgress({ id: input.diagnosisId, sessionId: input.sessionId, completedSteps: input.completedSteps });
        return { success: true, completedSteps: input.completedSteps } as const;
      }),
  }),
});

export type AppRouter = typeof appRouter;
