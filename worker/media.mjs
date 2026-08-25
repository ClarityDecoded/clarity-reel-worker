// Media handling: download the CDN video, then use FFmpeg to (a) extract mono
// 16kHz WAV audio for ASR and (b) sample a few downscaled frames for on-screen
// text OCR. Uses ffmpeg-static so it runs identically on the GitHub runner and
// locally without relying on a system FFmpeg install.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { withRetry } from "./retry.mjs";

// Resolves with ffmpeg's stderr — we parse it for showinfo frame timestamps,
// so callers that need timing can read it rather than guessing frame times.
function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// IG CDN links are signed and flaky — a dropped connection surfaces as a bare
// undici "fetch failed". Retry transport blips and 5xx; a 4xx means the signed
// link is dead, so don't waste retries on it. This is a plain byte-for-byte
// download and isn't actually video-specific — downloadImage below is the
// same function under a name that matches what it's fetching.
async function downloadFile(url, destPath) {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0" }, // CDN links can be picky
      });
      if (!res.ok || !res.body) {
        const err = new Error(`Download failed: ${res.status}`);
        err.status = res.status;
        throw err;
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
      return destPath;
    },
    {
      onRetry: (e, attempt, delay) =>
        console.warn(`Download retry ${attempt} in ${delay}ms: ${e.message}`),
    },
  );
}

export const downloadVideo = downloadFile;
// Same CDN, same signed-link behaviour, same retry policy — a carousel
// post's slide is fetched with exactly this. Named separately so the call
// site in process-queue.mjs reads honestly.
export const downloadImage = downloadFile;

// Mono 16kHz WAV is the sweet spot for ASR models.
//
// Returns NULL for a video with no audio track instead of throwing. ffmpeg exits
// 234 with "Output file does not contain any stream" on a silent reel, which used
// to kill the whole item before OCR or the caption were ever read — even though
// those are first-class tracks (gotcha #52) and a silent reel is often ALL
// on-screen text. A genuinely broken file still throws.
export async function extractAudio(videoPath, outWav) {
  try {
    await run(["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", outWav]);
    return outWav;
  } catch (e) {
    if (/does not contain any stream|Output file is empty/i.test(String(e?.message || ""))) {
      console.warn("  no audio track — continuing with on-screen text + caption only");
      return null;
    }
    throw e;
  }
}

// Grab a single poster frame (~1s in, or the first frame for very short clips)
// as a downscaled JPEG. Used as the fallback thumbnail when the resolver's cover
// image can't be fetched, so we archive a stable image instead of an IG CDN link
// that expires. Returns the output path.
export async function capturePoster(videoPath, outPath, width = 720) {
  await run([
    "-y", "-ss", "1", "-i", videoPath, "-frames:v", "1",
    "-vf", `scale=${width}:-2`, "-q:v", "3", outPath,
  ]);
  return outPath;
}

// Sample downscaled frames (one every few seconds, capped) for OCR. We avoid
// ffprobe (not bundled) by using an fps filter and capping the output count.
//
// DEPRECATED — start-biased. `fps=1/4` with `-frames:v 3` only ever reached the
// first ~8-12 seconds of a video, so on-screen text in the rest was never read.
// Kept only so an older caller doesn't break; use sampleTextFrames instead.
export async function sampleFrames(videoPath, outDir, count = 6) {
  await mkdir(outDir, { recursive: true });
  // ~one frame every 4s, downscaled to 720px wide, capped at `count`.
  await run([
    "-y", "-i", videoPath,
    "-vf", "fps=1/4,scale=720:-1",
    "-frames:v", String(count),
    path.join(outDir, "frame-%02d.jpg"),
  ]);
  const files = (await readdir(outDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));
  return files;
}

// Pull ONE pts_time per surviving frame out of ffmpeg's showinfo output. The
// filter prints a line per frame that made it through mpdecimate, in order, so
// the Nth timestamp belongs to the Nth written jpg.
function parseShowinfoTimes(stderr) {
  const times = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) times.push(Number(m[1]));
  return times;
}

// Evenly thin a list down to `max` items, always keeping the first and last.
// Even spacing matters: taking the first N would recreate the exact start-bias
// bug this function exists to fix.
function evenlySubsample(items, max) {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, 1);
  const step = (items.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return [...new Set(out)];
}

