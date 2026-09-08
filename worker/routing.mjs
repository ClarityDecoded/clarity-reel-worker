// WHAT PRODUCTION ACTUALLY RUNS — the routing decisions, in one browser-safe place.
//
// WHY THIS FILE EXISTS. The chain lived in router.mjs and the model ids in
// providers.mjs, both of which read process.env at the top and neither of which
// a browser can load. So the lab could show you how a step was MEASURED and
// never what was DECIDED, which is the half you actually act on — and the only
// way to answer "what does structure run today" was to read two node modules.
//
// The alternative was hand-typing the answer into the page, and that answer goes
// stale the first time somebody swaps a model. This codebase has paid for that
// twice over: NVIDIA's default was 410 Gone for twelve days and the docs said it
// was fine, and CLAUDE.md described a deleted panel for ten days. So the CHAIN
// and the MODEL IDS live here, as data, and both the worker and the page read
// this file. The judgement about WHY lives in worker/lab/benchmarks.mjs next to
// the test that produced it, and a test asserts the two cannot disagree.
//
// KEEP BROWSER-SAFE: no imports, no process.env. providers.mjs still lets an env
// var override any of these — this is the DEFAULT, which is what runs.

/**
 * Task -> provider preference order. The router walks it and takes the first
 * provider that is configured, healthy, and capable.
 */
export const PROFILES = {
  // OPENAI FIRST FOR STRUCTURE — Rahul's call, 2026-09-07, on Comprehension Test
  // evidence (gotcha #91g). Across 5 real reels and 29 objective checks,
  // gpt-4o-mini scored 100% at 5.6s and $0.0042 — tying the only other model
  // that scored 100% (kimi-k3) while being 13x faster and 31x cheaper. Every
  // Gemini model scored 34-45%, not because the summaries were poor but because
  // they return valid JSON in the WRONG SHAPE (flat, no content_type, no
  // synopsis wrapper), which renders an empty reel page. NVIDIA's old default
  // was 410 Gone for twelve days and nothing surfaced it, because failover works.
  // This is the step a new reel's title, summary AND category come from
  // (gotcha #39), so it is the highest-stakes routing decision in the pipeline.
  //
  // MEASURED, 2026-09-07: 6 models x 5 fixtures x 3 PASSES, 87 checks each
  // (worker/lab/run-comprehension.mjs). Rahul's call on the result.
  //
  // The top four tied on SCORE — gpt-4o-mini alone scored 100/93/93 on
  // identical passes, so its own spread is 7 points and a 95-to-99 range means
  // nothing. The order below is therefore decided on TIME, COST and
  // CONSISTENCY, which is the only honest way to separate them:
  //
  //   cerebras   97/97/97   1.1s   $0.038/100 reels   0 retries
  //   openrouter 100/100/97 15.2s  $0.027/100 reels   0 retries
  //   openai     100/93/93   3.6s  $0.084/100 reels   0 retries
  //   groq       97/97/97   29.3s  $0.036/100 reels   36 retries
  //   kimi       72/72/72   64.2s  $4.663/100 reels   3 outright failures
  //
  // Cerebras leads: same score as anything, 3x faster than gpt-4o-mini and 13x
  // faster than mistral, and perfectly consistent across passes. Rahul now pays
  // for it, which is what makes it usable — it 402'd for months before that.
  // The two backups are deliberately a DIFFERENT MODEL AND VENDOR each, so no
  // single outage takes out two links.
  //
  // GROQ IS FOURTH DESPITE MATCHING ON SCORE: it serves the SAME model as
  // Cerebras, so it adds no capability diversity, and 36 retries across 15 calls
  // says its free tier cannot sustain this step.
  //
  // GEMINI IS REMOVED FROM STRUCTURE ENTIRELY. It scored 1/87 with 59 retries,
  // and its failure mode is the dangerous one: valid JSON in the WRONG SHAPE
  // (flat, no content_type, no synopsis wrapper), which renders an empty reel
  // page and which nothing downstream detects. A fallback that fails invisibly
  // is worse than no fallback. It remains first for OCR and synthesize, where
  // it is measured or untested respectively — this judgement is about structure.
  structure:  ["cerebras", "openrouter", "openai", "groq", "kimi"],
  // OPENAI FIRST FOR CLASSIFY — Rahul's call, 2026-09-07, and it is measured
  // rather than assumed. On the same reel, at the same moment, gpt-4o-mini
  // answered "security" every single time while Gemini returned an empty body,
  // then "relationships", then "medical". A wrong category is worse than no
  // category: it files a reel somewhere you will never look for it. The others
  // stay as FALLBACK only — the router reaches them solely when OpenAI errors,
  // so in practice 4o-mini serves every classification.
  classify:   ["openai", "kimi", "groq", "gemini", "cerebras", "openrouter"],
  // Gemini stays first — unchanged and still unmeasured, so a change here would
  // be a guess. Groq is second because synthesize is TIME-BOXED to 25s (gotcha
  // #20) and Groq is the lowest-latency provider; kimi is behind it precisely
  // because at 44-123s it will abort that budget every time. It is still worth
  // listing: aborting fails safe, and the alternative was a chain of one.
  synthesize: ["gemini", "groq", "kimi", "cerebras", "openrouter"],
  // Gemini first on Eye Chart evidence. OPENAI IS THE FALLBACK, and it matters:
  // NVIDIA's vision model 410s and OpenRouter's 404s, so without it Gemini is
  // the ONLY provider that can see, and a rate limit there would stop OCR dead.
  // gpt-4o scored 99-100% on the same chart, so the fallback is a real second
  // opinion rather than a warm body.
  ocr:        ["gemini", "openai", "kimi", "openrouter"],
};

