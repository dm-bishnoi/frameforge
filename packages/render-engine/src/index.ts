import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  type Clip,
  formatRationalFrameRate,
  getFrameRateValue,
  type Project,
  ProjectSchema,
  validateSafeProjectPath
} from "@frameforge/project-schema";
import {
  MAX_SOURCE_MEDIA_BYTES,
  probeMediaFile,
  type MediaProbeResult
} from "@frameforge/media-engine";

export const MAX_RENDERED_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB rendered output limit (distinct from 500 MB MAX_SOURCE_MEDIA_BYTES)
export { MAX_SOURCE_MEDIA_BYTES };

export const RenderJobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const RenderEngineCapabilitySchema = z.object({
  stage: z.literal("step-5-ffmpeg-pipeline"),
  exportAvailable: z.literal(true),
  supportedProfile: z.string(),
  supportedEffects: z.array(z.string()),
  unsupportedFeatures: z.array(z.string())
});

export type RenderEngineCapability = z.infer<typeof RenderEngineCapabilitySchema>;

export function getRenderEngineCapability(): RenderEngineCapability {
  return {
    stage: "step-5-ffmpeg-pipeline",
    exportAvailable: true,
    supportedProfile: "1080x1920 30 FPS Vertical MP4 (H.264 yuv420p + AAC 48kHz)",
    supportedEffects: [
      "brightness",
      "contrast",
      "saturation",
      "blur",
      "grayscale",
      "playbackSpeed (0.25x-4.0x with chained atempo)",
      "audioFadeIn / audioFadeOut",
      "transition:fade",
      "textOverlay (drawtext with full filtergraph escaping)"
    ],
    unsupportedFeatures: [
      "4K UHD export (unverified / disabled)",
      "GPU hardware acceleration (NVENC/QSV/AMF not claimed)",
      "3D camera warp transitions"
    ]
  };
}

export interface RemotionSequenceItem {
  clipId: string;
  trackId: string;
  trackKind: "video" | "audio" | "text";
  from: number;
  durationInFrames: number;
  playbackRate: number;
  text?: string;
}

export interface RemotionCompositionDescriptor {
  id: string;
  width: number;
  height: number;
  fps: number;
  rationalFps: string;
  durationInFrames: number;
  sequences: RemotionSequenceItem[];
}

export function buildRemotionCompositionDescriptor(
  project: Project
): RemotionCompositionDescriptor {
  const validated = ProjectSchema.parse(project);
  const fps = getFrameRateValue(validated.timeline.frameRate);
  const rationalFps = formatRationalFrameRate(validated.timeline.frameRate);
  const sequences: RemotionSequenceItem[] = [];
  let maxEnd = 0;

  for (const track of validated.timeline.tracks) {
    if (!track.visible || track.muted) continue;
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > maxEnd) maxEnd = end;
      sequences.push({
        clipId: clip.id,
        trackId: track.id,
        trackKind: track.kind,
        from: clip.startFrame,
        durationInFrames: clip.durationFrames,
        playbackRate: clip.playbackSpeed,
        text: clip.textOverlay?.text
      });
    }
  }

  return {
    id: validated.id,
    width: validated.timeline.resolution.width,
    height: validated.timeline.resolution.height,
    fps,
    rationalFps,
    durationInFrames: Math.max(Math.ceil(fps), maxEnd),
    sequences
  };
}

/**
 * Escapes untrusted caption / textOverlay strings for FFmpeg `drawtext` inside `-filter_complex`.
 * Handles backslashes (`\`), colons (`:`), commas (`,`), semicolons (`;`), brackets (`[` `]`),
 * single quotes (`'`), double quotes (`"`), percent signs (`%`), and multiline text (`\r\n`, `\n`).
 *
 * In FFmpeg's `avfilter_graph_parse2`:
 * - Level 1 (option parser): `\` escapes `:`, `'`, and `\`
 * - Level 2 (filtergraph parser): `\` escapes `,`, `;`, `[`, `]`, `'`, `"`, and `\`
 */
