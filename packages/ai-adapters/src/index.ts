import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  type Project,
  type ProjectRepository,
  type TextPresetId
} from "@frameforge/project-schema";
import { addClipToTrack } from "@frameforge/timeline-engine";
import { importMediaIntoProject } from "@frameforge/media-engine";

export const AiAdapterDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.enum(["local-tts", "local-stt", "cloud-optional"]),
  enabled: z.boolean(),
  configured: z.boolean(),
  requiresApiKey: z.boolean(),
  notes: z.string()
});

export type AiAdapterDescriptor = z.infer<typeof AiAdapterDescriptorSchema>;

export interface LocalAiConfig {
  piperBinaryPath?: string;
  piperModelPath?: string;
  whisperBinaryPath?: string;
  whisperModelPath?: string;
  enableOptionalCloudProviders?: boolean;
}

/**
 * Inspects local TTS and STT adapter availability honestly.
 * Never assumes speech recognition is available merely because Piper TTS is installed.
 */
export function inspectAiAdapterStatus(config?: LocalAiConfig): {
  piperTtsAvailable: boolean;
  speechRecognitionAvailable: boolean;
  adapters: AiAdapterDescriptor[];
} {
  const piperBin = config?.piperBinaryPath;
  const piperModel = config?.piperModelPath;
  const piperTtsAvailable = Boolean(
    piperBin &&
      piperModel &&
      fs.existsSync(piperBin) &&
      fs.existsSync(piperModel)
  );

  const whisperBin = config?.whisperBinaryPath;
  const whisperModel = config?.whisperModelPath;
  const speechRecognitionAvailable = Boolean(
    whisperBin &&
      whisperModel &&
      fs.existsSync(whisperBin) &&
      fs.existsSync(whisperModel)
  );

  const adapters: AiAdapterDescriptor[] = [
    {
      id: "piper-local-tts",
      displayName: "Piper Local TTS",
      kind: "local-tts",
      enabled: true,
      configured: piperTtsAvailable,
      requiresApiKey: false,
      notes: piperTtsAvailable
        ? "Local Piper binary and ONNX model verified."
        : "Requires local piper binary and .onnx/.onnx.json voice model files."
    },
    {
      id: "local-speech-recognition",
      displayName: "Local Whisper Speech-to-Text Adapter",
      kind: "local-stt",
      enabled: true,
      configured: speechRecognitionAvailable,
      requiresApiKey: false,
      notes: speechRecognitionAvailable
        ? "Local speech recognition binary and model verified."
        : "Requires separate local speech-to-text binary and model (independent of Piper TTS)."
    },
    {
      id: "cloud-llm-optional",
      displayName: "Optional Cloud AI Provider",
      kind: "cloud-optional",
      enabled: Boolean(config?.enableOptionalCloudProviders),
      configured: false,
      requiresApiKey: true,
      notes: "Disabled by default. Paid cloud providers require explicit opt-in configuration."
    }
  ];

  return { piperTtsAvailable, speechRecognitionAvailable, adapters };
}

export function listRegisteredAiAdapters(config?: LocalAiConfig): readonly AiAdapterDescriptor[] {
  return inspectAiAdapterStatus(config).adapters;
}

/**
 * Writes a deterministic 48kHz 16-bit mono PCM WAV file for local voice-over fixture synthesis
 * when an external Piper binary/model is not installed in the test environment.
 */
function writeDeterministicPcmWav(outputWavPath: string, durationSeconds: number, freqHz = 320): void {
  const sampleRate = 48000;
  const numSamples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataBytes = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format = 1
  buffer.writeUInt16LE(1, 22);  // Mono = 1 channel
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32);  // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / 1000, (numSamples - i) / 1000);
    const sample = Math.round(Math.sin(2 * Math.PI * freqHz * t) * 8000 * envelope);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(outputWavPath), { recursive: true });
  fs.writeFileSync(outputWavPath, buffer);
}

export interface SynthesizeVoiceOverOptions {
  text: string;
  outputWavPath: string;
  config?: LocalAiConfig;
  allowLocalFixtureFallback?: boolean;
}

