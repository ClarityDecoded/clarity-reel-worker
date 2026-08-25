// Resolver: Instagram post URL -> { videoUrl, imageUrls, caption, thumbnail,
// author }. A reel/video post carries `videoUrl`; a photo or multi-image
// carousel post (a `/p/...` link with no video track) carries `imageUrls`
// instead — exactly one of the two is populated, never both, since a single
// IG post is one or the other. Downstream (process-queue.mjs) branches on
// which one came back: video runs through ffmpeg + frame OCR as before,
// images are OCR'd directly, no audio/frame-sampling step involved.
//
// We don't scrape Instagram ourselves (datacenter IPs get blocked); a RapidAPI
// downloader returns direct CDN URLs. This is the ONLY platform-specific module
// — adding TikTok / YT Shorts later is a sibling resolver, nothing downstream
// changes. normalize() handles a few common response shapes (incl. a capitalized
// Media[] array of {Type, Url}); extend the lists if you swap providers.

import { config } from "./config.mjs";
import { withRetry } from "./retry.mjs";

// One or more RapidAPI account keys for the SAME downloader API. We burn through
// one key's monthly quota, then roll to the next. When they're all spent the
// worker gets ALL_RESOLVERS_EXHAUSTED and emails the owner to add more.
const { keys, host, urlTemplate } = config.rapidapi;

// Failover state (module-level, persists across calls within a single run).
let keyIndex = 0;
const spent = new Set(); // indexes whose quota is used up this run

export function resolverStatus() {
  return { total: keys.length, spent: spent.size, live: keys.length - spent.size };
}

export class AllResolversExhausted extends Error {
  constructor() {
    super("ALL_RESOLVERS_EXHAUSTED");
    this.code = "ALL_RESOLVERS_EXHAUSTED";
  }
}

const MP4_RE = /^https?:\/\/[^\s"']+\.mp4(\?|$)/i;
const IMG_RE = /^https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp)(\?|$)/i;

// Share Sheet links arrive in several shapes: instagram.com vs www.instagram.com,
// /reel/ vs /reels/ vs /p/, and usually a "?igsh=…" tracking param. Downstream
// providers key off the exact string, so canonicalise before we ask.
export function normalizeInstagramUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./i, ""))) return String(raw).trim();
    u.protocol = "https:";
    u.hostname = "www.instagram.com";
    u.search = "";   // igsh / img_index / utm_* add nothing and can confuse providers
    u.hash = "";
    u.pathname = u.pathname.replace(/^\/reels\//i, "/reel/").replace(/\/+$/, "") + "/";
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}

// The RapidAPI call is the one external fetch that used to run naked — a
// transient blip surfaced as a bare "fetch failed" and killed the item with no
// retry. Retry ONLY the transient cases (network throw or 5xx/408). The
// deliberate statuses — 429/403 (key rollover) and 400/404 (private) — must
// pass straight through to the caller's logic, so they're excluded here.
async function fetchResolver(endpoint, key) {
  return withRetry(
    async () => {
      const res = await fetch(endpoint, {
        headers: { "x-rapidapi-key": key, "x-rapidapi-host": host },
      });
      if (res.status >= 500 || res.status === 408) {
        const err = new Error(`Resolver ${res.status}`);
        err.status = res.status; // triggers a retry below
        throw err;
      }
      return res;
    },
    {
      shouldRetry: (e) => e?.status == null || e.status >= 500 || e.status === 408,
      onRetry: (e, attempt, delay) =>
        console.warn(`Resolver retry ${attempt} in ${delay}ms: ${e.message}`),
    },
  );
}

