# FrameForge

FrameForge is a local-first AI-powered vertical video editing platform built as a strict TypeScript monorepo with two independent Model Context Protocol (MCP) servers: **Development MCP** (`@frameforge/mcp-dev-server`) and **Video Editing MCP** (`@frameforge/mcp-video-server`).

## Monorepo Architecture

```text
frameforge/
├── apps/
│   └── web/                  # @frameforge/web — Next.js App Router dark editor UI (localhost:3000)
├── packages/
│   ├── project-schema/       # @frameforge/project-schema — Versioned (v0.2.0) Zod project/timeline schemas, migration, persistence & path confinement
│   ├── timeline-engine/      # @frameforge/timeline-engine — Deterministic multi-track editing (add, move, snap, trim, split, ripple delete, keyframes, AV sync, undo/redo)
│   ├── media-engine/         # @frameforge/media-engine — Safe media classification, ffprobe inspection & confined project media import
│   ├── render-engine/        # @frameforge/render-engine — Real FFmpeg 1080x1920@30fps MP4 pipeline, Remotion composition manifest, job queue & ffprobe output validation
│   └── ai-adapters/          # @frameforge/ai-adapters — Optional Piper TTS adapter, local speech-to-text status & SRT caption pipeline
├── mcp/
│   ├── dev-server/           # @frameforge/mcp-dev-server — Stdio MCP server for restricted repo inspection, search, typecheck, lint, test & diagnostics
│   ├── video-server/         # @frameforge/mcp-video-server — Stdio MCP server for project creation, timeline editing, text overlays & verified MP4 rendering
│   └── client-configs/       # Official configuration templates for Antigravity, Claude Desktop, and Codex
└── tests/
    └── integration/          # @frameforge/integration-tests — Cross-package, reliability/security, and live stdio MCP client integration tests
```

## Windows Installation & Prerequisites

### 1. Install Core Dependencies (PowerShell)

```powershell
# Install Git, Node.js 24 LTS, and FFmpeg (includes ffmpeg & ffprobe)
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id Gyan.FFmpeg -e --source winget

# Enable pnpm via Corepack
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### 2. Optional Local AI Dependencies (Step 8)

Core video editing, timeline manipulation, SRT caption editing, and FFmpeg MP4 rendering work **100% locally without any AI models or paid API keys**.

- **Piper TTS (Optional Local Voice-Over):** Download the standalone `piper` executable and an `.onnx` + `.onnx.json` voice model (e.g., `en_US-lessac-medium.onnx`), then pass `piperBinaryPath` and `piperModelPath` in `LocalAiConfig`.
- **Local Speech Recognition (Optional STT):** Installing Piper TTS does **not** provide speech recognition. To transcribe audio locally, configure a separate local Whisper binary (`whisperBinaryPath`) and model file (`whisperModelPath`).
- **Paid Cloud AI Providers:** Disabled by default (`enabled: false`) and never required for editing or rendering.

## Workspace Commands

| Command | Description |
| --- | --- |
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start `@frameforge/web` on `http://127.0.0.1:3000` (localhost-only) |
| `pnpm build` | Build all packages and compile the Next.js production bundle |
| `pnpm typecheck` | Run strict TypeScript validation across all 9 workspaces |
| `pnpm lint` | Run ESLint across workspace source files and configs |
| `pnpm test` | Run all 10 unit, integration, security, and live MCP test suites |

## Supported Formats, Effects & Honest Limitations

- **Supported Input Extensions:** Video (`.mp4`, `.mov`, `.mkv`, `.webm`), Audio (`.wav`, `.mp3`, `.aac`, `.flac`), Image (`.png`, `.jpg`, `.jpeg`, `.webp`), Subtitles (`.srt`, `.vtt`, `.json`).
- **Verified Render Profile:** `1080x1920` (9:16 vertical), `30 FPS`, H.264 (`libx264`, `yuv420p`) + AAC (`48 kHz`) MP4.
- **Preview & Export Parity:**
  - Clip trimming (`sourceInFrame`/`sourceOutFrame`), timeline positioning (`startFrame`/`durationFrames`), and playback speed (`0.25x`–`4.0x` via `setpts`/`atempo`)
  - Visual filters: `brightness`, `contrast`, `saturation`, `blur` (`boxblur`), `grayscale` (`hue=s=0`)
  - Transitions: `fade` in/out
  - Audio volume (`0`–`200%`), `fadeInFrames` / `fadeOutFrames` (`afade`), and multi-track mixing (`amix`)
  - Text overlays (`drawtext` when FreeType font is present) and vertical templates (`tiktok-hook-story-cta`, `product-showcase-9x16`, `podcast-clip-vertical`)
- **Known Limitations:**
  - Keyframes (`opacity`, `scale`, `x`, `y`) are evaluated in the timeline engine (`evaluateKeyframeAtFrame`) and stored in the project schema, but dynamic per-frame keyframe expressions in FFmpeg export are limited to static/fade equivalents in v0.2.0.
  - 4K UHD export, hardware GPU encoding (NVENC/AMF/QSV), and 3D mesh transitions are not enabled or claimed.

## Connecting MCP Clients (Step 11)

Build the workspace first (`pnpm build`) so `mcp/dev-server/dist/cli.js` and `mcp/video-server/dist/cli.js` exist. Reference templates are in `mcp/client-configs/`:

- **Antigravity:** Merge `mcp/client-configs/antigravity.mcp.json` into your Antigravity `mcp_config.json`.
- **Claude Desktop:** Merge `mcp/client-configs/claude_desktop_config.json` into `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
- **Codex:** Append the `[mcp_servers.frameforge-dev-mcp]` and `[mcp_servers.frameforge-video-mcp]` sections from `mcp/client-configs/codex.config.toml` into `~/.codex/config.toml`.

## Data Storage, Backups & Recovery

- **Isolated Project Layout:** Each project is stored in `<workspaceRoot>/projects/<projectId>/` with metadata in `project.json`, automatic crash recovery snapshots in `project.autosave.json`, and imported media files strictly confined to `media/`.
- **Crash Recovery:** Calling `repo.loadProject(projectId, { allowAutosaveRecovery: true })` or `repo.recoverFromAutosave(projectId)` automatically restores the latest valid `project.autosave.json` if `project.json` is corrupted or interrupted during a write.
