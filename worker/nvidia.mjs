// AI calls: LLM (classify + structure + synthesize) and VLM (on-screen text) now
// go through the multi-provider ROUTER (router.mjs), which routes each task to
// the best free provider by skill and fails over on rate-limit/exhaustion — so
// we're no longer pinned to NVIDIA's single free tier (CLAUDE.md gotcha #18).
// Transcription stays a direct Whisper call (Groq by default) because NVIDIA's
// hosted ASR is gRPC-only and it has no OpenAI-compatible sibling to route to.
// Each capability is isolated so a provider swap touches only this file + config.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";
import {
  SYSTEM_PROMPT, buildUserContent, SYNTHESIS_PROMPT, buildSynthesisContent,
  CATEGORY_PROMPT, buildCategoryContent, normalizeCategory, existingCategoriesNote,
} from "./prompts.mjs";
import { fileToBase64, tileFrames } from "./media.mjs";
import { route, parseLooseJson } from "./router.mjs";
import { withRetry } from "./retry.mjs";

const asr = config.transcription;

// Re-export so callers/logging can read which providers carried a run.
export { llmUsageSummary } from "./router.mjs";

// ── Transcription: audio -> transcript (Groq Whisper by default) ───────────
export async function transcribe(wavPath) {
  if (!asr.key) throw new Error("GROQ_API_KEY not set — cannot transcribe audio.");
  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  form.append("model", asr.model);
  // verbose_json (not plain json) so we get per-segment start/end times. Those
  // timestamps are what let on-screen text be interleaved with what was being
  // said at that moment, instead of both arriving as undifferentiated blobs.
  form.append("response_format", "verbose_json");

  const data = await withRetry(
    async () => {
      const res = await fetch(asr.base.replace(/\/$/, "") + "/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + asr.key },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`Transcription ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res.json().catch(() => null);
    },
    {
      onRetry: (e, attempt, delay) =>
        console.warn(`Transcription retry ${attempt} in ${delay}ms: ${e.message}`),
    },
  );
  const text = (data?.text || data?.transcript || "").trim();
  // Normalise segments to just what the timeline needs. Not every provider
  // returns them, so an empty array is a valid, non-fatal outcome.
  const segments = Array.isArray(data?.segments)
    ? data.segments
        .map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text || "").trim(),
        }))
        .filter((s) => s.text)
    : [];
  return { text, segments };
}

// ── VLM: frames -> on-screen text (best-effort) ───────────────────────────

// EXPORTED so the lab measures the prompt PRODUCTION sends. server.mjs kept its
// own byte-identical copy; two copies of the instruction a benchmark exists to
// test is one edit away from scoring something the pipeline does not run.
export const OCR_INSTRUCTION =
  "Read and output only the text visible in this image, exactly as shown. " +
  "Preserve line breaks. Do not describe the image, do not add commentary. " +
  "If there is no readable text, output NONE.";

// Tiled OCR: several frames stacked into one grid image, read in ONE call.
// The panels must come back SEPARATED and IN ORDER or we can't map text back to
// its timestamp — and a timestamp is half the point of the timeline (gotcha
// #22). Hence the numbered-marker format: it survives a chatty model far better
// than JSON (no vision provider here reliably honours response_format), and any
// answer whose markers don't match the panel count falls back to per-frame.
const OCR_TILE_INSTRUCTION = (n) =>
  `This image is a grid of ${n} separate video frames, in reading order: ` +
  "left to right, then top to bottom. Read each panel SEPARATELY. " +
  `Output exactly ${n} blocks, one per panel, each starting with its number ` +
  "on its own line as [1], [2], and so on. After each marker put only the text " +
  "visible in that panel, exactly as shown, preserving line breaks. " +
  "If a panel has no readable text, put NONE after its marker. " +
  "Do not describe the images and do not add any other commentary.";

// Pull "[1] text… [2] text…" back apart. Returns null if the markers don't
// cover exactly `n` panels — the caller then re-reads that group frame by
// frame, so a confused answer costs time, never correctness.
export function parseTiledOcr(raw, n) {
  const text = String(raw || "");
  const re = /\[(\d+)\][ \t]*\r?\n?/g;
  const hits = [...text.matchAll(re)];
  if (hits.length !== n) return null;
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const idx = Number(hits[i][1]);
    if (idx !== i + 1) return null;                    // out of order or a gap
    const start = hits[i].index + hits[i][0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out.push(text.slice(start, end).trim());
  }
  return out;
}

