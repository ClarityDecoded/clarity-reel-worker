// Where a dumped link came from, and the canonical form of it.
//
// Instagram has a paid resolver (RapidAPI, residential IPs). YouTube and
// Facebook do NOT: that template is Instagram specific, so they go through
// yt-dlp alone. Everything after the resolver (download, audio, OCR, structure)
// never looked at the source, so this is the only place it has to be named.
//
// supabase/functions/reel-enqueue carries its own copy of the URL shapes
// (Edge Functions are self-contained). Keep the two in sync.

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;
const FB_HOSTS = /^(?:www\.|m\.|web\.|mbasic\.)?facebook\.com$/i;

export function sourceOf(raw) {
  try {
    const host = new URL(String(raw).trim()).hostname.toLowerCase();
    if (/(?:^|\.)instagram\.com$/.test(host)) return "instagram";
    if (YT_HOSTS.test(host) || host === "youtu.be") return "youtube";
    if (FB_HOSTS.test(host) || host === "fb.watch") return "facebook";
  } catch { /* not a url */ }
  return "unknown";
}

// YouTube: keep ONLY the video id. list=, t=, si=, pp= and friends add nothing
// and make the same video look like different links.
// Facebook: left alone. /watch/?v=ID carries the id in the query, and share
// links (/share/v/..., /share/r/...) are opaque tokens yt-dlp follows itself.
export function canonicalUrl(raw) {
  const text = String(raw).trim();
  try {
    const u = new URL(text);
    if (sourceOf(text) !== "youtube") return text;
    let id = null;
    if (u.hostname.toLowerCase() === "youtu.be") id = u.pathname.split("/")[1];
    else if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,})/);
      if (m) id = m[1];
    }
    return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : text;
  } catch {
    return text;
  }
}

// A YouTube video can run for hours; a reel runs for seconds. The pipeline
// downloads the whole file, OCRs the whole thing and sends the whole transcript
// to a model, so an unbounded video is a way to burn a run (and a month of free
// tier) on one item. Default 20 minutes; env-overridable.
export const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 20 * 60);
