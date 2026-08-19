// A run budget for the long backfill sweeps.
//
// The backfills used to run until they finished or until the workflow's
// `timeout-minutes` killed them. Two entity sweeps hit that 300 minute ceiling
// and were CANCELLED — GitHub still bills every minute of a cancelled run, so
// that was ~600 billed minutes for a job that never got to report what it did.
//
// A sweep is resumable by design (both scripts pick their own targets on every
// start), so the fix is to stop on OUR terms and exit 0: do a chunk, say what's
// left, let the next run continue. The time budget matters more than the item
// count because provider latency swings wildly (gotcha #39) — an item can take
// 2 seconds or 4 minutes, so N items is not a predictor of wall clock.
//
//   --limit=N        stop after N items      (0 / absent = no item cap)
//   --budget-min=N   stop after N minutes    (0 / absent = no time cap)
//
// Always set the time budget BELOW the workflow's timeout-minutes, or the
// ceiling that gets hit is still GitHub's.

export function runBudget(args = [], { defaultBudgetMin = 0, defaultLimit = 0, now = () => Date.now() } = {}) {
  const num = (prefix, fallback) => {
    const hit = args.find((a) => a.startsWith(prefix));
    if (!hit) return fallback;
    const n = Number(hit.slice(prefix.length));
    // A junk value must not silently mean "unlimited" — fall back to the default.
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const limit = num("--limit=", defaultLimit);
  const budgetMin = num("--budget-min=", defaultBudgetMin);
  const started = now();
  let count = 0;

  return {
    limit,
    budgetMin,
    count: () => count,
    elapsedMin: () => (now() - started) / 60000,
    // Checked BEFORE each item: returns a human reason to stop, or null.
    exhausted() {
      if (limit && count >= limit) return `item limit (${limit})`;
      if (budgetMin && now() - started >= budgetMin * 60000) return `time budget (${budgetMin}m)`;
      return null;
    },
    tick() {
      count++;
    },
    // One line for the end of a run, so a partial sweep reads as progress
    // rather than as a failure.
    summary(remaining) {
      const spent = this.elapsedMin().toFixed(1);
      if (remaining > 0) {
        return `Stopped with ${remaining} left after ${count} item(s) in ${spent}m — run it again to continue.`;
      }
      return `Nothing left: ${count} item(s) in ${spent}m.`;
    },
  };
}
