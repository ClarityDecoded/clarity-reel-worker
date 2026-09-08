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
  if (err?.status === 404 || err?.status === 410) return true;
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

// Read a 400 that names a parameter the model will not take, and return a fixed
// payload — or null if we do not recognise the complaint. Deliberately narrow:
// it only ever RENAMES max_tokens or DROPS a parameter, never invents one, so a
// misread error can degrade a request but cannot corrupt it.
export function adaptPayload(payload, status, body) {
  if (status !== 400) return null;
  const text = String(body || "");

  // gpt-5 / o-series: "Use 'max_completion_tokens' instead."
  if (/max_completion_tokens/.test(text) && "max_tokens" in payload) {
    const { max_tokens, ...rest } = payload;
    return { ...rest, max_completion_tokens: max_tokens };
  }
  // Reasoning models accept only the default temperature. The phrasing varies
  // per vendor and the narrow list here did not cover Kimi's "invalid
  // temperature: only 1 is allowed for this model" — so kimi-k3, second in the
  // structure chain, 400'd on EVERY call and adapted nothing. Matching on the
  // parameter name plus any refusal-shaped wording is what makes this rule
  // survive the next vendor's phrasing; dropping temperature is always safe,
  // since it only ever returns the model to its own default.
  if (/temperature/i.test(text) &&
      /unsupported|not supported|does not support|only the default|only 1 is allowed|invalid temperature|must be|can only be/i.test(text) &&
      "temperature" in payload) {
    const { temperature, ...rest } = payload;
    return rest;
  }
  // A model with no JSON mode: drop the format rather than lose the answer.
  if (/response_format/.test(text) && "response_format" in payload) {
    const { response_format, ...rest } = payload;
    return rest;
  }
  return null;
}

