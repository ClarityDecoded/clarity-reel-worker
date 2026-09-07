// Unit test: a provider answering with an EMPTY body must count as a failure,
// so the router fails over instead of handing the caller "".
//
// Found live: Gemini returned "" with HTTP 200 for the category classifier.
// route() passed that straight through, JSON.parse blew up on it with
// "Unexpected end of JSON input", classifyCategory swallowed the error, and
// every reel in the run was left Uncategorised — with nothing anywhere naming
// the actual cause. gpt-5 produces the same shape when reasoning consumes the
// whole token budget.
//
//   node test-router-empty.mjs      no network, no keys
process.env.KIMI_API_KEY = "k1";
process.env.OPENAI_API_KEY = "k2";
process.env.LLM_COOLDOWN_MS = "1";
process.env.NVIDIA_MIN_GAP_MS = "0";

const { route, parseLooseJson } = await import("./router.mjs");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

// Whoever is asked FIRST answers blank; the next one answers properly. Written
// this way on purpose: asserting a particular provider is asked first made this test depend
// on the preference order, and it broke the moment classify was pointed at
// OpenAI. What matters here is that a blank answer is not accepted.
const calls = [];
globalThis.fetch = async (url, opts) => {
  const model = JSON.parse(opts.body).model;
  calls.push(model);
  const content = calls.length === 1 ? "   " : '{"category":"ai"}';
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: {} }) };
};

const out = await route({ task: "classify", messages: [{ role: "user", content: "x" }], json: true, retries: 0 });
ok("failed over past the empty answer", out === '{"category":"ai"}');
ok("it moved on to a second provider", calls.length >= 2);
ok("a whitespace-only body counts as empty", calls.length >= 2);

// When EVERY provider is blank, it must throw rather than return "" — a caller
// that gets "" has no way to tell "no answer" from "the answer is nothing".
globalThis.fetch = async () => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }),
});
let threw = false;
try { await route({ task: "classify", messages: [{ role: "user", content: "x" }], retries: 0 }); }
catch { threw = true; }
ok("all-empty throws instead of returning ''", threw);

// ── a json:true answer with no JSON in it ─────────────────────────────────
// Gemini returned the literal string "```json" — an opening markdown fence and
// nothing else. Non-empty, so the empty check waved it through, and the caller
// died on JSON.parse three layers away from the provider that misbehaved.
const seen = [];
globalThis.fetch = async (url, opts) => {
  seen.push(JSON.parse(opts.body).model);
  const content = seen.length === 1 ? "```json" : '{"category":"ai"}';
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};
const j = await route({ task: "classify", messages: [{ role: "user", content: "x" }], json: true, retries: 0 });
ok("a fence with no JSON fails over", j === '{"category":"ai"}');
ok("it moved on past the unusable answer", seen.length >= 2);

// The same junk must be ACCEPTED when the caller did not ask for JSON — the
// router must not invent a contract nobody requested.
globalThis.fetch = async () => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "```json" } }] }),
});
const plain = await route({ task: "classify", messages: [{ role: "user", content: "x" }], retries: 0 });
ok("json:false passes non-JSON through untouched", plain === "```json");

// Real answers wrapped in a fence must still be accepted, not failed over.
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: '```json\n{"category":"seo"}\n```' } }] }),
});
const fenced = await route({ task: "classify", messages: [{ role: "user", content: "x" }], json: true, retries: 0 });
ok("a properly fenced object is accepted", /seo/.test(fenced));
ok("parseLooseJson reads a fenced object", parseLooseJson(fenced).category === "seo");
ok("parseLooseJson reads an UNTERMINATED fence", parseLooseJson('```json\n{"a":1}').a === 1);
ok("parseLooseJson reads prose then an object", parseLooseJson('Sure! {"a":2} hope that helps').a === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
