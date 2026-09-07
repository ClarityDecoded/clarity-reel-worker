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

export function getProviders() {
  return [
    // NVIDIA build.nvidia.com — the baseline. Text + vision. Paced.
    make("nvidia", "NVIDIA_API_KEY", env("NVIDIA_BASE", "https://integrate.api.nvidia.com/v1"), {
      text: env("NVIDIA_LLM_MODEL", "moonshotai/kimi-k3"),
      vision: env("NVIDIA_VLM_MODEL", "nvidia/llama-3.1-nemotron-nano-vl-8b-v1"),
    }, { priority: 2, paced: true, minGapMs: Number(env("NVIDIA_MIN_GAP_MS", 400)) }),

    // Groq — already keyed (Whisper). Fast Llama, text only here. Highest priority
    // for cheap/quick text because it's the lowest-latency free option.
    make("groq", "GROQ_API_KEY", env("GROQ_BASE", "https://api.groq.com/openai/v1"), {
      text: env("GROQ_LLM_MODEL", "llama-3.3-70b-versatile"),
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
      text: env("OPENROUTER_LLM_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
      vision: env("OPENROUTER_VLM_MODEL", "meta-llama/llama-3.2-11b-vision-instruct:free"),
    }, {
      priority: 5,
      extraHeaders: { "HTTP-Referer": env("APP_URL", "https://portal.claritydecoded.com"), "X-Title": "Clarity Reel Worker" },
    }),

    // OpenAI — the first PAID provider in this list. Everything above is a free
    // tier, which is exactly why the whole pipeline fell over in September when
    // five free catalogs rotted or ran out at once. A paid key doesn't rot on a
    // quota boundary, so OpenAI (and a paid Gemini key) are the reliability
    // floor; the free tiers stay as cost-savers above it.
    // Text + vision come from the same multimodal model, so one id covers both.
    make("openai", "OPENAI_API_KEY", env("OPENAI_BASE", "https://api.openai.com/v1"), {
      text: env("OPENAI_LLM_MODEL", "gpt-4o-mini"),
      vision: env("OPENAI_VLM_MODEL", "gpt-4o-mini"),
    }, { priority: 0 }),

    // NOTE: Cloudflare Workers AI is intentionally NOT wired here — its free
    // neuron pool is reserved for actual Workers, not the reel pipeline.
  ].filter(Boolean);
}
