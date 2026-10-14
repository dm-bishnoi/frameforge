import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSanitizedEnv,
  DevelopmentMcpServer,
  scrubSensitiveOutputText,
  truncateBoundedOutput
} from "../index";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

describe("@frameforge/mcp-dev-server — Step 7 Development MCP Security & Tools", () => {
  it("reads approved source files, searches code, and rejects path traversal, .env secrets, and unapproved directories", () => {
    const server = new DevelopmentMcpServer({ repoRoot: REPO_ROOT });

    const pkgRead = server.callTool("fs.read_source", {
      relativePath: "package.json"
    }) as { content: string; truncated: boolean };
    expect(pkgRead.content).toContain('"name": "frameforge"');
    expect(pkgRead.truncated).toBe(false);

    // Reject path traversal
    expect(() =>
      server.callTool("fs.read_source", { relativePath: "../../etc/passwd" })
    ).toThrow("escapes root");

    // Reject .env or unapproved paths
    expect(() =>
      server.callTool("fs.read_source", { relativePath: ".env" })
    ).toThrow("Access denied");
    expect(() =>
      server.callTool("fs.read_source", { relativePath: ".git/config" })
    ).toThrow("Access denied");

    // Search code
    const searchRes = server.callTool("code.search", {
      query: "ProjectSchema",
      maxResults: 5
    }) as { matches: Array<{ file: string }> };
    expect(searchRes.matches.length).toBeGreaterThan(0);
  });

  it("enforces command allowlists, argument sanitization, output truncation, and secret env scrubbing", () => {
    const server = new DevelopmentMcpServer({ repoRoot: REPO_ROOT });

    // Reject shell injection metacharacters in arguments
    expect(() =>
      server.runAllowlistedCommand("git", ["status; rm -rf /"])
    ).toThrow("Rejected unsafe command argument");

    // Verify bounded output truncation
    const huge = "A".repeat(12000);
    const bounded = truncateBoundedOutput(huge, 1000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("[TRUNCATED]");

    // Verify secret scrubbing from environment and output strings
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

    // Verify git.status and diagnostics.summary execute cleanly
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
