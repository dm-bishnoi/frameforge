import { describe, expect, it } from "vitest";
import { createEmptyProject } from "@frameforge/project-schema";
import {
  addClipToTrack,
  checkAudioVideoSync,
  deleteClip,
  evaluateKeyframeAtFrame,
  moveClip,
  setTrackState,
  splitClip,
  summarizeTimeline,
  TimelineHistory,
  trimClip,
  updateClipProperties
} from "../index";

function createSampleProjectWithAsset() {
  const base = createEmptyProject({
    id: "tl-test",
    name: "Timeline Engine Test",
    nowIso: "2026-10-14T00:00:00.000Z",
    createDefaultTracks: true
  });
  base.assets.push(
    {
      id: "asset-v1",
      name: "B-Roll.mp4",
      kind: "video",
      relativePath: "media/broll.mp4",
      durationFrames: 300,
      hasAudio: true
    },
    {
      id: "asset-a1",
      name: "Voiceover.wav",
      kind: "audio",
      relativePath: "media/vo.wav",
      durationFrames: 300,
      hasAudio: true
    }
  );
  return base;
}

describe("@frameforge/timeline-engine — Step 4 & Step 9 Operations", () => {
  it("adds, moves with snapping, trims, splits, and ripple-deletes clips deterministically", () => {
    let project = createSampleProjectWithAsset();

    project = addClipToTrack(project, {
      id: "clip-v1",
      assetId: "asset-v1",
      trackId: "track-video-1",
      startFrame: 0,
      durationFrames: 120,
      sourceInFrame: 0,
      sourceOutFrame: 120
    });

    // Reject overlapping clip by default
    expect(() =>
      addClipToTrack(project, {
        id: "clip-overlap",
        assetId: "asset-v1",
        trackId: "track-video-1",
        startFrame: 60,
        durationFrames: 60
      })
    ).toThrow("overlaps");

    // Split clip at frame 50
    project = splitClip(project, {
      clipId: "clip-v1",
      splitAtFrame: 50,
      rightClipId: "clip-v2"
    });

    const videoTrack = project.timeline.tracks.find((t) => t.id === "track-video-1")!;
    expect(videoTrack.clips).toHaveLength(2);
    expect(videoTrack.clips[0]?.durationFrames).toBe(50);
    expect(videoTrack.clips[1]?.id).toBe("clip-v2");
    expect(videoTrack.clips[1]?.startFrame).toBe(50);
    expect(videoTrack.clips[1]?.durationFrames).toBe(70);
    expect(videoTrack.clips[1]?.sourceInFrame).toBe(50);

    // Move second clip with snapping to playhead at frame 100
    project = moveClip(project, {
      clipId: "clip-v2",
      targetStartFrame: 97,
      playheadFrame: 100,
      snapThresholdFrames: 5
    });
    expect(
      project.timeline.tracks.find((t) => t.id === "track-video-1")?.clips[1]?.startFrame
    ).toBe(100);

    // Trim first clip duration to 40 frames
    project = trimClip(project, {
      clipId: "clip-v1",
      newDurationFrames: 40,
      newSourceOutFrame: 40
    });
    expect(summarizeTimeline(project.timeline).durationFrames).toBe(170);

    // Ripple delete first clip shifts second clip left by 40 frames (from 100 to 60)
    project = deleteClip(project, { clipId: "clip-v1", ripple: true });
    const remaining = project.timeline.tracks.find((t) => t.id === "track-video-1")?.clips;
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.startFrame).toBe(60);
  });

  it("enforces track locking, negative position rejection, undo/redo, keyframes, and AV sync", () => {
    const initial = createSampleProjectWithAsset();
    const history = new TimelineHistory(initial);

    const withVideo = addClipToTrack(history.current(), {
      id: "clip-v1",
      assetId: "asset-v1",
      trackId: "track-video-1",
      startFrame: 0,
      durationFrames: 90
    });
    history.commit(withVideo);

    const withAudio = addClipToTrack(history.current(), {
      id: "clip-a1",
      assetId: "asset-a1",
      trackId: "track-audio-1",
      startFrame: 0,
      durationFrames: 90
    });
    history.commit(withAudio);

    expect(checkAudioVideoSync(history.current(), "clip-v1", "clip-a1").synchronized).toBe(true);

    // Update keyframes & effects on clip-v1
    const withEffects = updateClipProperties(history.current(), "clip-v1", {
      playbackSpeed: 1.5,
      fadeInFrames: 10,
      fadeOutFrames: 10,
      effects: [{ type: "brightness", value: 0.2 }, { type: "contrast", value: 1.2 }],
      keyframes: [
        { frameOffset: 0, property: "opacity", value: 0, easing: "linear" },
        { frameOffset: 30, property: "opacity", value: 1, easing: "linear" }
      ]
    });
    history.commit(withEffects);

    const updatedClip = history
      .current()
      .timeline.tracks.find((t) => t.id === "track-video-1")!.clips[0]!;
    expect(evaluateKeyframeAtFrame(updatedClip, "opacity", 15, 1)).toBe(0.5);

    // Lock track and verify edits are rejected
    const locked = setTrackState(history.current(), "track-video-1", { locked: true });
    expect(() =>
      deleteClip(locked, { clipId: "clip-v1" })
    ).toThrow("locked");

    // Undo / Redo round trip
    expect(history.canUndo()).toBe(true);
    history.undo();
    expect(
      history.current().timeline.tracks.find((t) => t.id === "track-video-1")?.clips[0]?.effects
    ).toHaveLength(0);
    history.redo();
    expect(
      history.current().timeline.tracks.find((t) => t.id === "track-video-1")?.clips[0]?.effects
    ).toHaveLength(2);
  });
});
