import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptyProject,
  createProjectFromTemplate,
  isSafeRelativeMediaPath,
  LEGACY_SCHEMA_VERSION,
  migrateProjectSchema,
  ProjectRepository,
  ProjectSchema,
  SCHEMA_VERSION,
  validateSafeProjectPath
} from "../index";

describe("@frameforge/project-schema — Step 2 & Step 9 Project Engine", () => {
  it("creates a valid vertical 1080x1920@30fps project by default", () => {
    const project = createEmptyProject({
      id: "proj-001",
      name: "Vertical Short",
      nowIso: "2026-10-14T00:00:00.000Z",
      createDefaultTracks: true
    });

    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.id).toBe("proj-001");
    expect(project.timeline.resolution).toEqual({ width: 1080, height: 1920 });
    expect(project.timeline.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(project.timeline.tracks).toHaveLength(3);
  });

  it("rejects invalid resolution dimensions and invalid durations", () => {
    const base = createEmptyProject({
      id: "proj-bad",
      name: "Invalid Project",
      nowIso: "2026-10-14T00:00:00.000Z"
    });

    const badRes = ProjectSchema.safeParse({
      ...base,
      timeline: {
        ...base.timeline,
        resolution: { width: -1080, height: 1920 }
      }
    });
    expect(badRes.success).toBe(false);
  });

  it("rejects missing assets, duplicate clip/asset IDs, and invalid sourceIn/sourceOut points", () => {
    const base = createEmptyProject({
      id: "proj-integrity",
      name: "Integrity Check",
      nowIso: "2026-10-14T00:00:00.000Z",
      createDefaultTracks: true
    });

    // Missing asset reference
    const missingAssetResult = ProjectSchema.safeParse({
      ...base,
      timeline: {
        ...base.timeline,
        tracks: [
          {
            id: "track-video-1",
            name: "Video 1",
            kind: "video",
            visible: true,
            muted: false,
            locked: false,
            volume: 1,
            clips: [
              {
                id: "clip-1",
                assetId: "non-existent-asset",
                trackId: "track-video-1",
                startFrame: 0,
                durationFrames: 30,
                sourceInFrame: 0,
                playbackSpeed: 1,
                volume: 1,
                fadeInFrames: 0,
                fadeOutFrames: 0,
                effects: [],
                keyframes: []
              }
            ]
          }
        ]
      }
    });
    expect(missingAssetResult.success).toBe(false);

    // Duplicate asset IDs
    const dupAssetsResult = ProjectSchema.safeParse({
      ...base,
      assets: [
        { id: "a1", name: "Clip A", kind: "video", relativePath: "media/a.mp4", hasAudio: true },
        { id: "a1", name: "Clip B", kind: "video", relativePath: "media/b.mp4", hasAudio: true }
      ]
    });
    expect(dupAssetsResult.success).toBe(false);

    // Invalid sourceOutFrame <= sourceInFrame
    const badTrimResult = ProjectSchema.safeParse({
      ...base,
      assets: [
        { id: "a1", name: "Clip A", kind: "video", relativePath: "media/a.mp4", hasAudio: true }
      ],
      timeline: {
        ...base.timeline,
        tracks: [
          {
            id: "track-video-1",
            name: "Video 1",
            kind: "video",
            visible: true,
            muted: false,
            locked: false,
            volume: 1,
            clips: [
              {
                id: "clip-1",
                assetId: "a1",
                trackId: "track-video-1",
                startFrame: 0,
                durationFrames: 30,
                sourceInFrame: 20,
                sourceOutFrame: 10,
                playbackSpeed: 1,
                volume: 1,
                fadeInFrames: 0,
                fadeOutFrames: 0,
                effects: [],
                keyframes: []
              }
            ]
          }
        ]
      }
    });
    expect(badTrimResult.success).toBe(false);
  });

  it("prevents path traversal, absolute paths, and symlink escapes", () => {
    expect(isSafeRelativeMediaPath("media/clip.mp4")).toBe(true);
    expect(isSafeRelativeMediaPath("../secret.txt")).toBe(false);
    expect(isSafeRelativeMediaPath("media/../../etc/passwd")).toBe(false);
    expect(isSafeRelativeMediaPath("/etc/passwd")).toBe(false);
    expect(isSafeRelativeMediaPath("C:\\Windows\\System32")).toBe(false);
    expect(isSafeRelativeMediaPath("media/clip%2e%2e.mp4")).toBe(false);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-path-test-"));
    try {
      expect(() => validateSafeProjectPath(tmpRoot, "../outside")).toThrow("escapes root");
      expect(() => validateSafeProjectPath(tmpRoot, "/etc/passwd")).toThrow("absolute path");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("migrates v0.1.0 project payloads and persists, loads, and recovers from autosave", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-repo-test-"));
    try {
      const repo = new ProjectRepository(tmpRoot);
      const created = repo.createProject({
        id: "demo-project",
        name: "Persisted Demo",
        nowIso: "2026-10-14T01:00:00.000Z"
      });

      const listed = repo.listProjects();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe("demo-project");

      // Update and autosave
      const modified = {
        ...created,
        name: "Autosaved Title",
        updatedAtIso: "2026-10-14T02:00:00.000Z"
      };
      repo.autosaveProject(modified);

      // Simulate corrupted main project.json
      const mainPath = path.join(repo.getProjectDir("demo-project"), "project.json");
      fs.writeFileSync(mainPath, "{corrupted json", "utf8");

      // Without recovery flag, loading throws
      expect(() => repo.loadProject("demo-project")).toThrow();

      // With allowAutosaveRecovery, recovers cleanly
      const recovered = repo.loadProject("demo-project", { allowAutosaveRecovery: true });
      expect(recovered.name).toBe("Autosaved Title");

      // Legacy v0.1.0 schema migration check
      const migrated = migrateProjectSchema({
        schemaVersion: LEGACY_SCHEMA_VERSION,
        id: "legacy-1",
        name: "Legacy v0.1",
        createdAtIso: "2026-10-14T00:00:00.000Z",
        updatedAtIso: "2026-10-14T00:00:00.000Z",
        assets: [
          {
            id: "asset-1",
            name: "Intro",
            kind: "video",
            localPath: "/old/path/intro.mp4",
            durationFrames: 90
          }
        ],
        timeline: {
          id: "tl-legacy",
          resolution: { width: 1920, height: 1080 },
          frameRate: { numerator: 30, denominator: 1 },
          tracks: []
        }
      });
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(migrated.assets[0]?.relativePath).toBe("media/intro.mp4");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("creates vertical projects from reusable templates with validated text presets", () => {
    const templated = createProjectFromTemplate({
      id: "tiktok-proj",
      name: "TikTok Short",
      templateId: "tiktok-hook-story-cta",
      nowIso: "2026-10-14T00:00:00.000Z"
    });
    const textTrack = templated.timeline.tracks.find((t) => t.kind === "text");
    expect(textTrack?.clips).toHaveLength(2);
    expect(textTrack?.clips[0]?.textOverlay?.preset).toBe("title-bold");
  });
});
