import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileImage,
  FileVideo,
  LockKeyhole,
  Loader2,
  Paperclip,
  Plus,
  Printer,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wrench,
  X,
} from "lucide-react";
import {
  applianceOptions,
  formatDuration,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  partSearchUrl,
  safetyLabel,
  type DiagnosisResult,
  type StoredDiagnosis,
} from "@shared/fixpoint";

const stages = ["Evidence", "Diagnosis", "Guided fix"] as const;
type PipelineState = "idle" | "analyzing" | "results";

type UploadRef = { key: string; url: string };

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function readVideoDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This video could not be read."));
    };
    video.src = url;
  });
}

function extractVideoFrame(file: File) {
  return new Promise<Blob>((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.muted = true;
    video.onloadeddata = () => {
      video.currentTime = Math.min(1, Math.max(0, video.duration / 3));
    };
    video.onseeked = () => {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error("A representative frame could not be extracted."));
      }, "image/jpeg", .88);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This video could not be read."));
    };
    video.src = url;
  });
}

async function uploadFile(file: File, fileName = file.name): Promise<UploadRef> {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: await fileToDataUrl(file), fileName, mimeType: file.type }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The file could not be uploaded.");
  return payload as UploadRef;
}

function validateFile(file: File, allowVideo = true) {
  if (file.type.startsWith("image/") && file.size <= MAX_IMAGE_BYTES) return null;
  if (allowVideo && file.type.startsWith("video/") && file.size <= MAX_VIDEO_BYTES) return null;
  if (!file.type.startsWith("image/") && !(allowVideo && file.type.startsWith("video/"))) return "Use a photo or a short video of the appliance.";
  return `This file is larger than the ${file.type.startsWith("video/") ? "80 MB" : "10 MB"} limit.`;
}