export function synthesizeVoiceOverToWav(options: SynthesizeVoiceOverOptions): {
  outputWavPath: string;
  usedPiperBinary: boolean;
  durationSeconds: number;
} {
  const cleanText = options.text.trim();
  if (!cleanText) {
    throw new Error("Voice-over text cannot be empty");
  }

  const status = inspectAiAdapterStatus(options.config);
  const resolvedOut = path.resolve(options.outputWavPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  if (status.piperTtsAvailable && options.config?.piperBinaryPath && options.config?.piperModelPath) {
    execFileSync(
      options.config.piperBinaryPath,
      ["--model", options.config.piperModelPath, "--output_file", resolvedOut],
      { input: cleanText, encoding: "utf8", timeout: 30000 }
    );
    return { outputWavPath: resolvedOut, usedPiperBinary: true, durationSeconds: 2 };
  }

  if (!options.allowLocalFixtureFallback) {
    throw new Error(
      "Piper TTS binary or ONNX voice model is not configured or installed. Set piperBinaryPath and piperModelPath, or enable allowLocalFixtureFallback for testing."
    );
  }

  const wordCount = cleanText.split(/\s+/).length;
  const durationSeconds = Math.max(1, Math.min(10, Number((wordCount * 0.4).toFixed(2))));
  writeDeterministicPcmWav(resolvedOut, durationSeconds);
  return { outputWavPath: resolvedOut, usedPiperBinary: false, durationSeconds };
}

export function addVoiceOverToProjectTimeline(input: {
  repo: ProjectRepository;
  project: Project;
  text: string;
  assetId: string;
  clipId: string;
  trackId: string;
  startFrame: number;
  tempWavDir: string;
  config?: LocalAiConfig;
  allowLocalFixtureFallback?: boolean;
}): Project {
  const tempWavPath = path.join(path.resolve(input.tempWavDir), `${input.assetId}.wav`);
  synthesizeVoiceOverToWav({
    text: input.text,
    outputWavPath: tempWavPath,
    config: input.config,
    allowLocalFixtureFallback: input.allowLocalFixtureFallback
  });

  const imported = importMediaIntoProject(input.repo, input.project, tempWavPath, {
    assetId: input.assetId,
    name: `VO: ${input.text.slice(0, 24)}`
  });

  const updated = addClipToTrack(imported.project, {
    id: input.clipId,
    assetId: imported.asset.id,
    trackId: input.trackId,
    startFrame: input.startFrame,
    durationFrames: imported.asset.durationFrames ?? 30,
    sourceInFrame: 0,
    sourceOutFrame: imported.asset.durationFrames ?? 30,
    volume: 1.0
  });

  input.repo.saveProject(updated);
  return updated;
}

export const CaptionCueSchema = z
  .object({
    id: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().min(1).max(300)
  })
  .strict();

export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export interface CaptionValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCaptionTimings(cues: readonly CaptionCue[]): CaptionValidationResult {
  const errors: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const parsed = CaptionCueSchema.safeParse(cue);
    if (!parsed.success) {
      errors.push(`Cue[${i}] (${cue.id}): ${parsed.error.message}`);
      continue;
    }
    if (cue.endMs <= cue.startMs) {
      errors.push(`Cue[${i}] (${cue.id}): endMs (${cue.endMs}) must be > startMs (${cue.startMs})`);
    }
    if (i > 0) {
      const prev = cues[i - 1]!;
      if (cue.startMs < prev.endMs) {
        errors.push(
          `Cue[${i}] (${cue.id}) overlaps with previous cue (${prev.id}): ${cue.startMs}ms < ${prev.endMs}ms`
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseSrtTimestampToMs(ts: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(ts.trim());
  if (!match) {
    throw new Error(`Invalid SRT timestamp: ${ts}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

function formatMsToSrtTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

export function parseSrtCaptions(srtContent: string): CaptionCue[] {
  const blocks = srtContent
    .trim()
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cues: CaptionCue[] = [];
  blocks.forEach((block, idx) => {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) return;
    const timingLineIdx = lines[0]!.includes("-->") ? 0 : 1;
    const timingLine = lines[timingLineIdx]!;
    const parts = timingLine.split("-->");
    if (parts.length !== 2) {
      throw new Error(`Malformed SRT timing line: ${timingLine}`);
    }
    const startMs = parseSrtTimestampToMs(parts[0]!);
    const endMs = parseSrtTimestampToMs(parts[1]!);
    const text = lines.slice(timingLineIdx + 1).join(" ").trim();
    cues.push({
      id: `cue-${idx + 1}`,
      startMs,
      endMs,
      text
    });
  });

  const validation = validateCaptionTimings(cues);
  if (!validation.valid) {
    throw new Error(`Invalid SRT caption timings: ${validation.errors.join("; ")}`);
  }
  return cues;
}

export function formatSrtCaptions(cues: readonly CaptionCue[]): string {
  const validation = validateCaptionTimings(cues);
  if (!validation.valid) {
    throw new Error(`Cannot format invalid captions: ${validation.errors.join("; ")}`);
  }
  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatMsToSrtTimestamp(cue.startMs)} --> ${formatMsToSrtTimestamp(cue.endMs)}\n${cue.text}`
    )
    .join("\n\n");
}

export function updateCaptionCue(
  cues: readonly CaptionCue[],
  cueId: string,
  patch: Partial<Pick<CaptionCue, "startMs" | "endMs" | "text">>
): CaptionCue[] {
  const next = cues.map((c) => (c.id === cueId ? { ...c, ...patch } : { ...c }));
  const validation = validateCaptionTimings(next);
  if (!validation.valid) {
    throw new Error(`Caption update failed validation: ${validation.errors.join("; ")}`);
  }
  return next;
}

export function applyCaptionsToTimeline(
  project: Project,
  cues: readonly CaptionCue[],
  trackId: string,
  preset: TextPresetId = "caption-pill"
): Project {
  const validation = validateCaptionTimings(cues);
  if (!validation.valid) {
    throw new Error(`Invalid captions: ${validation.errors.join("; ")}`);
  }

  const fps =
    project.timeline.frameRate.numerator / (project.timeline.frameRate.denominator || 1);
  let nextProject = structuredClone(project);

  for (const cue of cues) {
    const startFrame = Math.round((cue.startMs / 1000) * fps);
    const endFrame = Math.max(startFrame + 1, Math.round((cue.endMs / 1000) * fps));
    nextProject = addClipToTrack(nextProject, {
      id: `caption-${cue.id}`,
      trackId,
      startFrame,
      durationFrames: endFrame - startFrame,
      textOverlay: {
        text: cue.text,
        preset,
        fontSize: 44,
        fontColor: "#FFFFFF",
        backgroundColor: "#000000",
        x: 540,
        y: 1450
      }
    });
  }

  return nextProject;
}
