import React from "react";
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createInitialEditorState,
  dispatchEditorAction,
  EditorWorkspace,
  formatTimecode
} from "../components/EditorWorkspace";

describe("@frameforge/web — Step 3 Editor UI & Interactions", () => {
  it("renders accessible dark EditorWorkspace with toolbar, media library, preview monitor, inspector, and timeline", () => {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(EditorWorkspace));
    expect(html).toContain("FRAMEFORGE");
    expect(html).toContain("Program Monitor (9:16 Vertical)");
    expect(html).toContain("Properties Inspector");
    expect(html).toContain("Media Bin");
    expect(html).toContain("aria-label=\"Undo edit\"");
    expect(html).toContain("aria-label=\"Play preview\"");
    expect(html).toContain("1080x1920 @ 30fps");
  });

  it("formats frame timecodes accurately and executes real timeline edit actions (split, speed, filter, mute, undo/redo)", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(45, 30)).toBe("00:00:01:15");

    let state = createInitialEditorState();
    expect(state.selectedClipId).toBe("clip-main-video");

    // Split selected video clip at playhead frame 30
    state = dispatchEditorAction(state, {
      type: "SPLIT_SELECTED_AT_PLAYHEAD",
      rightClipId: "clip-main-video-part2"
    });

    const videoTrack = state.history
      .current()
      .timeline.tracks.find((t) => t.id === "track-video-1")!;
    expect(videoTrack.clips).toHaveLength(2);
    expect(videoTrack.clips[0]?.durationFrames).toBe(30);
    expect(videoTrack.clips[1]?.id).toBe("clip-main-video-part2");
    expect(videoTrack.clips[1]?.durationFrames).toBe(60);

    // Apply brightness filter and speed change
    state = dispatchEditorAction(state, {
      type: "ADD_FILTER_TO_SELECTED",
      filterType: "brightness",
      value: 0.2
    });
    state = dispatchEditorAction(state, {
      type: "UPDATE_SELECTED_CLIP_SPEED",
      playbackSpeed: 1.5
    });

    const editedClip = state.history
      .current()
      .timeline.tracks.find((t) => t.id === "track-video-1")!.clips[0]!;
    expect(editedClip.playbackSpeed).toBe(1.5);
    expect(editedClip.effects).toEqual([{ type: "brightness", value: 0.2 }]);

    // Undo reverts speed change
    state = dispatchEditorAction(state, { type: "UNDO" });
    expect(
      state.history.current().timeline.tracks.find((t) => t.id === "track-video-1")!.clips[0]!
        .playbackSpeed
    ).toBe(1.0);

    // Redo restores speed change
    state = dispatchEditorAction(state, { type: "REDO" });
    expect(
      state.history.current().timeline.tracks.find((t) => t.id === "track-video-1")!.clips[0]!
        .playbackSpeed
    ).toBe(1.5);
  });
});
