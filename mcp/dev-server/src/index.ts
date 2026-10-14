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

export interface DevMcpJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: boolean;
}

export interface DevMcpToolDefinition {
  name: DevToolName;
  description: string;
  inputSchema: DevMcpJsonSchema;
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

/**
 * Cross-platform PATH prepender using `;` on Windows (`win32`) and `:` on POSIX (`path.delimiter`),
 * updating both `PATH` and `Path` when present on Windows.
 */
export function prependToPathEnv(
  env: NodeJS.ProcessEnv,
  binDir: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const delimiter = platform === "win32" ? ";" : ":";
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const existingPath = nextEnv.PATH ?? nextEnv.Path ?? (platform === "win32" ? "" : "/usr/bin:/bin");
  const combined = existingPath ? `${binDir}${delimiter}${existingPath}` : binDir;
  nextEnv.PATH = combined;
  if (platform === "win32" && "Path" in nextEnv) {
    nextEnv.Path = combined;
  }
  return nextEnv;
}

/**
 * Safely resolves allowlisted executables (`git` or `pnpm`) across Windows and POSIX
 * without enabling arbitrary shell execution (`shell: false`).
 *
 * - If a local Node-based pnpm entrypoint (`node_modules/.bin/pnpm` or `pnpm.cjs`) exists,
 *   runs it directly via `process.execPath` (`node`) with `shell: false`.
 * - On Windows (`win32`), searches `PATH` (split by `;`) for `pnpm.cjs`, `pnpm.exe`, `git.exe`,
 *   or `pnpm.cmd` without shell interpolation.
 */
export function resolveAllowlistedExecutable(
  binary: "git" | "pnpm",
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { command: string; prefixArgs: string[] } {
  const binDir = path.join(repoRoot, "node_modules", ".bin");

  if (binary === "pnpm") {
    const localNodePnpm = path.join(binDir, "pnpm");
    const localPnpmCjs = path.join(binDir, "pnpm.cjs");
    if (fs.existsSync(localPnpmCjs)) {
      return { command: process.execPath, prefixArgs: [localPnpmCjs] };
    }
    if (fs.existsSync(localNodePnpm)) {
      try {
        const head = fs.readFileSync(localNodePnpm, "utf8").slice(0, 64);
        if (head.startsWith("#!/usr/bin/env node") || head.includes("node")) {
          return { command: process.execPath, prefixArgs: [localNodePnpm] };
        }
      } catch {
        // Fall through
      }
      if (platform !== "win32") {
        return { command: localNodePnpm, prefixArgs: [] };
      }
    }
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const rawPath = env.PATH ?? env.Path ?? "";
  const searchDirs = [binDir, ...rawPath.split(delimiter).filter(Boolean)];

  const extensions =
    platform === "win32"
      ? binary === "pnpm"
        ? [".exe", ".cjs", ".cmd"]
        : [".exe", ""]
      : [""];

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`);
      if (fs.existsSync(candidate)) {
        if (ext === ".cjs") {
          return { command: process.execPath, prefixArgs: [candidate] };
        }
        return { command: candidate, prefixArgs: [] };
      }
    }
  }

  return { command: platform === "win32" ? `${binary}.exe` : binary, prefixArgs: [] };
}

export function scrubSensitiveOutputText(
  text: string,
  rawEnv: NodeJS.ProcessEnv = process.env
): string {
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

const EmptyObjectArgsSchema = z.object({}).strict();

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

export const DEV_MCP_TOOL_DEFINITIONS: readonly DevMcpToolDefinition[] = [
  {
    name: "git.status",
    description: "Inspect repository Git status (branch and modified/staged files)",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "fs.read_source",
    description: "Read an approved source file inside the repository",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string", minLength: 1, maxLength: 260 }
      },
      required: ["relativePath"],
      additionalProperties: false
    }
  },
  {
    name: "code.search",
    description: "Search approved source files for a literal query string",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 },
        maxResults: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "check.typecheck",
    description: "Run allowlisted TypeScript compiler checks across workspaces",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 30000 }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "check.lint",
    description: "Run allowlisted ESLint checks across workspaces",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 30000 }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "check.test",
    description: "Run allowlisted Vitest unit tests",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 30000 },
        filter: { type: "string", maxLength: 80 }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "check.build",
    description: "Run allowlisted workspace build",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 30000 }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "diagnostics.summary",
    description: "Retrieve sanitized workspace diagnostics without secrets",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
];

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

  public listTools(): readonly DevMcpToolDefinition[] {
    return DEV_MCP_TOOL_DEFINITIONS;
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
      if (arg.includes("\0") || /[;&|`$<>()\r\n]/.test(arg)) {
        throw new Error(`Rejected unsafe command argument: ${arg}`);
      }
    }

    const binDir = path.join(this.repoRoot, "node_modules", ".bin");
    const cleanEnv = prependToPathEnv(buildSanitizedEnv(process.env), binDir, process.platform);
    const resolvedExec = resolveAllowlistedExecutable(binary, this.repoRoot, process.platform, cleanEnv);

    const proc = spawnSync(resolvedExec.command, [...resolvedExec.prefixArgs, ...args], {
      cwd: this.repoRoot,
      env: cleanEnv,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      shell: false
    });

    const timedOut = Boolean(
      proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    );
    const outBound = truncateBoundedOutput(proc.stdout ?? "");
    const errBound = truncateBoundedOutput(
      proc.stderr ?? (proc.error ? proc.error.message : "")
    );

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
        EmptyObjectArgsSchema.parse(rawArgs);
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
        EmptyObjectArgsSchema.parse(rawArgs);
        const safeEnvKeys = Object.keys(buildSanitizedEnv(process.env));
        return {
          server: DEV_MCP_SERVER_INFO.name,
          version: DEV_MCP_SERVER_INFO.version,
          nodeVersion: process.version,
          platform: process.platform,
          pathDelimiter: path.delimiter,
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
