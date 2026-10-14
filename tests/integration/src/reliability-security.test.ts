import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectRepository,
  validateSafeProjectPath
} from "@frameforge/project-schema";
import { probeMediaFile } from "@frameforge/media-engine";
import { escapeFfmpegDrawtextValue, RenderJobQueue } from "@frameforge/render-engine";
import { DevelopmentMcpServer } from "@frameforge/mcp-dev-server";
import { VideoEditingMcpServer } from "@frameforge/mcp-video-server";

describe("Step 10 & Priority 1 Remediation — Reliability & Security Hardening Suite", () => {
  it("recovers from corrupted project files via autosave and rejects direct symlinks, symlinked parent directories, traversal, and null bytes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sec-test-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sec-outside-"));
    try {
      const repo = new ProjectRepository(path.join(tmpDir, "projects"));
      const created = repo.createProject({
        id: "sec-proj",
        name: "Security Test Project"
      });
      repo.autosaveProject({ ...created, name: "Recovered From Crash" });

      // Corrupt primary project.json
      const mainFile = path.join(repo.getProjectDir("sec-proj"), "project.json");
      fs.writeFileSync(mainFile, "<<<CORRUPTED_FILE_DATA>>>", "utf8");

      const recovered = repo.loadProject("sec-proj", { allowAutosaveRecovery: true });
      expect(recovered.name).toBe("Recovered From Crash");

      // 1. Direct symlink escape defense
      const outsideSecret = path.join(outsideDir, "outside-secret.mp4");
      fs.writeFileSync(outsideSecret, "dummy-secret-payload", "utf8");
      const symlinkPath = path.join(repo.getProjectDir("sec-proj"), "media/evil-link.mp4");
      fs.symlinkSync(outsideSecret, symlinkPath);

      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/evil-link.mp4")
      ).toThrow("symlink escapes root");

      expect(() => probeMediaFile(symlinkPath)).toThrow("Symbolic links are not permitted");

      // 2. Existing regular file reached through a symlinked parent directory
      const symlinkedParent = path.join(repo.getProjectDir("sec-proj"), "media/linked-parent");
      fs.symlinkSync(outsideDir, symlinkedParent);

      expect(() =>
        validateSafeProjectPath(
          repo.getProjectDir("sec-proj"),
          "media/linked-parent/outside-secret.mp4"
        )
      ).toThrow("symlink escapes root");

      // Also verify VideoEditingMcpServer media.inspect and Dev MCP fs.read_source reject symlinked parent escapes
      const videoMcp = new VideoEditingMcpServer({ workspaceRoot: repo.getProjectDir("sec-proj") });
      expect(() =>
        videoMcp.callTool("media.inspect", {
          relativeFilePath: "media/linked-parent/outside-secret.mp4"
        })
      ).toThrow("symlink escapes root");

      // 3. Null byte & URL-encoded traversal defense
      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/clip\0.mp4")
      ).toThrow("null byte");
      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/%2e%2e/secret")
      ).toThrow("encoded traversal");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("escapes untrusted drawtext overlays, enforces MCP rate quotas, cleans up failed renders, and scrubs sensitive env vars", () => {
    // Adversarial drawtext filtergraph injection strings
    const injectionAttempt =
      "Caption,null,system='id';[0:v]negate[vout]: 'quote' \"dbl\" \\slash 100%\nLine2";
    const escaped = escapeFfmpegDrawtextValue(injectionAttempt);
    expect(escaped).toContain("\\,null\\,");
    expect(escaped).toContain("\\;\\[0\\\\:v\\]");
    expect(escaped).toContain("%%");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-quota-test-"));
    try {
      const videoMcp = new VideoEditingMcpServer({
        workspaceRoot: tmpDir,
        maxRequestsPerSession: 3
      });
      videoMcp.callTool("project.create", { projectId: "p1", name: "P1" });
      videoMcp.callTool("project.inspect", { projectId: "p1" });
      videoMcp.callTool("project.validate", { projectId: "p1" });
      expect(() =>
        videoMcp.callTool("project.inspect", { projectId: "p1" })
      ).toThrow("MCP session rate limit exceeded");

      process.env.ANTHROPIC_API_KEY = "sk-ant-secret-key-999999";
      const devMcp = new DevelopmentMcpServer({ repoRoot: tmpDir });
      const rpcErr = devMcp.handleJsonRpc({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "fs.read_source",
          arguments: { relativePath: "sk-ant-secret-key-999999" }
        }
      });
      expect(JSON.stringify(rpcErr)).not.toContain("sk-ant-secret-key-999999");
      expect(JSON.stringify(rpcErr)).toContain("[REDACTED_SECRET]");
      delete process.env.ANTHROPIC_API_KEY;

      const queue = new RenderJobQueue(path.join(tmpDir, ".temp-renders"));
      const repo = new ProjectRepository(path.join(tmpDir, "projects"));
      const p1 = repo.loadProject("p1");
      p1.assets.push({
        id: "missing-asset",
        name: "missing.mp4",
        kind: "video",
        relativePath: "media/does-not-exist.mp4",
        hasAudio: false
      });
      p1.timeline.tracks[0]!.clips.push({
        id: "c-missing",
        assetId: "missing-asset",
        trackId: p1.timeline.tracks[0]!.id,
        startFrame: 0,
        durationFrames: 30,
        sourceInFrame: 0,
        playbackSpeed: 1,
        volume: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        effects: [],
        keyframes: []
      });

      const failedJob = queue.renderProjectSync({
        jobId: "job-missing-media",
        project: p1,
        projectDir: repo.getProjectDir("p1"),
        outputFilePath: path.join(tmpDir, "out.mp4")
      });
      expect(failedJob.status).toBe("failed");
      expect(fs.existsSync(failedJob.tempDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
