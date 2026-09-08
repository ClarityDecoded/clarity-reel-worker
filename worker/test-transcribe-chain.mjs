// Unit test: transcription's CHAIN — the first model that answers wins, and a
// failed link falls through to the next instead of costing the reel.
//
// Transcription does not go through the router, so none of the router tests
// cover it. It ran as a chain of ONE until 2026-09-08: a retired or capacity
// limited Whisper model meant the night's reels simply had no transcript, which
// is the failure NVIDIA's dead default already cost this codebase once (#57) —
// invisible precisely because everything around it keeps reporting success.
//
// Both links are Groq today, so this is deliberately NOT a test that failover
// crosses providers. What it pins is the behaviour that has to hold either way:
// order, fall-through, the endpoint skip, and that a total failure still throws
// the real error so isTransient can re-queue the reel (#25).
//
//   node test-transcribe-chain.mjs      no network, no keys, no DB
process.env.SUPABASE_URL = "https://example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sr";
process.env.GROQ_API_KEY = "g1";

import { writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const { transcribe } = await import("./nvidia.mjs");
const { TRANSCRIPTION } = await import("./routing.mjs");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  c ? pass++ : fail++;
  console.log((c ? "PASS " : "FAIL ") + n + (c || !extra ? "" : "  — " + extra));
};

const dir = await mkdtemp(path.join(os.tmpdir(), "asr-"));
const wav = path.join(dir, "a.wav");
await writeFile(wav, Buffer.from("RIFF"));

// A stub standing in for Groq. `answers` maps a model id to what it does.
const asked = [];
const stub = (answers) => async (url, opts) => {
  const model = opts.body.get("model");
  asked.push(model);
  const a = answers[model];
  if (typeof a === "number") {
    return { ok: false, status: a, text: async () => "nope" };
  }
  return { ok: true, status: 200, json: async () => a };
};
const body = { text: "hello there", segments: [{ start: 0, end: 1, text: "hello there" }] };

console.log("\nThe chain is walked in order");
{
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: body });
  const out = await transcribe(wav);
  ok("the primary is asked first", asked[0] === TRANSCRIPTION[0].model, "asked " + asked[0]);
  ok("a working primary is the only call", asked.length === 1, asked.join(","));
  ok("its transcript is returned", out.text === "hello there");
  ok("its segments survive", out.segments.length === 1 && out.segments[0].text === "hello there");
}

console.log("\nA dead model falls through to the next one");
{
  asked.length = 0;
  // 410 Gone is the exact shape that killed NVIDIA's default: permanent, and
  // identical on every call, so retrying in place would never recover.
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: 410, [TRANSCRIPTION[1].model]: body });
  const out = await transcribe(wav);
  ok("the backup is asked after the primary fails", asked.includes(TRANSCRIPTION[1].model));
  ok("the reel still gets a transcript", out.text === "hello there");
  ok("the primary was tried first, not skipped", asked[0] === TRANSCRIPTION[0].model);
}

console.log("\nEvery link failing still fails the way the queue expects");
{
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: 410, [TRANSCRIPTION[1].model]: 503 });
  let err = null;
  try { await transcribe(wav); } catch (e) { err = e; }
  ok("it throws rather than returning an empty transcript", !!err);
  // The LAST error is rethrown, not a summary of them: isTransient reads
  // err.status to decide whether the reel goes back to `queued` or is buried,
  // and a wrapped "all links failed" string would bury a recoverable 503.
  ok("the real status survives for isTransient", err && err.status === 503,
    "got " + (err && err.status));
  const { isTransient } = await import("./retry.mjs");
  ok("a 503 on every link is still re-queueable", isTransient(err));
}

console.log("\nA link we hold no endpoint for is skipped, never misrouted");
{
  // Posting an OpenAI model id at Groq gets a 400 that reads exactly like the
  // model being broken, so the endpoint has to gate the link.
  const { config } = await import("./config.mjs");
  const saved = config.transcription.models;
  config.transcription.models = [
    { provider: "openai", model: "whisper-1" },
    ...saved,
  ];
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: body });
  const out = await transcribe(wav);
  ok("the unconfigured provider is never called", !asked.includes("whisper-1"), asked.join(","));
  ok("the configured link still answers", out.text === "hello there");

  // And with NOTHING configured it must fail loudly rather than post at whatever
  // base happens to be set.
  config.transcription.models = [{ provider: "openai", model: "whisper-1" }];
  let err = null;
  try { await transcribe(wav); } catch (e) { err = e; }
  ok("no usable link is an error, not a silent empty transcript", !!err);
  config.transcription.models = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
