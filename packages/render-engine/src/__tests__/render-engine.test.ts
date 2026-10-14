import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRepository } from "@frameforge/project-schema";
import { addClipToTrack } from "@frameforge/timeline-engine";
import {
  generateDeterministicMediaFixture,
  importMediaIntoProject
} from "@frameforge/media-engine";
import {
  buildRemotionCompositionDescriptor,
  getRenderEngineCapability,
  RenderJobQueue
} from "../index";

describe("@frameforge/render-engine — Step 5 Real FFmpeg Rendering Pipeline", () => {
  it("renders a 1080x1920 30 FPS vertical MP4 with clips, effects, text overlay, and audio, and validates via ffprobe", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-render-test-"));
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
        { durationSeconds: 1, width: 1080, height: 1920, fps: 30 }
      );

      const imported = importMediaIntoProject(repo, project, fixtureVideoPath, {
        assetId: "asset-v1",
        name: "SourceClip.mp4"
      });
      project = imported.project;

      // Add video clip with brightness/contrast filter & fade transition
      project = addClipToTrack(project, {
        id: "clip-v1",
        assetId: "asset-v1",
        trackId: "track-video-1",
        startFrame: 0,
        durationFrames: 30,
        sourceInFrame: 0,
        sourceOutFrame: 30,
        fadeInFrames: 5,
        fadeOutFrames: 5,
        transitionIn: { type: "fade", durationFrames: 5 },
        effects: [
          { type: "brightness", value: 0.1 },
          { type: "contrast", value: 1.1 }
        ]
      });

      // Add text overlay clip
      project = addClipToTrack(project, {
        id: "clip-txt-1",
        trackId: "track-text-1",
        startFrame: 0,
        durationFrames: 30,
        textOverlay: {
          text: "FRAMEFORGE 1080x1920",
          preset: "title-bold",
          fontSize: 54,
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
      // Verify temp directory was cleaned up
      expect(fs.existsSync(job.tempDir)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
