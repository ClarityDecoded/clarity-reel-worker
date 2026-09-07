// Recover the CAPTION for reels that were saved before it was being stored.
//
// WHY THIS EXISTS. `reel_results.caption` arrived with patch_019 (gotcha #52).
// Reels saved before that kept their transcript and on-screen text but LOST the
// caption — and for a whole class of reel the caption IS the content. The worst
// case in the library: a cybersecurity post whose caption carried the entire
// advisory (a named CVE-style bug, the affected frameworks, three fix steps),
// while the transcript held nothing but the BACKGROUND SONG'S lyrics. Nothing
// downstream could ever name that reel correctly, because the words were never
// there to read. That is not a model failing to understand; it is a model
// working from 48 characters of song lyrics.
//
// So this re-resolves the ORIGINAL post and stores the caption it comes back
// with. It writes ONLY the caption — re-running the structuring is
// backfill-entities.mjs's job, and keeping the two separate means a resolver
// hiccup cannot cost you a good summary you already had.
//
//   node --env-file=.env backfill-captions.mjs            every reel missing one
//   node --env-file=.env backfill-captions.mjs <id>       just this one
//   node --env-file=.env backfill-captions.mjs --dry      show, write nothing
//
// NEEDS A WORKING RESOLVER. Locally that means yt-dlp on PATH (no key, and a
// home IP is exactly the case it handles best — the doubt in gotcha #55 is
// about datacenter IPs on Actions). Reels whose post has since been deleted or
// made private are genuinely gone, and are reported as such rather than
// silently skipped.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.mjs";
import { resolveReel } from "./resolve.mjs";
import { resolveViaYtDlp, ytDlpAvailable } from "./resolve-ytdlp.mjs";
import { runBudget } from "./run-budget.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyId = args.find((a) => !a.startsWith("--")) || null;

const supabase = createClient(config.supabase.url, config.supabase.serviceRole, {
  auth: { persistSession: false },
});

// Re-resolving costs a resolver call per reel, so a big sweep stops on OUR
// terms rather than running until something kills it (gotcha #74c).
const budget = runBudget(args, { defaultBudgetMin: 45 });

// Space the requests out. This runs from Rahul's HOME connection, and firing a
// few hundred back-to-back requests at Instagram is how that IP gets rate
// limited — which would not just stop the sweep, it would degrade his normal
// browsing. A second or two between reels costs a few minutes across the whole
// run and is the difference between a polite crawl and a burst.
const GAP_MS = Number(process.env.CAPTION_GAP_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let q = supabase
    .from("reel_results")
    .select("id, title, source_url, caption, created_at")
    .order("created_at", { ascending: false });
  if (onlyId) q = q.eq("id", onlyId);

  const { data: rows, error } = await q;
  if (error) throw new Error("Could not read results: " + error.message);

  const useYtDlp = await ytDlpAvailable();
  console.log(useYtDlp
    ? "Using yt-dlp for metadata (no key needed)."
    : "yt-dlp not found — falling back to the configured resolver, which needs a video to succeed.");

  // A caption of "" and a caption of NULL both mean "we never stored one".
  const targets = rows.filter((r) => onlyId || !String(r.caption || "").trim());
  console.log(`${targets.length} reel(s) missing a caption${dry ? " (dry run)" : ""}.\n`);

  let recovered = 0, gone = 0, empty = 0, seen = 0, streak = 0;
  const STREAK_STOP = 8;
  for (const r of targets) {
    const stop = budget.exhausted();
    if (stop) { console.log(`\nStopping: ${stop}.`); break; }
    seen++; budget.tick();
    if (seen > 1) await sleep(GAP_MS);
    if (!r.source_url) { console.log(`- ${r.id}  no source url stored, cannot re-resolve`); gone++; continue; }

    let caption;
    try {
      // Deliberately NOT resolveReel here. That walks the tiers looking for a
      // playable VIDEO and only counts a tier as successful when it finds one —
      // so a reel whose metadata (and caption) came back perfectly is reported
      // as PRIVATE_OR_UNAVAILABLE just because no muxed stream was on offer.
      // Verified on the live MCP post: yt-dlp returns the full caption while
      // resolveReel calls the same post unavailable. Recovering a caption needs
      // metadata, not a stream, so ask the metadata resolver directly and keep
      // resolveReel only as the fallback for setups without yt-dlp.
      if (useYtDlp) ({ caption } = await resolveViaYtDlp(r.source_url));
      else ({ caption } = await resolveReel(r.source_url));
    } catch (e) {
      // A deleted or private post is a real, permanent answer — say which reel
      // and why, so it is obvious this is not a bug to chase.
      console.log(`✗ ${r.id}  "${r.title}"  → could not re-resolve: ${String(e.message).slice(0, 90)}`);
      gone++;
      // A LONG RUN of failures is a rate limit, not 200 deleted posts. Stopping
      // keeps a temporary block from being recorded as "these are all gone",
      // and leaves the rest to a later run.
      if (++streak >= STREAK_STOP) {
        console.log(`\nStopping: ${STREAK_STOP} failures in a row — that reads as a rate limit, not deleted posts. Try again later.`);
        break;
      }
      continue;
    }

    caption = String(caption || "").trim();
    if (!caption) {
      // The post is live but genuinely has no caption. Worth distinguishing
      // from a failure: nothing is broken and re-running will not help.
      streak = 0;
      console.log(`- ${r.id}  "${r.title}"  → post has no caption`);
      empty++;
      continue;
    }

    streak = 0;
    console.log(`✓ ${r.id}  "${r.title}"  → ${caption.length} chars`);
    console.log(`    ${caption.slice(0, 140).replace(/\s+/g, " ")}${caption.length > 140 ? "…" : ""}`);
    recovered++;

    if (dry) continue;
    const { error: upErr } = await supabase.from("reel_results").update({ caption }).eq("id", r.id);
    if (upErr) throw new Error(`update ${r.id} failed: ${upErr.message}`);
  }

  console.log(`\nDone. ${recovered} caption(s) ${dry ? "would be " : ""}recovered, ${empty} had none, ${gone} unreachable.`);
  console.log(budget.summary(targets.length - seen));
  if (recovered && !dry) {
    console.log("Now re-run structuring so the new text is actually used:");
    console.log("  node --env-file=.env backfill-entities.mjs --all");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
