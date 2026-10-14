import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDeterministicMediaFixture } from "@frameforge/media-engine";
import { VideoEditingMcpServer } from "../index";

describe("@frameforge/mcp-video-server — Step 6 & Priority 2 MCP Compliance", () => {
  it("exposes valid JSON Schema inputSchema on every tool in tools/list consistent with Zod runtime validation", () => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ff-video-mcp-schema-"));
    try {
      const server = new VideoEditingMcpServer({ workspaceRoot: tmpWorkspace });
      const listRes = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/list"
      });

      const tools = (
        listRes?.result as {
          tools: Array<{
            name: string;
            description: string;
            inputSchema: {
              type: string;
              properties: Record<string, unknown>;
              required?: string[];
              additionalProperties: boolean;
            };
          }>;
        }
      ).tools;

      expect(tools).toHaveLength(14);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);

        // Reject unrecognized extra properties via strict Zod runtime validation
        const badCall = server.handleJsonRpc({
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: { __unexpectedField__: true }
          }
        });
        expect(badCall?.error).toBeDefined();
      }
    } finally {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it("handles MCP initialize, tools/list, and end-to-end project creation, clip editing with nonzero sourceInFrame, text overlay, rendering, and validation", () => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ff-video-mcp-"));
    try {
      const server = new VideoEditingMcpServer({ workspaceRoot: tmpWorkspace });

      const initRes = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      });
      expect(initRes?.error).toBeUndefined();

      generateDeterministicMediaFixture(
        path.join(tmpWorkspace, "fixtures/clip1.mp4"),
        { durationSeconds: 3, width: 1080, height: 1920, fps: 30 }
      );

      server.callTool("project.create", {
        projectId: "mcp-e2e-proj",
        name: "MCP E2E Vertical Video"
      });

      server.callTool("media.import", {
        projectId: "mcp-e2e-proj",
        sourceRelativePath: "fixtures/clip1.mp4",
        assetId: "asset-1",
        name: "Clip 1"
      });

      server.callTool("timeline.add_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-1",
        trackId: "track-video-1",
        assetId: "asset-1",
        startFrame: 0,
        durationFrames: 60,
        sourceInFrame: 20
      });

      // Split clip at frame 30 -> clip-2 has sourceInFrame = 50
      server.callTool("timeline.split_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-1",
        splitAtFrame: 30,
        rightClipId: "clip-2"
      });

      // Edit clip-2 (which has nonzero sourceInFrame = 50) to newDurationFrames = 20 via tools/call
      const editRes = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "timeline.edit_clip",
          arguments: {
            projectId: "mcp-e2e-proj",
            clipId: "clip-2",
            newDurationFrames: 20
          }
        }
      });
      expect(editRes?.error).toBeUndefined();

      expect(() =>
        server.callTool("timeline.delete_clip", {
          projectId: "mcp-e2e-proj",
          clipId: "clip-2",
          confirm: false
        })
      ).toThrow("requires confirm: true");

      server.callTool("timeline.delete_clip", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-2",
        confirm: true
      });

      server.callTool("timeline.add_text_overlay", {
        projectId: "mcp-e2e-proj",
        clipId: "clip-text-1",
        trackId: "track-text-1",
        startFrame: 0,
        durationFrames: 30,
        overlay: {
          text: "EDITED VIA MCP, [VERIFIED]; 100%",
          preset: "title-bold",
          fontSize: 48,
          fontColor: "#FFFFFF",
          backgroundColor: "#000000",
          x: 540,
          y: 400
        }
      });

      expect(() =>
        server.callTool("media.inspect", {
          relativeFilePath: "../../etc/passwd"
        })
      ).toThrow("escapes root");

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
