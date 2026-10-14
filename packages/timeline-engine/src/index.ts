import {
  type Clip,
  type FilterEffect,
  type KeyframePoint,
  type KeyframeProperty,
  type Project,
  ProjectSchema,
  type TextOverlay,
  type Timeline,
  type Track,
  type TrackKind,
  type TransitionSpec
} from "@frameforge/project-schema";

export const TIMELINE_ENGINE_STAGE = "step-4-deterministic-engine" as const;

export interface TimelineSummary {
  timelineId: string;
  trackCount: number;
  clipCount: number;
  durationFrames: number;
}

export function summarizeTimeline(timeline: Timeline): TimelineSummary {
  let clipCount = 0;
  let maxEndFrame = 0;

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      clipCount += 1;
      const clipEnd = clip.startFrame + clip.durationFrames;
      if (clipEnd > maxEndFrame) {
        maxEndFrame = clipEnd;
      }
    }
  }

  return {
    timelineId: timeline.id,
    trackCount: timeline.tracks.length,
    clipCount,
    durationFrames: maxEndFrame
  };
}

function cloneAndValidate(project: Project): Project {
  const next = structuredClone(project);
  next.updatedAtIso = new Date().toISOString();
  return ProjectSchema.parse(next);
}

function assertTrackEditable(track: Track): void {
  if (track.locked) {
    throw new Error(`Track '${track.id}' is locked and cannot be modified`);
  }
}

function hasOverlap(clips: readonly Clip[], startFrame: number, durationFrames: number, ignoreClipId?: string): Clip | undefined {
  const endFrame = startFrame + durationFrames;
  return clips.find((c) => {
    if (c.id === ignoreClipId) return false;
    const cEnd = c.startFrame + c.durationFrames;
    return startFrame < cEnd && endFrame > c.startFrame;
  });
}

export function addTrack(
  project: Project,
  input: { id: string; name: string; kind: TrackKind }
): Project {
  const next = structuredClone(project);
  if (next.timeline.tracks.some((t) => t.id === input.id)) {
    throw new Error(`Duplicate track ID: ${input.id}`);
  }
  next.timeline.tracks.push({
    id: input.id,
    name: input.name,
    kind: input.kind,
    visible: true,
    muted: false,
    locked: false,
    volume: 1.0,
    clips: []
  });
  return cloneAndValidate(next);
}

export function setTrackState(
  project: Project,
  trackId: string,
  patch: Partial<Pick<Track, "visible" | "muted" | "locked" | "volume" | "name">>
): Project {
  const next = structuredClone(project);
  const track = next.timeline.tracks.find((t) => t.id === trackId);
  if (!track) {
    throw new Error(`Track not found: ${trackId}`);
  }
  if (patch.visible !== undefined) track.visible = patch.visible;
  if (patch.muted !== undefined) track.muted = patch.muted;
  if (patch.locked !== undefined) track.locked = patch.locked;
  if (patch.volume !== undefined) track.volume = patch.volume;
  if (patch.name !== undefined) track.name = patch.name;
  return cloneAndValidate(next);
}

export interface AddClipOptions {
  overlapPolicy?: "reject" | "shift-right";
}

export function addClipToTrack(
  project: Project,
  clipInput: Partial<Clip> & Pick<Clip, "id" | "trackId" | "startFrame" | "durationFrames">,
  options?: AddClipOptions
): Project {
  if (clipInput.startFrame < 0) {
    throw new Error("Clip startFrame cannot be negative");
  }
  if (clipInput.durationFrames <= 0) {
    throw new Error("Clip durationFrames must be positive");
  }

  const next = structuredClone(project);
  const track = next.timeline.tracks.find((t) => t.id === clipInput.trackId);
  if (!track) {
    throw new Error(`Target track not found: ${clipInput.trackId}`);
  }
  assertTrackEditable(track);

  const overlapPolicy = options?.overlapPolicy ?? "reject";
  let targetStartFrame = clipInput.startFrame;

  const existingOverlap = hasOverlap(track.clips, targetStartFrame, clipInput.durationFrames);
  if (existingOverlap) {
    if (overlapPolicy === "reject") {
      throw new Error(
        `Clip '${clipInput.id}' overlaps with existing clip '${existingOverlap.id}' on track '${track.id}'`
      );
    }
    const maxEnd = track.clips.reduce(
      (acc, c) => Math.max(acc, c.startFrame + c.durationFrames),
      targetStartFrame
    );
    targetStartFrame = maxEnd;
  }

  const newClip: Clip = {
    id: clipInput.id,
    assetId: clipInput.assetId,
    trackId: clipInput.trackId,
    startFrame: targetStartFrame,
    durationFrames: clipInput.durationFrames,
    sourceInFrame: clipInput.sourceInFrame ?? 0,
    sourceOutFrame: clipInput.sourceOutFrame,
    playbackSpeed: clipInput.playbackSpeed ?? 1.0,
    volume: clipInput.volume ?? 1.0,
    fadeInFrames: clipInput.fadeInFrames ?? 0,
    fadeOutFrames: clipInput.fadeOutFrames ?? 0,
    transitionIn: clipInput.transitionIn,
    transitionOut: clipInput.transitionOut,
    effects: clipInput.effects ?? [],
    keyframes: clipInput.keyframes ?? [],
    textOverlay: clipInput.textOverlay
  };

  track.clips.push(newClip);
  track.clips.sort((a, b) => a.startFrame - b.startFrame);
  return cloneAndValidate(next);
}

