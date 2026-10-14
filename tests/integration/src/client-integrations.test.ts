import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDeterministicMediaFixture } from "@frameforge/media-engine";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Non-destructively merges FrameForge MCP server entries into an existing client config object
 * (Antigravity / Claude Desktop format) while preserving existing user MCP servers and credentials.
 */
export function mergeMcpClientConfig(
  existingConfig: Record<string, unknown>,
  repoRoot: string,
  workspaceRoot: string
): Record<string, unknown> {
  const cloned = structuredClone(existingConfig);
  const existingServers =
    typeof cloned.mcpServers === "object" && cloned.mcpServers !== null
      ? (cloned.mcpServers as Record<string, unknown>)
      : {};

  cloned.mcpServers = {
    ...existingServers,
    "frameforge-dev-mcp": {
      command: "node",
      args: [path.join(repoRoot, "mcp/dev-server/dist/cli.js")],
      env: {
        FRAMEFORGE_REPO_ROOT: repoRoot
      }
    },
    "frameforge-video-mcp": {
      command: "node",
      args: [path.join(repoRoot, "mcp/video-server/dist/cli.js")],
      env: {
        FRAMEFORGE_WORKSPACE_ROOT: workspaceRoot
      }
    }
  };
  return cloned;
}

/**
 * Sends newline-delimited JSON-RPC 2.0 requests to a spawned stdio MCP server process
 * and collects the JSON-RPC responses.
 */
function runStdioMcpSession(
  cliScriptPath: string,
  envVars: Record<string, string>,
  requests: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliScriptPath],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...envVars },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    const responses: Array<Record<string, unknown>> = [];
    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
        if (responses.length >= requests.length) {
          child.kill("SIGTERM");
        }
      }
    });

    child.on("error", reject);
    child.on("close", () => resolve(responses));

    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
    child.stdin.end();
  });
}

describe("Step 11 — MCP Client Integrations & Live Stdio Subprocess Verification", () => {
  it("preserves existing user MCP servers and credentials when merging Antigravity, Claude Desktop, and Codex configs", () => {
    const existingUserConfig = {
      theme: "dark",
      mcpServers: {
        "user-custom-mcp": {
          command: "npx",
          args: ["-y", "custom-mcp"],
          env: { USER_SECRET_TOKEN: "keep-me-intact" }
        }
      }
    };

    const merged = mergeMcpClientConfig(
      existingUserConfig,
      REPO_ROOT,
      path.join(REPO_ROOT, "workspace-data")
    );
    const servers = merged.mcpServers as Record<string, { env?: Record<string, string> }>;

    expect(servers["user-custom-mcp"]?.env?.USER_SECRET_TOKEN).toBe("keep-me-intact");
    expect(servers["frameforge-dev-mcp"]).toBeDefined();
    expect(servers["frameforge-video-mcp"]).toBeDefined();

    // Verify client template files exist
    expect(fs.existsSync(path.join(REPO_ROOT, "mcp/client-configs/antigravity.mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "mcp/client-configs/claude_desktop_config.json"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "mcp/client-configs/codex.config.toml"))).toBe(true);
  });

  it("spawns built Development MCP and Video Editing MCP stdio servers and verifies tool discovery, repo inspection, and real video render", async () => {
    const devCli = path.join(REPO_ROOT, "mcp/dev-server/dist/cli.js");
    const videoCli = path.join(REPO_ROOT, "mcp/video-server/dist/cli.js");
    expect(fs.existsSync(devCli)).toBe(true);
    expect(fs.existsSync(videoCli)).toBe(true);

    // 1. Test Development MCP over live stdio pipe
    const devResponses = await runStdioMcpSession(
      devCli,
      { FRAMEFORGE_REPO_ROOT: REPO_ROOT },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "git.status", arguments: {} }
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "fs.read_source", arguments: { relativePath: "../outside.txt" } }
        }
      ]
    );

    expect(devResponses).toHaveLength(4);
    expect((devResponses[0]?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "frameforge-dev-mcp"
    );
    expect((devResponses[3] as { error?: { message: string } }).error?.message).toContain(
      "escapes root"
    );

    // 2. Test Video Editing MCP over live stdio pipe with real project + short MP4 render
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ff-stdio-video-"));
    try {
      generateDeterministicMediaFixture(path.join(tmpWorkspace, "input.mp4"), {
        durationSeconds: 1,
        width: 1080,
        height: 1920,
        fps: 30
      });

      const videoResponses = await runStdioMcpSession(
        videoCli,
        { FRAMEFORGE_WORKSPACE_ROOT: tmpWorkspace },
        [
          { jsonrpc: "2.0", id: 10, method: "initialize", params: {} },
          {
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: {
              name: "project.create",
              arguments: { projectId: "stdio-proj", name: "Stdio Render Project" }
            }
          },
          {
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: {
              name: "media.import",
              arguments: {
                projectId: "stdio-proj",
                sourceRelativePath: "input.mp4",
                assetId: "a1"
              }
            }
          },
          {
            jsonrpc: "2.0",
            id: 13,
            method: "tools/call",
            params: {
              name: "timeline.add_clip",
              arguments: {
                projectId: "stdio-proj",
                clipId: "c1",
                trackId: "track-video-1",
                assetId: "a1",
                startFrame: 0,
                durationFrames: 30
              }
            }
          },
          {
            jsonrpc: "2.0",
            id: 14,
            method: "tools/call",
            params: {
              name: "render.start",
              arguments: {
                projectId: "stdio-proj",
                jobId: "stdio-job-1",
                outputRelativePath: "rendered.mp4",
                confirm: true
              }
            }
          }
        ]
      );

      expect(videoResponses).toHaveLength(5);
      const renderRes = videoResponses[4]?.result as {
        structuredContent: { job: { status: string; validation: { valid: boolean } } };
      };
      expect(renderRes.structuredContent.job.status).toBe("completed");
      expect(renderRes.structuredContent.job.validation.valid).toBe(true);
      expect(fs.existsSync(path.join(tmpWorkspace, "rendered.mp4"))).toBe(true);
    } finally {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
