// Central config for the reel worker. Everything is env-driven so the same
// code runs on GitHub Actions and locally. Model / endpoint names are overridable
// without touching code, which matters while NVIDIA's hosted model catalog shifts.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  supabase: {
    url: req("SUPABASE_URL"),
    serviceRole: req("SUPABASE_SERVICE_ROLE_KEY"),
  },

  // Instagram resolver (RapidAPI). One or more account keys for the SAME API:
  // each key = its own monthly quota; the worker burns one, then rolls to the
  // next. host + urlTemplate are shared across the keys.
  //
  // Both env vars are MERGED, not OR'd. This used to be `KEYS || KEY`, which
  // silently ignored every key added to the singular whenever the plural was
  // also set — a new key looked added but the run kept using the spent list and
  // re-sent the out-of-quota email. Both accept a comma-separated list; dupes
  // are dropped so the same key in both places doesn't get tried twice.
  rapidapi: {
    keys: [...new Set(
      [process.env.RAPIDAPI_KEYS, process.env.RAPIDAPI_KEY]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    )],
    host: process.env.RAPIDAPI_HOST || "",
    urlTemplate: process.env.RAPIDAPI_URL_TEMPLATE || "",
  },

  // NVIDIA is GONE. It was a required env var that nothing read: providers moved
  // behind the router (gotcha #43) and this block was left behind, so `req()`
  // would have crashed process-queue and every backfill at startup the moment
  // the secret was deleted — for a provider that had already stopped working.
  // A dead REQUIRED dependency is worse than a dead optional one.

  // Transcription lives off NVIDIA (its hosted ASR is gRPC-only). Groq by default:
  // free tier, fast, Whisper via an OpenAI-compatible REST endpoint. Swap to
  // OpenAI by changing ASR_BASE + GROQ_API_KEY + ASR_MODEL.
  transcription: {
    key: process.env.GROQ_API_KEY || "",
    base: process.env.ASR_BASE || "https://api.groq.com/openai/v1",
    model: process.env.ASR_MODEL || "whisper-large-v3",
  },

  resend: {
    key: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM || "Clarity Decoded <hello@mail.claritydecoded.com>",
  },

  ownerEmail: process.env.OWNER_EMAIL || "rahul@claritydecoded.com",
  appUrl: process.env.APP_URL || "https://portal.claritydecoded.com",

  maxItemsPerRun: Number(process.env.MAX_ITEMS_PER_RUN || 50),
  frameCount: Number(process.env.FRAME_COUNT || 3),

  // ── On-screen text (OCR) sampling ───────────────────────────────────────
  // The old approach took FRAME_COUNT frames at one every 4s, which only ever
  // reached the first ~8-12s of a reel — everything after that was invisible.
  // Now we sample the WHOLE video at `fps`, drop near-identical frames with
  // ffmpeg's mpdecimate (free, local, no API calls), and OCR only what's left.
  // A typical reel collapses from ~135 sampled frames to 10-30 distinct text
  // states, so coverage goes up ~10x while cost only ~3x.
  ocr: {
    // Frames per second to sample BEFORE dedupe. 2 catches text that holds for
    // half a second; raising it mostly costs local CPU, not API calls.
    // 3 catches text held for a third of a second; 2 could miss a quick flash
    // outright, before dedupe ever got a chance to see it. Raising this costs
    // local ffmpeg decode, NOT API calls — mpdecimate still collapses whatever
    // is redundant, so the only real limit is maxFrames below.
    fps: Number(process.env.OCR_FPS || 3),
    // Hard ceiling on frames actually sent to the VLM, after dedupe. Protects
    // both cost and run time on a long or very busy video. If more frames
    // survive than this, they're evenly subsampled across the whole duration
    // so we never bias toward the start (the old bug, in a new form).
    // Raised 24 → 48 once tiling made a frame a quarter of a call. 24 was
    // TRUNCATING: reels hit exactly 24 every time, and one came back with 24
    // OCR entries from 24 frames — a 100% yield at the ceiling, which means
    // real on-screen text was being discarded for being frame #25, not for
    // being a duplicate. Text that's only up for a moment is precisely what
    // an even subsample throws away.
    maxFrames: Number(process.env.OCR_MAX_FRAMES || 48),
    // Frames packed into ONE vision call, as a grid. OCR — not the resolver —
    // is what makes a run slow: 24 frames = 24 sequential calls at ~40s each,
    // ~15 min per reel, so a 60-minute run cleared only 2 reels of an 18-reel
    // backlog. At 4-up that's 6 calls instead of 24. Set OCR_PER_TILE=1 to go
    // back to one call per frame (the per-frame path is still the fallback
    // whenever a tile's answer doesn't line up with its panels).
    perTile: Number(process.env.OCR_PER_TILE || 4),
    // mpdecimate sensitivity. Higher `hi`/`lo` = more aggressive dropping.
    // Defaults are ffmpeg's, which are tuned for "visually identical".
    // Text overlays change a small fraction of the frame, so `frac` is lowered
    // to 0.2 to stay sensitive to a caption appearing on an otherwise still shot.
    decimate: process.env.OCR_DECIMATE || "hi=64*12:lo=64*5:frac=0.2",
    // Width to downscale frames to before OCR. 720 keeps overlay text legible
    // while keeping the image token count near ~1,100.
    width: Number(process.env.OCR_WIDTH || 720),
    // Set > 1 to pack N frames into one grid image per VLM call (cheaper, but
    // small text gets less legible because each panel shrinks). 0/1 = off,
    // one call per frame, which is the most reliable for reading fine text.
    tile: Number(process.env.OCR_TILE || 0),
  },

  // "process" (default): drain the queue, write results, send NO email — runs
  // incrementally as reels are dumped. "digest": send ONE email of everything
  // not yet reported, then stamp emailed_at — the single 4am run.
  mode: process.env.MODE || "process",

  // TEST digest (MODE=digest + DIGEST_TEST=1): build the email from the most
  // recent reels REGARDLESS of emailed_at and send it, but DO NOT stamp
  // emailed_at — so a test send can't empty the real 4am digest. Used to preview
  // the morning email on demand. digestTestLimit = how many recent reels to pull
  // (the dashboard "Send test" button sends 5).
  digestTest: process.env.DIGEST_TEST === "1",
  digestTestLimit: Number(process.env.DIGEST_TEST_LIMIT || 10),
};
