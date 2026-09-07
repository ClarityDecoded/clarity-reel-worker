// Does a given resolver tier actually work from THIS machine?
//
// The whole point of the yt-dlp tier is one unknown: Instagram rate-limits
// datacenter IPs, and GitHub Actions runs on Azure ranges. This answers that
// with data instead of argument. It touches NOTHING — no Supabase, no queue, no
// downloads beyond asking for the url.
//
//   node probe-resolver.mjs "<reel-url>" ["<reel-url-2>" …]
//   RESOLVER_ORDER=ytdlp node probe-resolver.mjs "<url>"

process.env.SUPABASE_URL ||= "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub";
process.env.RESEND_API_KEY ||= "stub";
process.env.OWNER_EMAIL ||= "stub@example.com";

// Public repo = public run logs. No-op unless PUBLIC_LOGS=1. Imported late on
// purpose: the env stubs above must be set before any worker module loads.
const { installPrivateLogging } = await import("./log-privacy.mjs");
installPrivateLogging();

const urls = process.argv.slice(2).filter(Boolean);
if (!urls.length) {
  console.error('Usage: node probe-resolver.mjs "<instagram-reel-url>" ["<url2>" …]');
  process.exit(1);
}

const { resolverOrder } = await import("./resolve.mjs");
const { ytDlpAvailable, resolveViaYtDlp } = await import("./resolve-ytdlp.mjs");
const { resolveViaRapidApi, rapidApiConfigured } = await import("./resolve.mjs");

const order = resolverOrder();
console.log(`RESOLVER_ORDER = ${order.join(", ") || "(none)"}`);
console.log(`yt-dlp installed: ${await ytDlpAvailable()}`);
console.log(`rapidapi configured: ${rapidApiConfigured()}\n`);

const tiers = {
  ytdlp: resolveViaYtDlp,
  rapidapi: resolveViaRapidApi,
};

let anyWorked = false;
for (const url of urls) {
  console.log(`── ${url}`);
  for (const name of order) {
    const t0 = Date.now();
    try {
      const out = await tiers[name](url);
      const ms = Date.now() - t0;
      if (out?.videoUrl) {
        anyWorked = true;
        console.log(`   ✓ ${name} (${ms}ms)`);
        console.log(`     video    ${String(out.videoUrl).slice(0, 100)}`);
        console.log(`     author   ${out.author || "(none)"}`);
        console.log(`     thumb    ${out.thumbnail ? "yes" : "no"}`);
        console.log(`     caption  ${out.caption ? JSON.stringify(out.caption.slice(0, 80)) : "(empty)"}`);
      } else {
        console.log(`   ✗ ${name} (${ms}ms) — resolved but no playable url`);
      }
    } catch (e) {
      console.log(`   ✗ ${name} (${Date.now() - t0}ms) — ${e?.message || e}`);
    }
  }
  console.log("");
}

// Two different urls must return DIFFERENT videos, or the provider is a mock
// (the vetting rule in REEL-TOOL.md).
console.log(anyWorked ? "At least one tier resolved. Compare the video urls across inputs — identical urls mean a mock provider."
                      : "No tier resolved anything.");
