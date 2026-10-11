// Resolver tier: yt-dlp on the runner. No API key, no monthly quota.
//
// Returns the SAME shape as the RapidAPI resolver — { videoUrl, caption,
// thumbnail, author } — so resolve.mjs can try one then the other.
//
// THE OPEN QUESTION this exists to answer: Instagram rate-limits datacenter
// IPs, and GitHub Actions runs on Azure ranges. That is precisely why the
// RapidAPI resolver was chosen originally (see the note at the top of
// resolve.mjs) — you are paying that vendor for residential IPs, not for data.
// So this tier may work perfectly, or may hit a login wall on most reels. It is
// wired as a FIRST CHOICE WITH FALLBACK rather than a replacement so the answer
// costs nothing: when it fails, the paid path still runs.
//
// Set YTDLP_COOKIES (contents of a Netscape cookies.txt) to get past a login
// wall. Optional, and a real trade: those are live session cookies for whatever
// account exported them.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeInstagramUrl } from "./resolve.mjs";
import { sourceOf, canonicalUrl, MAX_VIDEO_SECONDS } from "./sources.mjs";

const run = promisify(execFile);

const BIN = process.env.YTDLP_BIN || "yt-dlp";
const TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 90_000);

let available = null;   // cached across a run — one probe is enough

/** Is the binary actually on this machine? */
export async function ytDlpAvailable() {
  if (available !== null) return available;
  try {
    await run(BIN, ["--version"], { timeout: 15_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

// Pick a single URL that has BOTH video and audio. process-queue downloads this
// one file and extracts audio from it, so a video-only DASH stream would give a
// silent reel and an empty transcript.
// A CAROUSEL (Instagram calls it a carousel; yt-dlp reports _type: "playlist")
// is a post of several images, not a video. There is no stream to download and
// nothing to transcribe — the content is entirely the pictures and the caption.
//
// Each entry carries a full-resolution still (1080x1350 on the ones checked,
// BETTER than the 720px we downscale video frames to), so the slides can be
// read directly. Returns [] for anything that is not a carousel.
//
// A slide that is itself a VIDEO contributes its poster frame here rather than
// its footage. That is a deliberate first cut: it captures the slide's on-screen
// text, which is the point, without dragging a per-slide download and transcode
// into what is otherwise a handful of image fetches.
function pickSlides(info) {
  if (info?._type !== "playlist") return [];
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return entries
    .map((e) => e?.thumbnail || e?.thumbnails?.at?.(-1)?.url || null)
    .filter(Boolean);
}

function pickVideoUrl(info) {
  const direct = info?.requested_downloads?.[0]?.url || info?.url;
  if (direct) return direct;

  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const muxed = formats.filter(
    (f) => f?.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none",
  );
  if (!muxed.length) return null;

  muxed.sort((a, b) => {
    const mp4 = (f) => (f.ext === "mp4" ? 1 : 0);
    return (mp4(b) - mp4(a)) || ((b.height || 0) - (a.height || 0)) || ((b.tbr || 0) - (a.tbr || 0));
  });
  return muxed[0].url;
}

// A login wall is NOT the same as a private post: the first is Instagram
// refusing US (the datacenter IP), the second is the post genuinely being gone.
// Only the second should be allowed to bury the item — the first must fall
// through to the next resolver.
function classify(stderr = "") {
  const s = stderr.toLowerCase();
  if (/login required|rate.?limit|429|checkpoint|sign in|not logged/i.test(s)) return "BLOCKED";
  if (/private|unavailable|removed|deleted|not exist|404/i.test(s)) return "PRIVATE_OR_UNAVAILABLE";
  return "FAILED";
}

export async function resolveViaYtDlp(rawUrl) {
  const source = sourceOf(rawUrl);
  const url = source === "instagram" ? normalizeInstagramUrl(rawUrl) : canonicalUrl(rawUrl);

  let cookieDir = null;
  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    // Without this, yt-dlp ABORTS the whole extraction with "No video formats
    // found!" and we lose the metadata along with it — even though the caption,
    // title and thumbnail were all sitting right there. It fires on Instagram
    // CAROUSEL posts (yt-dlp reports them as _type: playlist), which is a large
    // slice of the library: 8 of a 12-reel sample failed this way, and every one
    // of them handed over a full caption the moment this flag was added.
    // Safe for the video path too — pickVideoUrl still returns null when there
    // genuinely is no stream, and resolveReel already treats a null videoUrl as
    // "this tier did not resolve", so nothing starts believing it has a video.
    "--ignore-no-formats-error",
    "--socket-timeout", "20",
  ];
  // YouTube's default format is bestvideo+bestaudio, TWO separate streams, and
  // requested_downloads[0].url is the video-only one: it downloads fine and
  // gives a silent reel with an empty transcript. Ask for one muxed file.
  // Instagram is left on its default, which is already muxed and measured.
  if (source !== "instagram") args.push("-f", "b[acodec!=none][vcodec!=none]/b");

  try {
    if (process.env.YTDLP_COOKIES) {
      cookieDir = await mkdtemp(path.join(tmpdir(), "ytdlp-"));
      const jar = path.join(cookieDir, "cookies.txt");
      await writeFile(jar, process.env.YTDLP_COOKIES, "utf8");
      args.push("--cookies", jar);
    }
    args.push(url);

    let stdout;
    try {
      // yt-dlp's JSON for a reel is small, but formats[] can be long.
      ({ stdout } = await run(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }));
    } catch (e) {
      const kind = classify(e?.stderr || e?.message || "");
      const err = new Error(
        kind === "PRIVATE_OR_UNAVAILABLE"
          ? "PRIVATE_OR_UNAVAILABLE"
          : `yt-dlp ${kind}: ${String(e?.stderr || e?.message || "").trim().slice(0, 200)}`,
      );
      err.ytdlp = kind;
      throw err;
    }

    const info = JSON.parse(stdout);

    // Only checked off Instagram: reels are short by nature, long-form is a
    // YouTube/Facebook thing. Permanent for this item, so no status-looking
    // digits in the message (isTransient would read them as an HTTP code).
    if (source !== "instagram" && info?.duration > MAX_VIDEO_SECONDS) {
      throw new Error(
        `VIDEO_TOO_LONG: runs ${Math.round(info.duration / 60)} min, limit is ${Math.round(MAX_VIDEO_SECONDS / 60)} min (MAX_VIDEO_SECONDS)`,
      );
    }
    const videoUrl = pickVideoUrl(info);
    const slides = pickSlides(info);

    // Off Instagram, a post with formats but no single sound+picture stream is
    // normal (most YouTube is DASH: separate video and audio). Taking either
    // alone would give a silent reel, so hand back the PAGE url and let
    // downloadViaYtDlp fetch and merge both itself.
    const needsMerge = source !== "instagram" && !videoUrl && !slides.length &&
      Array.isArray(info?.formats) && info.formats.length > 0;
    return {
      videoUrl: videoUrl || null,
      pageUrl: needsMerge ? url : null,
      slides,
      caption: info?.description || "",
      thumbnail: info?.thumbnail || info?.thumbnails?.at?.(-1)?.url || null,
      author: info?.uploader || info?.uploader_id || info?.channel || null,
    };
  } finally {
    if (cookieDir) await rm(cookieDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Download + merge a post's best audio and video into ONE mp4 at destPath.
// Capped at 720p: the pipeline downscales frames to 720px for OCR anyway, and a
// 4K download is minutes of runner time for pixels nothing reads.
export async function downloadViaYtDlp(pageUrl, destPath) {
  const { default: ffmpegPath } = await import("ffmpeg-static");
  let cookieDir = null;
  const args = [
    "--no-playlist", "--no-warnings", "--no-progress",
    "--socket-timeout", "20",
    "-f", "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", ffmpegPath,
    "--max-filesize", process.env.YTDLP_MAX_FILESIZE || "300M",
    "-o", destPath,
  ];
  try {
    if (process.env.YTDLP_COOKIES) {
      cookieDir = await mkdtemp(path.join(tmpdir(), "ytdlp-"));
      const jar = path.join(cookieDir, "cookies.txt");
      await writeFile(jar, process.env.YTDLP_COOKIES, "utf8");
      args.push("--cookies", jar);
    }
    args.push(pageUrl);
    await run(BIN, args, { timeout: Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS || 300_000), maxBuffer: 16 * 1024 * 1024 });
    return destPath;
  } catch (e) {
    const kind = classify(e?.stderr || e?.message || "");
    throw new Error(`yt-dlp download ${kind}: ${String(e?.stderr || e?.message || "").trim().slice(0, 200)}`, { cause: e });
  } finally {
    if (cookieDir) await rm(cookieDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Exported for test-carousel.mjs — slide selection is pure and worth pinning.
export const __testables = { pickSlides, pickVideoUrl };