// Text that animates in ("Pre" -> "Preheat" -> "Preheat oven") produces a run of
// fragments across consecutive frames. A plain Set keeps all of them and feeds
// the LLM garbage, so collapse any line that is contained within a longer line.
export function collapseFragments(lines) {
  const uniq = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
  // Longest first, so a fragment is always tested against the fuller version.
  const sorted = [...uniq].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const line of sorted) {
    const norm = line.toLowerCase();
    const swallowed = kept.some((k) => k.toLowerCase().includes(norm));
    if (!swallowed) kept.push(line);
  }
  // Restore original order of first appearance.
  return uniq.filter((l) => kept.includes(l));
}

/**
 * OCR a list of [{ path, t }] frames and keep the timing.
 *
 * Returns [{ t, text }] ordered by time. Consecutive frames whose text is
 * identical (or a fragment of the next) are merged, so a caption that persists
 * across several sampled frames appears once, at the moment it first showed.
 */
// One vision call for one frame. The fallback path, and what tiling degrades to.
async function ocrOneFrame(frame) {
  const b64 = await fileToBase64(frame.path);
  const content = await route({
    task: "ocr",
    capability: "vision",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: OCR_INSTRUCTION },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ],
    }],
    maxTokens: 512,
  });
  return content.trim();
}

// One vision call for a GRID of frames. Returns per-panel text aligned to
// `group`, or null if the answer didn't come back cleanly separated.
async function ocrOneTile(tile, group) {
  const b64 = await fileToBase64(tile.path);
  const content = await route({
    task: "ocr",
    capability: "vision",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: OCR_TILE_INSTRUCTION(group.length) },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ],
    }],
    maxTokens: 512 * group.length,   // the budget is per panel, not per call
  });
  return parseTiledOcr(content, group.length);
}

export async function ocrTimeline(frames) {
  const entries = [];
  const perTile = config.ocr?.perTile || 1;

  // Pack frames into grids when tiling is on. Tiles are written next to the
  // frames themselves, inside the item's temp dir, so the existing cleanup
  // removes them and nothing new has to be plumbed through.
  let tiles = null;
  if (perTile >= 2 && frames.length >= 2) {
    try {
      const dir = path.join(path.dirname(frames[0].path), "tiles");
      // tileFrames splits `width` ACROSS the columns, so passing the normal OCR
      // width would halve every panel at 4-up (360px) and small caption text is
      // exactly what we're here to read. Scale the grid by the column count so
      // each panel keeps its full resolution; the image gets bigger, but it's
      // still one call instead of four.
      const cols = Math.ceil(Math.sqrt(perTile));
      tiles = await tileFrames(frames, dir, perTile, (config.ocr?.width || 720) * cols);
    } catch (e) {
      console.warn("Frame tiling failed, reading frame by frame:", e.message);
      tiles = null;
    }
  }

  if (tiles?.length) {
    console.log(`  OCR: ${frames.length} frame(s) in ${tiles.length} tiled call(s)`);
    let i = 0;
    for (const tile of tiles) {
      const group = frames.slice(i, i + perTile);
      i += perTile;
      let texts = null;
      try {
        texts = await ocrOneTile(tile, group);
        if (!texts) console.warn(`  tile ${tile.path.split("/").pop()}: panels didn't line up — re-reading singly`);
      } catch (e) {
        console.warn("  tiled OCR call failed, re-reading singly:", e.message);
      }
      // Whole-group fallback: read this group's frames one at a time.
      if (!texts) {
        for (const frame of group) {
          try {
            const text = await ocrOneFrame(frame);
            if (text && text.toUpperCase() !== "NONE") entries.push({ t: frame.t, text });
          } catch (e) {
            console.warn(`OCR frame at ${frame.t?.toFixed?.(1)}s skipped:`, e.message);
          }
        }
        continue;
      }
      texts.forEach((text, k) => {
        const t = group[k]?.t;
        if (text && text.toUpperCase() !== "NONE" && t != null) entries.push({ t, text });
      });
    }
  } else {
    for (const frame of frames) {
      try {
        const text = await ocrOneFrame(frame);
        if (text && text.toUpperCase() !== "NONE") entries.push({ t: frame.t, text });
      } catch (e) {
        console.warn(`OCR frame at ${frame.t?.toFixed?.(1)}s skipped:`, e.message);
      }
    }
  }

  // Timestamps must be in order for the merge below (and for buildTimeline).
  entries.sort((a, b) => a.t - b.t);

  // Merge runs of the same on-screen text, keeping the earliest timestamp.
  const merged = [];
  for (const e of entries) {
    const prev = merged[merged.length - 1];
    const a = e.text.toLowerCase();
    const b = prev?.text.toLowerCase();
    if (prev && (a === b || b.includes(a))) continue;      // same or a fragment of what we have
    if (prev && a.includes(b)) { prev.text = e.text; continue; } // fuller version of the same overlay
    merged.push({ t: e.t, text: e.text });
  }

  return merged.map((m) => ({
    t: m.t,
    text: collapseFragments(m.text.split("\n")).join("\n"),
  }));
}

