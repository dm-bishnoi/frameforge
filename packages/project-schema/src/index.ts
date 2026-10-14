import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export const LEGACY_SCHEMA_VERSION = "0.1.0" as const;
export const SCHEMA_VERSION = "0.2.0" as const;
export const MAX_PROJECT_JSON_BYTES = 10 * 1024 * 1024; // 10 MB

export const ResolutionSchema = z
  .object({
    width: z.number().int().positive().max(3840),
    height: z.number().int().positive().max(3840)
  })
  .strict();

export type Resolution = z.infer<typeof ResolutionSchema>;

export const FrameRateSchema = z
  .object({
    numerator: z.number().int().positive().max(240),
    denominator: z.number().int().positive().default(1)
  })
  .strict();

export type FrameRate = z.infer<typeof FrameRateSchema>;

export const ProjectSettingsSchema = z
  .object({
    resolution: ResolutionSchema.default({ width: 1080, height: 1920 }),
    frameRate: FrameRateSchema.default({ numerator: 30, denominator: 1 }),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Background color must be a 6-digit hex color")
      .default("#000000"),
    audioSampleRate: z.number().int().positive().default(48000)
  })
  .strict();

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * Validates that a media relative path is strictly inside `media/` with no traversal,
 * null bytes, backslashes, drive letters, or leading slashes.
 */
export function isSafeRelativeMediaPath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  if (relPath.includes("\0") || relPath.includes("\\")) return false;
  if (/%2e/i.test(relPath) || /%2f/i.test(relPath) || /%5c/i.test(relPath)) return false;
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith("/") || relPath.startsWith("~")) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized === ".") {
    return false;
  }
  if (!normalized.startsWith("media/") || normalized === "media" || normalized === "media/") {
    return false;
  }
  return true;
}

/**
 * Resolves a candidate path inside a base root directory, rejecting path traversal,
 * null bytes, and symbolic links that escape the base directory.
 */