/**
 * The model each provider serves per capability. providers.mjs wraps every one
 * of these in an env override, so this is the DEFAULT — which is what runs, in
 * every environment where nobody set the variable.
 */
export const DEFAULT_MODELS = {
  groq:       { text: "openai/gpt-oss-120b" },
  gemini:     { text: "gemini-flash-latest", vision: "gemini-3.1-flash-lite" },
  cerebras:   { text: "gpt-oss-120b" },
  openrouter: { text: "mistralai/mistral-small-24b-instruct-2501", vision: "google/gemma-3-12b-it" },
  openai:     { text: "gpt-4o-mini", vision: "gpt-4o" },
  kimi:       { text: "kimi-k3", vision: "kimi-k3" },
};

/**
 * Transcription still does NOT go through the router — it is a multipart upload
 * to /audio/transcriptions, not a chat completion, so none of the router's
 * cooldown, load spreading or capability logic applies. It now has a CHAIN of
 * its own instead: nvidia.mjs walks this list in order and takes the first
 * model that answers.
 *
 * TURBO LEADS — Rahul's call, 2026-09-08, on the Ear Chart run of 2026-09-07
 * 11:55. The averages read the wrong way round and the per-clip numbers are the
 * real result:
 *
 *                            clear   fast   tech names   hindi   avg    time
 *   whisper-large-v3-turbo    1.5%   2.9%      1.8%      100%   22.0%   592ms
 *   whisper-large-v3          4.6%   1.6%      2.4%     35.5%    9.4%  1798ms
 *
 * On ENGLISH turbo is the better model — three points better on clear speech,
 * better on tool and company names, 3x faster and 2.7x cheaper. Its whole 22%
 * average is one clip: it does not transcribe Hindi, dropping 56 of 155 words
 * and substituting 99 more. Nearly every reel is English, so the step gets
 * faster and cheaper on almost all of them.
 *
 * THE FALLBACK DOES NOT COVER THAT. A chain fires on an ERROR, and a bad
 * transcript is not an error — a non-English reel gets turbo's nonsense and
 * large-v3 is never asked. Gotcha #33 says foreign-language reels are a real
 * case here, so that is a known, accepted regression, not something the second
 * link fixes. What the second link buys is one model 410-ing or a capacity
 * error on turbo alone, which is exactly how NVIDIA's default died (#57).
 *
 * EVERY OpenAI transcription model was ruled out, and the reason is not the
 * word error rate — three of them beat both of these. None of them return
 * SEGMENTS (timed 0/5 in that run), and the timings are what let on-screen
 * text be interleaved with speech (gotcha #22). A better transcript with no
 * clock is a worse input to the step that reads it.
 *
 * BOTH LINKS ARE GROQ, which means this survives a dead model and NOT a dead
 * provider or a bad key. A link on another provider needs its own base url and
 * key in config.transcription before it would do anything — transcribe() skips
 * a link it holds no endpoint for rather than posting an OpenAI model id at
 * Groq.
 */
export const TRANSCRIPTION = [
  { provider: "groq", model: "whisper-large-v3-turbo" },
  { provider: "groq", model: "whisper-large-v3" },
];

/** What production runs for one step: the ordered chain, with each model named. */
export function chainFor(task, capability = "text") {
  if (task === "transcribe") {
    return TRANSCRIPTION.map((t) => ({ provider: t.provider, model: t.model }));
  }
  const names = PROFILES[task] || [];
  return names.map((provider) => ({
    provider,
    // A provider with no model for this capability cannot serve the step at all.
    // Named as missing rather than silently dropped: an absence in this list is
    // exactly the sort of thing that hides a chain being one deep.
    model: DEFAULT_MODELS[provider]?.[capability] || null,
  })).filter((e) => e.model);
}
