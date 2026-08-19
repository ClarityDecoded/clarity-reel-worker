// Unit tests for the backfill run budget (no network, no DB, no keys):
//   node worker/test-run-budget.mjs
//
// This is the thing standing between a sweep and a cancelled 300 minute run,
// and every way it can fail is SILENT: a mis-parsed flag reads as "unlimited",
// an off-by-one lets one more 4 minute item start past the ceiling, and a
// remaining count that lies makes a partial sweep look finished.

import { runBudget } from "./run-budget.mjs";

let pass = 0;
const fail = [];
const check = (name, cond) => (cond ? pass++ : fail.push(name));

// --- parsing -------------------------------------------------------------
{
  const b = runBudget([]);
  check("no flags = no item cap", b.limit === 0);
  check("no flags = no time cap", b.budgetMin === 0);
  check("no flags never exhausts", b.exhausted() === null);
}
{
  const b = runBudget(["--limit=25", "--budget-min=40"]);
  check("--limit parsed", b.limit === 25);
  check("--budget-min parsed", b.budgetMin === 40);
}
{
  const b = runBudget(["--all", "--cats=ai,stocks"], { defaultBudgetMin: 40 });
  check("default budget applies", b.budgetMin === 40);
  check("unrelated flags ignored", b.limit === 0);
}
// Junk must fall back to the default, never to "unlimited" — the failure mode
// of a typo'd flag should be a short run, not a cancelled one.
for (const junk of ["--limit=abc", "--limit=0", "--limit=-5", "--limit="]) {
  const b = runBudget([junk], { defaultLimit: 10 });
  check(`junk ${junk} falls back to default`, b.limit === 10);
}
{
  const b = runBudget(["--budget-min=nope"], { defaultBudgetMin: 40 });
  check("junk budget falls back to default", b.budgetMin === 40);
}

// --- item cap ------------------------------------------------------------
{
  const b = runBudget(["--limit=3"]);
  let done = 0;
  for (let i = 0; i < 10; i++) {
    if (b.exhausted()) break;
    done++;
    b.tick();
  }
  check("item cap stops at exactly N", done === 3);
  check("item cap names itself", /item limit \(3\)/.test(b.exhausted()));
}

// --- time cap ------------------------------------------------------------
{
  let clock = 0;
  const b = runBudget(["--budget-min=10"], { now: () => clock });
  check("fresh budget is not exhausted", b.exhausted() === null);
  clock = 9 * 60000;
  check("under budget still runs", b.exhausted() === null);
  clock = 10 * 60000;
  check("at budget stops", /time budget \(10m\)/.test(b.exhausted()));
}
{
  // The check runs BEFORE an item, so a long item may overrun the budget — that
  // is why the workflow timeout must sit above it, not on it.
  let clock = 0;
  const b = runBudget(["--budget-min=10"], { now: () => clock });
  let started = 0;
  for (let i = 0; i < 5; i++) {
    if (b.exhausted()) break;
    started++;
    b.tick();
    clock += 4 * 60000; // a 4 minute item
  }
  check("overrun is bounded to one item", started === 3);
  check("elapsed is reported", Math.round(b.elapsedMin()) === 12);
}

// --- the summary line ----------------------------------------------------
{
  let clock = 0;
  const b = runBudget(["--limit=2"], { now: () => clock });
  b.tick();
  b.tick();
  clock = 90000;
  const partial = b.summary(8);
  check("partial summary counts what is left", /8 left/.test(partial));
  check("partial summary says how to continue", /run it again/i.test(partial));
  check("partial summary counts what was done", /2 item\(s\)/.test(partial));
  check("finished summary does not ask for a rerun", !/run it again/i.test(b.summary(0)));
}

console.log(`${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
