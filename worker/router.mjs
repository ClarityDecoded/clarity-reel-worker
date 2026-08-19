// The task manager: routes each AI task to the best-fit free provider, spreads
// load across them, and fails over when one is rate-limited or down.
//
// Two axes:
//   • SKILL  — each task type has a preferred provider order (PROFILES). OCR only
//     considers vision-capable providers; cheap classification prefers the fast
//     ones; heavy structuring prefers the strongest models.
//   • WORKLOAD — a provider that just returned a rate-limit/exhaustion error is
//     put on a short COOLDOWN and dropped to the back of the line, so the next
//     calls flow to a healthy provider instead of hammering the throttled one.
//     Among otherwise-equal candidates we pick the least-recently-used, so a
//     batch is spread rather than piled on the single top choice.
//
// Every call still goes through withRetry (in-provider transient backoff), so a
// one-off 503 is ridden out in place before we bother failing over. Only when a
// provider is genuinely unavailable do we move to the next. If every capable
// provider fails, the last error propagates (so process-queue can re-queue a
// transient failure exactly as before — CLAUDE.md gotcha #25/#26).

import { getProviders } from "./providers.mjs";
import { withRetry, isTransient, isNetworkError, isRetryableStatus, sleep } from "./retry.mjs";

const COOLDOWN_MS = Number(process.env.LLM_COOLDOWN_MS || 60000);

// Skill routing: task -> provider-name preference order. Names missing from a
// list fall to the end, ordered by their global `priority`. A provider that
// lacks the needed capability is filtered out regardless of the list.
const PROFILES = {
  structure:  ["nvidia", "cerebras", "groq", "gemini", "openrouter"],
  classify:   ["groq", "gemini", "cerebras", "nvidia", "openrouter"],
  synthesize: ["gemini", "cerebras", "nvidia", "groq", "openrouter"],
  ocr:        ["gemini", "nvidia", "openrouter"],
};

// Per-provider live state for this run (module-level = lives for the whole job).
const health = new Map(); // name -> { coolUntil, lastUsed, calls, fails, dead:Set }
function stat(name) {
  if (!health.has(name)) {
    health.set(name, { coolUntil: 0, lastUsed: 0, calls: 0, fails: 0, dead: new Set() });
  }
  return health.get(name);
}

// One serial gate per provider that asks for pacing (NVIDIA). Floors a minimum
// gap BETWEEN that provider's calls, before the first failure — same mechanism
// the old nvidia.mjs used, now generalised.
const gates = new Map(); // name -> Promise
function paced(p, fn) {
  if (!p.paced || !p.minGapMs) return fn();
  const prev = gates.get(p.name) || Promise.resolve();
  const result = prev.then(fn);
  gates.set(p.name, result.then(() => sleep(p.minGapMs), () => sleep(p.minGapMs)));
  return result;
}

// A rate-limit / capacity error: cool the provider off and move on. 429 = quota,
// 503 = shared-pool exhaustion, plus a few provider-specific phrasings.
function isRateLimited(err) {
  const status = typeof err?.status === "number" ? err.status : null;
  if (status === 429 || status === 503) return true;
  return /rate limit|quota|exhaust|too many requests|resource[_ ]?exhausted|insufficient/i.test(String(err?.message || ""));
}

// A model that does not exist for this key — retired, renamed, or never granted.
// UNLIKE a rate limit this will NOT get better in 60 seconds: it is the same
// answer on every call for the whole run. Gemini retiring gemini-2.5-flash cost
// 105 pointless round trips in ONE run (every OCR frame tried Gemini, 404'd,
// then failed over to NVIDIA) and was most of why that run hit the 30-minute
// workflow timeout. So this is a PERMANENT per-run disable, not a cooldown.
function isModelUnavailable(err) {
  if (err?.status === 404) return true;
  return /model[^.]{0,20}(not found|no longer available|does not exist|decommissioned|deprecated)|no longer available to new users/i
    .test(String(err?.message || ""));
}