function firstString(obj, paths) {
  for (const path of paths) {
    const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

// Case-insensitive top-level key lookup (this provider uses "Caption", etc.).
function ciGet(obj, names) {
  if (!obj || typeof obj !== "object") return null;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Providers that return a Media array of { type, url, thumbnail } (e.g. Image + Video).
// A carousel/photo post's array holds MULTIPLE image entries (one per slide),
// so every image-typed item is collected, not just the first — the whole
// point of "extract all the text from the post".
function fromMediaArray(data) {
  const media = data?.Media || data?.media || data?.medias;
  if (!Array.isArray(media)) return {};
  const byType = (t) => media.find((m) => String(m?.Type || m?.type || "").toLowerCase() === t);
  const vid = byType("video");
  const imgs = media.filter((m) => {
    const t = String(m?.Type || m?.type || "").toLowerCase();
    return t === "image" || t === "photo" || t === "carousel_media";
  });
  const videoUrl = vid ? (vid.Url || vid.url || null) : null;
  const imageUrls = imgs
    .map((m) => m.Url || m.url || m.image_url || m.imageUrl || m.display_url)
    .filter((u) => typeof u === "string" && u.trim());
  // Prefer the video item's own thumbnail; fall back to the first image.
  const thumbnail =
    (vid && (vid.thumbnail || vid.Thumbnail)) ||
    imageUrls[0] ||
    null;
  return { videoUrl, imageUrls, thumbnail };
}

// Carousel image urls under common container keys other than Media[] (a
// provider that separates video-post and photo-post response shapes rather
// than using one typed array). Only known container names are scanned —
// deliberately not a generic recursive image scrape, which would just as
// happily pick up an unrelated avatar or icon url buried in the response.
function findImageUrls(data) {
  const containers = [
    data?.images, data?.image_urls, data?.carousel_media, data?.sidecar,
    data?.slides, data?.data?.carousel_media, data?.result?.carousel_media,
    data?.data?.images, data?.result?.images,
  ];
  const urls = [];
  const seen = new Set();
  for (const c of containers) {
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      const u = typeof item === "string"
        ? item
        : (item?.url || item?.Url || item?.image_url || item?.imageUrl || item?.display_url);
      if (typeof u === "string" && IMG_RE.test(u) && !seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }
  return urls;
}

// Recursively find the first URL that looks like a video CDN link.
function findVideoUrl(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (typeof node === "string") return MP4_RE.test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    const explicit = firstString(node, ["video_url", "videoUrl", "video", "download_url", "downloadUrl", "url", "Url"]);
    if (explicit && MP4_RE.test(explicit)) return explicit;
    for (const v of Object.values(node)) {
      const found = findVideoUrl(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Keys that hold a post's caption across the shapes these providers return.
const CAPTION_KEYS = new Set([
  "caption", "caption_text", "captiontext", "text", "title", "description",
  "edge_media_to_caption", "post_caption",
]);
// Junk that shows up under the same key names and must never be read as a caption.
const NOT_CAPTION = /^(https?:|data:|\/|video|image|photo|reel|feed|graph)/i;

// Recursively find the post caption. The video URL search is already recursive
// (findVideoUrl) but the caption was TOP LEVEL only plus three hardcoded dotted
// paths — so any provider nesting it elsewhere (items[0].caption.text, the
// classic Instagram shape, among others) silently yielded "" and the post's
// entire written content never reached the model. For a reel whose substance is
// in the caption and whose audio is background music, that loses the whole point
// of the post. Longest match wins: a provider often returns BOTH a truncated
// `title` and the full `caption`, and we want the full one.
function findCaption(node, depth = 0, best = { text: "" }) {
  if (depth > 6 || node == null) return best;
  if (Array.isArray(node)) {
    for (const item of node) findCaption(item, depth + 1, best);
    return best;
  }
  if (typeof node !== "object") return best;
  for (const [k, v] of Object.entries(node)) {
    const keyed = CAPTION_KEYS.has(k.toLowerCase());
    if (keyed && typeof v === "string") {
      const t = v.trim();
      if (t && t.length > best.text.length && !NOT_CAPTION.test(t)) best.text = t;
    } else if (v && typeof v === "object") {
      findCaption(v, depth + 1, best);
    }
  }
  return best;
}

function normalize(data) {
  const media = fromMediaArray(data);
  const videoUrl =
    media.videoUrl ||
    firstString(data, ["video_url", "videoUrl", "data.video_url", "media.video_url", "result.video", "links.mp4"]) ||
    findVideoUrl(data);
  // A post is a video OR a photo/carousel, never both — only look for images
  // when no video turned up, so a reel's own thumbnail/cover art (which also
  // matches IMG_RE) never gets misread as carousel slides.
  const imageUrls = videoUrl ? [] : (media.imageUrls?.length ? media.imageUrls : findImageUrls(data));
  // Known shapes first (cheap and exact), then a deep search so an unknown
  // nesting can't silently drop the post's written content. The deep result
  // also wins when it is materially longer — providers commonly expose a
  // truncated `title` at the top level and the full caption further down.
  const knownRaw =
    ciGet(data, ["caption", "title", "description"]) ||
    firstString(data, ["data.caption", "media.caption", "edge_media_to_caption.edges.0.node.text"]) ||
    "";
  // Same junk guard as the deep search: providers park a permalink under
  // `description`, and a URL read as a caption is worse than no caption.
  const known = NOT_CAPTION.test(knownRaw) ? "" : knownRaw;
  const deep = findCaption(data).text;
  const caption = deep.length > known.length ? deep : known;
  const thumbnail =
    media.thumbnail ||
    firstString(data, ["thumbnail", "thumbnail_url", "thumb", "cover", "image", "display_url"]) ||
    imageUrls[0] ||
    null;
  const author =
    ciGet(data, ["author", "username"]) ||
    firstString(data, ["owner.username", "user.username"]) ||
    null;
  return { videoUrl, imageUrls, caption, thumbnail, author };
}

// Exposed for test-caption.mjs — the normalizer is the part worth unit testing
// (it decides whether a post's written content reaches the model at all), and
// it needs no network to exercise.
export const __testables = { normalize, findCaption };

export function rapidApiConfigured() {
  return Boolean(keys.length && host && urlTemplate);
}

// The original resolver, unchanged — now one TIER behind resolveReel().
export async function resolveViaRapidApi(url) {
  if (!rapidApiConfigured()) {
    throw new Error(
      "Resolver not configured. Set RAPIDAPI_KEYS (or RAPIDAPI_KEY), RAPIDAPI_HOST " +
        "and RAPIDAPI_URL_TEMPLATE (a URL containing {url} where the reel link goes).",
    );
  }

  const endpoint = urlTemplate.replace("{url}", encodeURIComponent(normalizeInstagramUrl(url)));

  // Try keys in turn, skipping ones already spent this run. A 429 (quota) or 403
  // (subscription) marks the key spent and rolls to the next; when all are spent
  // we throw AllResolversExhausted so the worker can stop + alert.
  for (let tried = 0; tried < keys.length; tried++) {
    while (spent.has(keyIndex) && spent.size < keys.length) keyIndex = (keyIndex + 1) % keys.length;
    if (spent.size >= keys.length) throw new AllResolversExhausted();

    const res = await fetchResolver(endpoint, keys[keyIndex]);

    if (res.status === 429 || res.status === 403) {
      spent.add(keyIndex);
      keyIndex = (keyIndex + 1) % keys.length;
      continue; // roll to the next key
    }
    if (res.status === 400 || res.status === 404) throw new Error("PRIVATE_OR_UNAVAILABLE");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resolver error ${res.status}: ${body.slice(0, 200)}`);
    }

    // Success. If this key just hit zero remaining, retire it for next time.
    const remaining = Number(res.headers.get("x-ratelimit-requests-remaining"));
    if (Number.isFinite(remaining) && remaining <= 0) spent.add(keyIndex);

    const data = await res.json();
    const out = normalize(data);
    if (!out.videoUrl && !out.imageUrls.length) throw new Error("PRIVATE_OR_UNAVAILABLE");
    return out;
  }

  throw new AllResolversExhausted();
}

// ── provider tiers ──────────────────────────────────────────────────────────
//
// resolveReel walks RESOLVER_ORDER (default "rapidapi", i.e. exactly the old
// behaviour) and returns the first provider that yields a video url OR a set
// of carousel image urls. A tier that fails — for any reason — falls through
// to the next.
//
// The three failure signals downstream depends on are preserved carefully,
// because process-queue and isTransient key off them (gotchas #25/#26):
//
//   AllResolversExhausted   quota gone -> re-queue + email "add a RapidAPI key"
//   PRIVATE_OR_UNAVAILABLE  dead link  -> bury it, never retry
//   anything else           transient  -> re-queue up to MAX_ATTEMPTS
//
// Precedence when EVERY tier fails is deliberate: exhaustion wins over private.
// If the paid tier never got to look because its quota was gone, we cannot know
// the reel is actually dead — and burying a live reel is worse than retrying it.
async function ytDlpTier(url) {
  const { ytDlpAvailable, resolveViaYtDlp } = await import("./resolve-ytdlp.mjs");
  if (!(await ytDlpAvailable())) throw new Error("yt-dlp not installed on this runner");
  return resolveViaYtDlp(url);
}

// Exported so the tier/precedence rules can be unit tested without a network —
// the test swaps these entries for stubs.
export const RESOLVER_TIERS = {
  rapidapi: { available: () => rapidApiConfigured(), resolve: (u) => resolveViaRapidApi(u) },
  ytdlp: { available: () => true, resolve: (u) => ytDlpTier(u) },
};

export function resolverOrder() {
  return (process.env.RESOLVER_ORDER || "rapidapi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => RESOLVER_TIERS[s]);
}

export async function resolveReel(url) {
  const order = resolverOrder();
  if (!order.length) throw new Error("RESOLVER_ORDER names no known resolver (try: ytdlp,rapidapi)");

  const notes = [];
  let exhausted = null;
  let sawPrivate = false;
  let configured = false;

  for (const name of order) {
    const tier = RESOLVER_TIERS[name];
    if (!tier.available()) { notes.push(`${name}: not configured`); continue; }
    configured = true;
    try {
      const out = await tier.resolve(url);
      if (out?.videoUrl || out?.imageUrls?.length) {
        if (name !== order[0]) console.log(`  resolver: fell back to ${name}`);
        return out;
      }
      // Nothing playable AND no images is the same class of answer as
      // "private" — the provider looked and found nothing.
      sawPrivate = true;
      notes.push(`${name}: no video url or images`);
    } catch (e) {
      if (e instanceof AllResolversExhausted || e?.code === "ALL_RESOLVERS_EXHAUSTED") {
        exhausted = e;
        notes.push(`${name}: quota exhausted`);
      } else if (e?.message === "PRIVATE_OR_UNAVAILABLE") {
        sawPrivate = true;
        notes.push(`${name}: private or unavailable`);
      } else {
        notes.push(`${name}: ${e?.message || e}`);
      }
    }
  }

  if (!configured) {
    throw new Error(
      "Resolver not configured. Set RAPIDAPI_KEYS (or RAPIDAPI_KEY), RAPIDAPI_HOST " +
        "and RAPIDAPI_URL_TEMPLATE, or install yt-dlp and set RESOLVER_ORDER=ytdlp.",
    );
  }
  if (order.length > 1) console.log(`  resolver: all tiers failed — ${notes.join(" | ")}`);
  if (exhausted) throw exhausted;
  if (sawPrivate) throw new Error("PRIVATE_OR_UNAVAILABLE");
  throw new Error(`Resolver failed — ${notes.join(" | ")}`);
}
