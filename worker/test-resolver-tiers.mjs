// Unit test for the resolver TIER logic — no network, no keys, no yt-dlp.
//
// The precedence rules matter more than they look: process-queue and isTransient
// key off exactly three signals (gotchas #25/#26), and getting them wrong either
// buries a live reel forever or retries a dead one until MAX_ATTEMPTS.
//
//   node worker/test-resolver-tiers.mjs

// config.mjs demands the real worker env at import time; these are never used
// because every tier is stubbed, but they have to exist for the module to load.
process.env.SUPABASE_URL ||= "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub";
process.env.NVIDIA_API_KEY ||= "stub";
process.env.RESEND_API_KEY ||= "stub";
process.env.OWNER_EMAIL ||= "stub@example.com";

const { RESOLVER_TIERS, resolveReel, AllResolversExhausted } = await import("./resolve.mjs");

const real = { ...RESOLVER_TIERS };
let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("  ok  ", name);
  else { fails++; console.log("  FAIL", name, extra ?? ""); }
};

// Replace both tiers with stubs we control.
function stub(rapid, ytdlp) {
  RESOLVER_TIERS.rapidapi = { available: () => rapid !== "absent", resolve: async () => behave(rapid) };
  RESOLVER_TIERS.ytdlp = { available: () => ytdlp !== "absent", resolve: async () => behave(ytdlp) };
}
function behave(kind) {
  if (kind === "ok") return { videoUrl: "https://cdn/v.mp4", caption: "c", thumbnail: "t", author: "a" };
  if (kind === "empty") return { videoUrl: null };
  if (kind === "exhausted") throw new AllResolversExhausted();
  if (kind === "private") throw new Error("PRIVATE_OR_UNAVAILABLE");
  if (kind === "blocked") throw new Error("yt-dlp BLOCKED: login required");
  throw new Error("boom");
}
async function attempt(order, rapid, ytdlp) {
  process.env.RESOLVER_ORDER = order;
  stub(rapid, ytdlp);
  try { return { ok: await resolveReel("https://www.instagram.com/reel/abc/") }; }
  catch (e) { return { err: e }; }
}

console.log("--- default order is unchanged behaviour ---");
delete process.env.RESOLVER_ORDER;
stub("ok", "ok");
check("default = rapidapi only", (await resolveReel("https://www.instagram.com/reel/a/")).videoUrl.includes("cdn"));

console.log("--- failover ---");
let r = await attempt("ytdlp,rapidapi", "ok", "blocked");
check("yt-dlp blocked -> falls back to rapidapi", !!r.ok?.videoUrl, r.err?.message);
r = await attempt("ytdlp,rapidapi", "exhausted", "ok");
check("yt-dlp works even when rapidapi quota is gone", !!r.ok?.videoUrl, r.err?.message);
r = await attempt("ytdlp,rapidapi", "ok", "empty");
check("a tier returning no url falls through", !!r.ok?.videoUrl, r.err?.message);

console.log("--- precedence when everything fails ---");
r = await attempt("ytdlp,rapidapi", "exhausted", "blocked");
check("quota exhaustion surfaces (triggers the add-a-key email)",
  r.err?.code === "ALL_RESOLVERS_EXHAUSTED", r.err?.message);
r = await attempt("ytdlp,rapidapi", "exhausted", "private");
check("exhaustion BEATS private — never bury a reel the paid tier never saw",
  r.err?.code === "ALL_RESOLVERS_EXHAUSTED", r.err?.message);
r = await attempt("ytdlp,rapidapi", "private", "private");
check("both say private -> PRIVATE_OR_UNAVAILABLE (permanent, not retried)",
  r.err?.message === "PRIVATE_OR_UNAVAILABLE", r.err?.message);
r = await attempt("ytdlp,rapidapi", "boom", "blocked");
check("generic failures stay transient (re-queued)",
  /Resolver failed/.test(r.err?.message || ""), r.err?.message);

console.log("--- config guards ---");
r = await attempt("ytdlp", "absent", "absent");
check("nothing available -> configuration error", /not configured/i.test(r.err?.message || ""), r.err?.message);
r = await attempt("nonsense", "ok", "ok");
check("unknown name -> names no known resolver", /no known resolver/.test(r.err?.message || ""), r.err?.message);
r = await attempt("ytdlp,rapidapi", "ok", "absent");
check("yt-dlp missing -> rapidapi still serves", !!r.ok?.videoUrl, r.err?.message);

Object.assign(RESOLVER_TIERS, real);
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