// Order the capable providers for a task: healthy first, then skill preference,
// then global priority, then least-recently-used to spread the load.
function orderFor(task, capability, now) {
  const pref = PROFILES[task] || [];
  const rank = (p) => {
    const i = pref.indexOf(p.name);
    return i === -1 ? pref.length + p.priority : i;
  };
  return getProviders()
    .filter((p) => p.models[capability])
    .filter((p) => !stat(p.name).dead.has(capability)) // model 404'd earlier this run
    .sort((a, b) => {
      const ca = stat(a.name).coolUntil > now ? 1 : 0;
      const cb = stat(b.name).coolUntil > now ? 1 : 0;
      if (ca !== cb) return ca - cb;              // healthy before cooling
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;              // skill/priority preference
      return stat(a.name).lastUsed - stat(b.name).lastUsed; // spread load
    });
}

// One raw OpenAI-compatible call to a specific provider. Throws with .status set
// so withRetry / isRateLimited can classify it.
async function callOnce(p, { capability, messages, json, maxTokens, timeoutMs }) {
  const model = p.models[capability];
  return paced(p, async () => {
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(p.base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + p.key, "Content-Type": "application/json", ...p.extraHeaders },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller?.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`${p.name} ${model} ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

/**
 * Route a chat/vision task to the best free provider, with failover.
 *
 * @param {object} o
 * @param {string} o.task        one of PROFILES (structure|classify|synthesize|ocr)
 * @param {"text"|"vision"} [o.capability="text"]
 * @param {Array}  o.messages    OpenAI-format messages
 * @param {boolean}[o.json]      request a JSON object response
 * @param {number} [o.maxTokens]
 * @param {number} [o.retries]   per-provider in-place retry budget (withRetry)
 * @param {number} [o.cap]       per-provider backoff cap
 * @param {number} [o.timeoutMs] abort a single hung request (fail fast)
 * @returns {Promise<string>} the message content
 */
export async function route({ task, capability = "text", messages, json = false, maxTokens = 2048, retries = 5, cap = 20000, timeoutMs }) {
  const now = Date.now();
  const candidates = orderFor(task, capability, now);
  if (candidates.length === 0) {
    throw new Error(`No provider available for ${capability} (task=${task}). Set at least one provider key.`);
  }

  let lastErr;
  for (const p of candidates) {
    const s = stat(p.name);
    try {
      const content = await withRetry(
        () => callOnce(p, { capability, messages, json, maxTokens, timeoutMs }),
        {
          retries,
          cap,
          onRetry: (e, attempt, delay) => console.warn(`[${p.name}:${task}] retry ${attempt} in ${delay}ms: ${e.message}`),
        },
      );
      s.calls++; s.lastUsed = Date.now();
      if (candidates.indexOf(p) > 0) console.log(`[router] ${task}/${capability} served by ${p.name} (failover)`);
      return content;
    } catch (e) {
      s.fails++; lastErr = e;
      if (isModelUnavailable(e)) {
        s.dead.add(capability);
        console.warn(`[router] ${p.name} has no working ${capability} model — disabled for this run: ${e.message}`);
      } else if (isRateLimited(e)) {
        s.coolUntil = Date.now() + COOLDOWN_MS;
        console.warn(`[router] ${p.name} rate-limited on ${task}, cooling ${COOLDOWN_MS}ms → next provider`);
      } else if (isTransient(e) || isNetworkError(e) || (typeof e.status === "number" && isRetryableStatus(e.status))) {
        console.warn(`[router] ${p.name} transient-failed on ${task} → next provider: ${e.message}`);
      } else {
        console.warn(`[router] ${p.name} errored on ${task} → next provider: ${e.message}`);
      }
      // fall through to the next candidate
    }
  }
  throw lastErr || new Error(`All providers failed for ${task}/${capability}`);
}

// End-of-run observability: which provider carried the load, and how many calls
// failed over. Log this at the end of a process/digest run.
export function llmUsageSummary() {
  const rows = [...health.entries()]
    .filter(([, s]) => s.calls || s.fails)
    .map(([name, s]) => `${name}: ${s.calls} ok, ${s.fails} fail`);
  return rows.length ? rows.join(" | ") : "no LLM calls";
}
