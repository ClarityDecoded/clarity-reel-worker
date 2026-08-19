// Standalone resolver smoke test — validates RAPIDAPI_HOST + RAPIDAPI_URL_TEMPLATE
// without running the whole pipeline (no Supabase/NVIDIA/Groq needed).
//
// 1. Put RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_URL_TEMPLATE in worker/.env
// 2. cd worker && node --env-file=.env test-resolve.mjs "https://www.instagram.com/reel/XXXXX/"
//
// It prints the RAW provider response first (so you can see the real field
// shape), then what resolveReel() extracted from it.

// config.mjs requires a few unrelated keys at import — stub them so a pure
// resolver test needs only the RAPIDAPI_* vars.
process.env.SUPABASE_URL ||= "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub";
process.env.NVIDIA_API_KEY ||= "stub";

const url = process.argv[2];
if (!url) {
  console.error('Usage: node --env-file=.env test-resolve.mjs "<instagram-reel-url>"');
  process.exit(1);
}

const key = process.env.RAPIDAPI_KEY;
const host = process.env.RAPIDAPI_HOST;
const template = process.env.RAPIDAPI_URL_TEMPLATE;
if (!key || !host || !template) {
  console.error("Missing RAPIDAPI_KEY / RAPIDAPI_HOST / RAPIDAPI_URL_TEMPLATE in .env");
  process.exit(1);
}

const endpoint = template.replace("{url}", encodeURIComponent(url));
console.log("→ GET", endpoint);
console.log("  host:", host, "\n");

const raw = await fetch(endpoint, {
  headers: { "x-rapidapi-key": key, "x-rapidapi-host": host },
});
console.log("HTTP", raw.status, raw.statusText);
const text = await raw.text();
let json;
try { json = JSON.parse(text); } catch { json = null; }
console.log("\n=== RAW RESPONSE ===");
console.log(json ? JSON.stringify(json, null, 2).slice(0, 4000) : text.slice(0, 2000));

// Now run the real normalizer.
const { resolveReel } = await import("./resolve.mjs");
console.log("\n=== resolveReel() OUTPUT ===");
try {
  const out = await resolveReel(url);
  console.log(JSON.stringify(out, null, 2));
  console.log(out.videoUrl ? "\n✅ videoUrl found — resolver works." : "\n❌ no videoUrl extracted.");
} catch (e) {
  console.error("resolveReel failed:", e.message);
  console.error("\nIf the RAW response above HAS a video URL but this failed, the normalizer\nin resolve.mjs needs a field added — paste the RAW shape and I'll fix it.");
  process.exit(1);
}