export interface MoveClipOptions {
  clipId: string;
  targetStartFrame: number;
  targetTrackId?: string;
  snapThresholdFrames?: number;
  playheadFrame?: number;
}

export function moveClip(project: Project, options: MoveClipOptions): Project {
  if (options.targetStartFrame < 0) {
    throw new Error("Cannot move clip to a negative startFrame");
  }

  const next = structuredClone(project);
  let sourceTrack: Track | undefined;
  let clipIndex = -1;

  for (const track of next.timeline.tracks) {
    const idx = track.clips.findIndex((c) => c.id === options.clipId);
    if (idx !== -1) {
      sourceTrack = track;
      clipIndex = idx;
      break;
    }
  }

  if (!sourceTrack || clipIndex === -1) {
    throw new Error(`Clip not found: ${options.clipId}`);
  }
  assertTrackEditable(sourceTrack);

  const clip = sourceTrack.clips[clipIndex]!;
  const destTrack = options.targetTrackId
    ? next.timeline.tracks.find((t) => t.id === options.targetTrackId)
    : sourceTrack;

  if (!destTrack) {
    throw new Error(`Destination track not found: ${options.targetTrackId}`);
  }
  assertTrackEditable(destTrack);

  // Compute snapping candidate points (0, playheadFrame, and other clip start/end edges on destTrack)
  let snappedStart = options.targetStartFrame;
  const threshold = options.snapThresholdFrames ?? 0;
  if (threshold > 0) {
    const snapPoints: number[] = [0];
    if (options.playheadFrame !== undefined) {
      snapPoints.push(options.playheadFrame);
    }
    for (const other of destTrack.clips) {
      if (other.id === clip.id) continue;
      snapPoints.push(other.startFrame);
      snapPoints.push(other.startFrame + other.durationFrames);
    }
    let bestDist = threshold + 1;
    for (const pt of snapPoints) {
      const dist = Math.abs(options.targetStartFrame - pt);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        snappedStart = pt;
      }
    }
  }

  const overlap = hasOverlap(destTrack.clips, snappedStart, clip.durationFrames, clip.id);
  if (overlap) {
    throw new Error(
      `Moving clip '${clip.id}' to frame ${snappedStart} overlaps with clip '${overlap.id}'`
    );
  }

  sourceTrack.clips.splice(clipIndex, 1);
  clip.trackId = destTrack.id;
  clip.startFrame = snappedStart;
  destTrack.clips.push(clip);
  destTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

  return cloneAndValidate(next);
}

export interface TrimClipOptions {
  clipId: string;
  newStartFrame?: number;
  newDurationFrames?: number;
  newSourceInFrame?: number;
  newSourceOutFrame?: number;
}