function StatusChip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blue" | "safe" | "caution" | "danger" }) {
  const toneClass = {
    neutral: "border-[var(--border)] bg-white text-[var(--muted)]",
    blue: "border-[#BCD0FF] bg-[#F3F6FF] text-[var(--signal)]",
    safe: "border-[#B7E5D0] bg-[#F1FBF6] text-[var(--safe)]",
    caution: "border-[#F0D9A6] bg-[#FFF9EA] text-[#8E6110]",
    danger: "border-[#F0BABA] bg-[#FFF4F4] text-[var(--danger)]",
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] font-display font-semibold ${toneClass}`}>{children}</span>;
}

function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="mb-1 text-[13px] font-display font-semibold text-[var(--muted)]">{eyebrow}</div>
        <h2 className="font-display text-[26px] font-semibold tracking-[-.03em]">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function UploadPanel({ onAnalyze }: { onAnalyze: (payload: { file: File; nameplate: File | null; applianceType: string; modelNumber: string; notes: string }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [nameplate, setNameplate] = useState<File | null>(null);
  const [applianceType, setApplianceType] = useState("Refrigerator");
  const [modelNumber, setModelNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const [ocrStatus, setOcrStatus] = useState<"idle" | "reading" | "done" | "error">("idle");
  const [brand, setBrand] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const ocrMutation = trpc.diagnosis.ocrNameplate.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const nameplateRef = useRef<HTMLInputElement>(null);

  const pickFile = async (candidate: File | null) => {
    if (!candidate) return;
    const validationError = validateFile(candidate);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (candidate.type.startsWith("video/")) {
      try {
        const duration = await readVideoDuration(candidate);
        if (duration > MAX_VIDEO_SECONDS) {
          setError(`Keep the video under ${MAX_VIDEO_SECONDS} seconds so the diagnosis stays focused.`);
          return;
        }
      } catch (videoError) {
        setError(videoError instanceof Error ? videoError.message : "This video could not be read.");
        return;
      }
    }
    setError("");
    setFile(candidate);
  };

  const pickNameplate = async (candidate: File | null) => {
    if (!candidate) return;
    if (!candidate.type.startsWith("image/")) {
      setError("The nameplate image needs to be a photo.");
      return;
    }
    if (candidate.size > MAX_IMAGE_BYTES) {
      setError("The nameplate image is larger than the 10 MB limit.");
      return;
    }
    setNameplate(candidate);
    setError("");
    setOcrStatus("reading");
    try {
      const uploaded = await uploadFile(candidate, `nameplate-${candidate.name}`);
      const details = await ocrMutation.mutateAsync({ fileKey: uploaded.key });
      if (details.appliance_type) {
        const match = applianceOptions.find(option => option.toLowerCase() === details.appliance_type?.toLowerCase());
        if (match) setApplianceType(match);
      }
      if (details.model_number) setModelNumber(details.model_number);
      if (details.brand) setBrand(details.brand);
      if (details.serial_number) setSerialNumber(details.serial_number);
      setOcrStatus("done");
    } catch {
      setOcrStatus("error");
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload appliance photo or video"
        className={`group relative flex min-h-[330px] cursor-pointer flex-col items-center justify-center border-2 border-dashed px-5 text-center transition-colors ${dragActive ? "border-[var(--signal)] bg-[#F5F8FF]" : "border-[#B8C0C9] bg-[var(--surface-alt)] hover:border-[var(--signal)] hover:bg-[#F8FAFF]"}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
        onDragOver={event => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={event => { event.preventDefault(); setDragActive(false); void pickFile(event.dataTransfer.files?.[0] ?? null); }}
      >
        <input ref={inputRef} type="file" accept="image/*,video/*" capture="environment" className="hidden" onChange={event => void pickFile(event.target.files?.[0] ?? null)} />
        <div className="mb-5 flex h-14 w-14 items-center justify-center border border-[#B8C0C9] bg-white text-[var(--signal)]">
          {file?.type.startsWith("video/") ? <FileVideo size={26} strokeWidth={1.7} /> : <UploadCloud size={27} strokeWidth={1.7} />}
        </div>
        {file ? (
          <>
            <div className="font-display text-[17px] font-semibold">{file.name}</div>
            <div className="mt-1 text-[15px] text-[var(--muted)]">{file.type.startsWith("video/") ? "Video ready · under 30 seconds" : "Photo ready for analysis"}</div>
            <button type="button" className="mt-4 font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4" onClick={event => { event.stopPropagation(); setFile(null); }}>Choose a different file</button>
          </>
        ) : (
          <>
            <div className="font-display text-[20px] font-semibold">Drop a photo or short video here</div>
            <div className="mt-2 max-w-[360px] text-[15px] leading-6 text-[var(--muted)]">Show the problem clearly. A close-up of the leak, noise source, or damaged area helps most.</div>
            <div className="mt-5 flex flex-wrap justify-center gap-2 text-[13px] text-[var(--muted)]"><StatusChip><FileImage size={14} />Photo · 10 MB</StatusChip><StatusChip><FileVideo size={14} />Video · 30 sec</StatusChip></div>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
        <div className="border border-[var(--border)] bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-display text-[14px] font-semibold"><Paperclip size={15} className="text-[var(--signal)]" /> Optional model / serial plate</div>
            <div className="mt-1 max-w-[320px] text-[14px] leading-5 text-[var(--muted)]">We’ll read the model and serial details for you.</div>
            </div>
            <button type="button" className="border border-[var(--border)] p-2 text-[var(--signal)] hover:border-[var(--signal)]" aria-label="Add model plate photo" onClick={() => nameplateRef.current?.click()}><Plus size={16} /></button>
            <input ref={nameplateRef} type="file" accept="image/*" className="hidden" onChange={event => pickNameplate(event.target.files?.[0] ?? null)} />
          </div>
          {nameplate && <div className="mt-3 bg-[var(--surface-alt)] px-3 py-2 text-[13px]"><div className="flex items-center justify-between"><span className="truncate font-mono-data">{nameplate.name}</span><button type="button" onClick={() => { setNameplate(null); setOcrStatus("idle"); setBrand(""); setSerialNumber(""); }} aria-label="Remove model plate photo"><X size={15} /></button></div><div className="mt-1 text-[var(--muted)]">{ocrStatus === "reading" ? "Reading the plate…" : ocrStatus === "done" ? `Details added${brand ? ` · ${brand}` : ""}${serialNumber ? ` · serial ${serialNumber}` : ""}` : ocrStatus === "error" ? "Couldn’t read it clearly. You can enter the model below." : "Ready"}</div></div>}
        </div>
        <label className="border border-[var(--border)] bg-white p-4">
          <span className="font-display text-[14px] font-semibold">Anything else you’ve noticed?</span>
          <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} maxLength={1000} placeholder="Sound, smell, when it started…" className="mt-2 w-full resize-none border-0 bg-transparent p-0 text-[15px] placeholder:text-[#9AA2AC] focus:outline-none" />
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
        <label className="block">
          <span className="mb-1.5 block font-display text-[13px] font-semibold">Appliance type</span>
          <select value={applianceType} onChange={event => setApplianceType(event.target.value)} className="h-11 w-full border border-[var(--border)] bg-white px-3 text-[15px] focus:border-[var(--signal)] focus:outline-none">
            {applianceOptions.map(option => <option key={option}>{option}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block font-display text-[13px] font-semibold">Model number <span className="font-body font-normal text-[var(--muted)]">· optional if not in the photo</span></span>
          <input value={modelNumber} onChange={event => setModelNumber(event.target.value)} placeholder="e.g. RF28T5001SR" className="font-mono-data h-11 w-full border border-[var(--border)] bg-white px-3 text-[14px] placeholder:font-body placeholder:text-[#9AA2AC] focus:border-[var(--signal)] focus:outline-none" />
        </label>
      </div>
      {error && <div role="alert" className="mt-4 flex items-start gap-2 border-l-2 border-[var(--danger)] bg-[#FFF4F4] px-3 py-2 text-[14px] leading-5 text-[#8F2D2D]"><AlertTriangle size={17} className="mt-0.5 shrink-0" />{error}</div>}
      <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <Button type="button" disabled={!file} className="h-12 rounded-none bg-[var(--signal)] px-6 font-display text-[14px] font-semibold text-white hover:bg-[#1D4DD8]" onClick={() => file && onAnalyze({ file, nameplate, applianceType, modelNumber, notes })}>Analyze this appliance <ArrowRight size={17} /></Button>
        <div className="flex items-center gap-2 text-[13px] text-[var(--muted)]"><LockKeyhole size={14} /> Photos are processed for this diagnosis, then not shown publicly.</div>
      </div>
    </div>
  );
}

function MiniExample({ label, result, tone }: { label: string; result: string; tone: "safe" | "caution" | "danger" }) {
  return <div className="border border-[var(--border)] bg-white p-4"><div className="mb-4 flex items-center justify-between"><span className="font-mono-data text-[12px] text-[var(--muted)]">{label}</span><StatusChip tone={tone}>{tone === "safe" ? "DIY" : tone === "caution" ? "Caution" : "Pro"}</StatusChip></div><div className="h-1 w-full bg-[var(--surface-alt)]"><div className={`h-1 ${tone === "safe" ? "w-[72%] bg-[var(--safe)]" : tone === "caution" ? "w-[48%] bg-[var(--caution)]" : "w-[23%] bg-[var(--danger)]"}`} /></div><div className="mt-4 font-display text-[15px] font-semibold leading-5">{result}</div><div className="mt-2 text-[13px] text-[var(--muted)]">Cause ranking · safety verdict · next step</div></div>;
}

function AnalyzeState({ currentStage }: { currentStage: number }) {
  const items = ["Reading the image and visible symptoms", "Matching against known failure patterns", "Checking the repair path for safety"]; 
  return <div className="border border-[var(--border)] bg-[var(--surface-alt)] p-6 sm:p-8"><div className="flex items-center gap-3"><Loader2 className="animate-spin text-[var(--signal)]" size={20} /><div className="font-display text-[17px] font-semibold">Building your diagnostic report</div></div><div className="mt-6 space-y-4">{items.map((item, index) => <div key={item} className="flex items-center gap-3 text-[15px] text-[var(--muted)]"><span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[12px] font-display ${index < currentStage ? "border-[var(--signal)] bg-[var(--signal)] text-white" : "border-[#C7CDD4] bg-white"}`}>{index < currentStage ? <Check size={14} /> : index + 1}</span>{item}{index === currentStage && <span className="ml-auto font-mono-data text-[11px] text-[var(--signal)]">IN PROGRESS</span>}</div>)}</div><div className="mt-8 h-1 w-full overflow-hidden bg-white"><div className="h-full w-1/2 animate-pulse bg-[var(--signal)]" /></div><div className="mt-3 text-[13px] text-[var(--muted)]">This state reflects the live diagnosis request. It is not a fixed-duration animation.</div></div>;
}

function SafetyPanel({ diagnosis }: { diagnosis: StoredDiagnosis }) {
  const level = diagnosis.safety_flag.level;
  const tone = level === "green" ? "safe" : level === "amber" ? "caution" : "danger";
  const Icon = level === "green" ? ShieldCheck : AlertTriangle;
  return <div className={`resolve-panel border-l-4 p-5 ${level === "green" ? "border-[var(--safe)] bg-[#F1FBF6]" : level === "amber" ? "border-[var(--caution)] bg-[#FFF9EA]" : "border-[var(--danger)] bg-[#FFF4F4]"}`}><div className="flex items-start gap-4"><Icon size={25} className={level === "green" ? "text-[var(--safe)]" : level === "amber" ? "text-[#8E6110]" : "text-[var(--danger)]"} /><div className="min-w-0"><div className={`font-display text-[13px] font-semibold ${tone === "safe" ? "text-[var(--safe)]" : tone === "caution" ? "text-[#8E6110]" : "text-[var(--danger)]"}`}>SAFETY VERDICT</div><div className="mt-1 font-display text-[20px] font-semibold tracking-[-.02em]">{safetyLabel(level)}</div><p className="mt-2 max-w-[580px] text-[16px] leading-6">{diagnosis.safety_flag.reason}</p></div></div>{level === "red" && <div className="mt-5 flex flex-col gap-3 border-t border-[#E8BABA] pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="text-[14px] text-[#8F2D2D]">Do not remove panels or test live components.</div><a href="https://www.google.com/search?q=appliance+repair+professional" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 border border-[var(--danger)] px-4 py-2 font-display text-[13px] font-semibold text-[var(--danger)] hover:bg-white">Find a professional <ArrowRight size={15} /></a></div>}</div>;
}

function Results({ diagnosis, onReset, onLogin }: { diagnosis: StoredDiagnosis; onReset: () => void; onLogin: () => void }) {
  const [whyOpen, setWhyOpen] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<number[]>(diagnosis.completedSteps || []);
  const updateProgress = trpc.diagnosis.updateProgress.useMutation();
  const result: DiagnosisResult = diagnosis;
  const isRed = diagnosis.safety_flag.level === "red";
  const toggleStep = (index: number) => {
    const next = completedSteps.includes(index) ? completedSteps.filter(step => step !== index) : [...completedSteps, index].sort((a, b) => a - b);
    setCompletedSteps(next);
    updateProgress.mutate({ diagnosisId: diagnosis.id, sessionId: getSessionId(), completedSteps: next });
  };
  return <>
    <section id="diagnosis" className="scroll-mt-8"><SectionHeading eyebrow="02 · DIAGNOSIS" title="What the evidence points to"><div className="flex gap-2 no-print"><Button variant="outline" size="sm" className="rounded-none border-[var(--border)] bg-white font-display text-[13px]" onClick={onReset}><RotateCcw size={14} /> Start over</Button><Button variant="outline" size="sm" className="rounded-none border-[var(--border)] bg-white font-display text-[13px]" onClick={() => window.print()}><Printer size={14} /> Print</Button></div></SectionHeading><SafetyPanel diagnosis={diagnosis} />
      <div className="mt-6 grid gap-5 md:grid-cols-[1fr_220px]">
        <div className="border border-[var(--border)] bg-white p-5"><div className="mb-4 flex items-center justify-between"><div className="font-display text-[14px] font-semibold">Ranked probable causes</div><span className="font-mono-data text-[12px] text-[var(--muted)]">{diagnosis.probable_causes.length} signals</span></div>{diagnosis.probable_causes.length ? <div className="space-y-5">{diagnosis.probable_causes.map((cause, index) => <div key={`${cause.cause}-${index}`}><div className="flex items-start gap-4"><div className="font-mono-data text-[12px] text-[var(--muted)]">0{index + 1}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-2"><div className="font-display text-[16px] font-semibold">{cause.cause}</div><div className="font-mono-data text-[13px] font-medium text-[var(--signal)]">{cause.confidence}%</div></div><div className="mt-2 h-1 bg-[var(--surface-alt)]"><div className="h-1 bg-[var(--signal)]" style={{ width: `${cause.confidence}%` }} /></div><p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">{cause.explanation}</p></div></div></div>)}</div> : <div className="text-[15px] text-[var(--muted)]">No ranked cause came back with enough evidence. Try a closer photo of the problem area.</div>}<button type="button" className="mt-5 flex w-full items-center justify-between border-t border-[var(--border)] pt-4 text-left font-display text-[13px] font-semibold" onClick={() => setWhyOpen(!whyOpen)}><span className="flex items-center gap-2"><CircleHelp size={15} className="text-[var(--signal)]" /> Why we think this</span><ChevronDown size={16} className={`transition-transform ${whyOpen ? "rotate-180" : ""}`} /></button>{whyOpen && <div className="mt-3 bg-[var(--surface-alt)] p-3 text-[14px] leading-6 text-[var(--muted)]">The ranking combines visible symptoms, the appliance type, and any model or symptom notes you supplied. Percentages express relative confidence between the returned causes — they are not a promise that the part has failed.</div>}</div>
        <div className="border border-[var(--border)] bg-[var(--surface-alt)] p-5"><div className="font-display text-[13px] font-semibold text-[var(--muted)]">REPORT SNAPSHOT</div><div className="mt-4 space-y-4"><div><div className="text-[13px] text-[var(--muted)]">Difficulty</div><div className="mt-1 font-display text-[16px] font-semibold capitalize">{diagnosis.difficulty.replace("_", " ")}</div></div><div><div className="text-[13px] text-[var(--muted)]">Estimated parts</div><div className="mt-1 font-mono-data text-[16px]">{diagnosis.estimated_cost_range.currency} {diagnosis.estimated_cost_range.low}–{diagnosis.estimated_cost_range.high}</div></div><div><div className="text-[13px] text-[var(--muted)]">Time on task</div><div className="mt-1 font-mono-data text-[16px]">{formatDuration(diagnosis.estimated_time_minutes)}</div></div></div></div>
      </div>
    </section>

    {!isRed && <section id="guided-fix" className="mt-12 scroll-mt-8"><SectionHeading eyebrow="03 · GUIDED FIX" title="A repair path you can follow"><span className="text-[14px] text-[var(--muted)]">{completedSteps.length} of {diagnosis.repair_steps.length} steps done</span></SectionHeading><div className="border border-[var(--border)] bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="font-display text-[15px] font-semibold">Before you open anything</div><div className="mt-1 text-[15px] text-[var(--muted)]">Have these tools within reach first.</div></div><Wrench size={21} className="text-[var(--signal)]" /></div><div className="mt-4 flex flex-wrap gap-2">{diagnosis.tools_needed.map(tool => <span key={tool} className="border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1.5 text-[14px]">{tool}</span>)}</div></div>{diagnosis.parts_needed.length > 0 && <div className="mt-5 border border-[var(--border)] bg-white p-5"><div className="font-display text-[15px] font-semibold">Parts to identify</div><div className="mt-4 divide-y divide-[var(--border)]">{diagnosis.parts_needed.map(part => <div key={part.name} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"><div><div className="font-display text-[15px] font-semibold">{part.name}</div>{part.likely_part_number && <div className="mt-1 font-mono-data text-[12px] text-[var(--muted)]">{part.likely_part_number}</div>}<div className="mt-1 text-[14px] text-[var(--muted)]">{part.notes}</div></div><a href={partSearchUrl(part)} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-2 font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4">Search for this part <ArrowRight size={14} /></a></div>)}</div><div className="mt-4 border-t border-[var(--border)] pt-3 text-[13px] text-[var(--muted)]">Links leave Fixpoint for a general part search. We do not claim stock or pricing here.</div></div>}
      <div className="mt-5 space-y-3">{diagnosis.repair_steps.map((step, index) => { const done = completedSteps.includes(index); return <div key={`${step.title}-${index}`} className={`border ${done ? "border-[#B7E5D0] bg-[#F7FCF9]" : "border-[var(--border)] bg-white"}`}><label className="flex cursor-pointer gap-4 p-5"><input type="checkbox" checked={done} onChange={() => toggleStep(index)} className="mt-1 h-5 w-5 accent-[var(--signal)]" /><span className="flex min-w-0 flex-1 gap-4"><span className="font-mono-data text-[12px] text-[var(--muted)]">{String(index + 1).padStart(2, "0")}</span><span><span className={`block font-display text-[16px] font-semibold ${done ? "line-through opacity-60" : ""}`}>{step.title}</span><span className="mt-2 block max-w-[590px] text-[16px] leading-7 text-[var(--muted)]">{step.detail}</span>{step.caution && <span className="mt-3 block border-l-2 border-[var(--caution)] bg-[#FFF9EA] px-3 py-2 text-[14px] leading-5 text-[#8E6110]"><strong className="font-display">Caution. </strong>{step.caution}</span>}</span></span></label></div>; })}</div>{completedSteps.length === diagnosis.repair_steps.length && diagnosis.repair_steps.length > 0 && <div className="mt-5 border-l-4 border-[var(--safe)] bg-[#F1FBF6] p-4"><div className="font-display text-[16px] font-semibold text-[var(--safe)]">Repair path complete</div><div className="mt-1 text-[15px]">Run the appliance through a normal cycle and watch for the original symptom before putting the panels back.</div></div>}<div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4 no-print"><div className="text-[13px] text-[var(--muted)]">Progress syncs to this repair session{!useAuth().isAuthenticated ? " on this device" : ""}.</div>{!useAuth().isAuthenticated && <button type="button" onClick={onLogin} className="font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4">Sign in to keep it across devices</button>}</div></section>}
    {isRed && <div className="mt-8 border border-[var(--border)] bg-[var(--surface-alt)] p-5 text-[15px] leading-6 text-[var(--muted)]"><strong className="font-display text-[var(--ink)]">Why there are no repair steps:</strong> the safety verdict overrides the guide. Fixpoint will never render DIY instructions when the diagnosis touches a hard-stop hazard.</div>}
  </>;
}

function getSessionId() {
  const key = "fixpoint-session";
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(key, next);
  return next;
}

export default function Home() {
  const { isAuthenticated } = useAuth();
  const [sessionId] = useState(getSessionId);
  const [pipeline, setPipeline] = useState<PipelineState>("idle");
  const [analysisStage, setAnalysisStage] = useState(0);
  const [diagnosis, setDiagnosis] = useState<StoredDiagnosis | null>(null);
  const [uploadError, setUploadError] = useState("");
  const diagnosisMutation = trpc.diagnosis.diagnose.useMutation();
  const latestInput = useMemo(() => ({ sessionId }), [sessionId]);
  const latest = trpc.diagnosis.latest.useQuery(latestInput, { enabled: !diagnosis });

  useEffect(() => {
    if (latest.data && !diagnosis) {
      setDiagnosis(latest.data);
      setPipeline("results");
    }
  }, [diagnosis, latest.data]);

  useEffect(() => {
    if (pipeline !== "analyzing") return;
    const timer = window.setInterval(() => setAnalysisStage(current => Math.min(2, current + 1)), 900);
    return () => window.clearInterval(timer);
  }, [pipeline]);

  const handleAnalyze = async (payload: { file: File; nameplate: File | null; applianceType: string; modelNumber: string; notes: string }) => {
    setUploadError("");
    setPipeline("analyzing");
    setAnalysisStage(0);
    try {
      const primary = await uploadFile(payload.file);
      const nameplate = payload.nameplate ? await uploadFile(payload.nameplate, `nameplate-${payload.nameplate.name}`) : null;
      let frame: UploadRef | null = null;
      if (payload.file.type.startsWith("video/")) {
        const frameBlob = await extractVideoFrame(payload.file);
        frame = await uploadFile(new File([frameBlob], "representative-frame.jpg", { type: "image/jpeg" }));
      }
      const result = await diagnosisMutation.mutateAsync({
        sessionId,
        applianceType: payload.applianceType,
        modelNumber: payload.modelNumber || undefined,
        notes: payload.notes || undefined,
        fileKey: primary.key,
        fileMime: payload.file.type,
        frameKey: frame?.key,
        nameplateKey: nameplate?.key,
      });
      setDiagnosis(result);
      setPipeline("results");
      window.setTimeout(() => document.getElementById("diagnosis")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
    } catch (error) {
      setPipeline("idle");
      setUploadError(error instanceof Error ? error.message : "We couldn't get a clear enough read. Try a closer shot of the problem itself.");
    }
  };

  const activeDiagnosis = diagnosis;
  return <div className="min-h-screen bg-[var(--surface)]">
    <header className="border-b border-[var(--border)] bg-white"><div className="mx-auto flex min-h-[64px] max-w-[1280px] items-center justify-between gap-4 px-5 lg:px-8"><a href="/" className="font-display text-[18px] font-bold tracking-[-.04em]">Bernard</a><div className="flex items-center gap-3 text-[13px] text-[var(--muted)]"><button type="button" onClick={() => activeDiagnosis ? document.getElementById("diagnosis")?.scrollIntoView({ behavior: "smooth" }) : document.getElementById("upload")?.scrollIntoView({ behavior: "smooth" })} className="font-display font-semibold text-[var(--signal)]">{activeDiagnosis ? "View report" : "Start"}</button>{!isAuthenticated && <button type="button" onClick={() => startLogin()} className="hidden border-l border-[var(--border)] pl-3 font-display font-semibold text-[var(--ink)] sm:inline">Sign in</button>}</div></div></header>
    <div className="mx-auto grid max-w-[1280px] grid-cols-1 lg:grid-cols-[174px_minmax(0,680px)_1fr] lg:gap-12 lg:px-8">
      <aside className="steps-rail order-2 hidden border-r border-[var(--border)] py-10 lg:order-1 lg:block"><div className="sticky top-8"><div className="mb-5 font-display text-[12px] font-semibold text-[var(--muted)]">YOUR SESSION</div>{stages.map((stage, index) => { const current = activeDiagnosis ? index <= 2 : pipeline === "analyzing" ? index === 1 : index === 0; return <a href={index === 0 ? "#upload" : index === 1 ? "#diagnosis" : "#guided-fix"} key={stage} className={`mb-4 flex items-center gap-3 text-left text-[14px] ${current ? "font-display font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}><span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-mono-data ${current ? "border-[var(--signal)] bg-[var(--signal)] text-white" : "border-[var(--border)] bg-white"}`}>{activeDiagnosis && index < 2 ? <Check size={13} /> : index + 1}</span>{stage}</a>; })}<div className="mt-10 border-t border-[var(--border)] pt-4 text-[13px] leading-5 text-[var(--muted)]">Evidence is processed for this session. Save a repair only when you choose to.</div></div></aside>
      <main className="order-1 min-w-0 px-5 py-10 sm:py-14 lg:order-2 lg:px-0">
        {!activeDiagnosis && <section id="upload" className="scroll-mt-8"><div className="mb-7"><div className="mb-2 font-display text-[13px] font-semibold text-[var(--signal)]">BERNARD</div><h1 className="max-w-[630px] font-display text-[34px] font-semibold leading-[1.12] tracking-[-.045em] sm:text-[44px]">Show me what’s wrong.</h1></div>{pipeline === "analyzing" ? <AnalyzeState currentStage={analysisStage} /> : <UploadPanel onAnalyze={handleAnalyze} />}{uploadError && pipeline !== "analyzing" && <div className="mt-5 flex items-start gap-2 border-l-2 border-[var(--danger)] bg-[#FFF4F4] px-3 py-2 text-[14px] leading-5 text-[#8F2D2D]"><AlertTriangle size={17} className="mt-0.5 shrink-0" />{uploadError}</div>}</section>}
        {activeDiagnosis && <Results diagnosis={activeDiagnosis} onReset={() => { setDiagnosis(null); setPipeline("idle"); setUploadError(""); window.scrollTo({ top: 0, behavior: "smooth" }); }} onLogin={() => startLogin()} />}
      </main>
      <div className="order-3 hidden lg:block" />
    </div>
    <footer className="border-t border-[var(--border)] bg-[var(--surface-alt)]"><div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-5 py-6 text-[13px] text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between lg:px-8"><div>Bernard</div><div>Upload a clear photo. Get a clear next step.</div></div></footer>
  </div>;
}
