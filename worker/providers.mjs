// Free-tier LLM/VLM provider registry.
//
// Every provider here speaks the SAME OpenAI-compatible /chat/completions shape,
// so the router (router.mjs) can treat them interchangeably and fail over between
// them. A provider only becomes ACTIVE when its API key env var is present — so
// this file can ship now and each provider "lights up" the moment Rahul adds its
// GitHub repo secret. NVIDIA stays the required baseline; the rest are free
// backups that spread load off NVIDIA's single free tier (CLAUDE.md gotcha #18).
//
// `models.text`  — chat/JSON structuring model (required for a text provider)
// `models.vision`— multimodal model that can read an image_url (OCR); omit if the
//                  provider has no vision model wired, and the router just won't
//                  consider it for OCR tasks.
// `priority`     — lower = tried earlier when a task has no explicit preference.
// `paced`        — funnel calls through a serial min-gap gate (NVIDIA needs this;
//                  its shared pool 503s on a burst — pacing BEFORE the first
//                  failure is what keeps a batch under the ceiling).
// Model names are all env-overridable so a shifting free catalog never needs a
// code change.

const env = (name, fallback) => process.env[name] || fallback;

// Build the descriptor for one provider, or null if its key isn't set.
function make(name, keyVar, base, models, { priority, paced = false, minGapMs = 0, extraHeaders = {} } = {}) {
  const key = process.env[keyVar];
  if (!key) return null;
  return { name, key, base: base.replace(/\/$/, ""), models, priority, paced, minGapMs, extraHeaders };
}

/**
 * EVERY PROVIDER KEY, IN THE SAME FILE THAT DECLARES THE PROVIDERS.
 *
 * Rahul's rule: adding a provider and adding its key are ONE job. Split across
 * two files they drift, and a provider whose key nobody was told to set is a
 * silent chain-of-one — which is exactly what happened when kimi-k3 was
 * reachable only through NVIDIA. `test-keys.mjs` fails if a provider declared
 * below has no entry here, so this cannot be forgotten rather than merely
 * shouldn't be.
 *
 * `verify` MUST make a call that REQUIRES AUTHENTICATION. Listing endpoints are
 * not proof: nvidia's and openrouter's /models both answer 200 with NO KEY AT
 * ALL (measured 2026-09-07), which is precisely how a dead NVIDIA key was
 * reported as "OK, 81 models" while every real call 401'd. A chat completion
 * costs a fraction of a cent and proves the thing we actually need.
 *
 * `shape` is a sanity check on a PASTE, never a secret test — it catches a
 * truncated copy or a key dropped into the wrong slot, which is the failure the
 * masked summary exists to surface.
 */
export const PROVIDER_KEYS = [
  {
    env: "OPENAI_API_KEY", label: "OpenAI", provider: "openai",
    shape: /^sk-[A-Za-z0-9_-]{20,}$/, typicalLen: [80, 200],
    console: "https://platform.openai.com/api-keys",
    verify: (key) => chatProbe("https://api.openai.com/v1", key, "gpt-4o-mini"),
  },
  {
    env: "GEMINI_API_KEY", label: "Google Gemini", provider: "gemini",
    shape: /^[A-Za-z0-9_.-]{30,}$/, typicalLen: [35, 60],
    console: "https://aistudio.google.com/apikey",
    verify: (key) => chatProbe("https://generativelanguage.googleapis.com/v1beta/openai", key, "gemini-flash-latest"),
  },
  {
    env: "GROQ_API_KEY", label: "Groq", provider: "groq",
    shape: /^gsk_[A-Za-z0-9]{20,}$/, typicalLen: [50, 70],
    console: "https://console.groq.com/keys",
    verify: (key) => chatProbe("https://api.groq.com/openai/v1", key, "openai/gpt-oss-120b"),
  },
  {
    env: "KIMI_API_KEY", label: "Moonshot (Kimi)", provider: "kimi",
    shape: /^sk-[A-Za-z0-9_-]{20,}$/, typicalLen: [40, 120],
    console: "https://platform.moonshot.ai/console/api-keys",
    verify: (key) => chatProbe("https://api.moonshot.ai/v1", key, "kimi-k3"),
  },
  {
    env: "CEREBRAS_API_KEY", label: "Cerebras", provider: "cerebras",
    shape: /^csk-[A-Za-z0-9]{20,}$/, typicalLen: [40, 80],
    console: "https://cloud.cerebras.ai/platform/apikeys",
    verify: (key) => chatProbe("https://api.cerebras.ai/v1", key, "gpt-oss-120b"),
  },
  {
    env: "OPENROUTER_API_KEY", label: "OpenRouter", provider: "openrouter",
    shape: /^sk-or-v1-[A-Za-z0-9]{20,}$/, typicalLen: [60, 90],
    console: "https://openrouter.ai/settings/keys",
    // /models answers 200 with no key. /credits requires auth.
    verify: async (key) => {
      const r = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(30000),
      });
      return { ok: r.ok, detail: r.ok ? "authenticated" : `HTTP ${r.status}` };
    },
  },
];

