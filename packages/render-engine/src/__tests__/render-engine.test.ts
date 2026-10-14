import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRepository } from "@frameforge/project-schema";
import { addClipToTrack } from "@frameforge/timeline-engine";
import {
  generateDeterministicMediaFixture,
  importMediaIntoProject,
  MAX_SOURCE_MEDIA_BYTES,
  probeMediaFile
} from "@frameforge/media-engine";
import {
  buildAtempoFilterChain,
  buildRemotionCompositionDescriptor,
  escapeFfmpegDrawtextValue,
  getRenderEngineCapability,
  MAX_RENDERED_OUTPUT_BYTES,
  RenderJobQueue,
  validateRenderedOutput
} from "../index";

describe("@frameforge/render-engine — Step 5 & Remediation Verification", () => {
  it("escapes adversarial drawtext characters (commas, brackets, semicolons, colons, quotes, backslashes, multiline) and renders real MP4 via FFmpeg", () => {
    const adversarialText =
      "Hook, Line & [Sinker]; 'Single' \"Double\" : 100% \\Path\nSecond Line!";
    const escaped = escapeFfmpegDrawtextValue(adversarialText);

    expect(escaped).toContain("\\,");
    expect(escaped).toContain("\\[Sinker\\]");
    expect(escaped).toContain("\\;");
    expect(escaped).toContain("\\\\:");
    expect(escaped).toContain("\\\\\\'");
    expect(escaped).toContain('\\\\"');
    expect(escaped).toContain("\\\\\\\\Path");
    expect(escaped).toContain("%%");
    expect(escaped).toContain("\nSecond Line!");

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-render-adv-"));
    try {
      const capability = getRenderEngineCapability();
      expect(capability.exportAvailable).toBe(true);

      const repo = new ProjectRepository(path.join(tmpRoot, "projects"));
      let project = repo.createProject({
        id: "vertical-render-demo",
        name: "Vertical 9x16 Render Test"
      });

      const fixtureVideoPath = generateDeterministicMediaFixture(
        path.join(tmpRoot, "fixtures/source-clip.mp4"),
        { durationSeconds: 2, width: 1080, height: 1920, fps: 30 }
      );

      const imported = importMediaIntoProject(repo, project, fixtureVideoPath, {
        assetId: "asset-v1",
        name: "SourceClip.mp4"
      });
      project = imported.project;

      // Add clip at 0.25x speed (tests chained atempo=0.5,atempo=0.5 in real FFmpeg render!)
      project = addClipToTrack(project, {
        id: "clip-v1",
        assetId: "asset-v1",
        trackId: "track-video-1",
        startFrame: 0,
        durationFrames: 30,
        sourceInFrame: 0,
        playbackSpeed: 0.25,
        fadeInFrames: 5,
        fadeOutFrames: 5,
        transitionIn: { type: "fade", durationFrames: 5 },
        effects: [
          { type: "brightness", value: 0.1 },
          { type: "contrast", value: 1.1 }
        ]
      });

      // Add adversarial text overlay containing commas, brackets, semicolons, colons, quotes, backslashes, and multiline text
      project = addClipToTrack(project, {
        id: "clip-txt-adv",
        trackId: "track-text-1",
        startFrame: 0,
        durationFrames: 30,
        textOverlay: {
          text: adversarialText,
          preset: "title-bold",
          fontSize: 40,
          fontColor: "#FFFFFF",
          backgroundColor: "#000000",
          x: 540,
          y: 400
        }
      });

      repo.saveProject(project);

      const remotionComp = buildRemotionCompositionDescriptor(project);
      expect(remotionComp.width).toBe(1080);
      expect(remotionComp.height).toBe(1920);
      expect(remotionComp.fps).toBe(30);
      expect(remotionComp.sequences).toHaveLength(2);

      const queue = new RenderJobQueue(path.join(tmpRoot, "temp-renders"));
      const outputMp4 = path.join(tmpRoot, "exports/output-vertical.mp4");
      const job = queue.renderProjectSync({
        jobId: "job-001",
        project,
        projectDir: repo.getProjectDir(project.id),
        outputFilePath: outputMp4,
        extractSampleFrame: true
      });

      expect(job.status).toBe("completed");
      expect(job.progressPercent).toBe(100);
      expect(job.validation?.valid).toBe(true);
      expect(job.validation?.probe.width).toBe(1080);
      expect(job.validation?.probe.height).toBe(1920);
      expect(Math.round(job.validation?.probe.fps ?? 0)).toBe(30);
      expect(job.validation?.probe.hasVideo).toBe(true);
      expect(job.validation?.probe.hasAudio).toBe(true);
      expect(fs.existsSync(job.validation?.extractedFramePath ?? "")).toBe(true);
      expect(fs.existsSync(job.tempDir)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("chains atempo filters across 0.25x–4.0x, supports rational 29.97 FPS (30000/1001), and separates source vs output size limits", () => {
    // 1. Audio tempo filter chaining across 0.25x - 4.0x
    expect(buildAtempoFilterChain(1.0)).toEqual([]);
    expect(buildAtempoFilterChain(0.25)).toEqual(["atempo=0.5000", "atempo=0.5000"]);
    expect(buildAtempoFilterChain(0.5)).toEqual(["atempo=0.5000"]);
    expect(buildAtempoFilterChain(2.0)).toEqual(["atempo=2.0000"]);
    expect(buildAtempoFilterChain(4.0)).toEqual(["atempo=2.0000", "atempo=2.0000"]);
    expect(buildAtempoFilterChain(3.0)).toEqual(["atempo=2.0000", "atempo=1.5000"]);
    expect(() => buildAtempoFilterChain(0.1)).toThrow("Unsupported audio playbackSpeed");
    expect(() => buildAtempoFilterChain(5.0)).toThrow("Unsupported audio playbackSpeed");

    // 2. Separate source media limit (500 MB) from rendered output limit (2 GB)
    expect(MAX_RENDERED_OUTPUT_BYTES).toBeGreaterThan(MAX_SOURCE_MEDIA_BYTES);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-rational-fps-"));
    try {
      // 3. Rational 29.97 FPS (30000/1001) render and validation
      const repo = new ProjectRepository(path.join(tmpRoot, "projects"));
      const project = repo.createProject({
        id: "ntsc-proj",
        name: "NTSC 29.97 Project",
        frameRate: { numerator: 30000, denominator: 1001 }
      });

      const queue = new RenderJobQueue(path.join(tmpRoot, "temp"));
      const outPath = path.join(tmpRoot, "ntsc-out.mp4");
      const job = queue.renderProjectSync({
        jobId: "ntsc-job",
        project,
        projectDir: repo.getProjectDir("ntsc-proj"),
        outputFilePath: outPath
      });

      expect(job.status).toBe("completed");
      expect(job.validation?.valid).toBe(true);
      expect(Math.abs((job.validation?.probe.fps ?? 0) - 29.97)).toBeLessThan(0.05);

      // Verify custom maxBytes separation between source media probing and output validation
      expect(() => probeMediaFile(outPath, 30, { maxBytes: 10 })).toThrow(
        "exceeds maximum allowed quota"
      );
      const outputCheck = validateRenderedOutput(outPath, {
        width: 1080,
        height: 1920,
        fps: 30000 / 1001,
        maxOutputBytes: MAX_RENDERED_OUTPUT_BYTES
      });
      expect(outputCheck.valid).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
