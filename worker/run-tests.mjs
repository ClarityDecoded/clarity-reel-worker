// Run every HERMETIC worker suite — no network, no keys, no DB.
//
// This exists because `npm test` here used to run two of fourteen suites, so a
// real failure sailed past unnoticed: pointing classify at OpenAI broke
// test-router-empty (it had been asserting a preference order as a side effect)
// and nothing said so.
//
// The list is EXPLICIT rather than a glob over test-*.mjs, because several
// files matching that pattern are CLI TOOLS, not suites — test-ocr.mjs and
// test-resolve.mjs take a reel URL and exit non-zero without one, and a glob
// reports those as failures forever. test-verify.mjs is a real suite but hits
// the live network, so it is deliberately left out of the default gate: a flaky
// connection must not read as a broken build. Run it by hand.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const SUITES = [
  "test-adapt-payload.mjs",
  "test-autofile.mjs",
  "test-caption.mjs",
  "test-carousel.mjs",
  "test-log-privacy.mjs",
  "test-resolver-tiers.mjs",
  "test-retry.mjs",
  "test-router-cooldown-skip.mjs",
  "test-router-dead-model.mjs",
  "test-router-empty.mjs",
  "test-router-profiles.mjs",
  "test-run-budget.mjs",
  "test-tiled-ocr.mjs",
];

let failed = [];
for (const suite of SUITES) {
  try {
    await run(process.execPath, [suite], { timeout: 120000 });
    console.log(`  ok   ${suite}`);
  } catch (e) {
    failed.push(suite);
    console.log(`  FAIL ${suite}`);
    const out = `${e.stdout || ""}${e.stderr || ""}`.trim().split("\n").filter((l) => /FAIL|Error|error/.test(l));
    out.slice(0, 4).forEach((l) => console.log(`       ${l.trim().slice(0, 140)}`));
  }
}

console.log("");
if (failed.length) {
  console.log(`${failed.length} of ${SUITES.length} suites FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`All ${SUITES.length} worker suites pass.`);