export function escapeFfmpegDrawtextValue(rawText: string): string {
  const normalizedNewlines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  for (const ch of normalizedNewlines) {
    switch (ch) {
      case "\\":
        out += "\\\\\\\\";
        break;
      case "'":
        out += "\\\\\\'";
        break;
      case '"':
        out += '\\\\"';
        break;
      case ":":
        out += "\\\\:";
        break;
      case ",":
        out += "\\,";
        break;
      case ";":
        out += "\\;";
        break;
      case "[":
        out += "\\[";
        break;
      case "]":
        out += "\\]";
        break;
      case "%":
        out += "%%";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

/**
 * Builds an accurate FFmpeg `atempo` filter chain across the full 0.25x–4.0x range.
 * Since each FFmpeg `atempo` instance only accepts [0.5, 2.0], speeds <0.5 or >2.0
 * are decomposed into chained `atempo` filters (e.g. 0.25x -> `atempo=0.5000,atempo=0.5000`;
 * 4.0x -> `atempo=2.0000,atempo=2.0000`).
 * Explicitly rejects unsupported speeds outside [0.25, 4.0].
 */
export function buildAtempoFilterChain(playbackSpeed: number): string[] {
  if (!Number.isFinite(playbackSpeed) || playbackSpeed < 0.25 || playbackSpeed > 4.0) {
    throw new Error(
      `Unsupported audio playbackSpeed (${playbackSpeed}): must be between 0.25x and 4.0x`
    );
  }
  if (Math.abs(playbackSpeed - 1.0) < 1e-6) {
    return [];
  }

  const chain: string[] = [];
  let remaining = playbackSpeed;

  while (remaining < 0.5 - 1e-9) {
    chain.push("atempo=0.5000");
    remaining /= 0.5;
  }
  while (remaining > 2.0 + 1e-9) {
    chain.push("atempo=2.0000");
    remaining /= 2.0;
  }
  if (Math.abs(remaining - 1.0) >= 1e-4 || chain.length === 0) {
    const clampedFinal = Math.max(0.5, Math.min(2.0, remaining));
    chain.push(`atempo=${clampedFinal.toFixed(4)}`);
  }

  return chain;
}

function resolveSystemFontPath(): string | undefined {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf"
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function buildVideoClipFilterChain(clip: Clip, fps: number): string[] {
  const filters: string[] = [];
  for (const effect of clip.effects) {
    if (effect.type === "brightness") {
      filters.push(`eq=brightness=${effect.value.toFixed(2)}`);
    } else if (effect.type === "contrast") {
      filters.push(`eq=contrast=${effect.value.toFixed(2)}`);
    } else if (effect.type === "saturation") {
      filters.push(`eq=saturation=${effect.value.toFixed(2)}`);
    } else if (effect.type === "blur" && effect.value > 0) {
      const radius = Math.max(1, Math.min(20, Math.round(effect.value)));
      filters.push(`boxblur=${radius}:1`);
    } else if (effect.type === "grayscale" && effect.value === 1) {
      filters.push("hue=s=0");
    }
  }

  const clipDurationSec = clip.durationFrames / fps;
  if (
    clip.transitionIn &&
    clip.transitionIn.type !== "none" &&
    clip.transitionIn.durationFrames > 0
  ) {
    const dur = (clip.transitionIn.durationFrames / fps).toFixed(3);
    filters.push(`fade=t=in:st=0:d=${dur}`);
  }
  if (
    clip.transitionOut &&
    clip.transitionOut.type !== "none" &&
    clip.transitionOut.durationFrames > 0
  ) {
    const durSec = clip.transitionOut.durationFrames / fps;
    const stSec = Math.max(0, clipDurationSec - durSec);
    filters.push(`fade=t=out:st=${stSec.toFixed(3)}:d=${durSec.toFixed(3)}`);
  }

  return filters;
}

export function buildFfmpegRenderCommand(
  project: Project,
  projectDir: string,
  outputFilePath: string
): { args: string[]; totalDurationFrames: number; fps: number; rationalFps: string } {
  const validated = ProjectSchema.parse(project);
  const width = validated.timeline.resolution.width;
  const height = validated.timeline.resolution.height;
  const fps = getFrameRateValue(validated.timeline.frameRate);
  const rationalFps = formatRationalFrameRate(validated.timeline.frameRate);

  const assetMap = new Map(validated.assets.map((a) => [a.id, a]));
  const videoTracks = validated.timeline.tracks.filter((t) => t.kind === "video" && t.visible);
  const textTracks = validated.timeline.tracks.filter((t) => t.kind === "text" && t.visible);
  const audioTracks = validated.timeline.tracks.filter((t) => t.kind === "audio" && !t.muted);

  const allVideoClips = videoTracks
    .flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })))
    .sort((a, b) => a.clip.startFrame - b.clip.startFrame);

  const allTextClips = textTracks
    .flatMap((t) => t.clips)
    .filter((c) => Boolean(c.textOverlay));

  const allAudioClips = audioTracks.flatMap((t) =>
    t.clips.map((c) => ({ clip: c, track: t }))
  );

  let maxEndFrame = 0;
  for (const t of validated.timeline.tracks) {
    if (!t.visible && t.kind !== "audio") continue;
    for (const c of t.clips) {
      const end = c.startFrame + c.durationFrames;
      if (end > maxEndFrame) maxEndFrame = end;
    }
  }
  const totalDurationFrames = Math.max(Math.ceil(fps), maxEndFrame);
  const totalDurationSec = Number((totalDurationFrames / fps).toFixed(3));

  const args: string[] = ["-y"];
  args.push(
    "-f",
    "lavfi",
    "-i",
    `color=c=${validated.settings.backgroundColor.replace("#", "0x")}:s=${width}x${height}:r=${rationalFps}:d=${totalDurationSec}`
  );
  args.push(
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=${validated.settings.audioSampleRate}`,
    "-t",
    String(totalDurationSec)
  );

  let nextInputIdx = 2;
  const videoClipInputs: Array<{
    inputIdx: number;
    clip: Clip;
    trackMuted: boolean;
    trackVolume: number;
    hasAudio: boolean;
  }> = [];
  for (const item of allVideoClips) {
    const asset = item.clip.assetId ? assetMap.get(item.clip.assetId) : undefined;
    if (!asset) continue;
    const mediaPath = validateSafeProjectPath(projectDir, asset.relativePath);
    args.push("-i", mediaPath);
    videoClipInputs.push({
      inputIdx: nextInputIdx++,
      clip: item.clip,
      trackMuted: item.track.muted,
      trackVolume: item.track.volume,
      hasAudio: asset.hasAudio
    });
  }

  const audioClipInputs: Array<{ inputIdx: number; clip: Clip; trackVolume: number }> = [];
  for (const item of allAudioClips) {
    const asset = item.clip.assetId ? assetMap.get(item.clip.assetId) : undefined;
    if (!asset) continue;
    const mediaPath = validateSafeProjectPath(projectDir, asset.relativePath);
    args.push("-i", mediaPath);
    audioClipInputs.push({
      inputIdx: nextInputIdx++,
      clip: item.clip,
      trackVolume: item.track.volume
    });
  }

  const filterParts: string[] = [];
  let currentVideoLabel = "[0:v]";
  const audioMixLabels: string[] = ["[1:a]"];

  videoClipInputs.forEach((vItem, idx) => {
    const { inputIdx, clip } = vItem;
    const srcStartSec = (clip.sourceInFrame / fps).toFixed(3);
    const srcSpanFrames =
      clip.sourceOutFrame !== undefined
        ? clip.sourceOutFrame - clip.sourceInFrame
        : clip.durationFrames * clip.playbackSpeed;
    const srcDurationSec = (srcSpanFrames / fps).toFixed(3);
    const dstStartSec = (clip.startFrame / fps).toFixed(3);
    const dstEndSec = ((clip.startFrame + clip.durationFrames) / fps).toFixed(3);
    const speedPts = (1 / clip.playbackSpeed).toFixed(4);

    const effectChain = buildVideoClipFilterChain(clip, fps);
    const chainStr = [
      `trim=start=${srcStartSec}:duration=${srcDurationSec}`,
      `setpts=${speedPts}*(PTS-STARTPTS)`,
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      `setsar=1`,
      ...effectChain,
      `setpts=PTS+${dstStartSec}/TB`
    ].join(",");

    const clipLabel = `[vclip${idx}]`;
    const nextOverlayLabel = `[vstage${idx}]`;
    filterParts.push(`[${inputIdx}:v]${chainStr}${clipLabel}`);
    filterParts.push(
      `${currentVideoLabel}${clipLabel}overlay=x=0:y=0:enable='between(t,${dstStartSec},${dstEndSec})'${nextOverlayLabel}`
    );
    currentVideoLabel = nextOverlayLabel;

    if (vItem.hasAudio && !vItem.trackMuted && clip.volume > 0) {
      const aLabel = `[vaud${idx}]`;
      const delayMs = Math.round((clip.startFrame / fps) * 1000);
      const effectiveVol = (clip.volume * vItem.trackVolume).toFixed(3);
      const aFilters: string[] = [
        `atrim=start=${srcStartSec}:duration=${srcDurationSec}`,
        `asetpts=PTS-STARTPTS`,
        ...buildAtempoFilterChain(clip.playbackSpeed),
        `volume=${effectiveVol}`
      ];
      if (clip.fadeInFrames > 0) {
        aFilters.push(`afade=t=in:st=0:d=${(clip.fadeInFrames / fps).toFixed(3)}`);
      }
      if (clip.fadeOutFrames > 0) {
        const outDur = clip.fadeOutFrames / fps;
        const outSt = Math.max(0, clip.durationFrames / fps - outDur);
        aFilters.push(`afade=t=out:st=${outSt.toFixed(3)}:d=${outDur.toFixed(3)}`);
      }
      if (delayMs > 0) {
        aFilters.push(`adelay=${delayMs}|${delayMs}`);
      }
      filterParts.push(`[${inputIdx}:a]${aFilters.join(",")}${aLabel}`);
      audioMixLabels.push(aLabel);
    }
  });

  const fontFile = resolveSystemFontPath();
  if (fontFile && allTextClips.length > 0) {
    allTextClips.forEach((tClip, idx) => {
      const overlay = tClip.textOverlay!;
      const startSec = (tClip.startFrame / fps).toFixed(3);
      const endSec = ((tClip.startFrame + tClip.durationFrames) / fps).toFixed(3);
      const safeText = escapeFfmpegDrawtextValue(overlay.text);
      const nextLabel = `[vtxt${idx}]`;
      const fontColor = overlay.fontColor.replace("#", "0x");
      const drawtextFilter = `drawtext=fontfile='${fontFile}':expansion=none:text=${safeText}:fontsize=${overlay.fontSize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=${overlay.y}:enable='between(t,${startSec},${endSec})'`;
      filterParts.push(`${currentVideoLabel}${drawtextFilter}${nextLabel}`);
      currentVideoLabel = nextLabel;
    });
  }

  audioClipInputs.forEach((aItem, idx) => {
    const { inputIdx, clip, trackVolume } = aItem;
    const srcStartSec = (clip.sourceInFrame / fps).toFixed(3);
    const srcSpanFrames =
      clip.sourceOutFrame !== undefined
        ? clip.sourceOutFrame - clip.sourceInFrame
        : clip.durationFrames * clip.playbackSpeed;
    const srcDurationSec = (srcSpanFrames / fps).toFixed(3);
    const delayMs = Math.round((clip.startFrame / fps) * 1000);
    const effectiveVol = (clip.volume * trackVolume).toFixed(3);
    const aLabel = `[aaud${idx}]`;

    const aFilters: string[] = [
      `atrim=start=${srcStartSec}:duration=${srcDurationSec}`,
      `asetpts=PTS-STARTPTS`,
      ...buildAtempoFilterChain(clip.playbackSpeed),
      `volume=${effectiveVol}`
    ];
    if (clip.fadeInFrames > 0) {
      aFilters.push(`afade=t=in:st=0:d=${(clip.fadeInFrames / fps).toFixed(3)}`);
    }
    if (clip.fadeOutFrames > 0) {
      const outDur = clip.fadeOutFrames / fps;
      const outSt = Math.max(0, clip.durationFrames / fps - outDur);
      aFilters.push(`afade=t=out:st=${outSt.toFixed(3)}:d=${outDur.toFixed(3)}`);
    }
    if (delayMs > 0) {
      aFilters.push(`adelay=${delayMs}|${delayMs}`);
    }
    filterParts.push(`[${inputIdx}:a]${aFilters.join(",")}${aLabel}`);
    audioMixLabels.push(aLabel);
  });

  filterParts.push(`${currentVideoLabel}format=yuv420p[vout]`);
  if (audioMixLabels.length === 1) {
    filterParts.push(`[1:a]atrim=duration=${totalDurationSec}[aout]`);
  } else {
    filterParts.push(
      `${audioMixLabels.join("")}amix=inputs=${audioMixLabels.length}:duration=first:dropout_transition=0,atrim=duration=${totalDurationSec}[aout]`
    );
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-r",
    rationalFps,
    "-c:a",
    "aac",
    "-ar",
    String(validated.settings.audioSampleRate),
    "-t",
    String(totalDurationSec),
    path.resolve(outputFilePath)
  );

  return { args, totalDurationFrames, fps, rationalFps };
}

export interface RenderOutputValidation {
  valid: boolean;
  probe: MediaProbeResult;
  extractedFramePath?: string;
}

export function validateRenderedOutput(
  outputFilePath: string,
  expected: { width: number; height: number; fps: number; maxOutputBytes?: number },
  extractFrameToPath?: string
): RenderOutputValidation {
  const probe = probeMediaFile(outputFilePath, expected.fps, {
    maxBytes: expected.maxOutputBytes ?? MAX_RENDERED_OUTPUT_BYTES
  });
  const fpsMatches = Math.abs(probe.fps - expected.fps) <= 0.05;
  const valid =
    probe.hasVideo &&
    probe.hasAudio &&
    probe.width === expected.width &&
    probe.height === expected.height &&
    fpsMatches &&
    probe.sizeBytes > 0 &&
    probe.sizeBytes <= (expected.maxOutputBytes ?? MAX_RENDERED_OUTPUT_BYTES);

  if (extractFrameToPath) {
    const resolvedFrame = path.resolve(extractFrameToPath);
    fs.mkdirSync(path.dirname(resolvedFrame), { recursive: true });
    execFileSync(
      "ffmpeg",
      ["-y", "-i", path.resolve(outputFilePath), "-frames:v", "1", resolvedFrame],
      { stdio: "pipe", timeout: 10000 }
    );
    return { valid, probe, extractedFramePath: resolvedFrame };
  }

  return { valid, probe };
}

export interface RenderJobRecord {
  jobId: string;
  projectId: string;
  status: RenderJobStatus;
  progressPercent: number;
  outputFilePath: string;
  tempDir: string;
  startedAtIso: string;
  completedAtIso?: string;
  errorMessage?: string;
  validation?: RenderOutputValidation;
}

export class RenderJobQueue {
  private readonly jobs = new Map<string, RenderJobRecord>();
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly tempRootDir: string;

  constructor(tempRootDir: string) {
    this.tempRootDir = path.resolve(tempRootDir);
    fs.mkdirSync(this.tempRootDir, { recursive: true });
  }

  public getJob(jobId: string): RenderJobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  public listJobs(): RenderJobRecord[] {
    return Array.from(this.jobs.values()).map((j) => structuredClone(j));
  }

  public renderProjectSync(input: {
    jobId: string;
    project: Project;
    projectDir: string;
    outputFilePath: string;
    extractSampleFrame?: boolean;
  }): RenderJobRecord {
    const tempDir = validateSafeProjectPath(this.tempRootDir, `job-${input.jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const resolvedOut = path.resolve(input.outputFilePath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

    const record: RenderJobRecord = {
      jobId: input.jobId,
      projectId: input.project.id,
      status: "running",
      progressPercent: 10,
      outputFilePath: resolvedOut,
      tempDir,
      startedAtIso: new Date().toISOString()
    };
    this.jobs.set(input.jobId, record);

    try {
      const { args, fps } = buildFfmpegRenderCommand(
        input.project,
        input.projectDir,
        resolvedOut
      );
      execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 60000 });
      record.progressPercent = 90;

      const sampleFramePath = input.extractSampleFrame
        ? path.join(path.dirname(resolvedOut), `${input.jobId}-frame1.png`)
        : undefined;

      const validation = validateRenderedOutput(
        resolvedOut,
        {
          width: input.project.timeline.resolution.width,
          height: input.project.timeline.resolution.height,
          fps
        },
        sampleFramePath
      );

      if (!validation.valid) {
        throw new Error("Rendered output failed post-render ffprobe validation");
      }

      record.status = "completed";
      record.progressPercent = 100;
      record.completedAtIso = new Date().toISOString();
      record.validation = validation;
    } catch (err) {
      record.status = "failed";
      record.completedAtIso = new Date().toISOString();
      record.errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return structuredClone(record);
  }

  public startRenderJob(input: {
    jobId: string;
    project: Project;
    projectDir: string;
    outputFilePath: string;
  }): Promise<RenderJobRecord> {
    const tempDir = validateSafeProjectPath(this.tempRootDir, `job-${input.jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const resolvedOut = path.resolve(input.outputFilePath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

    const record: RenderJobRecord = {
      jobId: input.jobId,
      projectId: input.project.id,
      status: "running",
      progressPercent: 5,
      outputFilePath: resolvedOut,
      tempDir,
      startedAtIso: new Date().toISOString()
    };
    this.jobs.set(input.jobId, record);

    const { args, fps } = buildFfmpegRenderCommand(
      input.project,
      input.projectDir,
      resolvedOut
    );

    return new Promise((resolve) => {
      const child = execFile("ffmpeg", args, { timeout: 60000 }, (error) => {
        this.activeProcesses.delete(input.jobId);
        fs.rmSync(tempDir, { recursive: true, force: true });

        if (record.status === "cancelled") {
          if (fs.existsSync(resolvedOut)) {
            fs.rmSync(resolvedOut, { force: true });
          }
          resolve(structuredClone(record));
          return;
        }

        if (error) {
          record.status = "failed";
          record.completedAtIso = new Date().toISOString();
          record.errorMessage = error.message;
          resolve(structuredClone(record));
          return;
        }

        try {
          const validation = validateRenderedOutput(resolvedOut, {
            width: input.project.timeline.resolution.width,
            height: input.project.timeline.resolution.height,
            fps
          });
          record.status = validation.valid ? "completed" : "failed";
          record.progressPercent = validation.valid ? 100 : record.progressPercent;
          record.completedAtIso = new Date().toISOString();
          record.validation = validation;
        } catch (valErr) {
          record.status = "failed";
          record.completedAtIso = new Date().toISOString();
          record.errorMessage = valErr instanceof Error ? valErr.message : String(valErr);
        }
        resolve(structuredClone(record));
      });

      this.activeProcesses.set(input.jobId, child);
    });
  }

  public cancelJob(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;

    record.status = "cancelled";
    record.completedAtIso = new Date().toISOString();
    const proc = this.activeProcesses.get(jobId);
    if (proc) {
      proc.kill("SIGTERM");
      this.activeProcesses.delete(jobId);
    }
    fs.rmSync(record.tempDir, { recursive: true, force: true });
    return true;
  }
}
