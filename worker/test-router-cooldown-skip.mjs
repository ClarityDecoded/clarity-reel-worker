// Unit test: once EVERY capable candidate for a task/capability is on
// cooldown, route() must fail fast instead of still calling one anyway.
//
// Cooldown was decorative before this fix — orderFor() sorted a cooling
// provider to the back, but the try/loop in route() still called it with its
// FULL retry budget (5 attempts, exp backoff up to a 20s cap) regardless.
// That's invisible when there's a healthy fallback to fail over to, but once
// NVIDIA and OpenRouter were both marked dead this run (their models were
// retired — 410/404) and Gemini was the SOLE remaining OCR provider with its
// free daily quota exhausted, every OCR frame call still paid Gemini's full
// retry budget (~90s) with nowhere to fail over to. 671 such retries in one
// run is what burned the entire 1-hour job timeout without finishing a
// single item. See CLAUDE.md gotcha #85 / router.mjs's `ready` filter.
//
// No network, no DB, no real keys: global fetch is stubbed.
//   node test-router-cooldown-skip.mjs

// Any keyed provider will do — this suite is about the COOLDOWN, not about
// which provider. It used NVIDIA, which no longer exists (removed 2026-09-07),
// leaving the test with no providers at all and a misleading failure.
process.env.KIMI_API_KEY = "test-kimi";
process.env.LLM_COOLDOWN_MS = "60000"; // real-world default, not the 1ms other tests use
process.env.NVIDIA_MIN_GAP_MS = "0";

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response(
    JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details." } }),
    { status: 429 },
  );
};

const { route } = await import("./router.mjs");

let failed = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : `  got=${JSON.stringify(got)}`}`);
  if (!cond) failed++;
}

const ask = () => route({ task: "structure", messages: [{ role: "user", content: "hi" }], retries: 2, cap: 10 });

// Call 1: NVIDIA is the only candidate, not yet cooling — it gets tried (and
// its own in-place retry budget), then cools down after failing.
let threw1 = false;
try { await ask(); } catch { threw1 = true; }
check("first call actually hits the provider", threw1 && calls > 0, calls);
const callsAfterFirst = calls;

// Call 2: NVIDIA is now cooling and is the ONLY candidate — must fail FAST,
// without calling fetch again, instead of paying the retry budget for
// something we already know just failed.
let threw2 = false;
let msg2 = "";
try { await ask(); } catch (e) { threw2 = true; msg2 = e.message; }
check("second call fails without calling the cooling provider again", threw2 && calls === callsAfterFirst, calls);
check("failure message says why (cooling, not a real provider error)", /cooling/i.test(msg2), msg2);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
