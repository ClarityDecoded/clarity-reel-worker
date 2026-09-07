// Re-structure reels processed before the current prompt: entities, stocks, the
// universal point, the honest verification read, and the rewritten summary.
//
// The source video is deleted after processing, so we CANNOT re-run OCR/ASR —
// but the timed tracks are persisted (transcript, transcript_segments,
// on_screen_text), which is exactly what structure() needs. This re-runs the
// (upgraded) structuring prompt from that stored data, verifies the links, and
// UPDATES the row only when the new run actually produced something — so a reel
// that legitimately names nothing is never blanked out.
//
//   cd worker
//   node backfill-entities.mjs                 # every non-recipe result missing entities
//   node backfill-entities.mjs <result-id>     # one specific reel
//   node backfill-entities.mjs --all           # re-run even ones that already have entities
//   node backfill-entities.mjs --dry           # print what would change, write nothing
//   node backfill-entities.mjs --limit=25      # do 25 and stop (resume by running again)
//   node backfill-entities.mjs --budget-min=40 # stop after 40 minutes, cleanly
//
// Guarded by design: recipes are skipped (entities live on synopses), and an
// empty/failed extraction leaves the existing row untouched.

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.mjs";
import { structure } from "./nvidia.mjs";
import { selectResult } from "./prompts.mjs";
import { verifyEntities } from "./verify.mjs";
import { runBudget } from "./run-budget.mjs";
import { installPrivateLogging } from "./log-privacy.mjs";

// Public repo = public run logs. No-op unless PUBLIC_LOGS=1.
installPrivateLogging();

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const all = args.includes("--all");
const onlyId = args.find((a) => !a.startsWith("--"));
// --cats=ai,stocks → only re-extract reels in those categories
const catsArg = args.find((a) => a.startsWith("--cats="));
const onlyCats = catsArg ? catsArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null;
// A sweep does a CHUNK and exits 0 rather than running until the workflow's
// timeout cancels it (a cancelled run is billed in full and reports nothing).
// Resuming is free: the next run re-picks its own targets.
const budget = runBudget(args, { defaultBudgetMin: 40 });

const supabase = createClient(config.supabase.url, config.supabase.serviceRole, {
  auth: { persistSession: false },
});

