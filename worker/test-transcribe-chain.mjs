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
process.env.OPENAI_API_KEY = "o1";

import { writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const { transcribe, asrConfidence, asrIsPoor } = await import("./nvidia.mjs");
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
// A confident answer and an unconfident one. The numbers are the real measured
// bands: audio a model understands scores about -0.1, invented output about -1.1.
const said = (t) => [{ start: 0, end: 1, text: t, avg_logprob: -0.1 }];
const body = { text: "hello there", language: "English", segments: said("hello there") };
const poor = {
  text: "I have never eaten so much",
  language: "English",            // it is WRONG about this, which is the whole point
  segments: [{ start: 0, end: 1, text: "I have never eaten so much", avg_logprob: -1.06 }],
};
const rescued = {
  text: "इतनी टेस्टी सब्ज़ी",
  language: "Hindi",
  segments: [{ start: 0, end: 1, text: "इतनी टेस्टी सब्ज़ी", avg_logprob: -0.29 }],
};

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
  // Deliberately a provider with NO endpoint entry. whisper-1 used to stand in
  // here and stopped being a valid example the moment OpenAI became a real link
  // in the chain — a fixture that quietly stops testing what it claims to.
  config.transcription.models = [
    { provider: "nowhere", model: "ghost-asr" },
    ...saved,
  ];
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: body });
  const out = await transcribe(wav);
  ok("the unconfigured provider is never called", !asked.includes("ghost-asr"), asked.join(","));
  ok("the configured link still answers", out.text === "hello there");

  // And with NOTHING configured it must fail loudly rather than post at whatever
  // base happens to be set.
  config.transcription.models = [{ provider: "nowhere", model: "ghost-asr" }];
  let err = null;
  try { await transcribe(wav); } catch (e) { err = e; }
  ok("no usable link is an error, not a silent empty transcript", !!err);
  config.transcription.models = saved;
}

console.log("\nA confident transcript is never second-guessed");
{
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: body });
  const out = await transcribe(wav);
  ok("one call, no rescue", asked.length === 1, asked.join(","));
  ok("it reports which model was believed", out.provider === "groq" && out.model === TRANSCRIPTION[0].model);
  ok("the language is lowercased for callers", out.language === "english");
}

console.log("\nAn UNCONFIDENT transcript is re-read by the next model");
{
  // The measured failure: given Hindi, turbo returns fluent invented English
  // AND reports the language as English. Nothing about the response says it is
  // wrong except how little the model believed it.
  asked.length = 0;
  globalThis.fetch = stub({ [TRANSCRIPTION[0].model]: poor, [TRANSCRIPTION[1].model]: rescued });
  const out = await transcribe(wav);
  ok("the primary answered but was not trusted", asked[0] === TRANSCRIPTION[0].model);
  ok("the next model was asked", asked[1] === TRANSCRIPTION[1].model);
  ok("the more confident transcript is kept", out.text === rescued.text, out.text);
  ok("and it is attributed to the model that produced it", out.model === TRANSCRIPTION[1].model);
  ok("a self-reported language cannot be trusted to catch this",
    poor.language.toLowerCase() === "english");
}

console.log("\nA rescue can never make the transcript worse");
{
  // If the rescue comes back LESS confident than what we already had, the
  // original stands. Taking the later answer on position rather than on
  // confidence would replace a good transcript with a worse one.
  asked.length = 0;
  globalThis.fetch = stub({
    [TRANSCRIPTION[0].model]: poor,
    [TRANSCRIPTION[1].model]: { text: "worse", language: "English",
      segments: [{ start: 0, end: 1, text: "worse", avg_logprob: -2.4 }] },
  });
  const out = await transcribe(wav);
  ok("the better of the two is kept", out.text === poor.text, out.text);
}

console.log("\nThe rescue is bounded, and unknown confidence is not poor");
{
  // Every link unconfident: it must stop after the allowed rescues rather than
  // walking the whole chain and paying three times for junk audio.
  asked.length = 0;
  globalThis.fetch = stub({
    [TRANSCRIPTION[0].model]: poor,
    [TRANSCRIPTION[1].model]: poor,
    [TRANSCRIPTION[2].model]: poor,
  });
  const out = await transcribe(wav);
  ok("it stops after one rescue, not at the end of the chain", asked.length === 2, asked.join(","));
  ok("and still returns a transcript rather than nothing", out.text === poor.text);

  // A provider that returns no segments gives no confidence at all. Treating
  // that as poor would rescue EVERY reel it served and silently double the bill.
  ok("no segments means unknown, not poor", asrConfidence([]) === null);
  ok("unknown confidence never triggers a rescue", asrIsPoor(null) === false);
  ok("a real low score does", asrIsPoor(-1.06, -0.6) === true);
  ok("a real good score does not", asrIsPoor(-0.16, -0.6) === false);
  // The threshold sits in a measured empty band; these are the real edges of it.
  ok("the measured band has nothing in it", asrIsPoor(-0.29, -0.6) === false && asrIsPoor(-1.06, -0.6) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
