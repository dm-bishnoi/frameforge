import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSanitizedEnv,
  DevelopmentMcpServer,
  prependToPathEnv,
  resolveAllowlistedExecutable,
  scrubSensitiveOutputText,
  truncateBoundedOutput
} from "../index";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

describe("@frameforge/mcp-dev-server — Step 7, Priority 2 MCP Compliance & Priority 3 Windows Compatibility", () => {
  it("exposes valid JSON Schema inputSchema on every tool in tools/list consistent with Zod runtime validation", () => {
    const server = new DevelopmentMcpServer({ repoRoot: REPO_ROOT });
    const listRes = server.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    });

    const tools = (
      listRes?.result as {
        tools: Array<{
          name: string;
          inputSchema: {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties: boolean;
          };
        }>;
      }
    ).tools;

    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);

      // Verify runtime Zod validation rejects unrecognized properties on every tool
      const badCall = server.handleJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: tool.name,
          arguments: { __unexpectedKey__: "rejected" }
        }
      });
      expect(badCall?.error).toBeDefined();
    }
  });

  it("reads approved source files, searches code, and rejects path traversal, .env secrets, and symlinked parent escapes", () => {
    const server = new DevelopmentMcpServer({ repoRoot: REPO_ROOT });

    const pkgRead = server.callTool("fs.read_source", {
      relativePath: "package.json"
    }) as { content: string; truncated: boolean };
    expect(pkgRead.content).toContain('"name": "frameforge"');
    expect(pkgRead.truncated).toBe(false);

    expect(() =>
      server.callTool("fs.read_source", { relativePath: "../../etc/passwd" })
    ).toThrow("escapes root");

    expect(() =>
      server.callTool("fs.read_source", { relativePath: ".env" })
    ).toThrow("Access denied");
    expect(() =>
      server.callTool("fs.read_source", { relativePath: ".git/config" })
    ).toThrow("Access denied");

    const searchRes = server.callTool("code.search", {
      query: "ProjectSchema",
      maxResults: 5
    }) as { matches: Array<{ file: string }> };
    expect(searchRes.matches.length).toBeGreaterThan(0);
  });

  it("handles Windows (;) and POSIX (:) PATH delimiters and resolves pnpm executable safely without shell execution", () => {
    // Windows PATH handling (`;` separator, preserving C:\ drive colons)
    const winEnv = prependToPathEnv(
      { Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs", PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs" },
      "C:\\repo\\node_modules\\.bin",
      "win32"
    );
    expect(winEnv.PATH).toBe(
      "C:\\repo\\node_modules\\.bin;C:\\Windows\\System32;C:\\Program Files\\nodejs"
    );
    expect(winEnv.Path).toBe(
      "C:\\repo\\node_modules\\.bin;C:\\Windows\\System32;C:\\Program Files\\nodejs"
    );

    // POSIX PATH handling (`:` separator)
    const posixEnv = prependToPathEnv(
      { PATH: "/usr/local/bin:/usr/bin" },
      "/workspace/node_modules/.bin",
      "linux"
    );
    expect(posixEnv.PATH).toBe("/workspace/node_modules/.bin:/usr/local/bin:/usr/bin");

    // Safe pnpm resolution via node_modules/.bin/pnpm.cjs on win32 without shell
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ff-win-resolve-"));
    try {
      const binDir = path.join(tmpRepo, "node_modules", ".bin");
      fs.mkdirSync(binDir, { recursive: true });
      const pnpmCjs = path.join(binDir, "pnpm.cjs");
      fs.writeFileSync(pnpmCjs, "console.log('pnpm');", "utf8");

      const resolved = resolveAllowlistedExecutable("pnpm", tmpRepo, "win32", {});
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.prefixArgs).toEqual([pnpmCjs]);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("enforces command allowlists, argument sanitization, output truncation, and secret env scrubbing", () => {
    const server = new DevelopmentMcpServer({ repoRoot: REPO_ROOT });

    expect(() =>
      server.runAllowlistedCommand("git", ["status; rm -rf /"])
    ).toThrow("Rejected unsafe command argument");

    const huge = "A".repeat(12000);
    const bounded = truncateBoundedOutput(huge, 1000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("[TRUNCATED]");

    const fakeEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-proj-supersecretkey123456",
      GITHUB_TOKEN: "ghp_secretTokenValue987654"
    };
    const sanitized = buildSanitizedEnv(fakeEnv);
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();

    const scrubbedText = scrubSensitiveOutputText(
      "Error using key sk-proj-supersecretkey123456 in request",
      fakeEnv
    );
    expect(scrubbedText).not.toContain("sk-proj-supersecretkey123456");
    expect(scrubbedText).toContain("[REDACTED_SECRET]");

    const gitRes = server.callTool("git.status", {}) as { success: boolean };
    expect(gitRes.success).toBe(true);

    const diag = server.callTool("diagnostics.summary", {}) as {
      allowArbitraryShellExecution: boolean;
      secretsRedacted: boolean;
    };
    expect(diag.allowArbitraryShellExecution).toBe(false);
    expect(diag.secretsRedacted).toBe(true);
  });
});
