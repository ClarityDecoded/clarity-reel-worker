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
  // CEREBRAS FIRST FOR CLASSIFY — Rahul's call, 2026-09-08, on the Classify
  // benchmark's first run (worker/lab/run-classify.mjs): 6 models x 9 fixtures
  // x 3 passes, each fixture a reel whose category Rahul confirmed by hand.
  //
  //   cerebras   23/27 right (85%)   350ms    0 errors
  //   openai     21/27 right (78%)   701ms    0 errors
  //   openrouter 21/27 right (78%)   671ms    0 errors
  //   kimi       19/27 right (70%)  7427ms    0 errors
  //   groq       18/27 right (67%)  1510ms    4 retries
  //   gemini      1/27 right  (4%) 22043ms   25 errors, 104 retries
  //
  // Cerebras leads: best score AND roughly twice as fast as OpenAI, the
  // previous primary. OpenAI stays second (a different vendor, not just a
  // different model) — the original pick was a real spot check, gpt-4o-mini
  // answering "security" correctly every time on one reel while the prior
  // leader returned an empty body then two wrong subjects, just never measured
  // against a confirmed answer key until now. Openrouter/mistral is third,
  // tied with OpenAI on score.
  //
  // This run ALSO caught a real bug, not a model-quality gap: maxTokens 64
  // (sized for the one-word answer alone) truncated cerebras/kimi/groq mid-JSON
  // because all three spend hidden reasoning tokens before writing anything
  // visible — gotcha #86a's exact shape, never caught because this step had
  // never been benchmarked. Fixed to 512 here and in nvidia.mjs's real
  // classifyCategory(). And it found every model, cerebras included, sharing
  // the SAME mistake on 3 of 9 fixtures: filing "used an AI tool for
  // marketing/design" as "ai" instead of the real subject. That was a prompt
  // gap in CATEGORY_GUIDE, not a model-choice one — fixed the same session, and
  // a re-run confirmed it: every model gets all three of those fixtures right
  // now. The scores above are from BEFORE that fix; a re-run after it landed
  // cerebras/openai/openrouter all at 89% (16/18), the only remaining miss
  // being menstrual_cycle, a personal-taxonomy call no content signal predicts.
  //
  // WORTH NAMING: cerebras is now primary for structure, classify AND
  // synthesize below — three of five text steps on one vendor. Real
  // concentration risk. Rahul's call to accept it rather than a reason to avoid
  // the better-measured model.
  classify:   ["cerebras", "openai", "openrouter", "kimi", "groq", "gemini"],
  // CEREBRAS FIRST FOR SYNTHESIZE TOO — Rahul's call, 2026-09-08, on the
  // Synthesize benchmark's first run (worker/lab/run-synthesize.mjs): 5 models
  // x 2 real nights x 3 passes, scored on groundedness (no invented ticker, no
  // padded stocks section) since this step has no single right answer to grade
  // like a rubric of facts.
  //
  //   cerebras   27/27 (100%)   1208ms   0 too slow
  //   openrouter 22/27  (81%)  10229ms   1 too slow
  //   groq       12/27  (44%)   3490ms   0 too slow (rate limited outright)
  //   gemini      0/27   (0%)      —     0 too slow (rate limited EVERY call)
  //   kimi        0/27   (0%)      —     6 too slow (past the 25s budget EVERY call)
  //
  // Gemini was the previous primary and scored zero — rate limited on every
  // single call across all three passes. Kimi ran past this step's hard
  // production time budget (gotcha #20) on every call too; it is not wrong
  // here, it is simply too slow to ever finish before the digest would abandon
  // it. Cerebras answered every call with full marks and never once ran over
  // budget. Openrouter/mistral is the backup — a different vendor, correct when
  // it answers, just slow (avg 10s, one outright timeout in nine calls).
  synthesize: ["cerebras", "openrouter", "groq", "gemini", "kimi"],
  // OCR: GEMINI, THEN TWO OPENAI MODELS — Rahul's call, 2026-09-08, on the Eye
  // Chart run of 2026-09-07 00:21. All three links were measured in that one
  // run, on the same five images, so this order is a straight read of it:
  //
  //   gemini  gemini-3.1-flash-lite   99.0%   2.0s   $0.0020 / 5 images
  //   openai  gpt-5.6-luna           100.0%  22.3s   $0.0038 / 5 images
  //   openai  gpt-4o                  99.2%   1.7s   $0.0149 / 5 images
  //
  // None of the three blanked or failed on any image, which is the column that
  // actually separates vision models here — the whole gpt-5 family answers
  // 200 OK with NOTHING on the two hard images (gotcha #90c).
  //
  // Gemini still leads on the same reasoning as before: it reads essentially
  // the whole chart at the lowest price and in two seconds. OCR runs about a
  // dozen times a reel, so price and latency compound here harder than anywhere
  // else in the pipeline, and a fifth of a point of recall does not.
  //
  // BOTH BACKUPS ARE OPENAI, WHICH IS A KNOWN AND ACCEPTED NARROWING. Everywhere
  // else in this file a chain deliberately spans vendors so one outage cannot
  // take out two links (see structure, and gotcha #99c). It cannot here: of the
  // providers with a key, only Gemini and OpenAI have a working vision model at
  // all — kimi and openrouter were in the previous chain but were never measured
  // by the Eye Chart, and a link nobody has tested is not a fallback, it is a
  // hope. Two measured OpenAI models beat two unmeasured vendors. The exposure
  // is real and it is exactly this: a bad OPENAI_API_KEY or an account-level
  // rate limit takes out both backups at once, leaving Gemini alone.
  //
  // gpt-5.6-luna sits above gpt-4o despite being thirteen times slower because
  // a fallback is not the hot path: it runs when Gemini is rate-limited, where
  // being right matters more than being quick, and it is also four times
  // cheaper than gpt-4o. gpt-4o is last as the fast one to fall back to if luna
  // is itself unavailable.
  //
  // gpt-4o-mini is deliberately NOT here even though it is the TEXT model: it
  // spent twenty-seven times as many image tokens as gpt-4.1-mini on the same
  // five pictures, which makes the cheap-looking mini about ten times dearer to
  // actually run (gotcha #90e).
  //
  // TWO ENTRIES SHARE A PROVIDER, which is why an entry may be an object. See
  // profileEntries below.
  ocr: [
    "gemini",
    { provider: "openai", model: "gpt-5.6-luna" },
    { provider: "openai", model: "gpt-4o" },
  ],
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
 * OPENAI/WHISPER-1 IS THE LAST LINK, and it is there for the failure the first
 * two share: they are both Groq, so a dead key or a Groq outage took out the
 * whole chain. It is the ONLY OpenAI transcription model eligible, because it
 * is the only one that returns segments — the newer gpt-4o-transcribe family
 * scores better on word error rate and cannot be used at any position for that
 * reason alone. It is last because it is the slowest (7.4s against 0.6s) and
 * roughly nine times the price of turbo per minute, which is exactly what a
 * last resort should be.
 *
 * A cross-provider link only works because config.transcription.endpoints holds
 * a base url and key per provider. transcribe() SKIPS a link it has no endpoint
 * for rather than posting an OpenAI model id at Groq, which returns a 400 that
 * reads exactly like the model being broken.
 */