/**
 * Sample the WHOLE video for on-screen text, cheaply.
 *
 * 1. `fps=N` walks the entire duration instead of stopping after a few frames.
 * 2. `mpdecimate` drops frames that look near-identical to the previous one, so
 *    a caption that holds for 4 seconds costs one frame, not eight. This is the
 *    whole trick: it happens locally in ffmpeg, with no API calls, and turns
 *    ~135 sampled frames into ~10-30 distinct text states.
 * 3. `showinfo` reports the presentation timestamp of every frame that survived,
 *    which is what lets on-screen text later be aligned against the transcript.
 *
 * Returns [{ path, t }] ordered by time, capped at `maxFrames`.
 */
export async function sampleTextFrames(videoPath, outDir, opts = {}) {
  const {
    fps = 2,
    maxFrames = 24,
    decimate = "hi=64*12:lo=64*5:frac=0.2",
    width = 720,
  } = opts;

  await mkdir(outDir, { recursive: true });

  // -vsync 0 (passthrough) is REQUIRED: without it ffmpeg re-duplicates frames
  // to maintain a constant output rate, which would undo mpdecimate entirely.
  const stderr = await run([
    "-y", "-i", videoPath,
    "-vf", `fps=${fps},mpdecimate=${decimate},scale=${width}:-1,showinfo`,
    "-vsync", "0",
    "-q:v", "3",
    path.join(outDir, "frame-%04d.jpg"),
  ]);

  const files = (await readdir(outDir))
    .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));

  const times = parseShowinfoTimes(stderr);

  // Pair each file with its timestamp. If showinfo gave us fewer times than
  // files (format drift between ffmpeg builds), fall back to deriving the time
  // from the sample rate rather than losing the frames entirely.
  const frames = files.map((p, i) => ({
    path: p,
    t: Number.isFinite(times[i]) ? times[i] : i / fps,
  }));

  // Say so out loud when the cap actually bites. Every frame reaching here has
  // already SURVIVED mpdecimate, so it is visually distinct from its neighbour —
  // dropping one discards a real on-screen change, usually text. This went
  // unnoticed for a long time because the log only ever printed the post-cap
  // count, and "24 frames" reads like a measurement rather than a ceiling.
  if (frames.length > maxFrames) {
    console.log(`  ${frames.length} distinct frames found, capped to ${maxFrames} ` +
      `(raise OCR_MAX_FRAMES to keep more)`);
  }
  return evenlySubsample(frames, maxFrames);
}

/**
 * Pack frames into grid images (N per tile) so one VLM call can read several
 * frames at once. Cheaper per frame, but every panel is scaled down, so fine
 * print gets harder to read — off by default. Returns [{ path, times[] }].
 */
export async function tileFrames(frames, outDir, perTile, width = 720) {
  if (!perTile || perTile < 2 || frames.length === 0) return null;
  await mkdir(outDir, { recursive: true });

  const cols = Math.ceil(Math.sqrt(perTile));
  const rows = Math.ceil(perTile / cols);
  const panelW = Math.max(240, Math.round(width / cols));
  const tiles = [];

  for (let i = 0; i < frames.length; i += perTile) {
    const group = frames.slice(i, i + perTile);
    const outPath = path.join(outDir, `tile-${String(tiles.length).padStart(3, "0")}.jpg`);
    const args = ["-y"];
    for (const f of group) args.push("-i", f.path);
    // Scale every panel to a common size, then stack them into a grid. xstack
    // needs an explicit layout, so tile= over a concat of inputs is simpler:
    // build with the `tile` filter fed by a virtual sequence.
    const scale = group.map((_, k) => `[${k}:v]scale=${panelW}:-1[p${k}]`).join(";");
    const inputs = group.map((_, k) => `[p${k}]`).join("");
    args.push(
      "-filter_complex",
      `${scale};${inputs}xstack=inputs=${group.length}:layout=${xstackLayout(group.length, cols)}:fill=black[out]`,
      "-map", "[out]", "-frames:v", "1", "-q:v", "3", outPath,
    );
    await run(args);
    tiles.push({ path: outPath, times: group.map((g) => g.t) });
  }
  return tiles;
}

// xstack wants an explicit "x_y|x_y|..." layout string.
function xstackLayout(n, cols) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    parts.push(`${c === 0 ? "0" : Array(c).fill("w0").join("+")}_${r === 0 ? "0" : Array(r).fill("h0").join("+")}`);
  }
  return parts.join("|");
}

export async function fileToBase64(filePath) {
  const buf = await readFile(filePath);
  return buf.toString("base64");
}