// One raw OpenAI-compatible call to a specific provider. Throws with .status set
// so withRetry / isRateLimited can classify it.
//
// Returns { content, usage, model, ms }. It used to return just the string, but
// the token counts were being thrown away with the rest of the response body —
// and token counts are the only MEASURED input to a cost comparison (a price
// table is an estimate; usage is fact). route() unwraps .content so every
// existing caller is unaffected; the lab reads the whole object.
// `modelOverride` lets the lab pin one exact model instead of the provider's
// configured production default.
async function callOnce(p, { capability, messages, json, maxTokens, timeoutMs, modelOverride }) {
  const model = modelOverride || p.models[capability];
  return paced(p, async () => {
    const startedAt = Date.now();
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      // Start from the shape every OpenAI-compatible endpoint has accepted for
      // years, then ADAPT if the provider rejects a parameter. OpenAI's gpt-5
      // and o-series renamed max_tokens -> max_completion_tokens and refuse a
      // non-default temperature; a newer model family will break something else
      // next year. Pattern-matching model ids to decide the body up front is
      // just another pinned assumption of exactly the kind that has now rotted
      // twice here (gotcha #57), so instead we read the 400 the API sends,
      // which names the offending parameter, and try again without it.
      let payload = {
        model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      };

      let res, body = "";
      // At most 3 attempts: each one drops or renames exactly one rejected
      // parameter, so this terminates rather than looping on a persistent 400.
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(p.base + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + p.key, "Content-Type": "application/json", ...p.extraHeaders },
          body: JSON.stringify(payload),
          signal: controller?.signal,
        });
        if (res.ok) break;
        body = await res.text().catch(() => "");
        const next = adaptPayload(payload, res.status, body);
        if (!next) break;          // not something we know how to fix
        payload = next;
        console.warn(`[router] ${p.name} ${model}: retrying without a rejected parameter`);
      }

      if (!res.ok) {
        const err = new Error(`${p.name} ${model} ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage || null,
        model,
        ms: Date.now() - startedAt,
      };
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

  // A cooling provider is sorted to the back (orderFor), but the loop below
  // used to still call it — cooldown was decorative, not enforced. When it's
  // the LAST capable candidate (the common shape once others are marked dead
  // this run, gotcha #57/#85) that meant every call still paid the provider's
  // full retry budget against something we already know just failed. Skip a
  // cooling candidate outright UNLESS every candidate is cooling/dead, in
  // which case fail fast rather than hammer one anyway — this is what let a
  // single stalled OCR frame (Gemini's daily quota exhausted, NVIDIA+
  // OpenRouter already dead) cost ~90s each and burn a whole 1-hour run
  // without finishing its first item.
  const ready = candidates.filter((p) => stat(p.name).coolUntil <= now);
  if (ready.length === 0) {
    const soonest = candidates.reduce((a, b) => (stat(a.name).coolUntil < stat(b.name).coolUntil ? a : b));
    const err = new Error(
      `All providers cooling for ${capability} (task=${task}) — soonest back is ${soonest.name} in ` +
      `${Math.max(0, stat(soonest.name).coolUntil - now)}ms`,
    );
    err.status = 503; // temporary, not permanent — isTransient (retry.mjs) must re-queue, not bury, the item
    throw err;
  }

  let lastErr;
  for (const p of ready) {
    const s = stat(p.name);
    try {
      const res = await withRetry(
        () => callOnce(p, { capability, messages, json, maxTokens, timeoutMs }),
        {
          retries,
          cap,
          onRetry: (e, attempt, delay) => console.warn(`[${p.name}:${task}] retry ${attempt} in ${delay}ms: ${e.message}`),
        },
      );
      // AN EMPTY ANSWER IS A FAILURE, NOT A RESULT. A provider that returns ""
      // with HTTP 200 used to WIN the race and hand the caller nothing, which
      // then blew up somewhere else entirely — classifyCategory died on
      // "Unexpected end of JSON input" and every reel it touched was left
      // Uncategorised, with the real cause (Gemini answering blank) never
      // mentioned. gpt-5 does the same when reasoning eats the whole token
      // budget. Treat it as this provider failing so the router moves on.
      if (!String(res.content || "").trim()) {
        const err = new Error(`${p.name} ${res.model} returned an empty response`);
        err.status = 502; // transient-shaped: worth trying the next provider
        throw err;
      }

      // AND a json:true answer that holds no JSON is a failure too. Gemini
      // returned the literal string "```json" here — an opening markdown fence
      // and nothing else. Non-empty, so the check above waved it through, and
      // the caller died on JSON.parse instead, three layers away from the
      // provider that actually misbehaved. `json: true` is a contract: if the
      // answer cannot yield an object, this provider did not answer.
      if (json) {
        try {
          parseLooseJson(res.content);
        } catch {
          const err = new Error(
            `${p.name} ${res.model} returned no usable JSON: ${String(res.content).slice(0, 80)}`,
          );
          err.status = 502;
          throw err;
        }
      }

      s.calls++; s.lastUsed = Date.now();
      if (candidates.indexOf(p) > 0) console.log(`[router] ${task}/${capability} served by ${p.name} (failover)`);
      return res.content;
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

/**
 * Read JSON out of a model's answer, tolerating the usual noise: a ```json
 * fence, or a sentence before the object. Throws if there is no object in there.
 *
 * Exported so the router and its callers share ONE implementation — nvidia.mjs
 * used to keep its own copy, and a model whose output shape drifts should not
 * need the same fix applied in two places.
 */
export function parseLooseJson(raw) {
  let text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  else if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").trim(); // unterminated fence
  if (!text.startsWith("{")) {
    const brace = text.indexOf("{");
    const close = text.lastIndexOf("}");
    if (brace >= 0 && close > brace) text = text.slice(brace, close + 1);
  }
  return JSON.parse(text);
}

// ── Direct single-model call, for the model lab ───────────────────────────
// Deliberately NO failover, NO cooldown, NO retry budget: the lab is asking
// "how did THIS model do on this input?", and a silent fail-over to another
// provider would answer a different question — you'd be reading Gemini's output
// under OpenAI's name. A failure here is a RESULT (shown as FAILED/TIMEOUT in
// the UI), not something to route around.
//
// Returns { content, usage, model, ms }. Throws with .status set on an API error.
export async function callModel({ providerName, model, capability = "text", messages, json = false, maxTokens = 2048, timeoutMs = 120000 }) {
  const p = getProviders().find((x) => x.name === providerName);
  if (!p) throw new Error(`Provider "${providerName}" is not configured (its API key env var is unset).`);
  return callOnce(p, { capability, messages, json, maxTokens, timeoutMs, modelOverride: model });
}

// What the lab needs to enumerate: which providers actually have a key set.
export function activeProviders() {
  return getProviders().map((p) => ({
    name: p.name,
    base: p.base,
    models: p.models,
    priority: p.priority,
  }));
}

// Ask a provider which models this key can actually reach. This is the antidote
// to the pinned-id rot that has now bitten twice (gotcha #57, and the Sept
// outage where five providers went dead at once): never hardcode a catalog we
// can just ask for. Returns [] rather than throwing — a provider without a
// /models endpoint should not sink the whole listing.
export async function listModels(providerName) {
  const p = getProviders().find((x) => x.name === providerName);
  if (!p) return [];
  try {
    const res = await fetch(p.base + "/models", {
      headers: { Authorization: "Bearer " + p.key, ...p.extraHeaders },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((m) => String(m.id || m.name || "")).filter(Boolean).sort();
  } catch {
    return [];
  }
}
