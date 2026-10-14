import * as path from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import {
  FilterEffectSchema,
  getFrameRateValue,
  ProjectRepository,
  ProjectSchema,
  TextOverlaySchema,
  TransitionSpecSchema,
  validateSafeProjectPath
} from "@frameforge/project-schema";
import {
  addClipToTrack,
  deleteClip,
  splitClip,
  summarizeTimeline,
  trimClip,
  updateClipProperties
} from "@frameforge/timeline-engine";
import {
  importMediaIntoProject,
  probeMediaFile
} from "@frameforge/media-engine";
import {
  RenderJobQueue,
  validateRenderedOutput
} from "@frameforge/render-engine";

export const VIDEO_MCP_SERVER_INFO = {
  name: "frameforge-video-mcp",
  version: "0.2.0",
  protocolVersion: "2024-11-05",
  connected: false
} as const;

export const VideoToolNameSchema = z.enum([
  "project.create",
  "project.inspect",
  "project.validate",
  "media.inspect",
  "media.import",
  "timeline.inspect",
  "timeline.add_clip",
  "timeline.edit_clip",
  "timeline.split_clip",
  "timeline.delete_clip",
  "timeline.add_text_overlay",
  "render.start",
  "render.status",
  "render.inspect_output"
]);

export type VideoToolName = z.infer<typeof VideoToolNameSchema>;

export function getVideoMcpServerDescriptor() {
  return VIDEO_MCP_SERVER_INFO;
}

export interface McpJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: boolean;
}

export interface McpToolDefinition {
  name: VideoToolName;
  description: string;
  inputSchema: McpJsonSchema;
}

const ProjectCreateArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    name: z.string().min(1).max(120)
  })
  .strict();

const ProjectIdArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80)
  })
  .strict();

const MediaInspectArgsSchema = z
  .object({
    relativeFilePath: z.string().min(1)
  })
  .strict();

const MediaImportArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    sourceRelativePath: z.string().min(1),
    assetId: z.string().min(1).max(80),
    name: z.string().min(1).max(120).optional()
  })
  .strict();

const TimelineAddClipArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    clipId: z.string().min(1).max(80),
    trackId: z.string().min(1).max(80),
    assetId: z.string().min(1).max(80),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    sourceInFrame: z.number().int().nonnegative().default(0),
    sourceOutFrame: z.number().int().positive().optional()
  })
  .strict();

const TimelineEditClipArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    clipId: z.string().min(1).max(80),
    newStartFrame: z.number().int().nonnegative().optional(),
    newDurationFrames: z.number().int().positive().optional(),
    newSourceInFrame: z.number().int().nonnegative().optional(),
    newSourceOutFrame: z.number().int().positive().optional(),
    playbackSpeed: z.number().min(0.25).max(4.0).optional(),
    volume: z.number().min(0).max(2.0).optional(),
    fadeInFrames: z.number().int().nonnegative().optional(),
    fadeOutFrames: z.number().int().nonnegative().optional(),
    transitionIn: TransitionSpecSchema.optional(),
    effects: z.array(FilterEffectSchema).optional()
  })
  .strict();

const TimelineSplitClipArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    clipId: z.string().min(1).max(80),
    splitAtFrame: z.number().int().positive(),
    rightClipId: z.string().min(1).max(80).optional()
  })
  .strict();

const TimelineDeleteClipArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    clipId: z.string().min(1).max(80),
    ripple: z.boolean().default(false),
    confirm: z.boolean()
  })
  .strict();

const TimelineAddTextOverlayArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    clipId: z.string().min(1).max(80),
    trackId: z.string().min(1).max(80).default("track-text-1"),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    overlay: TextOverlaySchema
  })
  .strict();

const RenderStartArgsSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    jobId: z.string().min(1).max(80),
    outputRelativePath: z.string().min(1),
    confirm: z.boolean()
  })
  .strict();

const RenderStatusArgsSchema = z
  .object({
    jobId: z.string().min(1).max(80)
  })
  .strict();

const RenderInspectOutputArgsSchema = z
  .object({
    outputRelativePath: z.string().min(1)
  })
  .strict();

