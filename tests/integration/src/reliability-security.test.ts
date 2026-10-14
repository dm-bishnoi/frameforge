import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectRepository,
  validateSafeProjectPath
} from "@frameforge/project-schema";
import { probeMediaFile } from "@frameforge/media-engine";
import { RenderJobQueue } from "@frameforge/render-engine";
import { DevelopmentMcpServer } from "@frameforge/mcp-dev-server";
import { VideoEditingMcpServer } from "@frameforge/mcp-video-server";

describe("Step 10 — Reliability & Security Hardening Suite", () => {
  it("recovers from corrupted project files via autosave and rejects symlinks, traversal, and null bytes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sec-test-"));
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

      // Symlink escape defense
      const outsideSecret = path.join(tmpDir, "outside-secret.mp4");
      fs.writeFileSync(outsideSecret, "dummy", "utf8");
      const symlinkPath = path.join(repo.getProjectDir("sec-proj"), "media/evil-link.mp4");
      fs.symlinkSync(outsideSecret, symlinkPath);

      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/evil-link.mp4")
      ).toThrow("symlink escapes root");

      expect(() => probeMediaFile(symlinkPath)).toThrow("Symbolic links are not permitted");

      // Null byte & URL-encoded traversal defense
      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/clip\0.mp4")
      ).toThrow("null byte");
      expect(() =>
        validateSafeProjectPath(repo.getProjectDir("sec-proj"), "media/%2e%2e/secret")
      ).toThrow("encoded traversal");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces MCP rate quotas, cleans up cancelled/failed renders, and scrubs sensitive env vars from errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-quota-test-"));
    try {
      // Rate quota enforcement on repeated MCP requests
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

      // Secret scrubbing in Development MCP JSON-RPC error responses
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

      // Failed render cleans up temporary working directory
      const queue = new RenderJobQueue(path.join(tmpDir, ".temp-renders"));
      const repo = new ProjectRepository(path.join(tmpDir, "projects"));
      const p1 = repo.loadProject("p1");
      // Force failure by passing non-existent asset on disk
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
