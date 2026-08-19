// resolve.mjs pulls in config.mjs, which demands the real worker env at import.
// None of it is used here — this file is pure logic, no network and no DB — but
// the module has to load. Stub them so the test runs from a clean checkout.
process.env.SUPABASE_URL ||= "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub";
process.env.NVIDIA_API_KEY ||= "stub";

const { isTransient, isNetworkError, withRetry } = await import("./retry.mjs");
const { normalizeInstagramUrl } = await import("./resolve.mjs");

const eq = (a,b,l) => console.log((JSON.stringify(a)===JSON.stringify(b)?"PASS":"FAIL <<<<")+" "+l+"  got="+JSON.stringify(a));

// The two real 2026-07-24 failures
eq(isTransient(new Error("fetch failed")), true, "undici 'fetch failed' is transient");
const nv = new Error('NVIDIA meta/llama-3.3-70b-instruct 503: {"error":{"message":"ResourceExhausted: Worker local total request limit reached (28/16)"}}');
eq(isTransient(nv), true, "NVIDIA 503 (message-parsed) is transient");
nv.status = 503; eq(isTransient(nv), true, "NVIDIA 503 (status field) is transient");

// Must NOT loop forever
eq(isTransient(new Error("PRIVATE_OR_UNAVAILABLE")), false, "private reel is permanent");
const ex = new Error("x"); ex.code = "ALL_RESOLVERS_EXHAUSTED";
eq(isTransient(ex), false, "resolver exhaustion is not item-transient");
const e401 = new Error("NVIDIA foo 401: bad key"); e401.status = 401;
eq(isTransient(e401), false, "401 bad key is permanent");
eq(isTransient(new Error("No readable content (no speech, on-screen text, or caption).")), false, "empty reel is permanent");
// model names with digits must not be misread as statuses
eq(isTransient(new Error("NVIDIA meta/llama-3.3-70b-instruct 200 ok")), false, "no false status match from model name");

// URL normalization
eq(normalizeInstagramUrl("https://instagram.com/p/DaLiYhuqpOC"), "https://www.instagram.com/p/DaLiYhuqpOC/", "bare host -> www, trailing slash");
eq(normalizeInstagramUrl("https://www.instagram.com/reel/DSc4uYfCkN4"), "https://www.instagram.com/reel/DSc4uYfCkN4/", "reel untouched");
eq(normalizeInstagramUrl("https://www.instagram.com/reels/ABC/?igsh=xyz&img_index=1"), "https://www.instagram.com/reel/ABC/", "reels->reel, tracking stripped");
eq(normalizeInstagramUrl("not a url"), "not a url", "garbage passes through");
eq(normalizeInstagramUrl("https://tiktok.com/x"), "https://tiktok.com/x", "non-instagram untouched");

// withRetry actually retries then succeeds
let n = 0;
const v = await withRetry(async () => { if (++n < 3) throw new Error("fetch failed"); return "ok"; }, { tries: 4, baseMs: 5, label: "test" });
eq([v, n], ["ok", 3], "withRetry recovers on 3rd attempt");
// ...and gives up immediately on a permanent error
let m = 0;
try { await withRetry(async () => { m++; throw new Error("PRIVATE_OR_UNAVAILABLE"); }, { tries: 4, baseMs: 5 }); } catch {}
eq(m, 1, "withRetry does not retry permanent errors");