async function backfillRow(r) {
  const segments = Array.isArray(r.transcript_segments) ? r.transcript_segments : [];
  const onScreen = Array.isArray(r.on_screen_text) ? r.on_screen_text : [];
  const onScreenText = onScreen.map((o) => o.text).join("\n");

  // patch_019 persists the caption, so a re-structure can finally read it.
  // Reels saved before that patch have none — their caption is unrecoverable
  // (the video and the resolver response are long gone).
  const caption = r.caption || "";

  // A stored title we would be happy to REPLACE. Only these — a real title is
  // never overwritten, because this pass re-runs the model and a second opinion
  // is not a reason to rename something the owner may already recognise.
  const titleIsMissing = !String(r.title || "").trim()
    || /^(untitled|unknown|n\/a|none)$/i.test(String(r.title).trim());

  if (!r.transcript && !onScreenText && !caption) {
    console.log(`- ${r.id}  skipped (no stored transcript, on-screen text or caption to work from)`);
    return { changed: false };
  }

  const out = await structure({
    transcript: r.transcript || "",
    caption,
    onScreenText,
    segments,
    onScreen,
  });
  // Same reader production uses, so a re-run can never interpret a result
  // differently from the original pass (see selectResult).
  const { type: newType, sub, summary: newSummary } = selectResult(out);

  const stocks = (sub.stocks || []).filter((s) => s?.ticker);
  // Write when the re-run produced ANY of the upgraded fields. universal_point
  // and the rewritten summary are the common case — most reels name nothing
  // lookup-able, and gating on entities/stocks alone would skip them all.
  const recoveredTitle = titleIsMissing && typeof sub.title === "string" && sub.title.trim()
    ? sub.title.trim()
    : null;

  // An existing title is the owner's — the manage modal writes it, and a re-run
  // is not a reason to rename something he may already recognise. But letting
  // structured_json.title say something DIFFERENT is worse than either: the row
  // and the body then disagree about what the reel is ("Coffee Porn" in the
  // library, "Mercato Caffe Grand Opening" inside it). Keep them equal.
  if (!titleIsMissing) sub.title = r.title;

  // The reel's TYPE can change on a re-run — a reel whose caption was missing
  // can now be plainly a recipe. content_type is what tells the renderer which
  // shape structured_json holds (gotcha #53), so writing the new body without
  // the new type leaves the two contradicting each other.
  const typeChanged = newType && newType !== r.content_type;

  // A recovered title counts as a result on its own: without this, a reel whose
  // only gain is finally having a name is reported as "nothing extracted".
  if (!sub.entities?.length && !stocks.length && !sub.universal_point && !newSummary && !recoveredTitle) {
    console.log(`- ${r.id}  "${r.title}"  → nothing extracted, left as-is`);
    return { changed: false };
  }

  // Snapshot what the model PROPOSED before verification prunes it, so a dry run
  // can show whether 0 verified means "model gave none" vs "all were dropped".
  sub.entities = sub.entities || [];
  const proposed = sub.entities.map((e) => (e.links || []).map((l) => l.url));

  sub.entities = await verifyEntities(sub.entities);
  const links = sub.entities.reduce((n, e) => n + (e.links?.length || 0), 0);
  if (titleIsMissing && !recoveredTitle) {
    // Say so out loud. A reel with nothing to work from (a transcript that is
    // just "Outro Music") SHOULD stay Untitled — inventing a name for it is
    // exactly the never-invent rule this pipeline is built on.
    console.log(`   (still no title — nothing in the stored tracks names this reel)`);
  }
  if (recoveredTitle) console.log(`   title: "${r.title}" → "${recoveredTitle}"`);
  if (typeChanged) console.log(`   type: ${r.content_type} → ${newType}  (re-run backfill-categories after this)`);
  console.log(`✓ ${r.id}  "${r.title}"  → ${sub.entities.length} entities, ${links} verified link(s)${stocks.length ? `, ${stocks.length} stock(s): ${stocks.map((s) => s.ticker).join(", ")}` : ""}${sub.universal_point ? `\n   universal point: ${sub.universal_point}` : ""}`);

  if (dry) {
    if (sub.summary) console.log(`   summary: ${sub.summary}`);
    if (sub.verification_note) console.log(`   verification: ${sub.verification_note}`);
    sub.entities.forEach((e, i) => {
      const kept = (e.links || []).map((l) => l.url);
      const dropped = proposed[i].filter((u) => !kept.includes(u));
      console.log(`   ${e.rank || ""} ${e.name}`.trimStart());
      console.log(`      proposed: ${proposed[i].length ? proposed[i].join(", ") : "(none)"}`);
      if (kept.length) console.log(`      kept:     ${kept.join(", ")}`);
      if (dropped.length) console.log(`      dropped:  ${dropped.join(", ")}`);
      if (e.needsLink) console.log(`      → needsLink (search fallback)`);
    });
    return { changed: true };
  }

  // Merge onto the EXISTING structured_json so takeaways/actions/etc. are kept
  // even if this run phrased them slightly differently — we only add/replace the
  // new fields the upgrade introduced.
  const merged = { ...(r.structured_json || {}), ...sub };
  // newSummary already covers a recipe's `description`; without that the old
  // synopsis summary survived onto a reel that had become a recipe.
  const fields = { structured_json: merged, summary: newSummary || r.summary };
  if (typeChanged) fields.content_type = newType;
  // Only ever FILL a missing title, never replace a real one.
  if (recoveredTitle) fields.title = recoveredTitle;
  const { error } = await supabase
    .from("reel_results")
    .update(fields)
    .eq("id", r.id);
  if (error) throw new Error(`update ${r.id} failed: ${error.message}`);
  return { changed: true };
}

async function main() {
  const BASE_COLS = "id, title, content_type, summary, structured_json, transcript, transcript_segments, on_screen_text";
  const build = (cols) => {
    let q = supabase
      .from("reel_results")
      .select(cols)
      .neq("content_type", "recipe")
      .order("created_at", { ascending: false });
    if (onlyId) q = q.eq("id", onlyId);
    if (onlyCats) q = q.in("category", onlyCats);
    return q;
  };

  // `caption` arrives with patch_019. PostgREST rejects the ENTIRE select over
  // one unknown column, so ask for it, and fall back to the old column set if
  // the patch hasn't been applied yet — a backfill must never be blocked by an
  // optional field.
  let { data: rows, error } = await build(`${BASE_COLS}, caption`);
  if (error && /caption/i.test(error.message)) {
    console.warn("caption column missing (run patch_019); backfilling without it");
    ({ data: rows, error } = await build(BASE_COLS));
  }
  if (error) throw new Error("Could not read results: " + error.message);

  const targets = rows.filter((r) => all || onlyId ||
    !(r.structured_json?.entities?.length) || !(r.structured_json?.stocks?.length) ||
    !r.structured_json?.universal_point);
  console.log(`${targets.length} reel(s) to re-extract${dry ? " (dry run)" : ""}.\n`);

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
      const res = await backfillRow(r);
      if (res.changed) changed++;
    } catch (e) {
      console.error(`✗ ${r.id}: ${e.message}`);
    }
    budget.tick();
  }
  console.log(`\nDone. ${changed} reel(s) ${dry ? "would be" : "were"} updated.`);
  console.log(budget.summary(targets.length - seen));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