export function trimClip(project: Project, options: TrimClipOptions): Project {
  const next = structuredClone(project);
  for (const track of next.timeline.tracks) {
    const clip = track.clips.find((c) => c.id === options.clipId);
    if (!clip) continue;
    assertTrackEditable(track);

    const nextStart = options.newStartFrame ?? clip.startFrame;
    const nextDuration = options.newDurationFrames ?? clip.durationFrames;
    const nextSourceIn = options.newSourceInFrame ?? clip.sourceInFrame;
    const nextSourceOut = options.newSourceOutFrame ?? clip.sourceOutFrame;

    if (nextStart < 0) {
      throw new Error("Invalid trim: startFrame cannot be negative");
    }
    if (nextDuration <= 0) {
      throw new Error("Invalid trim: durationFrames must be >= 1");
    }
    if (nextSourceIn < 0) {
      throw new Error("Invalid trim: sourceInFrame cannot be negative");
    }
    if (nextSourceOut !== undefined && nextSourceOut <= nextSourceIn) {
      throw new Error("Invalid trim: sourceOutFrame must be greater than sourceInFrame");
    }

    const overlap = hasOverlap(track.clips, nextStart, nextDuration, clip.id);
    if (overlap) {
      throw new Error(`Invalid trim: overlaps with clip '${overlap.id}'`);
    }

    clip.startFrame = nextStart;
    clip.durationFrames = nextDuration;
    clip.sourceInFrame = nextSourceIn;
    if (nextSourceOut !== undefined) {
      clip.sourceOutFrame = nextSourceOut;
    }
    // Clamp fades if duration shrank
    if (clip.fadeInFrames + clip.fadeOutFrames > clip.durationFrames) {
      clip.fadeInFrames = Math.min(clip.fadeInFrames, Math.floor(clip.durationFrames / 2));
      clip.fadeOutFrames = Math.min(clip.fadeOutFrames, clip.durationFrames - clip.fadeInFrames);
    }

    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    return cloneAndValidate(next);
  }

  throw new Error(`Clip not found: ${options.clipId}`);
}

export interface SplitClipOptions {
  clipId: string;
  splitAtFrame: number;
  rightClipId?: string;
}

export function splitClip(project: Project, options: SplitClipOptions): Project {
  const next = structuredClone(project);
  for (const track of next.timeline.tracks) {
    const idx = track.clips.findIndex((c) => c.id === options.clipId);
    if (idx === -1) continue;
    assertTrackEditable(track);

    const clip = track.clips[idx]!;
    const clipEnd = clip.startFrame + clip.durationFrames;
    if (options.splitAtFrame <= clip.startFrame || options.splitAtFrame >= clipEnd) {
      throw new Error(
        `splitAtFrame (${options.splitAtFrame}) must be strictly inside clip bounds (${clip.startFrame}..${clipEnd})`
      );
    }

    const leftDuration = options.splitAtFrame - clip.startFrame;
    const rightDuration = clipEnd - options.splitAtFrame;
    const sourceFramesConsumedByLeft = Math.round(leftDuration * clip.playbackSpeed);
    const rightSourceIn = clip.sourceInFrame + sourceFramesConsumedByLeft;

    const rightId = options.rightClipId ?? `${clip.id}-part2`;
    const leftClip: Clip = {
      ...structuredClone(clip),
      durationFrames: leftDuration,
      sourceOutFrame:
        clip.sourceOutFrame !== undefined ? rightSourceIn : undefined,
      fadeOutFrames: 0,
      transitionOut: undefined,
      keyframes: clip.keyframes.filter((kf) => kf.frameOffset <= leftDuration)
    };

    const rightClip: Clip = {
      ...structuredClone(clip),
      id: rightId,
      startFrame: options.splitAtFrame,
      durationFrames: rightDuration,
      sourceInFrame: rightSourceIn,
      fadeInFrames: 0,
      transitionIn: undefined,
      keyframes: clip.keyframes
        .filter((kf) => kf.frameOffset >= leftDuration)
        .map((kf) => ({ ...kf, frameOffset: kf.frameOffset - leftDuration }))
    };

    track.clips.splice(idx, 1, leftClip, rightClip);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    return cloneAndValidate(next);
  }

  throw new Error(`Clip not found: ${options.clipId}`);
}

export function deleteClip(
  project: Project,
  options: { clipId: string; ripple?: boolean }
): Project {
  const next = structuredClone(project);
  for (const track of next.timeline.tracks) {
    const idx = track.clips.findIndex((c) => c.id === options.clipId);
    if (idx === -1) continue;
    assertTrackEditable(track);

    const removed = track.clips[idx]!;
    track.clips.splice(idx, 1);

    if (options.ripple) {
      for (const remaining of track.clips) {
        if (remaining.startFrame > removed.startFrame) {
          remaining.startFrame = Math.max(0, remaining.startFrame - removed.durationFrames);
        }
      }
    }

    return cloneAndValidate(next);
  }

  throw new Error(`Clip not found: ${options.clipId}`);
}

