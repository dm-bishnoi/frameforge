import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@frameforge/project-schema": path.resolve(__dirname, "./packages/project-schema/src/index.ts"),
      "@frameforge/timeline-engine": path.resolve(__dirname, "./packages/timeline-engine/src/index.ts"),
      "@frameforge/media-engine": path.resolve(__dirname, "./packages/media-engine/src/index.ts"),
      "@frameforge/render-engine": path.resolve(__dirname, "./packages/render-engine/src/index.ts"),
      "@frameforge/ai-adapters": path.resolve(__dirname, "./packages/ai-adapters/src/index.ts"),
      "@frameforge/mcp-dev-server": path.resolve(__dirname, "./mcp/dev-server/src/index.ts"),
      "@frameforge/mcp-video-server": path.resolve(__dirname, "./mcp/video-server/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "mcp/**/*.test.ts",
      "tests/**/*.test.ts"
    ],
    passWithNoTests: false
  }
});
