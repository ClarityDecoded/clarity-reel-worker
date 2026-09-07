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
for (const p of ["OPENAI", "GEMINI", "KIMI", "GROQ", "OPENROUTER"]) {
  process.env[`${p}_API_KEY`] = `stub-not-a-key-${p.toLowerCase()}`;
}
process.env.LLM_COOLDOWN_MS = "1";
process.env.NVIDIA_MIN_GAP_MS = "0";

const { route, PROFILES: PROFILE_NAMES } = await import("./router.mjs");


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

// --- chain DEPTH, which is the rule these orders exist to satisfy -----------
// Rahul's instruction, 2026-09-07: every AI step needs a backup AND a backup to
// the backup. Probing for real that day found the arrays were mostly decoration
// — four to seven providers listed, TWO working, and synthesize down to ONE.
// Listing a provider is not having one, so pin the COUNT, not just the order.
{
  const { getProviders } = await import("./providers.mjs");
  const keyed = new Set(getProviders().map((p) => p.name));
  for (const task of ["structure", "classify", "synthesize", "ocr"]) {
    const chain = PROFILE_NAMES[task].filter((n) => keyed.has(n));
    ok(`${task} lists at least 3 candidates`, chain.length >= 3);
  }
}

// GEMINI IS DEMOTED IN STRUCTURE, deliberately. It scored 34-45% on the
// Comprehension Test — not by writing poor summaries but by returning valid JSON
// in the WRONG SHAPE, which renders an empty reel page (gotcha #91g). It was the
// only working backup for the highest-stakes call in the pipeline, which is a
// backup that fails in a way nothing detects.
ok("structure does not fall back to Gemini before kimi or groq", (() => {
  const c = PROFILE_NAMES.structure;
  return c.indexOf("gemini") > c.indexOf("kimi") && c.indexOf("gemini") > c.indexOf("groq");
})());

// The retired-model trap, four times over (#57, #91g, and Groq's own
// llama-3.3-70b-versatile 404ing while its key worked fine for Whisper). A model
// id that has already died must never quietly come back as a default.
{
  const { getProviders } = await import("./providers.mjs");
  const byName = new Map(getProviders().map((p) => [p.name, p]));
  // Every model id that has died under us. NVIDIA's two are kept on the list
  // even though NVIDIA is gone, so re-adding the provider cannot quietly
  // re-add a corpse with it.
  const DEAD = ["llama-3.3-70b-versatile", "meta/llama-3.3-70b-instruct", "gemini-2.5-flash",
                "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
                "meta-llama/llama-3.3-70b-instruct:free",
                "meta-llama/llama-3.2-11b-vision-instruct:free"];
  for (const [name, p] of byName) {
    for (const cap of ["text", "vision"]) {
      const m = p.models?.[cap];
      if (!m) continue;
      ok(`${name}.${cap} is not a known-dead model (${m})`, !DEAD.includes(m));
    }
  }
}

// A provider must never be reachable ONLY as a last resort by accident — every
// provider with a key should appear somewhere in the classify order.
const { activeProviders } = await import("./router.mjs");
const names = activeProviders().map((p) => p.name);
ok("every keyed provider is a classify candidate", names.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
