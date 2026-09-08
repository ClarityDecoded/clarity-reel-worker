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

// Skill routing lives in routing.mjs — browser-safe, so the lab can show what
// production actually runs rather than a hand-typed copy that goes stale (the
// NVIDIA default was 410 Gone for twelve days while the docs said otherwise).
// Re-exported here under the name every caller already imports.
// PROFILES is re-exported for the callers that already import it from here;
// the router itself walks profileEntries, which normalises the entry shape.
export { PROFILES } from "./routing.mjs";
import { profileEntries } from "./routing.mjs";

// Per-provider live state for this run (module-level = lives for the whole job).
// `dead` holds MODEL IDS, not capabilities. It used to hold the capability, which
// was fine while a provider appeared at most once in a chain — but OCR now lists
// two OpenAI models, and killing "vision" on the first one's 404 would silently
// take the second link down with it. The 404 is about a model; record the model.
const health = new Map(); // name -> { coolUntil, lastUsed, calls, fails, dead:Set<modelId> }
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

// Order the candidate LINKS for a task: healthy first, then skill preference,
// then global priority, then least-recently-used to spread the load.
//
// A LINK is one (provider, model) pair, not a provider — because a chain may
// name the same provider twice with different models (PROFILES.ocr does). Health
// state stays keyed by provider NAME, which is right: a rate limit is on the
// account, not the model. Only `dead` is per model.
function orderFor(task, capability, now) {
  const pref = profileEntries(task);
  const named = new Set(pref.map((e) => e.provider));
  const byName = new Map(getProviders().map((p) => [p.name, p]));

  const links = [];
  const seen = new Set();
  const add = (p, model, rank) => {
    if (!p || !model) return;
    const id = `${p.name}:${model}`;
    if (seen.has(id)) return;                 // the same link listed twice
    seen.add(id);
    if (stat(p.name).dead.has(model)) return; // this exact model 404'd this run
    links.push({ p, model, rank });
  };

  // The profile's own order comes first, entry by entry.
  pref.forEach((e, i) => add(byName.get(e.provider), e.model || byName.get(e.provider)?.models[capability], i));
  // A capable provider the profile does not name is still reachable, ranked by
  // its global priority behind everything named — unchanged behaviour.
  for (const p of getProviders()) {
    if (named.has(p.name)) continue;
    add(p, p.models[capability], pref.length + p.priority);
  }

  return links.sort((a, b) => {
    const ca = stat(a.p.name).coolUntil > now ? 1 : 0;
    const cb = stat(b.p.name).coolUntil > now ? 1 : 0;
    if (ca !== cb) return ca - cb;                          // healthy before cooling
    if (a.rank !== b.rank) return a.rank - b.rank;          // skill/priority preference
    return stat(a.p.name).lastUsed - stat(b.p.name).lastUsed; // spread load
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
  const ready = candidates.filter((l) => stat(l.p.name).coolUntil <= now);
  if (ready.length === 0) {
    const soonest = candidates.reduce((a, b) => (stat(a.p.name).coolUntil < stat(b.p.name).coolUntil ? a : b));
    const err = new Error(
      `All providers cooling for ${capability} (task=${task}) — soonest back is ${soonest.p.name} in ` +
      `${Math.max(0, stat(soonest.p.name).coolUntil - now)}ms`,
    );
    err.status = 503; // temporary, not permanent — isTransient (retry.mjs) must re-queue, not bury, the item
    throw err;
  }

  let lastErr;
  for (const link of ready) {
    const { p, model } = link;
    const s = stat(p.name);
    try {
      const res = await withRetry(
        () => callOnce(p, { capability, messages, json, maxTokens, timeoutMs, modelOverride: model }),
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
      // Name the MODEL in the failover line, not just the provider: with two
      // OpenAI links in the OCR chain, "served by openai (failover)" no longer
      // says which one answered.
      if (candidates.indexOf(link) > 0) console.log(`[router] ${task}/${capability} served by ${p.name} ${model} (failover)`);
      return res.content;
    } catch (e) {
      s.fails++; lastErr = e;
      if (isModelUnavailable(e)) {
        // Disable THIS MODEL for the rest of the run, not the provider's whole
        // capability — the next link may be the same provider on a live model.
        s.dead.add(model);
        console.warn(`[router] ${p.name} ${model} is gone — that model is disabled for this run: ${e.message}`);
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
