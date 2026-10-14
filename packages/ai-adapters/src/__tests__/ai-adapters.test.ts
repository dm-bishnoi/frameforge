import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRepository } from "@frameforge/project-schema";
import {
  addVoiceOverToProjectTimeline,
  applyCaptionsToTimeline,
  formatSrtCaptions,
  inspectAiAdapterStatus,
  parseSrtCaptions,
  synthesizeVoiceOverToWav,
  updateCaptionCue,
  validateCaptionTimings
} from "../index";

describe("@frameforge/ai-adapters — Step 8 Local AI Features", () => {
  it("reports Piper TTS and Speech Recognition availability independently and keeps paid providers disabled by default", () => {
    const status = inspectAiAdapterStatus();
    expect(status.piperTtsAvailable).toBe(false);
    expect(status.speechRecognitionAvailable).toBe(false);

    const cloud = status.adapters.find((a) => a.id === "cloud-llm-optional");
    expect(cloud?.enabled).toBe(false);
    expect(cloud?.requiresApiKey).toBe(true);

    // If Piper binary/model exist, speechRecognitionAvailable still stays false unless Whisper is also configured
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-ai-check-"));
    try {
      const fakePiper = path.join(tmpDir, "piper");
      const fakeModel = path.join(tmpDir, "en_US.onnx");
      fs.writeFileSync(fakePiper, "");
      fs.writeFileSync(fakeModel, "");

      const partialStatus = inspectAiAdapterStatus({
        piperBinaryPath: fakePiper,
        piperModelPath: fakeModel
      });
      expect(partialStatus.piperTtsAvailable).toBe(true);
      expect(partialStatus.speechRecognitionAvailable).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses, edits, validates, and places SRT captions and synthesized voice-over onto the project timeline", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "Welcome to FrameForge",
      "",
      "2",
      "00:00:01,000 --> 00:00:02,000",
      "Local first video editing"
    ].join("\n");

    const cues = parseSrtCaptions(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe("Welcome to FrameForge");

    const edited = updateCaptionCue(cues, "cue-2", { text: "Verified local workflow" });
    expect(formatSrtCaptions(edited)).toContain("Verified local workflow");

    // Reject overlapping caption timings
    const overlapCheck = validateCaptionTimings([
      { id: "c1", startMs: 0, endMs: 1500, text: "First" },
      { id: "c2", startMs: 1000, endMs: 2000, text: "Overlapping second" }
    ]);
    expect(overlapCheck.valid).toBe(false);

    // Synthesize local fixture voice-over and place on timeline
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-vo-test-"));
    try {
      const repo = new ProjectRepository(tmpRoot);
      let project = repo.createProject({
        id: "vo-proj",
        name: "Voiceover Project"
      });

      // Without fallback and without Piper binary installed, throws honest error
      expect(() =>
        synthesizeVoiceOverToWav({
          text: "Test voiceover",
          outputWavPath: path.join(tmpRoot, "fail.wav"),
          allowLocalFixtureFallback: false
        })
      ).toThrow("Piper TTS binary or ONNX voice model is not configured");

      project = addVoiceOverToProjectTimeline({
        repo,
        project,
        text: "Welcome to FrameForge local voice over",
        assetId: "asset-vo-1",
        clipId: "clip-vo-1",
        trackId: "track-audio-1",
        startFrame: 0,
        tempWavDir: tmpRoot,
        allowLocalFixtureFallback: true
      });

      project = applyCaptionsToTimeline(project, edited, "track-text-1");
      const audioTrack = project.timeline.tracks.find((t) => t.id === "track-audio-1");
      const textTrack = project.timeline.tracks.find((t) => t.id === "track-text-1");

      expect(audioTrack?.clips).toHaveLength(1);
      expect(textTrack?.clips).toHaveLength(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