// Back-compat: the old flat-blob shape, for anything still calling it.
export async function ocrFrames(framePaths) {
  const timeline = await ocrTimeline(framePaths.map((p, i) => ({ path: p, t: i })));
  return collapseFragments(timeline.flatMap((e) => e.text.split("\n"))).join("\n");
}

// ── LLM: classify + structure ─────────────────────────────────────────────
// The lenient reader lives in router.mjs so the router can VALIDATE a json:true
// answer with the very same rules the caller will parse it with — otherwise the
// router can bless a response the caller then chokes on.
const parseJson = parseLooseJson;

// NOTE: `segments` and `onScreen` MUST be forwarded to buildUserContent. They
// are what buildTimeline interleaves into the single timed [mm:ss] [SPOKEN] /
// [ON SCREEN] view (gotcha #22) — the thing that lets the model tie a value
// flashed on screen to what was being said at that moment. Dropping them does
// not error: buildTimeline just returns null and the untimed fallback runs, so
// the feature dies silently. Same failure shape as gotcha #24.
export async function structure({ transcript, caption, onScreenText, segments, onScreen, knownCategories }) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  // Self-expanding taxonomy: show the model the categories already in the
  // library so it reuses an existing slug instead of minting a duplicate.
  const note = existingCategoriesNote(knownCategories);
  if (note) messages.push({ role: "system", content: note });
  messages.push({ role: "user", content: buildUserContent({ transcript, caption, onScreenText, segments, onScreen }) });

  // 4096: kimi-k3 truncated mid-JSON on this schema at 2048 and looked like a
  // comprehension failure. A cap is a ceiling, not a spend — see steps.mjs.
  const raw = await route({ task: "structure", messages, json: true, maxTokens: 4096 });
  return parseJson(raw);
}

// Standalone category classifier for the BACKFILL of existing reels (new reels
// get their category inline from structure()). Cheap + best-effort: small token
// budget, fails to null so it can never block a backfill run.
export async function classifyCategory(r, knownCategories) {
  try {
    const messages = [{ role: "system", content: CATEGORY_PROMPT }];
    const note = existingCategoriesNote(knownCategories);
    if (note) messages.push({ role: "system", content: note });
    messages.push({ role: "user", content: buildCategoryContent(r) });
    const raw = await route({
      task: "classify",
      messages,
      // No abort: this is a manual backfill, not the time-boxed digest, and a
      // provider can take 2min+ per call under load (same unbounded behaviour as
      // structure()). withRetry still rides out transient 503s, and the router
      // fails over to another provider if one is exhausted.
      json: true, maxTokens: 64, retries: 2, cap: 12000,
    });
    return normalizeCategory(parseJson(raw).category, r.content_type);
  } catch (e) {
    console.warn(`  classifyCategory failed for ${r.id}:`, e.message);
    return null;
  }
}

// ── Synthesis: one action-first brief over the whole night's saves ─────────
// Runs once per digest (not per item), so it's a single extra LLM call. Best
// effort — the caller treats a null return as "just skip the brief section".
export async function synthesize(results) {
  if (!Array.isArray(results) || results.length < 2) return null;
  try {
    const raw = await route({
      task: "synthesize",
      messages: [
        { role: "system", content: SYNTHESIS_PROMPT },
        { role: "user", content: buildSynthesisContent(results) },
      ],
      // Optional brief: fail fast so a rate-limited provider can't outlive the
      // digest job and block the email. 1 retry, 25s per-request abort. The
      // router still tries the next provider if the first is cooling down.
      json: true, maxTokens: 2048, retries: 1, cap: 4000, timeoutMs: 25000,
    });
    return parseJson(raw);
  } catch (e) {
    console.warn("Synthesis failed, sending digest without the overall brief:", e.message);
    return null;
  }
}
