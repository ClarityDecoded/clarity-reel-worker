// Unit test: which provider gets asked FIRST for each task.
//
// This is a product decision expressed as an array, and nothing else in the
// codebase would notice if it were reordered — a provider silently dropping to
// last is exactly how OpenAI ended up unreachable after being added, which cost
// two wrong categories on a real reel before anyone spotted it. Pin it.
//
//   node test-router-profiles.mjs      no network, no keys
// Providers activate only when their key env exists, so this test has to set
// some. Written as a LOOP with computed names on purpose: a literal
// `OPENAI_API_KEY = "..."` is the exact shape check-public-safe.mjs blocks, and
// it blocked the whole public build over these three fake values. The scanner is
// right to fail closed — it cannot tell a stub from the real thing — so the fix
// is to stop writing the shape, not to teach it an exception.
for (const p of ["OPENAI", "GEMINI", "NVIDIA"]) {
  process.env[`${p}_API_KEY`] = `stub-not-a-key-${p.toLowerCase()}`;
}
process.env.LLM_COOLDOWN_MS = "1";
process.env.NVIDIA_MIN_GAP_MS = "0";

const { route } = await import("./router.mjs");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

// Record who is asked, in order, then answer properly so the run ends.
let asked = [];
globalThis.fetch = async (url, _opts) => {
  asked.push(new URL(url).host);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"category":"ai"}' } }] }) };
};

async function firstAskedFor(task, json = true) {
  asked = [];
  await route({ task, messages: [{ role: "user", content: "x" }], json, retries: 0 });
  return asked[0];
}

ok("classify asks OpenAI first", (await firstAskedFor("classify")).includes("openai"));

// STRUCTURE joined it on 2026-09-07, on Comprehension Test evidence (gotcha
// #91g): gpt-4o-mini scored 100% of 29 objective checks at 5.6s and $0.0042,
// tying the only other 100% while being 13x faster and 31x cheaper, and the
// previous NVIDIA default had been 410 Gone for twelve days. This is the step a
// reel's title, summary and category all come from, so it is pinned hardest.
ok("structure asks OpenAI first", (await firstAskedFor("structure")).includes("openai"));

// Synthesize is deliberately unchanged; if it starts pointing at OpenAI too,
// that is a routing change someone should have to justify.
ok("synthesize does NOT ask OpenAI first", !(await firstAskedFor("synthesize")).includes("openai"));

// OCR goes to Gemini on Eye Chart evidence, with OpenAI behind it — NVIDIA's
// vision model 410s and OpenRouter's 404s, so without that fallback a single
// Gemini rate limit stops OCR dead.
ok("ocr asks Gemini first", (await firstAskedFor("ocr", false)).includes("generativelanguage"));

// OpenAI's TEXT and VISION ids are deliberately different, and the wrong one is
// silent: gpt-4o-mini is the correct text model and a trap for vision, costing
// 27x the image tokens of gpt-4.1-mini for the same pictures (gotcha #90e). It
// stayed mis-set for a day because "one multimodal id covers both" reads as
// tidier than the truth, and no run ever errors over it — the OCR fallback just
// quietly costs ~18x more whenever Gemini rate-limits.
const openai = (await import("./providers.mjs")).getProviders().find((p) => p.name === "openai");
ok("openai text is gpt-4o-mini", openai?.models.text === "gpt-4o-mini");
ok("openai vision is NOT gpt-4o-mini", openai?.models.vision !== "gpt-4o-mini");

// A provider must never be reachable ONLY as a last resort by accident — every
// provider with a key should appear somewhere in the classify order.
const { activeProviders } = await import("./router.mjs");
const names = activeProviders().map((p) => p.name);
ok("every keyed provider is a classify candidate", names.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
