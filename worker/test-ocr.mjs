// Try the new full-video OCR on ONE reel, without touching the database.
//
//   cd worker
//   node test-ocr.mjs https://www.instagram.com/reel/XXXX/     # resolve + download
//   node test-ocr.mjs ./some-local-video.mp4                   # skip the resolver
//
// Prints how many frames survived dedupe, the on-screen text with timestamps,
// the merged timeline exactly as the LLM will see it, and the structured JSON.
// Flags:
//   --no-llm     stop after OCR (no structuring call)
//   --keep       leave the extracted frames on disk so you can look at them
//
// Tuning knobs (env): OCR_FPS, OCR_MAX_FRAMES, OCR_DECIMATE, OCR_WIDTH.

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { config } from "./config.mjs";
import { resolveReel } from "./resolve.mjs";
import { downloadVideo, extractAudio, sampleTextFrames } from "./media.mjs";
import { transcribe, ocrTimeline, structure } from "./nvidia.mjs";
import { verifyEntities } from "./verify.mjs";
import { buildTimeline, buildUserContent } from "./prompts.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const noLlm = args.includes("--no-llm");
const keep = args.includes("--keep");

if (!target) {
  console.error("Usage: node test-ocr.mjs <reel-url | local-video.mp4> [--no-llm] [--keep]");
  process.exit(1);
}

const stamp = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), "reel-ocr-test-"));
  const t0 = Date.now();
  try {
    let videoPath;
    let caption = "";

    if (existsSync(target)) {
      videoPath = path.resolve(target);
      console.log(`Local file: ${videoPath}\n`);
    } else {
      console.log(`Resolving ${target} ...`);
      const r = await resolveReel(target);
      caption = r.caption || "";
      videoPath = path.join(work, "video.mp4");
      await downloadVideo(r.videoUrl, videoPath);
      console.log("Downloaded.\n");
    }

    // ── frames ──
    console.log(
      `Sampling at ${config.ocr.fps} fps, dedupe "${config.ocr.decimate}", ` +
      `cap ${config.ocr.maxFrames} frames ...`,
    );
    const frames = await sampleTextFrames(videoPath, path.join(work, "frames"), config.ocr);
    console.log(`  -> ${frames.length} distinct frame(s) kept`);
    if (frames.length) {
      console.log(`  -> spanning ${stamp(frames[0].t)} to ${stamp(frames[frames.length - 1].t)}`);
      console.log(`  -> at: ${frames.map((f) => stamp(f.t)).join(", ")}\n`);
    }

    // ── audio ──
    let transcript = "";
    let segments = [];
    try {
      const wav = path.join(work, "audio.wav");
      await extractAudio(videoPath, wav);
      const asr = await transcribe(wav);
      transcript = asr.text;
      segments = asr.segments;
      console.log(`Transcript: ${transcript.length} chars, ${segments.length} timed segment(s)\n`);
    } catch (e) {
      console.warn(`Transcription failed: ${e.message}\n`);
    }

    // ── OCR ──
    console.log(`OCR on ${frames.length} frame(s) ...`);
    const onScreen = await ocrTimeline(frames);
    console.log(`  -> ${onScreen.length} distinct on-screen text block(s) after merge\n`);

    console.log("──────── ON SCREEN TEXT ────────");
    if (!onScreen.length) console.log("(none found)");
    for (const o of onScreen) {
      console.log(`[${stamp(o.t)}] ${o.text.replace(/\n/g, "\n        ")}`);
    }

    console.log("\n──────── MERGED TIMELINE (what the LLM sees) ────────");
    console.log(buildTimeline({ segments, onScreen }) || "(empty)");

    if (noLlm) {
      console.log(`\nStopped before the LLM (--no-llm). ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }

    console.log("\n──────── STRUCTURED RESULT ────────");
    const onScreenText = onScreen.map((o) => o.text).join("\n");
    const out = await structure({ transcript, caption, onScreenText, segments, onScreen });
    const sub = out.synopsis || out.recipe || {};
    if (sub.entities?.length) {
      const before = sub.entities.reduce((n, e) => n + (e.links?.length || 0), 0);
      sub.entities = await verifyEntities(sub.entities);
      const after = sub.entities.reduce((n, e) => n + (e.links?.length || 0), 0);
      console.log(`(verified entity links: ${before} proposed → ${after} resolved)\n`);
    }
    console.log(JSON.stringify(out, null, 2));

    const promptChars = buildUserContent({ transcript, caption, onScreenText, segments, onScreen }).length;
    console.log(
      `\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. ` +
      `Prompt ~${promptChars} chars (~${Math.round(promptChars / 4)} tokens). ` +
      `VLM calls: ${frames.length}.`,
    );
  } finally {
    if (keep) console.log(`\nFrames kept in: ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nFailed:", e);
  process.exit(1);
});