/**
 * The only honest key check: a real completion. Anything less has already lied
 * to us once. `max_tokens` is generous because a reasoning model spends tokens
 * before it emits anything (gotcha #86a) and an empty reply would read as a
 * failed key when the key is fine.
 */
async function chatProbe(base, key, model) {
  try {
    const r = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with ok." }], max_tokens: 2048 }),
      signal: AbortSignal.timeout(120000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `HTTP ${r.status} — key rejected` };
    if (!r.ok) {
      // A dead MODEL is not a dead KEY, and saying so would send Rahul to
      // rotate a key that is fine. 402/429 likewise: the key authenticated.
      const kind = r.status === 404 || r.status === 410 ? "model gone, but the key authenticated"
        : r.status === 402 ? "billing required, but the key authenticated"
        : r.status === 429 ? "rate limited, but the key authenticated"
        : `HTTP ${r.status}`;
      return { ok: r.status === 404 || r.status === 410 || r.status === 402 || r.status === 429, detail: kind };
    }
    return { ok: true, detail: "authenticated" };
  } catch (e) {
    return { ok: false, detail: "ERR " + String(e.message).slice(0, 60) };
  }
}

export function getProviders() {
  return [
    // NVIDIA REMOVED, 2026-09-07 — Rahul's call after its key authenticated for
    // /models and 401'd on every actual inference call, its vision model went
    // 410 Gone, and its text model had already been dead for twelve days once
    // before. Replaced by OpenRouter, which needs no new key: it was already
    // configured, already deployed everywhere, and already authenticates.

    // Groq — already keyed (Whisper). Fast Llama, text only here. Highest priority
    // for cheap/quick text because it's the lowest-latency free option.
    make("groq", "GROQ_API_KEY", env("GROQ_BASE", "https://api.groq.com/openai/v1"), {
      // llama-3.3-70b-versatile was RETIRED — a 404 "model does not exist", not a
      // rate limit, so Groq silently contributed nothing to three chains while its
      // key worked perfectly for Whisper. The fourth model id to rot here (#57,
      // #91g), which is why the chain depth is now probed rather than assumed.
      text: env("GROQ_LLM_MODEL", "openai/gpt-oss-120b"),
    }, { priority: 1 }),

    // Google Gemini via its OpenAI-compatible endpoint. Native vision + generous
    // free quota (1,500 req/day) — the strongest single NVIDIA-vision backup.
    make("gemini", "GEMINI_API_KEY", env("GEMINI_BASE", "https://generativelanguage.googleapis.com/v1beta/openai"), {
      // Pinned model ids ROT: Google retired gemini-2.5-flash for new keys and
      // every call 404'd. The "-latest" aliases track the current flash model,
      // so a retirement rolls forward instead of silently breaking the provider.
      // If these ever 404 too, the router disables Gemini for the run after ONE
      // call rather than paying the 404 on every frame.
      text: env("GEMINI_LLM_MODEL", "gemini-flash-latest"),
      // OCR model chosen on measurement, not reputation (the Eye Chart,
      // gotcha #90): 99% of 211 expected words across five deliberately hard
      // images, at $0.0020 per five and 2.0s — the cheapest AND second-fastest
      // model that scored 99%+. Its only misses in the whole chart were one
      // "listed" and one Hindi word. OCR runs ~12x per reel, so speed and cost
      // compound here more than anywhere else in the pipeline.
      vision: env("GEMINI_VLM_MODEL", "gemini-3.1-flash-lite"),
    }, { priority: 3 }),

    // Cerebras — very high token/day ceiling, fast. Text only.
    make("cerebras", "CEREBRAS_API_KEY", env("CEREBRAS_BASE", "https://api.cerebras.ai/v1"), {
      text: env("CEREBRAS_LLM_MODEL", "gpt-oss-120b"),
    }, { priority: 4 }),

    // OpenRouter — many free models behind one key (thin daily cap; last-resort).
    make("openrouter", "OPENROUTER_API_KEY", env("OPENROUTER_BASE", "https://openrouter.ai/api/v1"), {
      // The `:free` variants are GONE — "unavailable for free, the paid version…"
      // — which is why OpenRouter contributed nothing despite a working key.
      // These two are verified answering RIGHT NOW at a zero credit balance.
      // Chosen for INDEPENDENCE as much as price: a fallback that routes to the
      // same upstream as the primary is not a fallback, so vision is Gemma
      // rather than the Gemini or GPT models already sitting above it.
      text: env("OPENROUTER_LLM_MODEL", "mistralai/mistral-small-24b-instruct-2501"),
      vision: env("OPENROUTER_VLM_MODEL", "google/gemma-3-12b-it"),
    }, {
      priority: 5,
      extraHeaders: { "HTTP-Referer": env("APP_URL", "https://portal.claritydecoded.com"), "X-Title": "Clarity Reel Worker" },
    }),

    // OpenAI — the first PAID provider in this list. Everything above is a free
    // tier, which is exactly why the whole pipeline fell over in September when
    // five free catalogs rotted or ran out at once. A paid key doesn't rot on a
    // quota boundary, so OpenAI (and a paid Gemini key) are the reliability
    // floor; the free tiers stay as cost-savers above it.
    // TEXT AND VISION ARE DIFFERENT MODELS HERE, and assuming one id covered
    // both was wrong. gpt-4o-mini is the right text model — it scored 100% on
    // the Comprehension Test (gotcha #91g). It is a TRAP for vision: the Eye
    // Chart measured 173,076 image tokens over five pictures against
    // gpt-4.1-mini's 6,343 — TWENTY-SEVEN times as many for the same images,
    // which makes the "mini" about 10x dearer than its own successor and 18x
    // dearer than gpt-4o on the same chart. Nothing in a per-token rate card
    // shows that; only measuring what a real image costs does (gotcha #90e).
    // Vision is gpt-4o, which scored 99-100% on the hard chart — this provider
    // is OCR's only working fallback (NVIDIA's vision model 410s, OpenRouter's
    // 404s), so it has to be a real second opinion, not a warm body.
    make("openai", "OPENAI_API_KEY", env("OPENAI_BASE", "https://api.openai.com/v1"), {
      text: env("OPENAI_LLM_MODEL", "gpt-4o-mini"),
      vision: env("OPENAI_VLM_MODEL", "gpt-4o"),
    }, { priority: 0 }),

    // Moonshot direct. kimi-k3 was previously reachable ONLY through NVIDIA, whose
    // key now 401s on inference — so the one model that scored 100% on the
    // Comprehension Test (gotcha #91g) had no working path at all. A direct
    // endpoint fixes that and is a genuinely independent provider, which is the
    // whole point of a fallback: NVIDIA going down must not take kimi with it.
    // It is MULTIMODAL (verified — all three models accept an image), which
    // matters more than it sounds: NVIDIA's vision model is gone and OpenRouter
    // has no working free one, so without Kimi, OCR has exactly two providers
    // that can see and no third.
    // SLOW: 44-123s on real work. Fine as a fallback, wrong for synthesize's
    // deliberate 25s budget (gotcha #20), where it will simply abort and the
    // digest sends without a brief — best-effort failing safe, as designed.
    make("kimi", "KIMI_API_KEY", env("KIMI_BASE", "https://api.moonshot.ai/v1"), {
      text: env("KIMI_LLM_MODEL", "kimi-k3"),
      vision: env("KIMI_VLM_MODEL", "kimi-k3"),
    }, { priority: 3 }),

    // NOTE: Cloudflare Workers AI is intentionally NOT wired here — its free
    // neuron pool is reserved for actual Workers, not the reel pipeline.
  ].filter(Boolean);
}