export function validateSafeProjectPath(baseRootDir: string, candidateSubPath: string): string {
  if (!candidateSubPath || typeof candidateSubPath !== "string") {
    throw new Error("Path validation failed: empty path");
  }
  if (candidateSubPath.includes("\0")) {
    throw new Error("Path validation failed: null byte detected");
  }
  if (/%2e/i.test(candidateSubPath)) {
    throw new Error("Path validation failed: encoded traversal sequence detected");
  }
  if (path.isAbsolute(candidateSubPath) || /^[a-zA-Z]:/.test(candidateSubPath)) {
    throw new Error(`Path validation failed: absolute path not allowed (${candidateSubPath})`);
  }

  const resolvedBase = path.resolve(baseRootDir);
  const resolvedTarget = path.resolve(resolvedBase, candidateSubPath);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path validation failed: path escapes root directory (${candidateSubPath})`);
  }

  if (fs.existsSync(resolvedBase)) {
    const realBase = fs.realpathSync(resolvedBase);
    let current = resolvedTarget;
    while (!fs.existsSync(current) && current !== path.dirname(current)) {
      current = path.dirname(current);
    }
    if (fs.existsSync(current)) {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        const realTarget = fs.realpathSync(current);
        const relReal = path.relative(realBase, realTarget);
        if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
          throw new Error(`Path validation failed: symlink escapes root directory (${candidateSubPath})`);
        }
      }
    }
  }

  return resolvedTarget;
}

export const MediaKindSchema = z.enum(["video", "audio", "image", "subtitle"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaAssetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: MediaKindSchema,
    relativePath: z
      .string()
      .min(1)
      .refine(isSafeRelativeMediaPath, "Media path must be a safe relative path inside media/"),
    durationFrames: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    hasAudio: z.boolean().default(false),
    codec: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional()
  })
  .strict();

export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const TextPresetIdSchema = z.enum([
  "title-bold",
  "lower-third",
  "caption-pill",
  "center-callout"
]);
export type TextPresetId = z.infer<typeof TextPresetIdSchema>;

export const TextOverlaySchema = z
  .object({
    text: z.string().min(1).max(500),
    preset: TextPresetIdSchema.default("center-callout"),
    fontSize: z.number().int().min(12).max(200).default(48),
    fontColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Font color must be a 6-digit hex color")
      .default("#FFFFFF"),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Background color must be hex")
      .default("#000000"),
    x: z.number().int().min(0).max(3840).default(540),
    y: z.number().int().min(0).max(3840).default(960)
  })
  .strict();

export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const FilterTypeSchema = z.enum([
  "brightness",
  "contrast",
  "saturation",
  "blur",
  "grayscale"
]);
export type FilterType = z.infer<typeof FilterTypeSchema>;

export const FilterEffectSchema = z
  .object({
    type: FilterTypeSchema,
    value: z.number()
  })
  .strict()
  .superRefine((effect, ctx) => {
    if (effect.type === "brightness" && (effect.value < -1 || effect.value > 1)) {
      ctx.addIssue({ path: ["value"], message: "brightness must be between -1 and 1" });
    }
    if (effect.type === "contrast" && (effect.value < 0 || effect.value > 3)) {
      ctx.addIssue({ path: ["value"], message: "contrast must be between 0 and 3" });
    }
    if (effect.type === "saturation" && (effect.value < 0 || effect.value > 3)) {
      ctx.addIssue({ path: ["value"], message: "saturation must be between 0 and 3" });
    }
    if (effect.type === "blur" && (effect.value < 0 || effect.value > 50)) {
      ctx.addIssue({ path: ["value"], message: "blur must be between 0 and 50" });
    }
    if (effect.type === "grayscale" && effect.value !== 0 && effect.value !== 1) {
      ctx.addIssue({ path: ["value"], message: "grayscale must be 0 or 1" });
    }
  });

export type FilterEffect = z.infer<typeof FilterEffectSchema>;

export const TransitionTypeSchema = z.enum(["none", "fade", "wipeleft", "dissolve"]);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

export const TransitionSpecSchema = z
  .object({
    type: TransitionTypeSchema.default("none"),
    durationFrames: z.number().int().nonnegative().max(300).default(0)
  })
  .strict();

export type TransitionSpec = z.infer<typeof TransitionSpecSchema>;

export const KeyframePropertySchema = z.enum(["opacity", "scale", "x", "y"]);
export type KeyframeProperty = z.infer<typeof KeyframePropertySchema>;

export const KeyframePointSchema = z
  .object({
    frameOffset: z.number().int().nonnegative(),
    property: KeyframePropertySchema,
    value: z.number(),
    easing: z.enum(["linear"]).default("linear")
  })
  .strict()
  .superRefine((kf, ctx) => {
    if (kf.property === "opacity" && (kf.value < 0 || kf.value > 1)) {
      ctx.addIssue({ path: ["value"], message: "opacity keyframe must be between 0 and 1" });
    }
    if (kf.property === "scale" && (kf.value <= 0 || kf.value > 10)) {
      ctx.addIssue({ path: ["value"], message: "scale keyframe must be between 0 (exclusive) and 10" });
    }
  });

export type KeyframePoint = z.infer<typeof KeyframePointSchema>;

export const ClipSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(1).optional(),
    trackId: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    sourceInFrame: z.number().int().nonnegative().default(0),
    sourceOutFrame: z.number().int().positive().optional(),
    playbackSpeed: z.number().min(0.25).max(4.0).default(1.0),
    volume: z.number().min(0).max(2.0).default(1.0),
    fadeInFrames: z.number().int().nonnegative().default(0),
    fadeOutFrames: z.number().int().nonnegative().default(0),
    transitionIn: TransitionSpecSchema.optional(),
    transitionOut: TransitionSpecSchema.optional(),
    effects: z.array(FilterEffectSchema).default([]),
    keyframes: z.array(KeyframePointSchema).default([]),
    textOverlay: TextOverlaySchema.optional()
  })
  .strict()
  .superRefine((clip, ctx) => {
    if (clip.sourceOutFrame !== undefined && clip.sourceOutFrame <= clip.sourceInFrame) {
      ctx.addIssue({
        path: ["sourceOutFrame"],
        message: "sourceOutFrame must be strictly greater than sourceInFrame"
      });
    }
    if (clip.fadeInFrames + clip.fadeOutFrames > clip.durationFrames) {
      ctx.addIssue({
        path: ["fadeInFrames"],
        message: "Sum of fadeInFrames and fadeOutFrames cannot exceed clip durationFrames"
      });
    }
    for (let i = 0; i < clip.keyframes.length; i++) {
      const kf = clip.keyframes[i];
      if (kf && kf.frameOffset > clip.durationFrames) {
        ctx.addIssue({
          path: ["keyframes", i, "frameOffset"],
          message: "Keyframe frameOffset cannot exceed clip durationFrames"
        });
      }
    }
  });

export type Clip = z.infer<typeof ClipSchema>;

export const TrackKindSchema = z.enum(["video", "audio", "text"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: TrackKindSchema,
    visible: z.boolean().default(true),
    muted: z.boolean().default(false),
    locked: z.boolean().default(false),
    volume: z.number().min(0).max(2.0).default(1.0),
    clips: z.array(ClipSchema).default([])
  })
  .strict();

export type Track = z.infer<typeof TrackSchema>;

export const TimelineSchema = z
  .object({
    id: z.string().min(1),
    resolution: ResolutionSchema,
    frameRate: FrameRateSchema,
    tracks: z.array(TrackSchema).default([])
  })
  .strict();

export type Timeline = z.infer<typeof TimelineSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    createdAtIso: z.string().datetime(),
    updatedAtIso: z.string().datetime(),
    settings: ProjectSettingsSchema.default({
      resolution: { width: 1080, height: 1920 },
      frameRate: { numerator: 30, denominator: 1 },
      backgroundColor: "#000000",
      audioSampleRate: 48000
    }),
    assets: z.array(MediaAssetSchema).default([]),
    timeline: TimelineSchema
  })
  .strict()
  .superRefine((project, ctx) => {
    const assetIds = new Set<string>();
    const assetMap = new Map<string, MediaAsset>();
    for (let i = 0; i < project.assets.length; i++) {
      const asset = project.assets[i]!;
      if (assetIds.has(asset.id)) {
        ctx.addIssue({
          path: ["assets", i, "id"],
          message: `Duplicate media asset ID: ${asset.id}`
        });
      }
      assetIds.add(asset.id);
      assetMap.set(asset.id, asset);
    }

    const trackIds = new Set<string>();
    const clipIds = new Set<string>();

    for (let tIdx = 0; tIdx < project.timeline.tracks.length; tIdx++) {
      const track = project.timeline.tracks[tIdx]!;
      if (trackIds.has(track.id)) {
        ctx.addIssue({
          path: ["timeline", "tracks", tIdx, "id"],
          message: `Duplicate track ID: ${track.id}`
        });
      }
      trackIds.add(track.id);

      for (let cIdx = 0; cIdx < track.clips.length; cIdx++) {
        const clip = track.clips[cIdx]!;
        if (clipIds.has(clip.id)) {
          ctx.addIssue({
            path: ["timeline", "tracks", tIdx, "clips", cIdx, "id"],
            message: `Duplicate clip ID: ${clip.id}`
          });
        }
        clipIds.add(clip.id);

        if (clip.trackId !== track.id) {
          ctx.addIssue({
            path: ["timeline", "tracks", tIdx, "clips", cIdx, "trackId"],
            message: `Clip trackId (${clip.trackId}) does not match parent track (${track.id})`
          });
        }

        if (track.kind === "text") {
          if (!clip.textOverlay && !clip.assetId) {
            ctx.addIssue({
              path: ["timeline", "tracks", tIdx, "clips", cIdx],
              message: `Text track clip (${clip.id}) requires textOverlay or subtitle assetId`
            });
          }
        } else {
          if (!clip.assetId) {
            ctx.addIssue({
              path: ["timeline", "tracks", tIdx, "clips", cIdx, "assetId"],
              message: `${track.kind} clip (${clip.id}) requires an assetId`
            });
          } else {
            const referencedAsset = assetMap.get(clip.assetId);
            if (!referencedAsset) {
              ctx.addIssue({
                path: ["timeline", "tracks", tIdx, "clips", cIdx, "assetId"],
                message: `Clip (${clip.id}) references missing assetId (${clip.assetId})`
              });
            } else if (
              referencedAsset.durationFrames !== undefined &&
              clip.sourceOutFrame !== undefined &&
              clip.sourceOutFrame > referencedAsset.durationFrames
            ) {
              ctx.addIssue({
                path: ["timeline", "tracks", tIdx, "clips", cIdx, "sourceOutFrame"],
                message: `Clip sourceOutFrame (${clip.sourceOutFrame}) exceeds asset durationFrames (${referencedAsset.durationFrames})`
              });
            }
          }
        }
      }
    }
  });

export type Project = z.infer<typeof ProjectSchema>;

export interface CreateEmptyProjectInput {
  id: string;
  name: string;
  nowIso?: string;
  resolution?: Resolution;
  frameRate?: FrameRate;
  createDefaultTracks?: boolean;
}

export function createEmptyProject(input: CreateEmptyProjectInput): Project {
  const timestamp = input.nowIso ?? new Date().toISOString();
  const resolution = input.resolution ?? { width: 1080, height: 1920 };
  const frameRate = input.frameRate ?? { numerator: 30, denominator: 1 };

  const tracks: Track[] = input.createDefaultTracks
    ? [
        {
          id: "track-video-1",
          name: "Video 1",
          kind: "video",
          visible: true,
          muted: false,
          locked: false,
          volume: 1.0,
          clips: []
        },
        {
          id: "track-text-1",
          name: "Text Overlays",
          kind: "text",
          visible: true,
          muted: false,
          locked: false,
          volume: 1.0,
          clips: []
        },
        {
          id: "track-audio-1",
          name: "Audio 1",
          kind: "audio",
          visible: true,
          muted: false,
          locked: false,
          volume: 1.0,
          clips: []
        }
      ]
    : [];

  const raw: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    createdAtIso: timestamp,
    updatedAtIso: timestamp,
    settings: {
      resolution,
      frameRate,
      backgroundColor: "#000000",
      audioSampleRate: 48000
    },
    assets: [],
    timeline: {
      id: `${input.id}-timeline`,
      resolution,
      frameRate,
      tracks
    }
  };

  return ProjectSchema.parse(raw);
}

/**
 * Migrates a raw project payload from v0.1.0 (or current v0.2.0) to validated v0.2.0 Project.
 */
export function migrateProjectSchema(rawInput: unknown): Project {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw new Error("Cannot migrate non-object project payload");
  }
  const record = structuredClone(rawInput) as Record<string, unknown>;
  if (record.schemaVersion === LEGACY_SCHEMA_VERSION) {
    record.schemaVersion = SCHEMA_VERSION;
    const timeline = (record.timeline ?? {}) as Record<string, unknown>;
    const resolution = (timeline.resolution as Resolution | undefined) ?? {
      width: 1080,
      height: 1920
    };
    const frameRate = (timeline.frameRate as FrameRate | undefined) ?? {
      numerator: 30,
      denominator: 1
    };
    record.settings = {
      resolution,
      frameRate,
      backgroundColor: "#000000",
      audioSampleRate: 48000
    };
    if (Array.isArray(record.assets)) {
      record.assets = record.assets.map((rawAsset: Record<string, unknown>) => {
        const nextAsset = { ...rawAsset };
        if (typeof nextAsset.localPath === "string" && !nextAsset.relativePath) {
          const base = path.posix.basename(nextAsset.localPath);
          nextAsset.relativePath = `media/${base}`;
          delete nextAsset.localPath;
        }
        if (nextAsset.hasAudio === undefined) nextAsset.hasAudio = false;
        return nextAsset;
      });
    }
    if (Array.isArray(timeline.tracks)) {
      timeline.tracks = timeline.tracks.map((rawTrack: Record<string, unknown>) => {
        const nextTrack = {
          visible: true,
          muted: false,
          locked: false,
          volume: 1.0,
          ...rawTrack
        };
        if (Array.isArray(nextTrack.clips)) {
          nextTrack.clips = nextTrack.clips.map((rawClip: Record<string, unknown>) => {
            const nextClip = { ...rawClip };
            if (typeof nextClip.sourceStartFrame === "number") {
              nextClip.sourceInFrame = nextClip.sourceStartFrame;
              delete nextClip.sourceStartFrame;
            }
            return {
              sourceInFrame: 0,
              playbackSpeed: 1.0,
              volume: 1.0,
              fadeInFrames: 0,
              fadeOutFrames: 0,
              effects: [],
              keyframes: [],
              ...nextClip
            };
          });
        }
        return nextTrack;
      });
    }
  }
  return ProjectSchema.parse(record);
}

export interface VerticalVideoTemplate {
  id: string;
  name: string;
  description: string;
  resolution: Resolution;
  frameRate: FrameRate;
  defaultTextOverlays: Array<{
    id: string;
    startFrame: number;
    durationFrames: number;
    overlay: TextOverlay;
  }>;
}

export const VERTICAL_VIDEO_TEMPLATES: readonly VerticalVideoTemplate[] = [
  {
    id: "tiktok-hook-story-cta",
    name: "Vertical Hook + Story + CTA (9:16)",
    description: "Three-part short-form structure with bold opening hook and closing call-to-action",
    resolution: { width: 1080, height: 1920 },
    frameRate: { numerator: 30, denominator: 1 },
    defaultTextOverlays: [
      {
        id: "clip-text-hook",
        startFrame: 0,
        durationFrames: 45,
        overlay: {
          text: "STOP SCROLLING",
          preset: "title-bold",
          fontSize: 64,
          fontColor: "#FFFFFF",
          backgroundColor: "#000000",
          x: 540,
          y: 320
        }
      },
      {
        id: "clip-text-cta",
        startFrame: 45,
        durationFrames: 45,
        overlay: {
          text: "FOLLOW FOR MORE",
          preset: "caption-pill",
          fontSize: 48,
          fontColor: "#FACC15",
          backgroundColor: "#000000",
          x: 540,
          y: 1500
        }
      }
    ]
  },
  {
    id: "product-showcase-9x16",
    name: "Product Showcase (9:16)",
    description: "Clean vertical product feature highlight with lower-third label",
    resolution: { width: 1080, height: 1920 },
    frameRate: { numerator: 30, denominator: 1 },
    defaultTextOverlays: [
      {
        id: "clip-text-product",
        startFrame: 0,
        durationFrames: 60,
        overlay: {
          text: "FEATURE HIGHLIGHT",
          preset: "lower-third",
          fontSize: 44,
          fontColor: "#FFFFFF",
          backgroundColor: "#18181B",
          x: 540,
          y: 1600
        }
      }
    ]
  },
  {
    id: "podcast-clip-vertical",
    name: "Podcast Clip + Captions (9:16)",
    description: "Vertical speaker layout with centered dynamic captions",
    resolution: { width: 1080, height: 1920 },
    frameRate: { numerator: 30, denominator: 1 },
    defaultTextOverlays: [
      {
        id: "clip-text-caption-1",
        startFrame: 0,
        durationFrames: 60,
        overlay: {
          text: "KEY INSIGHT FROM EPISODE",
          preset: "caption-pill",
          fontSize: 52,
          fontColor: "#FFFFFF",
          backgroundColor: "#000000",
          x: 540,
          y: 1200
        }
      }
    ]
  }
];

export function createProjectFromTemplate(input: {
  id: string;
  name: string;
  templateId: string;
  nowIso?: string;
}): Project {
  const template = VERTICAL_VIDEO_TEMPLATES.find((t) => t.id === input.templateId);
  if (!template) {
    throw new Error(`Unknown vertical video template: ${input.templateId}`);
  }
  const base = createEmptyProject({
    id: input.id,
    name: input.name,
    nowIso: input.nowIso,
    resolution: template.resolution,
    frameRate: template.frameRate,
    createDefaultTracks: true
  });

  const textTrack = base.timeline.tracks.find((t) => t.kind === "text");
  if (textTrack) {
    textTrack.clips = template.defaultTextOverlays.map((item) => ({
      id: item.id,
      trackId: textTrack.id,
      startFrame: item.startFrame,
      durationFrames: item.durationFrames,
      sourceInFrame: 0,
      playbackSpeed: 1.0,
      volume: 1.0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      effects: [],
      keyframes: [],
      textOverlay: item.overlay
    }));
  }

  return ProjectSchema.parse(base);
}

export interface ProjectSummaryItem {
  id: string;
  name: string;
  updatedAtIso: string;
  projectDir: string;
  hasAutosave: boolean;
}

/**
 * Local-first Project Repository managing isolated project directories,
 * separating project metadata (`project.json`) from imported media (`media/`),
 * and providing deterministic autosave & recovery.
 */
export class ProjectRepository {
  public readonly workspaceProjectsRoot: string;

  constructor(workspaceProjectsRoot: string) {
    this.workspaceProjectsRoot = path.resolve(workspaceProjectsRoot);
    fs.mkdirSync(this.workspaceProjectsRoot, { recursive: true });
  }

  private assertSafeProjectId(projectId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) {
      throw new Error(`Invalid or unsafe project ID: ${projectId}`);
    }
  }

  public getProjectDir(projectId: string): string {
    this.assertSafeProjectId(projectId);
    return validateSafeProjectPath(this.workspaceProjectsRoot, projectId);
  }

  public getProjectMediaDir(projectId: string): string {
    const projectDir = this.getProjectDir(projectId);
    return validateSafeProjectPath(projectDir, "media");
  }

  public createProject(input: CreateEmptyProjectInput): Project {
    this.assertSafeProjectId(input.id);
    const projectDir = this.getProjectDir(input.id);
    const mediaDir = this.getProjectMediaDir(input.id);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    const project = createEmptyProject({
      createDefaultTracks: true,
      ...input
    });
    this.saveProject(project);
    return project;
  }

  public saveProject(project: Project): string {
    const validated = ProjectSchema.parse(project);
    const projectDir = this.getProjectDir(validated.id);
    const mediaDir = this.getProjectMediaDir(validated.id);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    const serialized = JSON.stringify(validated, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_JSON_BYTES) {
      throw new Error("Project metadata exceeds maximum allowed size (10 MB)");
    }

    const filePath = validateSafeProjectPath(projectDir, "project.json");
    const tmpPath = validateSafeProjectPath(projectDir, "project.json.tmp");
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, filePath);
    return filePath;
  }

  public autosaveProject(project: Project): string {
    const validated = ProjectSchema.parse(project);
    const projectDir = this.getProjectDir(validated.id);
    fs.mkdirSync(projectDir, { recursive: true });
    const serialized = JSON.stringify(validated, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_JSON_BYTES) {
      throw new Error("Project autosave exceeds maximum allowed size (10 MB)");
    }
    const autosavePath = validateSafeProjectPath(projectDir, "project.autosave.json");
    fs.writeFileSync(autosavePath, serialized, "utf8");
    return autosavePath;
  }

  public loadProject(projectId: string, options?: { allowAutosaveRecovery?: boolean }): Project {
    const projectDir = this.getProjectDir(projectId);
    const mainPath = validateSafeProjectPath(projectDir, "project.json");
    const autosavePath = validateSafeProjectPath(projectDir, "project.autosave.json");

    if (!fs.existsSync(mainPath)) {
      if (options?.allowAutosaveRecovery && fs.existsSync(autosavePath)) {
        return this.recoverFromAutosave(projectId);
      }
      throw new Error(`Project not found: ${projectId}`);
    }

    const stat = fs.statSync(mainPath);
    if (stat.size > MAX_PROJECT_JSON_BYTES) {
      throw new Error(`Project file exceeds size limit (${stat.size} bytes)`);
    }

    try {
      const rawText = fs.readFileSync(mainPath, "utf8");
      const parsed = JSON.parse(rawText);
      return migrateProjectSchema(parsed);
    } catch (err) {
      if (options?.allowAutosaveRecovery && fs.existsSync(autosavePath)) {
        return this.recoverFromAutosave(projectId);
      }
      throw new Error(
        `Failed to load project ${projectId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public recoverFromAutosave(projectId: string): Project {
    const projectDir = this.getProjectDir(projectId);
    const autosavePath = validateSafeProjectPath(projectDir, "project.autosave.json");
    if (!fs.existsSync(autosavePath)) {
      throw new Error(`No autosave file available for project ${projectId}`);
    }
    const rawText = fs.readFileSync(autosavePath, "utf8");
    const parsed = JSON.parse(rawText);
    const project = migrateProjectSchema(parsed);
    this.saveProject(project);
    return project;
  }

  public listProjects(): ProjectSummaryItem[] {
    if (!fs.existsSync(this.workspaceProjectsRoot)) return [];
    const entries = fs.readdirSync(this.workspaceProjectsRoot, { withFileTypes: true });
    const items: ProjectSummaryItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const projectDir = this.getProjectDir(entry.name);
        const mainPath = path.join(projectDir, "project.json");
        const autosavePath = path.join(projectDir, "project.autosave.json");
        if (!fs.existsSync(mainPath)) continue;
        const project = this.loadProject(entry.name, { allowAutosaveRecovery: true });
        items.push({
          id: project.id,
          name: project.name,
          updatedAtIso: project.updatedAtIso,
          projectDir,
          hasAutosave: fs.existsSync(autosavePath)
        });
      } catch {
        // Skip corrupted directories in summary listing
      }
    }

    return items.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
  }

  public resolveConfinedMediaFile(projectId: string, relativeMediaPath: string): string {
    if (!isSafeRelativeMediaPath(relativeMediaPath)) {
      throw new Error(`Unsafe media relative path rejected: ${relativeMediaPath}`);
    }
    const projectDir = this.getProjectDir(projectId);
    return validateSafeProjectPath(projectDir, relativeMediaPath);
  }
}
