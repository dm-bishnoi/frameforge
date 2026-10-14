import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { validateSafeProjectPath } from "@frameforge/project-schema";

export const DEV_MCP_SERVER_INFO = {
  name: "frameforge-dev-mcp",
  version: "0.2.0",
  protocolVersion: "2024-11-05",
  connected: false,
  allowArbitraryShellExecution: false
} as const;

export const MAX_SOURCE_READ_BYTES = 256 * 1024; // 256 KB
export const MAX_TOOL_OUTPUT_CHARS = 8000;

export const DevToolNameSchema = z.enum([
  "git.status",
  "fs.read_source",
  "code.search",
  "check.typecheck",
  "check.lint",
  "check.test",
  "check.build",
  "diagnostics.summary"
]);

export type DevToolName = z.infer<typeof DevToolNameSchema>;

export function getDevMcpServerDescriptor() {
  return DEV_MCP_SERVER_INFO;
}

const APPROVED_TOP_PATHS = new Set([
  "apps",
  "packages",
  "mcp",
  "tests",
  "README.md",
  "RELEASE_READINESS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts"
]);

const SENSITIVE_ENV_KEY_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTH)/i;

export function buildSanitizedEnv(rawEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, val] of Object.entries(rawEnv)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) continue;
    clean[key] = val;
  }
  return clean;
}

export function scrubSensitiveOutputText(text: string, rawEnv: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [key, val] of Object.entries(rawEnv)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key) && val && val.length >= 6) {
      out = out.split(val).join("[REDACTED_SECRET]");
    }
  }
  return out;
}

export function truncateBoundedOutput(
  text: string,
  maxChars = MAX_TOOL_OUTPUT_CHARS
): { text: string; truncated: boolean } {
  const scrubbed = scrubSensitiveOutputText(text);
  if (scrubbed.length <= maxChars) {
    return { text: scrubbed, truncated: false };
  }
  return {
    text: `${scrubbed.slice(0, maxChars)}\n...[TRUNCATED]`,
    truncated: true
  };
}

const ReadSourceArgsSchema = z
  .object({
    relativePath: z.string().min(1).max(260)
  })
  .strict();

const CodeSearchArgsSchema = z
  .object({
    query: z.string().min(1).max(120),
    maxResults: z.number().int().min(1).max(100).default(25)
  })
  .strict();

const CheckCommandArgsSchema = z
  .object({
    timeoutMs: z.number().int().min(500).max(60000).default(30000),
    filter: z.string().max(80).optional()
  })
  .strict();

export interface CommandExecutionResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export class DevelopmentMcpServer {
  private readonly repoRoot: string;

  constructor(options: { repoRoot: string }) {
    this.repoRoot = path.resolve(options.repoRoot);
  }

  public listTools() {
    return [
      { name: "git.status", description: "Inspect repository Git status (branch and modified/staged files)" },
      { name: "fs.read_source", description: "Read an approved source file inside the repository" },
      { name: "code.search", description: "Search approved source files for a literal query string" },
      { name: "check.typecheck", description: "Run allowlisted TypeScript compiler checks across workspaces" },
      { name: "check.lint", description: "Run allowlisted ESLint checks across workspaces" },
      { name: "check.test", description: "Run allowlisted Vitest unit tests" },
      { name: "check.build", description: "Run allowlisted workspace build" },
      { name: "diagnostics.summary", description: "Retrieve sanitized workspace diagnostics without secrets" }
    ];
  }

  private assertApprovedSourcePath(relativePath: string): string {
    const resolved = validateSafeProjectPath(this.repoRoot, relativePath);
    const rel = path.relative(this.repoRoot, resolved).split(path.sep).join("/");
    const topSegment = rel.split("/")[0] ?? "";

    if (!APPROVED_TOP_PATHS.has(topSegment)) {
      throw new Error(`Access denied: path '${relativePath}' is not in approved source locations`);
    }
    const base = path.basename(resolved);
    if (
      base.startsWith(".env") ||
      base.endsWith(".pem") ||
      base.endsWith(".key") ||
      rel.includes("node_modules/") ||
      rel.includes(".git/")
    ) {
      throw new Error(`Access denied: sensitive or internal path '${relativePath}' is blocked`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Source file not found: ${relativePath}`);
    }
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Source path must be a regular file: ${relativePath}`);
    }
    if (stat.size > MAX_SOURCE_READ_BYTES) {
      throw new Error(`Source file exceeds read limit (${stat.size} bytes)`);
    }
    return resolved;
  }

