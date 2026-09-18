import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
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
  formatDuration,
  formatInrRange,
  type EvidenceRole,
  type ErrorCodeResult,
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
type EvidenceItem = { file: File; role: EvidenceRole; upload?: UploadRef; errorCode?: ErrorCodeResult | null; reading?: boolean };

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

async function prepareUploadFile(file: File) {
  if (!file.type.startsWith("image/") || file.size < 1.8 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", .82));
    bitmap.close();
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function uploadFile(file: File, fileName = file.name): Promise<UploadRef> {
  const prepared = await prepareUploadFile(file);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 120_000);
      const response = await fetch(`/api/upload-binary?fileName=${encodeURIComponent(fileName)}`, {
        method: "POST",
        headers: { "Content-Type": prepared.type, "X-File-Name": encodeURIComponent(fileName) },
        body: prepared,
        signal: controller.signal,
        cache: "no-store",
      });
      window.clearTimeout(timeout);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The file could not be uploaded.");
      return payload as UploadRef;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 500));
    }
  }
  if (lastError instanceof DOMException && lastError.name === "AbortError") throw new Error("The upload took too long. Try a smaller photo or a shorter video.");
  if (lastError instanceof TypeError) throw new Error("The connection was interrupted. Check your signal and try again.");
  throw lastError instanceof Error ? lastError : new Error("The file could not be uploaded. Try again.");
}

