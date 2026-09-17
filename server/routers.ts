import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { diagnosisJsonSchema, nameplateJsonSchema, normalizeDiagnosis, normalizeNameplate, safetyGate, type DiagnosisResult } from "@shared/fixpoint";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { createDiagnosis, getLatestDiagnosis, updateDiagnosisProgress } from "./db";
import { storageGetSignedUrl } from "./storage";

const diagnosisInput = z.object({
  sessionId: z.string().min(8).max(80),
  applianceType: z.string().min(2).max(120),
  modelNumber: z.string().max(160).optional(),
  notes: z.string().max(1000).optional(),
  fileKey: z.string().min(1).max(500),
  fileMime: z.string().min(1).max(120),
  frameKey: z.string().min(1).max(500).optional(),
  nameplateKey: z.string().min(1).max(500).optional(),
});

function readContent(response: Awaited<ReturnType<typeof invokeLLM>>) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
}

async function requestDiagnosis(input: z.infer<typeof diagnosisInput>, signedImageUrl: string, signedNameplateUrl?: string) {
  const imageParts = [
    ...(input.fileMime.startsWith("video/")
      ? [{ type: "file_url" as const, file_url: { url: signedImageUrl, mime_type: "video/mp4" as const } }]
      : [{ type: "image_url" as const, image_url: { url: signedImageUrl, detail: "high" as const } }]),
    ...(input.frameKey ? [{ type: "image_url" as const, image_url: { url: input.frameKey, detail: "high" as const } }] : []),
    ...(signedNameplateUrl ? [{ type: "image_url" as const, image_url: { url: signedNameplateUrl, detail: "high" as const } }] : []),
  ];
  const response = await invokeLLM({
    model: "claude-sonnet-4-6",
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [
      {
        role: "system",
              content: `You are Bernard, a careful device diagnostic assistant. Analyze the supplied evidence for any household appliance, personal electronic, entertainment device, or other consumer hardware and return only the requested JSON schema. Explain the likely problem in plain language for a non-technical person. Never invent a model-specific part number; use null when uncertain. Confidence is a calibrated estimate, not a promise. Any issue involving gas lines, refrigerant, sealed refrigeration systems, exposed mains voltage, swollen batteries, burning, smoke, or liquid near powered electronics MUST use safety_flag.level = red, explain the danger plainly, and return an empty repair_steps array. Do not provide DIY steps for those issues even if the user asks. For amber issues, include concise caution text on the affected steps.`,
      },
      {
        role: "user",
        content: [
          ...imageParts,
          {
            type: "text",
            text: `Device type: ${input.applianceType}\nModel number: ${input.modelNumber || "Not provided"}\nUser notes: ${input.notes || "None"}\n\nReturn a ranked, useful diagnosis for this exact evidence.`,
          },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: diagnosisJsonSchema },
    maxTokens: 2400,
  });
  const parsed = normalizeDiagnosis(JSON.parse(readContent(response)));
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
      const signedImageUrl = await storageGetSignedUrl(input.fileKey);
      const signedNameplateUrl = input.nameplateKey ? await storageGetSignedUrl(input.nameplateKey) : undefined;
      if (input.frameKey) input.frameKey = await storageGetSignedUrl(input.frameKey);
      let diagnosis: DiagnosisResult;
      try {
        diagnosis = await requestDiagnosis(input, signedImageUrl, signedNameplateUrl);
      } catch (firstError) {
        console.warn("[Fixpoint] Diagnosis retry after malformed or unavailable response", firstError);
        diagnosis = await requestDiagnosis(input, signedImageUrl, signedNameplateUrl);
      }
      const id = await createDiagnosis({
        userId: ctx.user?.id,
        sessionId: input.sessionId,
        applianceType: input.applianceType,
        modelNumber: input.modelNumber,
        notes: input.notes,
        diagnosisJson: JSON.stringify(diagnosis),
      });
      return { ...diagnosis, id, applianceType: input.applianceType, modelNumber: input.modelNumber ?? null, notes: input.notes ?? null, completedSteps: [] };
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
                { type: "text", text: "Extract the appliance type, brand, model number, serial number, and your confidence in the read." },
              ],
            },
          ],
          response_format: { type: "json_schema", json_schema: nameplateJsonSchema },
          maxTokens: 400,
        });
        const content = response.choices?.[0]?.message?.content;
        const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
        const details = normalizeNameplate(JSON.parse(raw));
        if (!details) throw new Error("The nameplate could not be read clearly.");
        return details;
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
