// Unit tests for the public-log filter (no network, no DB, no keys):
//   node worker/test-log-privacy.mjs
//
// The cases below are REAL log lines from this worker, because the only thing
// worth asserting is that an actual run's output comes out non-identifying. A
// filter that passes on invented strings and leaks on the ones the worker
// really prints is worse than none — it reads as protection.

import { redact, installPrivateLogging } from "./log-privacy.mjs";

let pass = 0;
const fail = [];
const check = (name, cond) => (cond ? pass++ : fail.push(name));
const clean = (name, out, ...banned) => {
  const leaked = banned.filter((b) => out.includes(b));
  check(name + (leaked.length ? ` — leaked: ${leaked.join(", ")}` : ""), leaked.length === 0);
};

// --- the lines process-queue.mjs actually prints ------------------------
{
  const out = redact('✓ https://www.instagram.com/reel/DAbC123xyz/ → recipe: Miso Butter Salmon');
  clean("processed line hides the reel url", out, "instagram.com", "DAbC123xyz");
  check("processed line keeps its shape", out.includes("✓") && out.includes("recipe"));
}
{
  const out = redact("✗ https://www.instagram.com/reel/DAbC123xyz/: We couldn't access this Reel. Make sure it's public.");
  clean("failure line hides the url", out, "instagram.com", "DAbC123xyz");
  check("failure line keeps the reason", /Make sure it's public/.test(out));
}
{
  const out = redact("↻ https://instagram.com/reel/X/: fetch failed — re-queued (attempt 2/3)");
  clean("requeue line hides the url", out, "instagram.com");
  check("requeue line keeps the attempt count", out.includes("(attempt 2/3)"));
}

// --- the lines the backfills print --------------------------------------
{
  const out = redact('✓ 8f2b… "How I made $35k a month with one funnel" → 3 entities, 2 verified link(s)');
  clean("backfill line hides the title", out, "How I made", "funnel");
  check("backfill line keeps the counts", out.includes("3 entities") && out.includes("2 verified link(s)"));
}
{
  const out = redact("   universal point: Distribution you rent can be taken away; an audience you own cannot.");
  clean("labelled content is dropped", out, "Distribution", "audience");
  check("label itself survives", /universal point:/.test(out));
}
{
  const out = redact("      proposed: https://github.com/someone/their-tool, https://example.com/x");
  clean("proposed links are dropped", out, "github.com", "example.com");
}

// --- other identifying detail -------------------------------------------
{
  const out = redact("Digest sent to owner@example.com (12 reels)");
  clean("email addresses go", out, "owner@example.com", "example.com");
  check("count survives", out.includes("(12 reels)"));
}
{
  const out = redact("Resolver keys loaded: 3");
  check("operational lines are untouched", out === "Resolver keys loaded: 3");
}
{
  const out = redact("[router] gemini rate-limited → next provider");
  check("router diagnostics survive", out === "[router] gemini rate-limited → next provider");
}
{
  const out = redact("24 distinct frame(s) to OCR");
  check("pipeline counters survive", out === "24 distinct frame(s) to OCR");
}

// --- errors carry urls in their message ----------------------------------
{
  check("non-strings pass through", redact(42) === 42);
  check("undefined passes through", redact(undefined) === undefined);
}

// --- the switch ----------------------------------------------------------
{
  check("off by default", installPrivateLogging(false) === false);
  const original = console.log;
  const seen = [];
  console.log = (...a) => seen.push(a.join(" "));
  const on = installPrivateLogging(true);
  console.log("✗ https://www.instagram.com/reel/SECRET/: nope");
  const captured = seen.join("\n");
  console.log = original;
  check("install returns true when enabled", on === true);
  clean("patched console redacts", captured, "SECRET", "instagram.com");
  check("install announces itself", /PUBLIC_LOGS=1/.test(captured));
}

console.log(`${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