function validateFile(file: File, allowVideo = true) {
  if (file.type.startsWith("image/") && file.size <= MAX_IMAGE_BYTES) return null;
  if (allowVideo && file.type.startsWith("video/") && file.size <= MAX_VIDEO_BYTES) return null;
  if (!file.type.startsWith("image/") && !(allowVideo && file.type.startsWith("video/"))) return "Use a photo or a short video of the device.";
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

function UploadPanel({ onAnalyze }: { onAnalyze: (payload: { file: File; evidence: EvidenceItem[]; nameplate: File | null; applianceType: string; modelNumber: string; notes: string }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [nameplate, setNameplate] = useState<File | null>(null);
  const [modelNumber, setModelNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const [ocrStatus, setOcrStatus] = useState<"idle" | "reading" | "done" | "error">("idle");
  const [brand, setBrand] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const ocrMutation = trpc.diagnosis.ocrNameplate.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const evidenceRef = useRef<HTMLInputElement>(null);
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
    setEvidence(current => [{ file: candidate, role: "problem" as EvidenceRole }, ...current.filter(item => item.file !== candidate)].slice(0, 4));
  };

  const addEvidence = (candidates: FileList | null) => {
    if (!candidates) return;
    const next = Array.from(candidates).filter(candidate => candidate.type.startsWith("image/") && candidate.size <= MAX_IMAGE_BYTES).slice(0, 4 - evidence.length);
    if (!next.length) return;
    setEvidence(current => [...current, ...next.map((file, index) => ({ file, role: index === 0 && !current.some(item => item.role === "device") ? "device" as const : "other" as const }))].slice(0, 4));
  };

  const removeEvidence = (candidate: File) => {
    setEvidence(current => current.filter(item => item.file !== candidate));
    if (candidate === file) setFile(null);
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
        aria-label="Upload device photo or video"
        className={`surface-enter mobile-card group relative flex min-h-[330px] cursor-pointer flex-col items-center justify-center border-2 border-dashed px-5 text-center transition-colors ${dragActive ? "border-[var(--signal)] bg-[#F5F8FF]" : "border-[#B8C0C9] bg-[var(--surface-alt)] hover:border-[var(--signal)] hover:bg-[#F8FAFF]"}`}
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
            <div className="mt-4 flex flex-wrap justify-center gap-4">
              <button type="button" className="font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4" onClick={event => { event.stopPropagation(); setFile(null); }}>Choose a different file</button>
              <button type="button" className="mobile-retake tap-target inline-flex items-center gap-1.5 font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4" onClick={event => { event.stopPropagation(); if (inputRef.current) inputRef.current.value = ""; inputRef.current?.click(); }}>Retake photo</button>
            </div>
          </>
        ) : (
          <>
            <div className="font-display text-[20px] font-semibold">Drop a photo or short video here</div>
            <div className="mt-2 max-w-[360px] text-[15px] leading-6 text-[var(--muted)]">Show the problem clearly. A close-up of the leak, noise source, or damaged area helps most.</div>
            <div className="mt-5 flex flex-wrap justify-center gap-2 text-[13px] text-[var(--muted)]"><StatusChip><FileImage size={14} />Photo · 10 MB</StatusChip><StatusChip><FileVideo size={14} />Video · 30 sec</StatusChip></div>
          </>
        )}
      </div>

      <div className="mt-4 mobile-card border border-[var(--border)] bg-white p-4">
        <div className="flex items-center justify-between gap-3"><div><div className="font-display text-[14px] font-semibold">Add more photos</div><div className="mt-1 text-[14px] text-[var(--muted)]">Show the device, problem, label, or error screen.</div></div><button type="button" disabled={evidence.length >= 4} className="min-h-11 border border-[var(--border)] px-3 font-display text-[13px] font-semibold text-[var(--signal)] disabled:opacity-40" onClick={() => evidenceRef.current?.click()}><Plus size={15} className="mr-1 inline" /> Add</button><input ref={evidenceRef} type="file" accept="image/*" multiple className="hidden" onChange={event => addEvidence(event.target.files)} /></div>
        {evidence.length > 0 && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{evidence.map(item => <div key={`${item.file.name}-${item.file.lastModified}`} className="relative overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-alt)]"><img src={URL.createObjectURL(item.file)} alt="Evidence preview" loading="lazy" decoding="async" className="aspect-square w-full object-cover" /><button type="button" onClick={() => removeEvidence(item.file)} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-[var(--ink)]" aria-label={`Remove ${item.file.name}`}><X size={14} /></button><select value={item.role} onChange={event => setEvidence(current => current.map(entry => entry.file === item.file ? { ...entry, role: event.target.value as EvidenceRole } : entry))} className="absolute bottom-1 left-1 right-1 h-7 rounded border-0 bg-white/90 px-1 text-[11px] font-display"><option value="problem">Problem</option><option value="device">Device</option><option value="label">Label</option><option value="error_code">Error code</option><option value="other">Other</option></select></div>)}</div>}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
        <div className="mobile-card border border-[var(--border)] bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-display text-[14px] font-semibold"><Paperclip size={15} className="text-[var(--signal)]" /> Optional model / serial label</div>
            <div className="mt-1 max-w-[320px] text-[14px] leading-5 text-[var(--muted)]">We’ll read the model and serial details for you.</div>
            </div>
            <button type="button" className="border border-[var(--border)] p-2 text-[var(--signal)] hover:border-[var(--signal)]" aria-label="Add model plate photo" onClick={() => nameplateRef.current?.click()}><Plus size={16} /></button>
            <input ref={nameplateRef} type="file" accept="image/*" className="hidden" onChange={event => pickNameplate(event.target.files?.[0] ?? null)} />
          </div>
          {nameplate && <div className="mt-3 bg-[var(--surface-alt)] px-3 py-2 text-[13px]"><div className="flex items-center justify-between"><span className="truncate font-mono-data">{nameplate.name}</span><button type="button" onClick={() => { setNameplate(null); setOcrStatus("idle"); setBrand(""); setSerialNumber(""); }} aria-label="Remove model plate photo"><X size={15} /></button></div><div className="mt-1 text-[var(--muted)]">{ocrStatus === "reading" ? "Reading the plate…" : ocrStatus === "done" ? `Details added${brand ? ` · ${brand}` : ""}${serialNumber ? ` · serial ${serialNumber}` : ""}` : ocrStatus === "error" ? "Couldn’t read it clearly. You can enter the model below." : "Ready"}</div></div>}
        </div>
        <label className="mobile-card border border-[var(--border)] bg-white p-4">
          <span className="font-display text-[14px] font-semibold">Anything else you’ve noticed?</span>
          <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} maxLength={1000} placeholder="Sound, smell, when it started…" className="mt-2 w-full resize-none border-0 bg-transparent p-0 text-[15px] placeholder:text-[#9AA2AC] focus:outline-none" />
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
        <div className="flex min-h-11 items-center gap-2 border border-[#B7E5D0] bg-[#F1FBF6] px-3 text-[14px] text-[var(--safe)]"><Sparkles size={15} /><span><strong className="font-display">Auto-detect</strong> · Bernard identifies the device from your evidence</span></div>
        <label className="block">
          <span className="mb-1.5 block font-display text-[13px] font-semibold">Model number <span className="font-body font-normal text-[var(--muted)]">· optional if not in the photo</span></span>
          <input value={modelNumber} onChange={event => setModelNumber(event.target.value)} placeholder="e.g. RF28T5001SR" className="font-mono-data h-11 w-full border border-[var(--border)] bg-white px-3 text-[14px] placeholder:font-body placeholder:text-[#9AA2AC] focus:border-[var(--signal)] focus:outline-none" />
        </label>
      </div>
      {error && <div role="alert" className="mt-4 flex items-start gap-2 border-l-2 border-[var(--danger)] bg-[#FFF4F4] px-3 py-2 text-[14px] leading-5 text-[#8F2D2D]"><AlertTriangle size={17} className="mt-0.5 shrink-0" />{error}</div>}
      <div className={`${file ? "mobile-sticky-action" : ""} mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center`}>
        <Button type="button" disabled={!file} className="tap-target h-12 rounded-none bg-[var(--signal)] px-6 font-display text-[14px] font-semibold text-white hover:bg-[#1D4DD8]" onClick={() => file && onAnalyze({ file, evidence, nameplate, applianceType: "Auto-detect", modelNumber, notes })}>Analyze {evidence.length > 1 ? `${evidence.length} photos` : "this device"} <ArrowRight size={17} /></Button>
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
  return <div className="surface-enter border border-[var(--border)] bg-[var(--surface-alt)] p-6 sm:p-8"><div className="flex items-center gap-3"><Loader2 className="animate-spin text-[var(--signal)]" size={20} /><div className="font-display text-[17px] font-semibold">Building your diagnostic report</div><span className="ml-auto flex gap-1" aria-label="Processing"><i className="processing-dot h-1.5 w-1.5 rounded-full bg-[var(--signal)]" /><i className="processing-dot h-1.5 w-1.5 rounded-full bg-[var(--signal)]" /><i className="processing-dot h-1.5 w-1.5 rounded-full bg-[var(--signal)]" /></span></div><div className="mt-6 space-y-4">{items.map((item, index) => <div key={item} className="flex items-center gap-3 text-[15px] text-[var(--muted)]"><span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[12px] font-display ${index < currentStage ? "border-[var(--signal)] bg-[var(--signal)] text-white" : "border-[#C7CDD4] bg-white"}`}>{index < currentStage ? <Check size={14} /> : index + 1}</span>{item}{index === currentStage && <span className="ml-auto font-mono-data text-[11px] text-[var(--signal)]">IN PROGRESS</span>}</div>)}</div><div className="mt-8 h-1 w-full overflow-hidden bg-white"><div className="processing-sweep h-full w-1/2 bg-[var(--signal)]" /></div><div className="mt-3 text-[13px] text-[var(--muted)]">Reading your evidence and checking the safest next step.</div></div>;
}

function SafetyPanel({ diagnosis }: { diagnosis: StoredDiagnosis }) {
  const level = diagnosis.safety_flag.level;
  const tone = level === "green" ? "safe" : level === "amber" ? "caution" : "danger";
  const Icon = level === "green" ? ShieldCheck : AlertTriangle;
  return <div className={`mobile-card resolve-panel border-l-4 p-5 ${level === "green" ? "border-[var(--safe)] bg-[#F1FBF6]" : level === "amber" ? "border-[var(--caution)] bg-[#FFF9EA]" : "border-[var(--danger)] bg-[#FFF4F4]"}`}><div className="flex items-start gap-4"><Icon size={25} className={level === "green" ? "text-[var(--safe)]" : level === "amber" ? "text-[#8E6110]" : "text-[var(--danger)]"} /><div className="min-w-0"><div className={`font-display text-[13px] font-semibold ${tone === "safe" ? "text-[var(--safe)]" : tone === "caution" ? "text-[#8E6110]" : "text-[var(--danger)]"}`}>SAFETY VERDICT</div><div className="mt-1 font-display text-[20px] font-semibold tracking-[-.02em]">{safetyLabel(level)}</div><p className="mt-2 max-w-[580px] text-[16px] leading-6">{diagnosis.safety_flag.reason}</p></div></div>{level === "red" && <div className="mt-5 flex flex-col gap-3 border-t border-[#E8BABA] pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="text-[14px] text-[#8F2D2D]">Do not remove panels or test live components.</div><a href="https://www.google.com/search?q=appliance+repair+professional" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 border border-[var(--danger)] px-4 py-2 font-display text-[13px] font-semibold text-[var(--danger)] hover:bg-white">Find a professional <ArrowRight size={15} /></a></div>}</div>;
}

const applianceIllustrations: Record<string, string> = {
  Refrigerator: "/manus-storage/bernard-refrigerator_500f4dd7.png",
  "Washing machine": "/manus-storage/bernard-appliance-illustration_82001637.png",
  Dryer: "/manus-storage/bernard-dryer_2a7c25b3.png",
  "Oven / range": "/manus-storage/bernard-oven_ca0a748c.png",
  Dishwasher: "/manus-storage/bernard-dishwasher_f12e7833.png",
  Phone: "/manus-storage/bernard-phone_321e3ade.png",
  Laptop: "/manus-storage/bernard-laptop_7d95d3e5.png",
  Headphones: "/manus-storage/bernard-headphones_d9b7d905.png",
  Television: "/manus-storage/bernard-television_c91b349e.png",
  "Other device": "/manus-storage/bernard-generic-device_b3b799fc.png",
};

function difficultyCopy(value: string) {
  if (value === "easy") return { label: "Easy", detail: "A careful beginner can try this", tone: "safe" as const };
  if (value === "moderate") return { label: "Some experience", detail: "Take your time and follow each step", tone: "caution" as const };
  if (value === "professional_only") return { label: "Professional only", detail: "Get a qualified repair person", tone: "danger" as const };
  return { label: "Advanced", detail: "Best for someone with repair experience", tone: "caution" as const };
}

function ErrorCodeCard({ code }: { code: NonNullable<StoredDiagnosis["error_code"]> }) {
  return <div className="mobile-card mt-5 border border-[#BCD0FF] bg-[#F3F6FF] p-4 sm:p-5"><div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white font-mono-data font-semibold text-[var(--signal)]">!</div><div><div className="font-display text-[13px] font-semibold text-[var(--signal)]">ERROR CODE FOUND</div><div className="mt-1 font-mono-data text-[22px] font-semibold tracking-[-.02em]">{code.code}</div><p className="mt-1 text-[15px] leading-6 text-[var(--muted)]">{code.meaning}</p></div></div></div>;
}

async function exportDiagnosisPdf(diagnosis: StoredDiagnosis) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 18;
  const width = 210 - margin * 2;
  let y = 22;
  const ink = [20, 23, 26] as const;
  const muted = [91, 100, 112] as const;
  const blue = [43, 95, 240] as const;
  const addText = (text: string, size: number, color: readonly [number, number, number] = ink, bold = false, gap = 6) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(text, width);
    if (y + lines.length * (size * .45) > 278) { pdf.addPage(); y = 20; }
    pdf.text(lines, margin, y);
    y += lines.length * (size * .45) + gap;
  };
  addText("bernard", 22, ink, true, 3);
  addText("DEVICE DIAGNOSIS REPORT", 9, blue, true, 12);
  addText(`${diagnosis.applianceType}${diagnosis.modelNumber ? ` · ${diagnosis.modelNumber}` : ""}`, 15, ink, true, 4);
  addText(`Generated ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`, 9, muted, false, 12);
  addText(`Safety: ${safetyLabel(diagnosis.safety_flag.level)}`, 13, diagnosis.safety_flag.level === "red" ? [209, 67, 67] : diagnosis.safety_flag.level === "amber" ? [142, 97, 16] : [30, 142, 90], true, 3);
  addText(diagnosis.safety_flag.reason, 10, muted, false, 10);
  addText("Most likely problem", 12, ink, true, 3);
  const cause = diagnosis.probable_causes[0];
  addText(cause ? `${cause.cause} (${cause.confidence}% likely)\n${cause.explanation}` : "Bernard needs a clearer photo of the problem area.", 10, muted, false, 9);
  addText("At a glance", 12, ink, true, 3);
  addText(`Repair difficulty: ${difficultyCopy(diagnosis.difficulty).label}\nEstimated cost in India: ${formatInrRange(diagnosis.estimated_cost_range)}\nTime needed: ${formatDuration(diagnosis.estimated_time_minutes)}`, 10, muted, false, 9);
  if (diagnosis.error_code) {
    addText(`Error code: ${diagnosis.error_code.code}\n${diagnosis.error_code.meaning}`, 10, blue, false, 9);
  }
  if (diagnosis.repair_steps.length) {
    addText("What to do next", 12, ink, true, 4);
    diagnosis.repair_steps.forEach((step, index) => addText(`${index + 1}. ${step.title}\n${step.detail}${step.caution ? `\nCaution: ${step.caution}` : ""}`, 10, muted, false, 7));
  }
  pdf.setFontSize(8);
  pdf.setTextColor(...muted);
  pdf.text("Bernard provides guidance, not a guarantee. Stop and contact a qualified professional if the safety verdict says Professional only.", margin, 287, { maxWidth: width });
  pdf.save(`bernard-diagnosis-${new Date().toISOString().slice(0, 10)}.pdf`);
}

function Results({ diagnosis, onReset }: { diagnosis: StoredDiagnosis; onReset: () => void }) {
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
    <section id="diagnosis" className="diagnosis-success scroll-mt-8"><div className="mb-4 flex items-center gap-3 text-[var(--safe)]" role="status" aria-live="polite"><span className="relative flex h-7 w-7 items-center justify-center"><span className="success-ring absolute inset-0 rounded-full bg-[#B7E5D0]" /><span className="success-pop relative flex h-7 w-7 items-center justify-center rounded-full bg-[var(--safe)] text-white"><Check size={15} strokeWidth={2.5} /></span></span><span className="font-display text-[13px] font-semibold">Diagnosis ready</span></div><SectionHeading eyebrow="02 · RESULT" title="Here’s the likely problem"><div className="flex flex-wrap gap-2 no-print"><Button variant="outline" size="sm" className="tap-target rounded-none border-[var(--border)] bg-white font-display text-[13px]" onClick={() => void exportDiagnosisPdf(diagnosis)}><Download size={14} /> Export PDF</Button><Button variant="outline" size="sm" className="tap-target rounded-none border-[var(--border)] bg-white font-display text-[13px]" onClick={onReset}><RotateCcw size={14} /> New photo</Button><Button variant="outline" size="sm" className="tap-target rounded-none border-[var(--border)] bg-white font-display text-[13px]" onClick={() => window.print()}><Printer size={14} /> Print</Button></div></SectionHeading><SafetyPanel diagnosis={diagnosis} />{diagnosis.error_code && <ErrorCodeCard code={diagnosis.error_code} />}
      <div className="mt-6 grid gap-5 md:grid-cols-[1fr_220px]">
        <div className="border border-[var(--border)] bg-white p-5"><div className="mb-4 flex items-center justify-between"><div className="font-display text-[14px] font-semibold">Most likely cause</div><span className="font-mono-data text-[12px] text-[var(--muted)]">{diagnosis.probable_causes[0]?.confidence ?? 0}% likely</span></div>{diagnosis.probable_causes.length ? <div className="space-y-5">{diagnosis.probable_causes.slice(0, 3).map((cause, index) => <div key={`${cause.cause}-${index}`}><div className="flex items-start gap-4"><div className="font-mono-data text-[12px] text-[var(--muted)]">{index === 0 ? "01" : "—"}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-2"><div className={`font-display font-semibold ${index === 0 ? "text-[20px]" : "text-[15px] text-[var(--muted)]"}`}>{cause.cause}</div>{index === 0 && <div className="font-mono-data text-[13px] font-medium text-[var(--signal)]">{cause.confidence}%</div>}</div>{index === 0 && <><div className="mt-2 h-1 bg-[var(--surface-alt)]"><div className="h-1 bg-[var(--signal)]" style={{ width: `${cause.confidence}%` }} /></div><p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">{cause.explanation}</p></>}</div></div></div>)}</div> : <div className="text-[15px] text-[var(--muted)]">We need a closer photo of the problem area.</div>}<button type="button" className="mt-5 flex w-full items-center justify-between border-t border-[var(--border)] pt-4 text-left font-display text-[13px] font-semibold" onClick={() => setWhyOpen(!whyOpen)}><span className="flex items-center gap-2"><CircleHelp size={15} className="text-[var(--signal)]" /> Why we think this</span><ChevronDown size={16} className={`transition-transform ${whyOpen ? "rotate-180" : ""}`} /></button>{whyOpen && <div className="mt-3 bg-[var(--surface-alt)] p-3 text-[14px] leading-6 text-[var(--muted)]">We compare what is visible in your photo with common appliance failure patterns. The percentage is a confidence estimate, not a guarantee.</div>}</div>
        <div className="mobile-card border border-[var(--border)] bg-[var(--surface-alt)] p-5"><img src={applianceIllustrations[diagnosis.applianceType] ?? applianceIllustrations["Other device"]} alt={`${diagnosis.applianceType} illustration`} loading="lazy" decoding="async" className="mx-auto mb-4 h-32 w-32 object-contain" /><div className="font-display text-[13px] font-semibold text-[var(--muted)]">AT A GLANCE</div><div className="mt-4 space-y-4"><div><div className="text-[13px] text-[var(--muted)]">Repair difficulty</div><div className="mt-1"><StatusChip tone={difficultyCopy(diagnosis.difficulty).tone}>{difficultyCopy(diagnosis.difficulty).label}</StatusChip></div><div className="mt-1 text-[13px] text-[var(--muted)]">{difficultyCopy(diagnosis.difficulty).detail}</div></div><div><div className="text-[13px] text-[var(--muted)]">Likely cost in India</div><div className="mt-1 font-display text-[18px] font-semibold">{formatInrRange(diagnosis.estimated_cost_range)}</div></div><div><div className="text-[13px] text-[var(--muted)]">Time needed</div><div className="mt-1 font-mono-data text-[16px]">{formatDuration(diagnosis.estimated_time_minutes)}</div></div></div></div>
      </div>
    </section>

    {!isRed && <section id="guided-fix" className="mt-12 scroll-mt-8"><SectionHeading eyebrow="03 · NEXT STEPS" title="What to do next"><span className="text-[14px] text-[var(--muted)]">{completedSteps.length} of {diagnosis.repair_steps.length} done</span></SectionHeading><div className="border border-[var(--border)] bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="font-display text-[15px] font-semibold">Tools first</div><div className="mt-1 text-[15px] text-[var(--muted)]">Have these nearby before you start.</div></div><Wrench size={21} className="text-[var(--signal)]" /></div><div className="mt-4 flex flex-wrap gap-2">{diagnosis.tools_needed.map(tool => <span key={tool} className="border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1.5 text-[14px]">{tool}</span>)}</div></div>{diagnosis.parts_needed.length > 0 && <div className="mt-5 border border-[var(--border)] bg-white p-5"><div className="font-display text-[15px] font-semibold">Parts you may need</div><div className="mt-4 divide-y divide-[var(--border)]">{diagnosis.parts_needed.map(part => <div key={part.name} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"><div><div className="font-display text-[15px] font-semibold">{part.name}</div>{part.likely_part_number && <div className="mt-1 font-mono-data text-[12px] text-[var(--muted)]">{part.likely_part_number}</div>}<div className="mt-1 text-[14px] text-[var(--muted)]">{part.notes}</div></div><a href={partSearchUrl(part)} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-2 font-display text-[13px] font-semibold text-[var(--signal)] underline underline-offset-4">Search for this part <ArrowRight size={14} /></a></div>)}</div><div className="mt-4 border-t border-[var(--border)] pt-3 text-[13px] text-[var(--muted)]">This opens a general search. Bernard does not claim stock or pricing.</div></div>}
      <div className="mt-5 space-y-3">{diagnosis.repair_steps.map((step, index) => { const done = completedSteps.includes(index); return <div key={`${step.title}-${index}`} className={`border ${done ? "border-[#B7E5D0] bg-[#F7FCF9]" : "border-[var(--border)] bg-white"}`}><label className="flex cursor-pointer gap-4 p-5"><input type="checkbox" checked={done} onChange={() => toggleStep(index)} className="mt-1 h-5 w-5 accent-[var(--signal)]" /><span className="flex min-w-0 flex-1 gap-4"><span className="font-mono-data text-[12px] text-[var(--muted)]">{String(index + 1).padStart(2, "0")}</span><span><span className={`block font-display text-[16px] font-semibold ${done ? "line-through opacity-60" : ""}`}>{step.title}</span><span className="mt-2 block max-w-[590px] text-[16px] leading-7 text-[var(--muted)]">{step.detail}</span>{step.caution && <span className="mt-3 block border-l-2 border-[var(--caution)] bg-[#FFF9EA] px-3 py-2 text-[14px] leading-5 text-[#8E6110]"><strong className="font-display">Caution. </strong>{step.caution}</span>}</span></span></label></div>; })}</div>{completedSteps.length === diagnosis.repair_steps.length && diagnosis.repair_steps.length > 0 && <div className="mt-5 border-l-4 border-[var(--safe)] bg-[#F1FBF6] p-4"><div className="font-display text-[16px] font-semibold text-[var(--safe)]">Repair path complete</div><div className="mt-1 text-[15px]">Run the device through a normal cycle or use it normally and watch for the original symptom before finishing the repair.</div></div>}<div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4 no-print"><div className="text-[13px] text-[var(--muted)]">Progress is saved on this device for this session.</div></div></section>}
    {isRed && <div className="mt-8 border border-[var(--border)] bg-[var(--surface-alt)] p-5 text-[15px] leading-6 text-[var(--muted)]"><strong className="font-display text-[var(--ink)]">No DIY steps are shown.</strong> This problem needs a qualified repair person.</div>}
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
  const [sessionId] = useState(getSessionId);
  const [pipeline, setPipeline] = useState<PipelineState>("idle");
  const [analysisStage, setAnalysisStage] = useState(0);
  const [diagnosis, setDiagnosis] = useState<StoredDiagnosis | null>(null);
  const [uploadError, setUploadError] = useState("");
  const diagnosisMutation = trpc.diagnosis.diagnose.useMutation();
  const errorCodeMutation = trpc.diagnosis.readErrorCode.useMutation();
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

  const handleAnalyze = async (payload: { file: File; evidence: EvidenceItem[]; nameplate: File | null; applianceType: string; modelNumber: string; notes: string }) => {
    setUploadError("");
    setPipeline("analyzing");
    setAnalysisStage(0);
    try {
      const evidenceUploads = await Promise.all(payload.evidence.map(async item => ({ ...item, upload: await uploadFile(item.file, `evidence-${item.role}-${item.file.name}`) })));
      const primary = evidenceUploads[0]?.upload ?? await uploadFile(payload.file);
      const errorCodePhoto = evidenceUploads.find(item => item.role === "error_code");
      let detectedErrorCode: ErrorCodeResult | null = null;
      if (errorCodePhoto?.upload) {
        try {
          detectedErrorCode = await errorCodeMutation.mutateAsync({ fileKey: errorCodePhoto.upload.key });
        } catch {
          detectedErrorCode = null;
        }
      }
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
        evidenceKeys: evidenceUploads.slice(1).map(item => item.upload?.key).filter((key): key is string => Boolean(key)),
        frameKey: frame?.key,
        nameplateKey: nameplate?.key,
      });
      setDiagnosis(detectedErrorCode ? { ...result, error_code: result.error_code ?? detectedErrorCode } : result);
      setPipeline("results");
      window.setTimeout(() => document.getElementById("diagnosis")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
    } catch (error) {
      setPipeline("idle");
      setUploadError(error instanceof Error ? error.message : "We couldn't get a clear enough read. Try a closer shot of the problem itself.");
    }
  };

  const activeDiagnosis = diagnosis;
  return <div className="min-h-screen bg-[var(--surface)]">
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-white/95 backdrop-blur"><div className="mx-auto flex min-h-[64px] max-w-[1280px] items-center justify-between gap-4 px-5 lg:px-8"><a href="/" aria-label="Bernard home" className="group flex items-center gap-2"><span className="brand-mark flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ink)] font-display text-[14px] font-bold">B</span><span className="brand-wordmark font-display text-[19px] font-semibold tracking-[-.04em]">bernard</span></a><button type="button" onClick={() => activeDiagnosis ? document.getElementById("diagnosis")?.scrollIntoView({ behavior: "smooth" }) : document.getElementById("upload")?.scrollIntoView({ behavior: "smooth" })} className="tap-target min-h-11 px-2 font-display font-semibold text-[var(--signal)]">{activeDiagnosis ? "View report" : "Start"}</button></div></header>
    <nav className="mobile-step-nav" aria-label="Session steps">{stages.map((stage, index) => { const current = activeDiagnosis ? index <= 2 : pipeline === "analyzing" ? index === 1 : index === 0; return <a href={index === 0 ? "#upload" : index === 1 ? "#diagnosis" : "#guided-fix"} key={stage} aria-current={current ? "step" : undefined} className={`rounded-full border px-3 py-1.5 text-[13px] ${current ? "border-[var(--border)] font-display font-semibold" : "border-transparent text-[var(--muted)]"}`}><span>{index + 1}. {stage}</span></a>; })}</nav>
    <div className="mx-auto grid max-w-[1280px] grid-cols-1 lg:grid-cols-[174px_minmax(0,680px)_1fr] lg:gap-12 lg:px-8">
      <aside className="steps-rail order-2 hidden border-r border-[var(--border)] py-10 lg:order-1 lg:block"><div className="sticky top-8"><div className="mb-5 font-display text-[12px] font-semibold text-[var(--muted)]">YOUR SESSION</div>{stages.map((stage, index) => { const current = activeDiagnosis ? index <= 2 : pipeline === "analyzing" ? index === 1 : index === 0; return <a href={index === 0 ? "#upload" : index === 1 ? "#diagnosis" : "#guided-fix"} key={stage} className={`mb-4 flex items-center gap-3 text-left text-[14px] ${current ? "font-display font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}><span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-mono-data ${current ? "border-[var(--signal)] bg-[var(--signal)] text-white" : "border-[var(--border)] bg-white"}`}>{activeDiagnosis && index < 2 ? <Check size={13} /> : index + 1}</span>{stage}</a>; })}<div className="mt-10 border-t border-[var(--border)] pt-4 text-[13px] leading-5 text-[var(--muted)]">Evidence is processed for this session. Save a repair only when you choose to.</div></div></aside>
      <main className="order-1 min-w-0 px-5 py-8 sm:py-14 lg:order-2 lg:px-0">
        {!activeDiagnosis && <section id="upload" className="scroll-mt-8"><div className="mb-7"><div className="mb-2 font-display text-[13px] font-semibold text-[var(--signal)]">BERNARD</div><h1 className="max-w-[630px] font-display text-[34px] font-semibold leading-[1.12] tracking-[-.045em] sm:text-[44px]">Show me what’s wrong.</h1></div>{pipeline === "analyzing" ? <AnalyzeState currentStage={analysisStage} /> : <UploadPanel onAnalyze={handleAnalyze} />}{uploadError && pipeline !== "analyzing" && <div className="mt-5 flex items-start gap-2 border-l-2 border-[var(--danger)] bg-[#FFF4F4] px-3 py-2 text-[14px] leading-5 text-[#8F2D2D]"><AlertTriangle size={17} className="mt-0.5 shrink-0" />{uploadError}</div>}</section>}
        {activeDiagnosis && <Results diagnosis={activeDiagnosis} onReset={() => { setDiagnosis(null); setPipeline("idle"); setUploadError(""); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}
      </main>
      <div className="order-3 hidden lg:block" />
    </div>
    <footer className="border-t border-[var(--border)] bg-[var(--surface-alt)]"><div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-5 py-6 text-[13px] text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between lg:px-8"><div>Bernard</div><div>Upload a clear photo. Get a clear next step.</div></div></footer>
  </div>;
}
