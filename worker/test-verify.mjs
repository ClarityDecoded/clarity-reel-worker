// Live checks for the link verifier: a known-good URL survives, a dead one is
// dropped, and an entity that loses all its links gets flagged needsLink.
//   cd worker
//   node test-verify.mjs        (needs network; hits github.com + a bogus host)
//
// This is the guardrail from the brief — "confirm a dead URL is dropped, not
// rendered." No DB, no model.

import { verifyEntities, _internal } from "./verify.mjs";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

console.log("normalizeUrl:");
ok("adds scheme", _internal.normalizeUrl("github.com/obra") === "https://github.com/obra");
ok("keeps https", _internal.normalizeUrl("https://x.com/") === "https://x.com/");
ok("rejects junk", _internal.normalizeUrl("not a url with spaces") === null || _internal.normalizeUrl("javascript:alert(1)") === null);
ok("rejects empty", _internal.normalizeUrl("") === null);

console.log("\nverifyEntities (live network):");
const entities = [
  { name: "GitHub", links: [{ label: "GitHub", url: "https://github.com/obra/superpowers" }] },
  { name: "Dead", links: [{ label: "GitHub", url: "https://github.com/this-org-should-not-exist-9z9z9z/nope-nope" }] },
  { name: "Bogus host", links: [{ label: "Site", url: "https://no-such-domain-zzqqxx-9999.example.invalid" }] },
  { name: "No links proposed", links: [] },
];

const out = await verifyEntities(entities);

ok("known-good link survives", out[0].links.length === 1 && !out[0].needsLink);
ok("dead 404 link dropped + flagged", out[1].links.length === 0 && out[1].needsLink === true);
ok("bad host dropped + flagged", out[2].links.length === 0 && out[2].needsLink === true);
ok("entity with no proposed links is NOT flagged", out[3].links.length === 0 && !out[3].needsLink);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
