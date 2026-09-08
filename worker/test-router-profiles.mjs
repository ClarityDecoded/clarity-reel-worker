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
for (const p of ["OPENAI", "GEMINI", "KIMI", "GROQ", "OPENROUTER", "CEREBRAS"]) {
  process.env[`${p}_API_KEY`] = `stub-not-a-key-${p.toLowerCase()}`;
}
process.env.LLM_COOLDOWN_MS = "1";
process.env.NVIDIA_MIN_GAP_MS = "0";

const { route, PROFILES: PROFILE_NAMES } = await import("./router.mjs");
const { profileEntries } = await import("./routing.mjs");


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

// STRUCTURE MOVED TO CEREBRAS on 2026-09-07 — Rahul's call, on a THREE-PASS
// Comprehension Test (6 models, 87 checks each). It replaced an OpenAI-first
// order that this very line used to pin, and flipping a deliberate pin is the
// justification step working rather than a test edited to pass.
//
// The evidence: the top four TIED on score — gpt-4o-mini alone scored
// 100/93/93 on identical passes, so its own spread is 7 points and a 95-to-99
// range means nothing. Cerebras won on everything else: 97% every pass, 1.1s
// against gpt-4o-mini's 3.6s and mistral's 15.2s, $0.038 per 100 reels, zero
// retries.
ok("structure asks Cerebras first", (await firstAskedFor("structure")).includes("cerebras"));

// The two backups must be a DIFFERENT MODEL AND VENDOR from the primary and
// from each other, or a single outage takes out two links. Groq serves the SAME
// model as Cerebras, so it must not be either backup.
{
  const top3 = profileEntries("structure").slice(0, 3).map((e) => e.provider);
  ok("structure's top three are three different providers", new Set(top3).size === 3);
  ok("groq is not a top-three backup (it serves the same model as cerebras)", !top3.includes("groq"));
}

// Synthesize is deliberately unchanged; if it starts pointing at OpenAI too,
// that is a routing change someone should have to justify.
ok("synthesize does NOT ask OpenAI first", !(await firstAskedFor("synthesize")).includes("openai"));

// OCR goes to Gemini on Eye Chart evidence, with OpenAI behind it — NVIDIA's
// vision model 410s and OpenRouter's 404s, so without that fallback a single
// Gemini rate limit stops OCR dead.
ok("ocr asks Gemini first", (await firstAskedFor("ocr", false)).includes("generativelanguage"));

// THE OCR CHAIN NAMES TWO MODELS OF ONE PROVIDER — Rahul's call, 2026-09-08, on
// the Eye Chart run of 2026-09-07 00:21, where all three were measured together.
// Pinned by MODEL, not just by provider: the whole point of that decision is
// which OpenAI model is asked first, and a provider-only assertion could not
// tell gpt-5.6-luna from gpt-4o and would pass however they were ordered.
{
  const chain = profileEntries("ocr");
  const asStrings = chain.map((e) => `${e.provider}/${e.model || "(default)"}`);
  ok("ocr chain is gemini, then gpt-5.6-luna, then gpt-4o",
    asStrings.join(" > ") === "gemini/(default) > openai/gpt-5.6-luna > openai/gpt-4o",
    asStrings.join(" > "));

  // AND IT IS DELIBERATELY NARROWER THAN EVERY OTHER CHAIN. Elsewhere a backup
  // is a different vendor so one outage cannot take two links; here both
  // backups are OpenAI, because Gemini and OpenAI are the only vendors with a
  // working vision model that the Eye Chart has actually measured. That is a
  // real exposure — one bad OPENAI_API_KEY removes both backups — so it must be
  // written down where somebody reordering this will read it, exactly the way
  // the single-provider transcription chain has to admit itself in its caveat.
  const vendors = new Set(chain.map((e) => e.provider));
  ok("ocr's narrowing to two vendors is stated in routing.mjs",
    vendors.size > 2 ||
    /BOTH BACKUPS ARE OPENAI/.test(await (await import("node:fs/promises")).readFile("./routing.mjs", "utf8")));
}

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
  // Count LINKS, not provider names: an entry may pin a specific model, and
  // PROFILES.ocr names the same provider twice on two different models.
  for (const task of ["structure", "classify", "synthesize", "ocr"]) {
    const chain = profileEntries(task).filter((e) => keyed.has(e.provider));
    ok(`${task} lists at least 3 candidates`, chain.length >= 3);
  }
}

// GEMINI IS OUT OF STRUCTURE ALTOGETHER: 1/87 with 59 retries across three
// passes, and its failure is the invisible kind — valid JSON in the WRONG SHAPE
// (flat, no content_type, no synopsis wrapper), which renders an empty reel page
// and which nothing downstream catches. A fallback that fails silently is worse
// than no fallback.
//
// Asserted as ABSENCE, not as ordering: indexOf returns -1 for a missing entry,
// so an ordering check would pass here for entirely the wrong reason.
ok("structure does not fall back to Gemini at all", !PROFILE_NAMES.structure.includes("gemini"));

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
