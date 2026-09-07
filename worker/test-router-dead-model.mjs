// Unit test: a provider whose MODEL is gone (404 / "no longer available") gets
// disabled for the rest of the run, instead of being retried on every call.
//
// This is the regression that cost 105 wasted round trips in one process run
// (Gemini retired gemini-2.5-flash; every OCR frame tried it, 404'd, and failed
// over to NVIDIA) and pushed that run into the 30-minute workflow timeout.
//
// No network, no DB, no real keys: global fetch is stubbed.
//   node test-router-dead-model.mjs

process.env.GEMINI_API_KEY = "test-gemini";
process.env.NVIDIA_API_KEY = "test-nvidia";
process.env.LLM_COOLDOWN_MS = "1";
process.env.NVIDIA_MIN_GAP_MS = "0";

const calls = [];
globalThis.fetch = async (url, opts) => {
  const model = JSON.parse(opts.body).model;
  const host = new URL(url).host;
  calls.push(host);
  if (host.includes("googleapis")) {
    return new Response(
      JSON.stringify({ error: { code: 404, message: `This model models/${model} is no longer available to new users.` } }),
      { status: 404 },
    );
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
};

const { route } = await import("./router.mjs");

let failed = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : `  got=${JSON.stringify(got)}`}`);
  if (!cond) failed++;
}

const ask = () =>
  route({ task: "ocr", capability: "vision", messages: [{ role: "user", content: "hi" }], retries: 0 });

// Gemini is first in the OCR profile, so call 1 tries it, 404s, fails over.
const first = await ask();
check("first call still succeeds via failover", first === "ok", first);
const geminiFirst = calls.filter((h) => h.includes("googleapis")).length;
check("gemini was tried exactly once", geminiFirst === 1, geminiFirst);

// Calls 2..5 must skip Gemini entirely — that's the whole point.
for (let i = 0; i < 4; i++) await ask();
const geminiTotal = calls.filter((h) => h.includes("googleapis")).length;
check("gemini never tried again after its model 404'd", geminiTotal === 1, geminiTotal);
check("all 5 calls served", calls.filter((h) => !h.includes("googleapis")).length === 5, calls.length);

// A 410 (retired model, e.g. NVIDIA pulling nemotron-nano-vl) is a permanent
// per-run kill too, not just 404 — this is the exact shape that stalled
// reel-process for days: NVIDIA 410'd on every OCR frame and was retried
// every time anyway, burning the run into the 1-hour timeout.
delete process.env.GEMINI_API_KEY; // isolate to nvidia so the mock can't be masked by gemini succeeding first
process.env.OPENROUTER_API_KEY = "test-openrouter"; // second vision candidate so failover has somewhere to land
const calls2 = [];
globalThis.fetch = async (url, _opts) => {
  const host = new URL(url).host;
  calls2.push(host);
  if (host.includes("integrate.api.nvidia.com")) {
    return new Response(JSON.stringify({ error: { message: "model retired" } }), { status: 410 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
};
const { route: route2 } = await import(`./router.mjs?cachebust=${Date.now()}`);
const ask2 = () =>
  route2({ task: "ocr", capability: "vision", messages: [{ role: "user", content: "hi" }], retries: 0 });
await ask2();
const nvidiaFirst = calls2.filter((h) => h.includes("nvidia")).length;
check("nvidia was tried exactly once after 410", nvidiaFirst === 1, nvidiaFirst);
for (let i = 0; i < 4; i++) await ask2();
const nvidiaTotal = calls2.filter((h) => h.includes("nvidia")).length;
check("nvidia never tried again after its model 410'd", nvidiaTotal === 1, nvidiaTotal);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
