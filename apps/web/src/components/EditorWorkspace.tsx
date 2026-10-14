"use client";

import React, { useState } from "react";
import {
  type Clip,
  createEmptyProject,
  createProjectFromTemplate,
  type FilterType,
  type Project,
  VERTICAL_VIDEO_TEMPLATES
} from "@frameforge/project-schema";
import {
  addClipToTrack,
  deleteClip,
  moveClip,
  setTrackState,
  splitClip,
  summarizeTimeline,
  TimelineHistory,
  trimClip,
  updateClipProperties
} from "@frameforge/timeline-engine";
import { getRenderEngineCapability } from "@frameforge/render-engine";
import { inspectAiAdapterStatus } from "@frameforge/ai-adapters";

export function formatTimecode(frame: number, fps = 30): string {
  const safeFrame = Math.max(0, Math.floor(frame));
  const ff = safeFrame % fps;
  const totalSeconds = Math.floor(safeFrame / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export interface EditorState {
  history: TimelineHistory;
  selectedClipId: string | null;
  playheadFrame: number;
  isPlaying: boolean;
  snapEnabled: boolean;
  autosaveTimestampIso: string;
}

export function createInitialEditorState(): EditorState {
  const project = createProjectFromTemplate({
    id: "default-vertical-project",
    name: "Vertical Reel 9x16",
    templateId: "tiktok-hook-story-cta",
    nowIso: "2026-10-14T00:00:00.000Z"
  });
  project.assets.push({
    id: "sample-video-asset",
    name: "intro-vertical.mp4",
    kind: "video",
    relativePath: "media/intro-vertical.mp4",
    durationFrames: 180,
    width: 1080,
    height: 1920,
    hasAudio: true,
    codec: "h264"
  });
  const withClip = addClipToTrack(project, {
    id: "clip-main-video",
    assetId: "sample-video-asset",
    trackId: "track-video-1",
    startFrame: 0,
    durationFrames: 90,
    sourceInFrame: 0,
    sourceOutFrame: 90,
    fadeInFrames: 5,
    fadeOutFrames: 5
  });

  return {
    history: new TimelineHistory(withClip),
    selectedClipId: "clip-main-video",
    playheadFrame: 30,
    isPlaying: false,
    snapEnabled: true,
    autosaveTimestampIso: withClip.updatedAtIso
  };
}

export type EditorAction =
  | { type: "SELECT_CLIP"; clipId: string | null }
  | { type: "SET_PLAYHEAD"; frame: number }
  | { type: "TOGGLE_PLAY" }
  | { type: "TOGGLE_SNAP" }
  | { type: "LOAD_TEMPLATE"; templateId: string; projectId: string; name: string }
  | { type: "SPLIT_SELECTED_AT_PLAYHEAD"; rightClipId?: string }
  | { type: "DELETE_SELECTED_CLIP"; ripple?: boolean }
  | { type: "MOVE_SELECTED_CLIP"; targetStartFrame: number }
  | { type: "TRIM_SELECTED_CLIP"; newDurationFrames: number }
  | { type: "UPDATE_SELECTED_CLIP_SPEED"; playbackSpeed: number }
  | { type: "UPDATE_SELECTED_CLIP_VOLUME"; volume: number }
  | { type: "ADD_FILTER_TO_SELECTED"; filterType: FilterType; value: number }
  | { type: "TOGGLE_TRACK_MUTE"; trackId: string }
  | { type: "TOGGLE_TRACK_VISIBLE"; trackId: string }
  | { type: "UNDO" }
  | { type: "REDO" };

export function dispatchEditorAction(state: EditorState, action: EditorAction): EditorState {
  const currentProject = state.history.current();

  switch (action.type) {
    case "SELECT_CLIP":
      return { ...state, selectedClipId: action.clipId };
    case "SET_PLAYHEAD":
      return { ...state, playheadFrame: Math.max(0, Math.floor(action.frame)) };
    case "TOGGLE_PLAY":
      return { ...state, isPlaying: !state.isPlaying };
    case "TOGGLE_SNAP":
      return { ...state, snapEnabled: !state.snapEnabled };
    case "LOAD_TEMPLATE": {
      const nextProj = createProjectFromTemplate({
        id: action.projectId,
        name: action.name,
        templateId: action.templateId
      });
      return {
        ...state,
        history: new TimelineHistory(nextProj),
        selectedClipId: nextProj.timeline.tracks.flatMap((t) => t.clips)[0]?.id ?? null,
        playheadFrame: 0,
        autosaveTimestampIso: nextProj.updatedAtIso
      };
    }
    case "SPLIT_SELECTED_AT_PLAYHEAD": {
      if (!state.selectedClipId) return state;
      const updated = splitClip(currentProject, {
        clipId: state.selectedClipId,
        splitAtFrame: state.playheadFrame,
        rightClipId: action.rightClipId
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "DELETE_SELECTED_CLIP": {
      if (!state.selectedClipId) return state;
      const updated = deleteClip(currentProject, {
        clipId: state.selectedClipId,
        ripple: action.ripple
      });
      state.history.commit(updated);
      return {
        ...state,
        selectedClipId: null,
        autosaveTimestampIso: updated.updatedAtIso
      };
    }
    case "MOVE_SELECTED_CLIP": {
      if (!state.selectedClipId) return state;
      const updated = moveClip(currentProject, {
        clipId: state.selectedClipId,
        targetStartFrame: action.targetStartFrame,
        playheadFrame: state.playheadFrame,
        snapThresholdFrames: state.snapEnabled ? 5 : 0
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "TRIM_SELECTED_CLIP": {
      if (!state.selectedClipId) return state;
      const updated = trimClip(currentProject, {
        clipId: state.selectedClipId,
        newDurationFrames: action.newDurationFrames,
        newSourceOutFrame: action.newDurationFrames
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "UPDATE_SELECTED_CLIP_SPEED": {
      if (!state.selectedClipId) return state;
      const updated = updateClipProperties(currentProject, state.selectedClipId, {
        playbackSpeed: action.playbackSpeed
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "UPDATE_SELECTED_CLIP_VOLUME": {
      if (!state.selectedClipId) return state;
      const updated = updateClipProperties(currentProject, state.selectedClipId, {
        volume: action.volume
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "ADD_FILTER_TO_SELECTED": {
      if (!state.selectedClipId) return state;
      const clip = currentProject.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === state.selectedClipId);
      if (!clip) return state;
      const filtered = clip.effects.filter((e) => e.type !== action.filterType);
      const updated = updateClipProperties(currentProject, state.selectedClipId, {
        effects: [...filtered, { type: action.filterType, value: action.value }]
      });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "TOGGLE_TRACK_MUTE": {
      const track = currentProject.timeline.tracks.find((t) => t.id === action.trackId);
      if (!track) return state;
      const updated = setTrackState(currentProject, action.trackId, { muted: !track.muted });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "TOGGLE_TRACK_VISIBLE": {
      const track = currentProject.timeline.tracks.find((t) => t.id === action.trackId);
      if (!track) return state;
      const updated = setTrackState(currentProject, action.trackId, { visible: !track.visible });
      state.history.commit(updated);
      return { ...state, autosaveTimestampIso: updated.updatedAtIso };
    }
    case "UNDO": {
      const prev = state.history.undo();
      return { ...state, autosaveTimestampIso: prev.updatedAtIso };
    }
    case "REDO": {
      const next = state.history.redo();
      return { ...state, autosaveTimestampIso: next.updatedAtIso };
    }
    default:
      return state;
  }
}

function findSelectedClip(project: Project, clipId: string | null): Clip | undefined {
  if (!clipId) return undefined;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) return clip;
    }
  }
  return undefined;
}

export function EditorWorkspace() {
  const [editorState, setEditorState] = useState<EditorState>(() => createInitialEditorState());
  const project = editorState.history.current();
  const summary = summarizeTimeline(project.timeline);
  const renderCap = getRenderEngineCapability();
  const aiStatus = inspectAiAdapterStatus();
  const selectedClip = findSelectedClip(project, editorState.selectedClipId);
  const fps = Math.round(
    project.timeline.frameRate.numerator / (project.timeline.frameRate.denominator || 1)
  );

  const activeTextClips = project.timeline.tracks
    .filter((t) => t.kind === "text" && t.visible)
    .flatMap((t) => t.clips)
    .filter(
      (c) =>
        editorState.playheadFrame >= c.startFrame &&
        editorState.playheadFrame < c.startFrame + c.durationFrames &&
        Boolean(c.textOverlay)
    );

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top Toolbar */}
      <header
        role="banner"
        aria-label="Editor top toolbar"
        className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-900/90 px-4 py-2.5"
      >
        <div className="flex items-center gap-3">
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-bold tracking-wider text-amber-300">
            FRAMEFORGE
          </span>
          <h1 className="text-sm font-semibold text-zinc-100">{project.name}</h1>
          <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
            {project.timeline.resolution.width}x{project.timeline.resolution.height} @ {fps}fps
          </span>
          <span className="text-xs text-zinc-400" aria-live="polite">
            Autosaved
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Undo edit"
            disabled={!editorState.history.canUndo()}
            onClick={() => setEditorState((s) => dispatchEditorAction(s, { type: "UNDO" }))}
            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            aria-label="Redo edit"
            disabled={!editorState.history.canRedo()}
            onClick={() => setEditorState((s) => dispatchEditorAction(s, { type: "REDO" }))}
            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
          >
            Redo
          </button>
          <button
            type="button"
            aria-label="Toggle timeline snapping"
            aria-pressed={editorState.snapEnabled}
            onClick={() => setEditorState((s) => dispatchEditorAction(s, { type: "TOGGLE_SNAP" }))}
            className={`rounded border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              editorState.snapEnabled
                ? "border-amber-500/50 bg-amber-500/20 text-amber-200"
                : "border-zinc-700 bg-zinc-800 text-zinc-400"
            }`}
          >
            Snap: {editorState.snapEnabled ? "ON" : "OFF"}
          </button>
          <span
            className="rounded bg-emerald-500/20 border border-emerald-500/40 px-3 py-1 text-xs font-semibold text-emerald-300"
            title={renderCap.supportedProfile}
          >
            FFmpeg Export Ready (1080x1920 MP4)
          </span>
        </div>
      </header>

      {/* Main 3-Column Workspace */}
      <div className="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-12">
        {/* Left Column: Media Library & Templates */}
        <aside
          aria-label="Media library and templates"
          className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-3"
        >
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Media Bin ({project.assets.length})
            </h2>
            <ul className="mt-2 space-y-2 text-xs">
              {project.assets.map((asset) => (
                <li
                  key={asset.id}
                  className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/80 px-2.5 py-2"
                >
                  <div>
                    <p className="font-medium text-zinc-200">{asset.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {asset.kind.toUpperCase()} • {asset.relativePath}
                    </p>
                  </div>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {asset.durationFrames ?? 0}f
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-zinc-800 pt-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Vertical 9:16 Templates
            </h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {VERTICAL_VIDEO_TEMPLATES.map((tpl) => (
                <li key={tpl.id}>
                  <button
                    type="button"
                    aria-label={`Apply template ${tpl.name}`}
                    onClick={() =>
                      setEditorState((s) =>
                        dispatchEditorAction(s, {
                          type: "LOAD_TEMPLATE",
                          templateId: tpl.id,
                          projectId: `proj-${tpl.id}`,
                          name: tpl.name
                        })
                      )
                    }
                    className="w-full rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 text-left text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
                  >
                    <span className="block font-medium text-zinc-200">{tpl.name}</span>
                    <span className="block text-[11px] text-zinc-500">{tpl.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-zinc-800 pt-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Local AI Adapters
            </h2>
            <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
              {aiStatus.adapters.map((adapter) => (
                <li key={adapter.id} className="flex items-center justify-between">
                  <span>{adapter.displayName}</span>
                  <span
                    className={
                      adapter.configured ? "text-emerald-400" : "text-zinc-500"
                    }
                  >
                    {adapter.configured ? "Configured" : "Unconfigured"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Center Column: Real Preview Player */}
        <section
          aria-label="Video preview monitor"
          className="flex flex-col items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-6"
        >
          <div className="flex w-full items-center justify-between text-xs text-zinc-400">
            <span>Program Monitor (9:16 Vertical)</span>
            <span className="font-mono text-sm font-semibold text-amber-400" aria-label="Current timecode">
              {formatTimecode(editorState.playheadFrame, fps)}
            </span>
          </div>

          {/* 9:16 Vertical Preview Stage */}
          <div className="relative my-4 flex aspect-[9/16] h-80 flex-col items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-black shadow-inner">
            <div className="text-center text-xs text-zinc-500">
              <p className="font-mono text-zinc-300">
                Frame {editorState.playheadFrame} / {summary.durationFrames}
              </p>
              <p className="mt-1 text-[11px]">
                {project.timeline.resolution.width}x{project.timeline.resolution.height}
              </p>
            </div>

            {activeTextClips.map((tClip) => (
              <div
                key={tClip.id}
                className="pointer-events-none absolute inset-x-4 bottom-8 rounded bg-black/80 px-3 py-1.5 text-center text-sm font-bold text-white shadow"
              >
                {tClip.textOverlay?.text}
              </div>
            ))}
          </div>

          {/* Transport Controls */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Step backward one frame"
              onClick={() =>
                setEditorState((s) =>
                  dispatchEditorAction(s, { type: "SET_PLAYHEAD", frame: s.playheadFrame - 1 })
                )
              }
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              -1f
            </button>
            <button
              type="button"
              aria-label={editorState.isPlaying ? "Pause preview" : "Play preview"}
              onClick={() =>
                setEditorState((s) => dispatchEditorAction(s, { type: "TOGGLE_PLAY" }))
              }
              className="rounded bg-amber-500 px-4 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300"
            >
              {editorState.isPlaying ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              aria-label="Step forward one frame"
              onClick={() =>
                setEditorState((s) =>
                  dispatchEditorAction(s, { type: "SET_PLAYHEAD", frame: s.playheadFrame + 1 })
                )
              }
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              +1f
            </button>
          </div>
        </section>

        {/* Right Column: Editable Properties Inspector */}
        <aside
          aria-label="Clip properties inspector"
          className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-3"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Properties Inspector
          </h2>
          {selectedClip ? (
            <div className="space-y-3 text-xs">
              <div className="rounded border border-zinc-800 bg-zinc-950 p-2.5">
                <p className="font-semibold text-zinc-200">Clip ID: {selectedClip.id}</p>
                <p className="mt-1 text-zinc-400">
                  Timeline: {selectedClip.startFrame}f –{" "}
                  {selectedClip.startFrame + selectedClip.durationFrames}f (
                  {selectedClip.durationFrames}f)
                </p>
                <p className="text-zinc-400">
                  Speed: {selectedClip.playbackSpeed}x • Volume:{" "}
                  {Math.round(selectedClip.volume * 100)}%
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="Set playback speed 1.5x"
                  onClick={() =>
                    setEditorState((s) =>
                      dispatchEditorAction(s, {
                        type: "UPDATE_SELECTED_CLIP_SPEED",
                        playbackSpeed: 1.5
                      })
                    )
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 hover:bg-zinc-700"
                >
                  Speed 1.5x
                </button>
                <button
                  type="button"
                  aria-label="Add brightness filter"
                  onClick={() =>
                    setEditorState((s) =>
                      dispatchEditorAction(s, {
                        type: "ADD_FILTER_TO_SELECTED",
                        filterType: "brightness",
                        value: 0.15
                      })
                    )
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 hover:bg-zinc-700"
                >
                  +Brightness
                </button>
                <button
                  type="button"
                  aria-label="Split selected clip at playhead"
                  onClick={() =>
                    setEditorState((s) =>
                      dispatchEditorAction(s, { type: "SPLIT_SELECTED_AT_PLAYHEAD" })
                    )
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 hover:bg-zinc-700"
                >
                  Split @ Playhead
                </button>
                <button
                  type="button"
                  aria-label="Delete selected clip"
                  onClick={() =>
                    setEditorState((s) =>
                      dispatchEditorAction(s, { type: "DELETE_SELECTED_CLIP", ripple: true })
                    )
                  }
                  className="rounded border border-red-800/60 bg-red-950/50 px-2.5 py-1 text-red-300 hover:bg-red-900/50"
                >
                  Ripple Delete
                </button>
              </div>

              <div className="border-t border-zinc-800 pt-2 text-[11px] text-zinc-400">
                <p className="font-medium text-zinc-300">Active Effects ({selectedClip.effects.length})</p>
                {selectedClip.effects.length === 0 ? (
                  <p className="text-zinc-500">No filter effects applied</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {selectedClip.effects.map((ef, idx) => (
                      <li key={idx}>
                        {ef.type}: {ef.value}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">Select a clip on the timeline to inspect and edit its properties.</p>
          )}
        </aside>
      </div>

      {/* Bottom Multi-Track Timeline */}
      <section
        aria-label="Multi-track timeline editor"
        className="border-t border-zinc-800 bg-zinc-900/90 p-4"
      >
        <div className="mb-3 flex items-center justify-between text-xs">
          <div className="flex items-center gap-4">
            <span className="font-semibold uppercase tracking-wider text-zinc-300">
              Timeline ({summary.trackCount} Tracks • {summary.clipCount} Clips •{" "}
              {summary.durationFrames} Frames)
            </span>
          </div>
          <span className="text-zinc-400">Playhead: Frame {editorState.playheadFrame}</span>
        </div>

        <div className="space-y-2">
          {project.timeline.tracks.map((track) => (
            <div
              key={track.id}
              className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-950 p-2"
            >
              <div className="flex w-44 items-center justify-between border-r border-zinc-800 pr-3 text-xs">
                <div>
                  <span className="font-medium text-zinc-200">{track.name}</span>
                  <span className="ml-1.5 text-[10px] uppercase text-zinc-500">
                    ({track.kind})
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Toggle visibility for ${track.name}`}
                    onClick={() =>
                      setEditorState((s) =>
                        dispatchEditorAction(s, {
                          type: "TOGGLE_TRACK_VISIBLE",
                          trackId: track.id
                        })
                      )
                    }
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                  >
                    {track.visible ? "Vis" : "Hid"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Toggle mute for ${track.name}`}
                    onClick={() =>
                      setEditorState((s) =>
                        dispatchEditorAction(s, {
                          type: "TOGGLE_TRACK_MUTE",
                          trackId: track.id
                        })
                      )
                    }
                    className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                  >
                    {track.muted ? "Muted" : "Audio"}
                  </button>
                </div>
              </div>

              <div className="flex flex-1 flex-wrap gap-2">
                {track.clips.map((clip) => {
                  const isSelected = clip.id === editorState.selectedClipId;
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      aria-label={`Select clip ${clip.id}`}
                      onClick={() =>
                        setEditorState((s) =>
                          dispatchEditorAction(s, { type: "SELECT_CLIP", clipId: clip.id })
                        )
                      }
                      className={`rounded border px-3 py-1.5 text-left text-xs transition ${
                        isSelected
                          ? "border-amber-400 bg-amber-500/20 text-amber-100"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      <span className="block font-semibold">
                        {clip.textOverlay ? `"${clip.textOverlay.text}"` : clip.id}
                      </span>
                      <span className="block text-[10px] text-zinc-400">
                        {clip.startFrame}f..{clip.startFrame + clip.durationFrames}f
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