export const VIDEO_MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "project.create",
    description: "Create a new vertical 1080x1920@30fps video project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        name: { type: "string", minLength: 1, maxLength: 120 }
      },
      required: ["projectId", "name"],
      additionalProperties: false
    }
  },
  {
    name: "project.inspect",
    description: "Inspect a saved project model and metadata",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "project.validate",
    description: "Validate project integrity, assets, and track/clip IDs",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "media.inspect",
    description: "Inspect a confined local media file using ffprobe",
    inputSchema: {
      type: "object",
      properties: {
        relativeFilePath: { type: "string", minLength: 1 }
      },
      required: ["relativeFilePath"],
      additionalProperties: false
    }
  },
  {
    name: "media.import",
    description: "Import a confined local media file into a project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        sourceRelativePath: { type: "string", minLength: 1 },
        assetId: { type: "string", minLength: 1, maxLength: 80 },
        name: { type: "string", minLength: 1, maxLength: 120 }
      },
      required: ["projectId", "sourceRelativePath", "assetId"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.inspect",
    description: "Summarize project timeline tracks, clips, and duration",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.add_clip",
    description: "Add a media clip onto a project timeline track",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        clipId: { type: "string", minLength: 1, maxLength: 80 },
        trackId: { type: "string", minLength: 1, maxLength: 80 },
        assetId: { type: "string", minLength: 1, maxLength: 80 },
        startFrame: { type: "integer", minimum: 0 },
        durationFrames: { type: "integer", exclusiveMinimum: 0 },
        sourceInFrame: { type: "integer", minimum: 0, default: 0 },
        sourceOutFrame: { type: "integer", exclusiveMinimum: 0 }
      },
      required: ["projectId", "clipId", "trackId", "assetId", "startFrame", "durationFrames"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.edit_clip",
    description: "Edit clip trim, playbackSpeed, volume, fades, or effects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        clipId: { type: "string", minLength: 1, maxLength: 80 },
        newStartFrame: { type: "integer", minimum: 0 },
        newDurationFrames: { type: "integer", exclusiveMinimum: 0 },
        newSourceInFrame: { type: "integer", minimum: 0 },
        newSourceOutFrame: { type: "integer", exclusiveMinimum: 0 },
        playbackSpeed: { type: "number", minimum: 0.25, maximum: 4.0 },
        volume: { type: "number", minimum: 0, maximum: 2.0 },
        fadeInFrames: { type: "integer", minimum: 0 },
        fadeOutFrames: { type: "integer", minimum: 0 },
        transitionIn: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["none", "fade", "wipeleft", "dissolve"] },
            durationFrames: { type: "integer", minimum: 0, maximum: 300 }
          },
          additionalProperties: false
        },
        effects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["brightness", "contrast", "saturation", "blur", "grayscale"]
              },
              value: { type: "number" }
            },
            required: ["type", "value"],
            additionalProperties: false
          }
        }
      },
      required: ["projectId", "clipId"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.split_clip",
    description: "Split a clip at a specific timeline frame",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        clipId: { type: "string", minLength: 1, maxLength: 80 },
        splitAtFrame: { type: "integer", exclusiveMinimum: 0 },
        rightClipId: { type: "string", minLength: 1, maxLength: 80 }
      },
      required: ["projectId", "clipId", "splitAtFrame"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.delete_clip",
    description: "Delete a clip from a track (requires confirm: true)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        clipId: { type: "string", minLength: 1, maxLength: 80 },
        ripple: { type: "boolean", default: false },
        confirm: { type: "boolean" }
      },
      required: ["projectId", "clipId", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "timeline.add_text_overlay",
    description: "Add a styled text overlay clip to a text track",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        clipId: { type: "string", minLength: 1, maxLength: 80 },
        trackId: { type: "string", minLength: 1, maxLength: 80, default: "track-text-1" },
        startFrame: { type: "integer", minimum: 0 },
        durationFrames: { type: "integer", exclusiveMinimum: 0 },
        overlay: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            preset: {
              type: "string",
              enum: ["title-bold", "lower-third", "caption-pill", "center-callout"]
            },
            fontSize: { type: "integer", minimum: 12, maximum: 200 },
            fontColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            backgroundColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" },
            x: { type: "integer", minimum: 0, maximum: 3840 },
            y: { type: "integer", minimum: 0, maximum: 3840 }
          },
          required: ["text"],
          additionalProperties: false
        }
      },
      required: ["projectId", "clipId", "startFrame", "durationFrames", "overlay"],
      additionalProperties: false
    }
  },
  {
    name: "render.start",
    description: "Render a project to a 1080x1920@30fps MP4 (requires confirm: true)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        jobId: { type: "string", minLength: 1, maxLength: 80 },
        outputRelativePath: { type: "string", minLength: 1 },
        confirm: { type: "boolean" }
      },
      required: ["projectId", "jobId", "outputRelativePath", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "render.status",
    description: "Check status and validation of a render job by jobId",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1, maxLength: 80 }
      },
      required: ["jobId"],
      additionalProperties: false
    }
  },
  {
    name: "render.inspect_output",
    description: "Inspect a rendered MP4 output file via ffprobe",
    inputSchema: {
      type: "object",
      properties: {
        outputRelativePath: { type: "string", minLength: 1 }
      },
      required: ["outputRelativePath"],
      additionalProperties: false
    }
  }
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export class VideoEditingMcpServer {
  private readonly workspaceRoot: string;
  private readonly repo: ProjectRepository;
  private readonly renderQueue: RenderJobQueue;
  private requestCount = 0;
  private readonly maxRequestsPerSession: number;

  constructor(options: { workspaceRoot: string; maxRequestsPerSession?: number }) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.repo = new ProjectRepository(path.join(this.workspaceRoot, "projects"));
    this.renderQueue = new RenderJobQueue(path.join(this.workspaceRoot, ".frameforge-temp"));
    this.maxRequestsPerSession = options.maxRequestsPerSession ?? 500;
  }

  public listTools(): readonly McpToolDefinition[] {
    return VIDEO_MCP_TOOL_DEFINITIONS;
  }

  public callTool(name: string, rawArgs: unknown): unknown {
    this.requestCount += 1;
    if (this.requestCount > this.maxRequestsPerSession) {
      throw new Error("MCP session rate limit exceeded");
    }

    const toolName = VideoToolNameSchema.parse(name);

    switch (toolName) {
      case "project.create": {
        const args = ProjectCreateArgsSchema.parse(rawArgs);
        const project = this.repo.createProject({
          id: args.projectId,
          name: args.name
        });
        return { project };
      }
      case "project.inspect": {
        const args = ProjectIdArgsSchema.parse(rawArgs);
        const project = this.repo.loadProject(args.projectId, { allowAutosaveRecovery: true });
        return { project };
      }
      case "project.validate": {
        const args = ProjectIdArgsSchema.parse(rawArgs);
        const project = this.repo.loadProject(args.projectId, { allowAutosaveRecovery: true });
        const check = ProjectSchema.safeParse(project);
        return { valid: check.success, projectId: args.projectId };
      }
      case "media.inspect": {
        const args = MediaInspectArgsSchema.parse(rawArgs);
        const safePath = validateSafeProjectPath(this.workspaceRoot, args.relativeFilePath);
        const probe = probeMediaFile(safePath);
        return { probe };
      }
      case "media.import": {
        const args = MediaImportArgsSchema.parse(rawArgs);
        const project = this.repo.loadProject(args.projectId);
        const safeSource = validateSafeProjectPath(this.workspaceRoot, args.sourceRelativePath);
        const imported = importMediaIntoProject(this.repo, project, safeSource, {
          assetId: args.assetId,
          name: args.name
        });
        return { asset: imported.asset, probe: imported.probe };
      }
      case "timeline.inspect": {
        const args = ProjectIdArgsSchema.parse(rawArgs);
        const project = this.repo.loadProject(args.projectId);
        return {
          summary: summarizeTimeline(project.timeline),
          tracks: project.timeline.tracks
        };
      }
      case "timeline.add_clip": {
        const args = TimelineAddClipArgsSchema.parse(rawArgs);
        let project = this.repo.loadProject(args.projectId);
        project = addClipToTrack(project, {
          id: args.clipId,
          trackId: args.trackId,
          assetId: args.assetId,
          startFrame: args.startFrame,
          durationFrames: args.durationFrames,
          sourceInFrame: args.sourceInFrame,
          sourceOutFrame: args.sourceOutFrame
        });
        this.repo.saveProject(project);
        return { summary: summarizeTimeline(project.timeline) };
      }
      case "timeline.edit_clip": {
        const args = TimelineEditClipArgsSchema.parse(rawArgs);
        let project = this.repo.loadProject(args.projectId);
        if (args.playbackSpeed !== undefined) {
          project = updateClipProperties(project, args.clipId, {
            playbackSpeed: args.playbackSpeed
          });
        }
        if (
          args.newStartFrame !== undefined ||
          args.newDurationFrames !== undefined ||
          args.newSourceInFrame !== undefined ||
          args.newSourceOutFrame !== undefined
        ) {
          project = trimClip(project, {
            clipId: args.clipId,
            newStartFrame: args.newStartFrame,
            newDurationFrames: args.newDurationFrames,
            newSourceInFrame: args.newSourceInFrame,
            newSourceOutFrame: args.newSourceOutFrame
          });
        }
        project = updateClipProperties(project, args.clipId, {
          volume: args.volume,
          fadeInFrames: args.fadeInFrames,
          fadeOutFrames: args.fadeOutFrames,
          transitionIn: args.transitionIn,
          effects: args.effects
        });
        this.repo.saveProject(project);
        return { summary: summarizeTimeline(project.timeline) };
      }
      case "timeline.split_clip": {
        const args = TimelineSplitClipArgsSchema.parse(rawArgs);
        let project = this.repo.loadProject(args.projectId);
        project = splitClip(project, {
          clipId: args.clipId,
          splitAtFrame: args.splitAtFrame,
          rightClipId: args.rightClipId
        });
        this.repo.saveProject(project);
        return { summary: summarizeTimeline(project.timeline) };
      }
      case "timeline.delete_clip": {
        const args = TimelineDeleteClipArgsSchema.parse(rawArgs);
        if (!args.confirm) {
          throw new Error("Destructive action timeline.delete_clip requires confirm: true");
        }
        let project = this.repo.loadProject(args.projectId);
        project = deleteClip(project, {
          clipId: args.clipId,
          ripple: args.ripple
        });
        this.repo.saveProject(project);
        return { summary: summarizeTimeline(project.timeline) };
      }
      case "timeline.add_text_overlay": {
        const args = TimelineAddTextOverlayArgsSchema.parse(rawArgs);
        let project = this.repo.loadProject(args.projectId);
        project = addClipToTrack(project, {
          id: args.clipId,
          trackId: args.trackId,
          startFrame: args.startFrame,
          durationFrames: args.durationFrames,
          textOverlay: args.overlay
        });
        this.repo.saveProject(project);
        return { summary: summarizeTimeline(project.timeline) };
      }
      case "render.start": {
        const args = RenderStartArgsSchema.parse(rawArgs);
        if (!args.confirm) {
          throw new Error("Externally visible action render.start requires confirm: true");
        }
        const project = this.repo.loadProject(args.projectId);
        const safeOut = validateSafeProjectPath(this.workspaceRoot, args.outputRelativePath);
        const job = this.renderQueue.renderProjectSync({
          jobId: args.jobId,
          project,
          projectDir: this.repo.getProjectDir(project.id),
          outputFilePath: safeOut,
          extractSampleFrame: true
        });
        return { job };
      }
      case "render.status": {
        const args = RenderStatusArgsSchema.parse(rawArgs);
        const job = this.renderQueue.getJob(args.jobId);
        if (!job) {
          throw new Error(`Render job not found: ${args.jobId}`);
        }
        return { job };
      }
      case "render.inspect_output": {
        const args = RenderInspectOutputArgsSchema.parse(rawArgs);
        const safeOut = validateSafeProjectPath(this.workspaceRoot, args.outputRelativePath);
        const validation = validateRenderedOutput(safeOut, {
          width: 1080,
          height: 1920,
          fps: 30
        });
        return { validation };
      }
    }
  }

  public handleJsonRpc(request: JsonRpcRequest): JsonRpcResponse | null {
    const id = request.id ?? null;
    try {
      if (request.method === "notifications/initialized") {
        return null;
      }
      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: VIDEO_MCP_SERVER_INFO.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: VIDEO_MCP_SERVER_INFO.name,
              version: VIDEO_MCP_SERVER_INFO.version
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
        if (!params.name) {
          throw new Error("Missing tool name in tools/call");
        }
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
          message: err instanceof Error ? err.message : String(err)
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
        const req = JSON.parse(trimmed) as JsonRpcRequest;
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