export interface ClipPropertyPatch {
  playbackSpeed?: number;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  transitionIn?: TransitionSpec;
  transitionOut?: TransitionSpec;
  effects?: FilterEffect[];
  keyframes?: KeyframePoint[];
  textOverlay?: TextOverlay;
}

export function updateClipProperties(
  project: Project,
  clipId: string,
  patch: ClipPropertyPatch
): Project {
  const next = structuredClone(project);
  for (const track of next.timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    assertTrackEditable(track);

    if (patch.playbackSpeed !== undefined) clip.playbackSpeed = patch.playbackSpeed;
    if (patch.volume !== undefined) clip.volume = patch.volume;
    if (patch.fadeInFrames !== undefined) clip.fadeInFrames = patch.fadeInFrames;
    if (patch.fadeOutFrames !== undefined) clip.fadeOutFrames = patch.fadeOutFrames;
    if (patch.transitionIn !== undefined) clip.transitionIn = patch.transitionIn;
    if (patch.transitionOut !== undefined) clip.transitionOut = patch.transitionOut;
    if (patch.effects !== undefined) clip.effects = patch.effects;
    if (patch.keyframes !== undefined) clip.keyframes = patch.keyframes;
    if (patch.textOverlay !== undefined) clip.textOverlay = patch.textOverlay;

    return cloneAndValidate(next);
  }

  throw new Error(`Clip not found: ${clipId}`);
}

/**
 * Evaluates a clip keyframe property at a specific relative frameOffset using linear interpolation.
 */
export function evaluateKeyframeAtFrame(
  clip: Clip,
  property: KeyframeProperty,
  frameOffset: number,
  defaultValue: number
): number {
  const points = clip.keyframes
    .filter((k) => k.property === property)
    .sort((a, b) => a.frameOffset - b.frameOffset);

  if (points.length === 0) return defaultValue;
  if (frameOffset <= points[0]!.frameOffset) return points[0]!.value;
  const last = points[points.length - 1]!;
  if (frameOffset >= last.frameOffset) return last.value;

  for (let i = 0; i < points.length - 1; i++) {
    const left = points[i]!;
    const right = points[i + 1]!;
    if (frameOffset >= left.frameOffset && frameOffset <= right.frameOffset) {
      const span = right.frameOffset - left.frameOffset;
      if (span === 0) return right.value;
      const ratio = (frameOffset - left.frameOffset) / span;
      return left.value + ratio * (right.value - left.value);
    }
  }
  return defaultValue;
}

export interface AvSyncReport {
  synchronized: boolean;
  startDriftFrames: number;
  durationDriftFrames: number;
}

export function checkAudioVideoSync(
  project: Project,
  videoClipId: string,
  audioClipId: string
): AvSyncReport {
  let videoClip: Clip | undefined;
  let audioClip: Clip | undefined;

  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === videoClipId) videoClip = clip;
      if (clip.id === audioClipId) audioClip = clip;
    }
  }

  if (!videoClip || !audioClip) {
    throw new Error("Both videoClipId and audioClipId must exist in project timeline");
  }

  const startDriftFrames = audioClip.startFrame - videoClip.startFrame;
  const durationDriftFrames = audioClip.durationFrames - videoClip.durationFrames;

  return {
    synchronized: startDriftFrames === 0 && durationDriftFrames === 0,
    startDriftFrames,
    durationDriftFrames
  };
}

/**
 * Deterministic Undo/Redo history stack for timeline editing sessions.
 */
export class TimelineHistory {
  private past: Project[] = [];
  private present: Project;
  private future: Project[] = [];
  private readonly maxDepth: number;

  constructor(initialProject: Project, maxDepth = 50) {
    this.present = ProjectSchema.parse(structuredClone(initialProject));
    this.maxDepth = maxDepth;
  }

  public current(): Project {
    return this.present;
  }

  public canUndo(): boolean {
    return this.past.length > 0;
  }

  public canRedo(): boolean {
    return this.future.length > 0;
  }

  public commit(nextProject: Project): Project {
    const validated = ProjectSchema.parse(structuredClone(nextProject));
    this.past.push(this.present);
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }
    this.present = validated;
    this.future = [];
    return this.present;
  }

  public undo(): Project {
    if (this.past.length === 0) return this.present;
    const previous = this.past.pop()!;
    this.future.push(this.present);
    this.present = previous;
    return this.present;
  }

  public redo(): Project {
    if (this.future.length === 0) return this.present;
    const next = this.future.pop()!;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }
}
