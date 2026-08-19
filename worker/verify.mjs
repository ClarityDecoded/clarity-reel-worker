// Link verification for extracted entities.
//
// The LLM has no web access, so it PROPOSES official links from memory (reliable
// for well-known repos, but it can hallucinate a repo path). This is the guard
// the brief demands: "never let the model output unverified URLs." Every link
// the model emits is actually fetched here; anything that doesn't resolve is
// dropped, and an entity left with no surviving link is flagged needsLink so the
// UI shows "search for this" instead of a wrong link.
//
// This runs in the worker (plain Node fetch on GitHub Actions), not the model.

const TIMEOUT_MS = Number(process.env.LINK_VERIFY_TIMEOUT_MS || 8000);
const MAX_CONCURRENT = Number(process.env.LINK_VERIFY_CONCURRENCY || 4);

// A desktop-ish UA — some hosts (GitHub included) 403 an empty/agent-less request.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u; // model sometimes drops the scheme
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// One live check. Try HEAD first (cheap), fall back to GET when a host rejects
// HEAD (405/403/501) — many do. Redirects are followed by default; a final 2xx
// (or a 3xx that fetch couldn't follow) counts as resolved.
async function urlResolves(url) {
  for (const method of ["HEAD", "GET"]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": UA, "Accept": "*/*" },
      });
      if (res.ok) return true;                 // 2xx after any redirects
      if (res.status >= 300 && res.status < 400) return true; // resolved, just not auto-followed
      // HEAD refused? try GET. Otherwise it's a real 4xx/5xx — dead link.
      if (method === "HEAD" && [403, 405, 501].includes(res.status)) continue;
      return false;
    } catch {
      // Network throw / timeout — on HEAD, give GET a chance; on GET, it's dead.
      if (method === "HEAD") continue;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// Cache within a single run so the same URL across entities is checked once.
async function makeChecker() {
  const cache = new Map();
  return (url) => {
    if (!cache.has(url)) cache.set(url, urlResolves(url));
    return cache.get(url);
  };
}

// Small concurrency gate so a big batch doesn't fan out unbounded.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Verify every link on every entity. Returns a NEW entities array with each
 * entity's `links` filtered to only those that resolved, and `needsLink: true`
 * added when an entity that proposed links ended up with none.
 *
 * Best-effort and non-fatal: any unexpected error leaves entities untouched
 * rather than sinking the item.
 */
export async function verifyEntities(entities) {
  if (!Array.isArray(entities) || !entities.length) return entities || [];
  try {
    const check = await makeChecker();

    // Flatten all (entityIndex, link) pairs, dedupe by normalized URL, verify.
    const jobs = [];
    entities.forEach((e, ei) => {
      (Array.isArray(e.links) ? e.links : []).forEach((l) => {
        const url = normalizeUrl(l?.url);
        if (url) jobs.push({ ei, label: l?.label, url });
      });
    });

    const results = await mapLimit(jobs, MAX_CONCURRENT, async (j) => ({
      ...j,
      ok: await check(j.url),
    }));

    const kept = entities.map((e) => ({ ...e, links: [] }));
    for (const r of results) {
      if (r.ok) kept[r.ei].links.push({ label: r.label || "Link", url: r.url });
    }

    return kept.map((e, ei) => {
      const proposed = Array.isArray(entities[ei].links) ? entities[ei].links.length : 0;
      const survived = e.links.length;
      if (proposed > 0 && survived === 0) return { ...e, needsLink: true };
      return e;
    });
  } catch (err) {
    console.warn("Link verification skipped (non-fatal):", err.message);
    return entities;
  }
}

// Exposed for the unit test.
export const _internal = { normalizeUrl, urlResolves };
