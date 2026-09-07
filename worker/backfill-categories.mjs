// Assign a library category to reels processed before auto-categorization.
//
// New reels get their category inline from the structuring pass. This one-off
// pass handles the existing backlog: for each reel with no category, it runs a
// CHEAP category-only classifier over the stored title/summary (the video is
// long gone, and re-running full structuring would be wasteful). Recipes are
// set to "recipe" directly with no LLM call.
//
//   cd worker
//   node backfill-categories.mjs           # every reel missing a category
//   node backfill-categories.mjs <id>      # one specific reel
//   node backfill-categories.mjs --all     # re-classify even ones already set
//   node backfill-categories.mjs --dry     # print what would change, write nothing
//   node backfill-categories.mjs --limit=50      # do 50 and stop (resume by running again)
//   node backfill-categories.mjs --budget-min=40 # stop after 40 minutes, cleanly
//
// Best-effort: a reel the classifier can't place stays Uncategorised (null) —
// never force-fit — and an existing category is never overwritten with null.

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.mjs";
import { classifyCategory } from "./nvidia.mjs";
import { runBudget } from "./run-budget.mjs";
import { installPrivateLogging } from "./log-privacy.mjs";

// Public repo = public run logs. No-op unless PUBLIC_LOGS=1.
installPrivateLogging();

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const all = args.includes("--all");
const onlyId = args.find((a) => !a.startsWith("--"));
// Same deal as the entities sweep: chunk and exit 0 instead of being cancelled
// at the workflow timeout. See run-budget.mjs.
const budget = runBudget(args, { defaultBudgetMin: 40 });

const supabase = createClient(config.supabase.url, config.supabase.serviceRole, {
  auth: { persistSession: false },
});

async function backfillRow(r, known = []) {
  const cat = r.content_type === "recipe" ? "recipe" : await classifyCategory(r, known);

  if (!cat) {
    console.log(`- ${r.id}  "${r.title || "Untitled"}"  → no clear category, left Uncategorised`);
    return { changed: false };
  }
  if (cat === r.category) {
    console.log(`= ${r.id}  "${r.title || "Untitled"}"  → already ${cat}`);
    return { changed: false };
  }

  console.log(`✓ ${r.id}  "${r.title || "Untitled"}"  → ${cat}${r.category ? ` (was ${r.category})` : ""}`);
  if (dry) return { changed: true, category: cat };

  const { error } = await supabase
    .from("reel_results")
    .update({ category: cat })
    .eq("id", r.id);
  if (error) throw new Error(`update ${r.id} failed: ${error.message}`);
  return { changed: true, category: cat };
}

// The classifier weighs title/summary first but also reads the caption and the
// on-screen text, so a reel whose title came back empty can still be filed from
// what was visible in the video. Those two columns must therefore be SELECTED —
// leaving them out does not error, it just silently classifies from less
// (the gotcha #52b shape: a param the caller never passes).
const COLS = "id, title, content_type, category, summary, structured_json, caption, on_screen_text";
const COLS_NO_CAPTION = "id, title, content_type, category, summary, structured_json, on_screen_text";

async function main() {
  const run = (cols) => {
    let q = supabase.from("reel_results").select(cols).order("created_at", { ascending: false });
    if (onlyId) q = q.eq("id", onlyId);
    return q;
  };

  // patch_019 added reel_results.caption; degrade rather than fail if a database
  // predates it, same convention as the worker's insert path.
  let { data: rows, error } = await run(COLS);
  if (error && /caption/i.test(error.message || "")) {
    console.warn("  (no caption column — classifying without it)");
    ({ data: rows, error } = await run(COLS_NO_CAPTION));
  }
  if (error) throw new Error("Could not read results: " + error.message);

  const targets = rows.filter((r) => all || onlyId || !r.category);
  console.log(`${targets.length} reel(s) to classify${dry ? " (dry run)" : ""}.\n`);

  // Seed the classifier with categories already assigned, so backfilled reels
  // reuse existing slugs instead of minting near-duplicates. Grows as the run
  // goes: a slug minted early is available to reuse for later reels.
  const known = new Set(rows.map((r) => r.category).filter(Boolean));

  let changed = 0;
  let seen = 0;
  for (const r of targets) {
    const stop = budget.exhausted();
    if (stop) {
      console.log(`\nStopping early — ${stop}.`);
      break;
    }
    seen++;
    try {
      const res = await backfillRow(r, [...known]);
      if (res.changed && res.category) known.add(res.category);
      if (res.changed) changed++;
    } catch (e) {
      console.error(`✗ ${r.id}: ${e.message}`);
    }
    budget.tick();
  }
  console.log(`\nDone. ${changed} reel(s) ${dry ? "would be" : "were"} categorized.`);
  console.log(budget.summary(targets.length - seen));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