  public runAllowlistedCommand(
    binary: "git" | "pnpm",
    args: string[],
    timeoutMs = 20000
  ): CommandExecutionResult {
    for (const arg of args) {
      if (arg.includes("\0") || /[;&|`$<>]/.test(arg)) {
        throw new Error(`Rejected unsafe command argument: ${arg}`);
      }
    }

    const binDir = path.join(this.repoRoot, "node_modules/.bin");
    const resolvedBinary =
      binary === "pnpm" && fs.existsSync(path.join(binDir, "pnpm"))
        ? path.join(binDir, "pnpm")
        : binary;

    const cleanEnv = buildSanitizedEnv(process.env);
    cleanEnv.PATH = `${binDir}:${cleanEnv.PATH ?? "/usr/bin:/bin"}`;

    const proc = spawnSync(resolvedBinary, args, {
      cwd: this.repoRoot,
      env: cleanEnv,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });

    const timedOut = Boolean(proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
    const outBound = truncateBoundedOutput(proc.stdout ?? "");
    const errBound = truncateBoundedOutput(proc.stderr ?? (proc.error ? proc.error.message : ""));

    return {
      success: !timedOut && proc.status === 0,
      exitCode: proc.status,
      timedOut,
      stdout: outBound.text,
      stderr: errBound.text,
      truncated: outBound.truncated || errBound.truncated
    };
  }

  private collectSearchableSourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".next", ".git", "artifacts"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|json|md)$/.test(entry.name)) out.push(full);
      }
    };
    for (const sub of ["packages", "apps", "mcp", "tests"]) {
      walk(path.join(this.repoRoot, sub));
    }
    return out;
  }

  public callTool(name: string, rawArgs: unknown = {}): unknown {
    const toolName = DevToolNameSchema.parse(name);

    switch (toolName) {
      case "git.status": {
        return this.runAllowlistedCommand("git", ["status", "--short", "--branch"], 10000);
      }
      case "fs.read_source": {
        const args = ReadSourceArgsSchema.parse(rawArgs);
        const fullPath = this.assertApprovedSourcePath(args.relativePath);
        const content = fs.readFileSync(fullPath, "utf8");
        const bounded = truncateBoundedOutput(content);
        return {
          relativePath: args.relativePath,
          content: bounded.text,
          truncated: bounded.truncated
        };
      }
      case "code.search": {
        const args = CodeSearchArgsSchema.parse(rawArgs);
        const files = this.collectSearchableSourceFiles();
        const matches: Array<{ file: string; line: number; snippet: string }> = [];

        for (const file of files) {
          if (matches.length >= args.maxResults) break;
          const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(args.query)) {
              matches.push({
                file: path.relative(this.repoRoot, file),
                line: i + 1,
                snippet: lines[i]!.trim().slice(0, 200)
              });
              if (matches.length >= args.maxResults) break;
            }
          }
        }
        return { query: args.query, matches };
      }
      case "check.typecheck": {
        const args = CheckCommandArgsSchema.parse(rawArgs);
        return this.runAllowlistedCommand("pnpm", ["typecheck"], args.timeoutMs);
      }
      case "check.lint": {
        const args = CheckCommandArgsSchema.parse(rawArgs);
        return this.runAllowlistedCommand("pnpm", ["lint"], args.timeoutMs);
      }
      case "check.test": {
        const args = CheckCommandArgsSchema.parse(rawArgs);
        const cmdArgs = args.filter ? ["test", args.filter] : ["test"];
        return this.runAllowlistedCommand("pnpm", cmdArgs, args.timeoutMs);
      }
      case "check.build": {
        const args = CheckCommandArgsSchema.parse(rawArgs);
        return this.runAllowlistedCommand("pnpm", ["build"], args.timeoutMs);
      }
      case "diagnostics.summary": {
        const safeEnvKeys = Object.keys(buildSanitizedEnv(process.env));
        return {
          server: DEV_MCP_SERVER_INFO.name,
          version: DEV_MCP_SERVER_INFO.version,
          nodeVersion: process.version,
          platform: process.platform,
          allowArbitraryShellExecution: false,
          exposedEnvVarCount: safeEnvKeys.length,
          secretsRedacted: true
        };
      }
    }
  }

  public handleJsonRpc(request: {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
  }) {
    const id = request.id ?? null;
    try {
      if (request.method === "notifications/initialized") return null;
      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: DEV_MCP_SERVER_INFO.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: DEV_MCP_SERVER_INFO.name,
              version: DEV_MCP_SERVER_INFO.version
            }
          }
        };
      }
      if (request.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.listTools() }
        };
      }
      if (request.method === "tools/call") {
        const params = (request.params ?? {}) as { name?: string; arguments?: unknown };
        if (!params.name) throw new Error("Missing tool name");
        const output = this.callTool(params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
            isError: false
          }
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` }
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: scrubSensitiveOutputText(err instanceof Error ? err.message : String(err))
        }
      };
    }
  }

  public startStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        const res = this.handleJsonRpc(req);
        if (res) {
          process.stdout.write(`${JSON.stringify(res)}\n`);
        }
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          })}\n`
        );
      }
    });
  }
}