export const TRANSCRIPTION = [
  { provider: "groq", model: "whisper-large-v3-turbo" },
  { provider: "groq", model: "whisper-large-v3" },
  { provider: "openai", model: "whisper-1" },
];

/**
 * Normalise a PROFILES entry. An entry is USUALLY just a provider name, meaning
 * "use whatever model that provider is configured to serve for this capability".
 * It may instead be `{ provider, model }` when the chain needs one exact model.
 *
 * WHY BOTH SHAPES. A provider-name-only chain cannot list the same provider
 * twice with different models, and OCR now has to: the only two vendors with a
 * working vision model are Gemini and OpenAI, so both backups are OpenAI models.
 * Rather than a second lookup table of per-task model overrides — a second
 * source of truth, which is the split-brain shape this codebase keeps paying for
 * — the entry itself carries the model.
 *
 * Everything that walks a chain goes through here, so neither shape has to be
 * handled twice.
 */
export function profileEntries(task) {
  return (PROFILES[task] || []).map((e) =>
    typeof e === "string"
      ? { provider: e, model: null }
      : { provider: e.provider, model: e.model || null });
}

/** What production runs for one step: the ordered chain, with each model named. */
export function chainFor(task, capability = "text") {
  if (task === "transcribe") {
    return TRANSCRIPTION.map((t) => ({ provider: t.provider, model: t.model }));
  }
  return profileEntries(task).map(({ provider, model }) => ({
    provider,
    // An entry's own model wins; otherwise the provider's default for this
    // capability. A provider with neither cannot serve the step at all, and is
    // named as missing rather than silently dropped: an absence here is exactly
    // the sort of thing that hides a chain being one deep.
    model: model || DEFAULT_MODELS[provider]?.[capability] || null,
  })).filter((e) => e.model);
}
