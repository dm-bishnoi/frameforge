import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDeterministicMediaFixture } from "@frameforge/media-engine";
import { VideoEditingMcpServer } from "../index";

describe("@frameforge/mcp-video-server — Step 6 Video Editing MCP Protocol & E2E Render", () => {
  it("handles MCP initialize, tools/list, and end-to-end project creation, clip editing, text overlay, rendering, and validation", () => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ff-video-mcp-"));
    try {
      const server = new VideoEditingMcpServer({ workspaceRoot: tmpWorkspace });

      // 1. initialize
      const initRes = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      });
      expect(initRes?.error).toBeUndefined();

      // 2. tools/list
      const listRes = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      });
      const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBeGreaterThanOrEqual(14);

      // 3. Generate a confined local fixture video inside tmpWorkspace/fixtures
      generateDeterministicMediaFixture(
        path.join(tmpWorkspace, "fixtures/clip1.mp4"),
        { durationSeconds: 2, width: 1080, height: 1920, fps: 30 }
      );

      // 4. Create project via MCP
      server.callTool("project.create", {
        projectId: "mcp-e2e-proj",
        name: "MCP E2E Vertical Video"
      });

      // 5. Import media via MCP
      server.callTool("media.import", {
        projectId: "mcp-e2e-proj",
        sourceRelativePath: "fixtures/clip1.mp4",
        assetId: "asset-1",
        name: "Clip 1"
      });

      // 6. Add clip & split & edit via MCP
      server.callTool("timeline.add_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-1",
        trackId: "track-video-1",
        assetId: "asset-1",
        startFrame: 0,
        durationFrames: 60
      });

      server.callTool("timeline.split_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-1",
        splitAtFrame: 30,
        rightClipId: "clip-2"
      });

      // Destructive delete without confirm: true must be rejected
      expect(() =>
        server.callTool("timeline.delete_clip", {
          projectId: "mcp-e2e-proj",
          clipId: "clip-2",
          confirm: false
        })
      ).toThrow("requires confirm: true");

      // Delete second half with confirm: true
      server.callTool("timeline.delete_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-2",
        confirm: true
      });

      // 7. Add text overlay via MCP
      server.callTool("timeline.add_text_overlay", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-text-1",
        trackId: "track-text-1",
        startFrame: 0,
        durationFrames: 30,
        overlay: {
          text: "EDITED VIA MCP",
          preset: "title-bold",
          fontSize: 52,
          fontColor: "#FFFFFF",
          backgroundColor: "#000000",
          x: 540,
          y: 400
        }
      });

      // 8. Reject path traversal on media.inspect
      expect(() =>
        server.callTool("media.inspect", {
          relativeFilePath: "../../etc/passwd"
        })
      ).toThrow("escapes root");

      // 9. Render via MCP and inspect output
      const renderOut = server.callTool("render.start", {
        projectId: "mcp-e2e-proj",
        jobId: "mcp-render-job-1",
        outputRelativePath: "exports/mcp-final.mp4",
        confirm: true
      }) as { job: { status: string; validation: { valid: boolean } } };

      expect(renderOut.job.status).toBe("completed");
      expect(renderOut.job.validation.valid).toBe(true);

      const inspectOut = server.callTool("render.inspect_output", {
        outputRelativePath: "exports/mcp-final.mp4"
      }) as { validation: { valid: boolean; probe: { width: number; height: number } } };

      expect(inspectOut.validation.valid).toBe(true);
      expect(inspectOut.validation.probe.width).toBe(1080);
      expect(inspectOut.validation.probe.height).toBe(1920);
    } finally {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
