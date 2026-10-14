import { describe, expect, it } from "vitest";
import { createEmptyProject } from "@frameforge/project-schema";
import { summarizeTimeline } from "@frameforge/timeline-engine";
import { classifyMediaExtension } from "@frameforge/media-engine";
import { getRenderEngineCapability } from "@frameforge/render-engine";
import { getDevMcpServerDescriptor } from "@frameforge/mcp-dev-server";
import { getVideoMcpServerDescriptor } from "@frameforge/mcp-video-server";

describe("FrameForge workspace integration", () => {
  it("integrates project-schema with timeline-engine", () => {
    const project = createEmptyProject({
      id: "integration-proj",
      name: "Integration Check",
      nowIso: "2026-10-14T00:00:00.000Z"
    });

    const summary = summarizeTimeline(project.timeline);
    expect(summary).toEqual({
      timelineId: "integration-proj-timeline",
      trackCount: 0,
      clipCount: 0,
      durationFrames: 0
    });
  });

  it("enforces workspace safety and capability invariants across packages", () => {
    expect(classifyMediaExtension(".mp4").category).toBe("video");
    expect(getRenderEngineCapability().exportAvailable).toBe(true);
    expect(getDevMcpServerDescriptor().connected).toBe(false);
    expect(getDevMcpServerDescriptor().allowArbitraryShellExecution).toBe(false);
    expect(getVideoMcpServerDescriptor().connected).toBe(false);
  });
});
