import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  isSafeRelativeMediaPath,
  type MediaAsset,
  type Project,
  type ProjectRepository,
  ProjectSchema,
  validateSafeProjectPath
} from "@frameforge/project-schema";

export const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm"] as const;
export const SUPPORTED_AUDIO_EXTENSIONS = [".wav", ".mp3", ".aac", ".flac"] as const;
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const SUPPORTED_SUBTITLE_EXTENSIONS = [".srt", ".vtt", ".json"] as const;

export const MAX_MEDIA_FILE_BYTES = 500 * 1024 * 1024; // 500 MB quota

export const MediaProbeDescriptorSchema = z.object({
  extension: z.string().startsWith("."),
  supported: z.boolean(),
  category: z.enum(["video", "audio", "image", "subtitle", "unknown"])
});

export type MediaProbeDescriptor = z.infer<typeof MediaProbeDescriptorSchema>;

export function classifyMediaExtension(rawExtension: string): MediaProbeDescriptor {
  const normalized = rawExtension.trim().toLowerCase();
  const ext = normalized.startsWith(".") ? normalized : `.${normalized}`;

  if ((SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return { extension: ext, supported: true, category: "video" };
  }
  if ((SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    return { extension: ext, supported: true, category: "audio" };
  }
  if ((SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { extension: ext, supported: true, category: "image" };
  }
  if ((SUPPORTED_SUBTITLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { extension: ext, supported: true, category: "subtitle" };
  }
  return { extension: ext, supported: false, category: "unknown" };
}

export const MediaProbeResultSchema = z.object({
  filePath: z.string().min(1),
  category: z.enum(["video", "audio", "image", "subtitle"]),
  durationSeconds: z.number().nonnegative(),
  durationFrames: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  sizeBytes: z.number().int().nonnegative()
});

export type MediaProbeResult = z.infer<typeof MediaProbeResultSchema>;

/**
 * Inspects a local media file using ffprobe with array arguments (never shell interpolation).
 */
export function probeMediaFile(filePath: string, targetFps = 30): MediaProbeResult {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("Invalid media file path");
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Media file does not exist: ${resolved}`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not permitted for media probing: ${resolved}`);
  }
  if (stat.size > MAX_MEDIA_FILE_BYTES) {
    throw new Error(`Media file exceeds maximum allowed quota (${stat.size} bytes)`);
  }

  const extInfo = classifyMediaExtension(path.extname(resolved));
  if (!extInfo.supported || extInfo.category === "unknown") {
    throw new Error(`Unsupported media file extension: ${extInfo.extension}`);
  }

  if (extInfo.category === "subtitle") {
    return {
      filePath: resolved,
      category: "subtitle",
      durationSeconds: 1,
      durationFrames: targetFps,
      fps: targetFps,
      hasVideo: false,
      hasAudio: false,
      sizeBytes: stat.size
    };
  }

  const rawJson = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,duration",
      "-of",
      "json",
      resolved
    ],
    { encoding: "utf8", timeout: 15000 }
  );

  const parsed = JSON.parse(rawJson) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string; size?: string };
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  let fps = targetFps;
  if (videoStream?.r_frame_rate) {
    const parts = videoStream.r_frame_rate.split("/");
    const num = Number(parts[0]);
    const den = Number(parts[1] ?? "1");
    if (num > 0 && den > 0) {
      fps = Math.round((num / den) * 100) / 100;
    }
  }

  const durationSecondsRaw = Number(
    parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? "1"
  );
  const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
    ? durationSecondsRaw
    : 1;
  const durationFrames = Math.max(1, Math.round(durationSeconds * targetFps));

  return MediaProbeResultSchema.parse({
    filePath: resolved,
    category: extInfo.category,
    durationSeconds,
    durationFrames,
    width: videoStream?.width,
    height: videoStream?.height,
    fps,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    sizeBytes: stat.size
  });
}

/**
 * Safely copies and registers a local media file into a project's `media/` directory.
 */
export function importMediaIntoProject(
  repo: ProjectRepository,
  project: Project,
  sourceFilePath: string,
  options: { assetId: string; name?: string }
): { project: Project; asset: MediaAsset; probe: MediaProbeResult } {
  const fps =
    project.timeline.frameRate.numerator / (project.timeline.frameRate.denominator || 1);
  const probe = probeMediaFile(sourceFilePath, fps);

  const rawBasename = path.basename(sourceFilePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const relativePath = `media/${options.assetId}-${rawBasename}`;
  if (!isSafeRelativeMediaPath(relativePath)) {
    throw new Error(`Generated relative media path is unsafe: ${relativePath}`);
  }

  const projectDir = repo.getProjectDir(project.id);
  const destPath = validateSafeProjectPath(projectDir, relativePath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(probe.filePath, destPath);

  const asset: MediaAsset = {
    id: options.assetId,
    name: options.name ?? rawBasename,
    kind: probe.category,
    relativePath,
    durationFrames: probe.durationFrames,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
    codec: probe.videoCodec ?? probe.audioCodec,
    sizeBytes: probe.sizeBytes
  };

  const nextProject = structuredClone(project);
  nextProject.assets.push(asset);
  nextProject.updatedAtIso = new Date().toISOString();
  const validated = ProjectSchema.parse(nextProject);
  repo.saveProject(validated);

  return { project: validated, asset, probe };
}

/**
 * Generates a small deterministic vertical MP4 or WAV fixture using FFmpeg without shell strings.
 */
export function generateDeterministicMediaFixture(
  targetFilePath: string,
  options?: {
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    color?: string;
    frequencyHz?: number;
    audioOnly?: boolean;
  }
): string {
  const resolved = path.resolve(targetFilePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const duration = options?.durationSeconds ?? 2;
  const width = options?.width ?? 1080;
  const height = options?.height ?? 1920;
  const fps = options?.fps ?? 30;
  const color = options?.color ?? "0x1e293b";
  const freq = options?.frequencyHz ?? 440;

  if (options?.audioOnly) {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${freq}:sample_rate=48000:duration=${duration}`,
        "-c:a",
        "pcm_s16le",
        resolved
      ],
      { stdio: "pipe", timeout: 15000 }
    );
    return resolved;
  }

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${width}x${height}:r=${fps}:d=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:sample_rate=48000:duration=${duration}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-shortest",
      resolved
    ],
    { stdio: "pipe", timeout: 20000 }
  );

  return resolved;
}
