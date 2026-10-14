# FrameForge v0.2.0 — Release Readiness Report (Step 12)

## 1. Executive Summary

FrameForge Steps 1 through 12 have been implemented, integrated, and verified locally. The monorepo provides a shared, Zod-validated project model (`v0.2.0` with automatic migration from `v0.1.0`), a deterministic multi-track timeline engine, an accessible Next.js dark editor workspace, a real `ffmpeg`/`ffprobe` 1080x1920@30fps vertical MP4 rendering pipeline, local AI creator adapters (Piper TTS + SRT caption pipeline), and two hardened stdio MCP servers (`frameforge-dev-mcp` and `frameforge-video-mcp`).

## 2. Verified Evidence Summary

| Verification Gate | Command / Suite | Result | Verified Evidence |
| --- | --- | --- | --- |
| **TypeScript Check** | `pnpm typecheck` | **PASSED** | All 9 workspace packages typechecked with 0 errors |
| **Lint Check** | `pnpm lint` | **PASSED** | 23 TypeScript/React source files and 3 JS/MJS config files passed with 0 errors |
| **Production Build** | `pnpm build` | **PASSED** | All library packages compiled to `dist/`; `@frameforge/web` static/server bundle built |
| **Unit, Integration, Security & MCP Tests** | `pnpm test` | **PASSED (10/10 suites, 22/22 tests)** | Includes schema migration, timeline operations, UI rendering, FFmpeg encoding, MCP stdio protocol, and security regression tests |
| **End-to-End MP4 Export & `ffprobe` Audit** | `frameforge-release-demo.mp4` | **PASSED** | Verified `1080x1920`, `30 FPS`, `h264` (`yuv420p`) video stream + `aac` (`48000 Hz`) audio stream |

## 3. Dependency & License Review

| Package | Version Baseline | License | Purpose |
| --- | --- | --- | --- |
| `next` / `react` / `react-dom` | `^15.1.0` / `^19.0.0` | MIT | Browser editor UI and local server routes |
| `zod` | `^3.24.1` | MIT | Runtime validation for schemas and MCP tool inputs |
| `tailwindcss` / `postcss` / `autoprefixer` | `^3.4.17` | MIT | Dark editor styling |
| `typescript` / `vitest` / `eslint` / `prettier` | `^5.7.2` / `^2.1.8` | Apache-2.0 / MIT | Build, test, and lint toolchain |
| External System Binary: `ffmpeg` / `ffprobe` | `5.1+` | LGPLv2.1+ / GPLv2+ (system binary) | Invoked via `execFile` array args; not statically linked |

## 4. Security & Reliability Controls Verified (Step 10)

- **Path Confinement & Traversal Prevention:** `validateSafeProjectPath` and `isSafeRelativeMediaPath` block `..`, `%2e%2e`, null bytes (`\0`), absolute paths, Windows drive letters, and symbolic links escaping the project root.
- **Zero Shell Interpolation:** All `ffmpeg`, `ffprobe`, `git`, and `pnpm` invocations use `execFile` / `execFileSync` / `spawnSync` with argument arrays and reject shell metacharacters (`[;&|`$<>]`).
- **Secret Scrubbing:** `DevelopmentMcpServer` strips environment variables matching `(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTH)` before child process execution and redacts secret values from stdout/stderr/error payloads.
- **Confirmation Gates & Quotas:** `timeline.delete_clip` and `render.start` require `confirm: true`; session request limits (`maxRequestsPerSession`), project JSON size limits (`10 MB`), and media file quotas (`500 MB`) are enforced.
- **Autosave & Crash Recovery:** `ProjectRepository.loadProject(..., { allowAutosaveRecovery: true })` restores `project.autosave.json` when `project.json` is corrupted.

## 5. Known Limitations & Unresolved Blockers

1. **Offline Container Constraints:** This build was verified in an offline Linux sandbox container (`Node.js v18.20.4`, `FFmpeg 5.1.9`). On a developer workstation, run `pnpm install` with Node.js 24 LTS to hydrate full upstream `node_modules` packages and test interactive desktop MCP clients (Antigravity, Claude Desktop, Codex GUI) live.
2. **External Local AI Models Not Bundled:** Piper TTS (`.onnx` models) and local Whisper binaries are not bundled in the repository to keep repository size small; `inspectAiAdapterStatus()` accurately reports them as unconfigured until local paths are supplied.
3. **Export Parity Scope:** 1080x1920@30fps H.264/AAC export is verified for trims, speed (`0.25x`–`4.0x`), brightness/contrast/saturation/blur/grayscale filters, fade transitions, audio fades, and `drawtext` overlays. Per-frame keyframe curve interpolation in FFmpeg filtergraphs, 4K export, and GPU hardware encoding are deferred to the next milestone.

## 6. Recommended Next Milestone (Post-v0.2.0)

- **Milestone v0.3.0 — Interactive Canvas Scrubber & Keyframe Filtergraph Compiler:** Add WebCodecs/HTML5 frame-accurate scrubbing over imported local video files in `@frameforge/web` and compile `KeyframePoint` curves into dynamic FFmpeg `overlay`/`scale` expressions.
