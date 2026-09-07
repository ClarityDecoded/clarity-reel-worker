// Orchestrator, two modes (config.mode):
//   process — pull queued Instagram links, run each through resolve -> download
//             -> ffmpeg -> ASR -> VLM -> LLM, write a structured result. Sends
//             NO email. Runs incrementally as reels are dumped (triggered by the
//             enqueue Edge Function) plus a safety run before the digest.
//   digest  — send ONE email of everything processed-but-not-yet-reported
//             (emailed_at IS NULL), then stamp emailed_at. The single 4am run.
// Per-item try/catch: one bad link never sinks the run.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { config } from "./config.mjs";
import { resolveReel, resolverStatus, AllResolversExhausted } from "./resolve.mjs";
import { downloadVideo, extractAudio, sampleTextFrames, capturePoster, downloadSlides } from "./media.mjs";
import { transcribe, ocrTimeline, structure, synthesize, llmUsageSummary } from "./nvidia.mjs";
import { normalizeCategory, selectResult } from "./prompts.mjs";
import { verifyEntities } from "./verify.mjs";
import { autoFile } from "./autofile.mjs";
import { sendDigest, sendResolverAlert } from "./email.mjs";
import { isTransient } from "./retry.mjs";
import { installPrivateLogging } from "./log-privacy.mjs";

// Public repo = public run logs. No-op unless PUBLIC_LOGS=1.
installPrivateLogging();

// After this many attempts a still-failing item stops being re-queued and is
// recorded as a real error, so a genuinely broken link can't cycle forever.
const MAX_ATTEMPTS = 3;

const supabase = createClient(config.supabase.url, config.supabase.serviceRole, {
  auth: { persistSession: false },
});

const friendlyError = (e) =>
  e?.message === "PRIVATE_OR_UNAVAILABLE"
    ? "We couldn't access this Reel. Make sure it's public."
    : (e?.message || "Something went wrong.");

// Bucket that archives reel cover images. The IG CDN `thumbnail` URL is signed
// and expires within days, leaving the library full of broken images — so while
// we still have the video, archive a stable copy here and store THAT url.
const THUMB_BUCKET = process.env.REEL_THUMB_BUCKET || "reel-thumbs";

// Persist a permanent thumbnail: fetch the resolver's cover image bytes (or, if
// that fails, grab a poster frame from the video we already downloaded), upload
// to Storage, and return its public URL. Best-effort — on any failure we fall
// back to the original (ephemeral) url so behaviour never regresses.
// `fallbackImage` is a local file to use when the source thumbnail cannot be
// fetched. For a video that is a poster frame grabbed with ffmpeg; for a
// CAROUSEL there is no video to grab from, so the first slide — already
// downloaded, and the image a reader sees first — stands in.
async function persistThumbnail(row, thumbnail, videoPath, work, fallbackImage = null) {
  try {
    let bytes = null;
    if (thumbnail) {
      const res = await fetch(thumbnail, { headers: { "user-agent": "Mozilla/5.0" } });
      if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    }
    if (!bytes && fallbackImage) {
      bytes = await readFile(fallbackImage);
    }
    if (!bytes && videoPath) {
      const poster = path.join(work, "poster.jpg");
      await capturePoster(videoPath, poster);
      bytes = await readFile(poster);
    }
    if (!bytes) throw new Error("no thumbnail source available");
    const key = `${row.id}.jpg`;
    const { error } = await supabase.storage
      .from(THUMB_BUCKET)
      .upload(key, bytes, { contentType: "image/jpeg", upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from(THUMB_BUCKET).getPublicUrl(key);
    return data?.publicUrl || thumbnail || null;
  } catch (e) {
    console.warn("  thumbnail archive failed, using source url:", e.message);
    return thumbnail || null;
  }
}

// Distinct categories already in the library — passed to the structuring pass
// so the self-expanding taxonomy reuses existing slugs instead of minting
// near-duplicates (e.g. "ai" vs "ai-tools").
async function fetchKnownCategories() {
  const { data } = await supabase
    .from("reel_results").select("category").not("category", "is", null);
  return [...new Set((data || []).map((r) => r.category).filter(Boolean))].sort();
}

async function processItem(row, knownCategories = []) {
  // Claim this row now (not the whole batch up front) so a run that stops early
  // — timeout or resolver exhaustion — leaves untouched items as 'queued' for
  // the next run instead of stranding them in 'processing'.
  const attempts = (row.attempts ?? 0) + 1;
  await supabase.from("reel_queue").update({ status: "processing", attempts }).eq("id", row.id);

  const work = await mkdtemp(path.join(tmpdir(), "reel-"));
  try {
    // 1. resolve
    const { videoUrl, slides, caption, thumbnail } = await resolveReel(row.url);

    // A CAROUSEL is a post of stills, not a video: nothing to download, nothing
    // to transcribe, and its whole content is the pictures plus the caption. It
    // used to work only by accident — RapidAPI renders one as a slideshow video
    // and mpdecimate happened to collapse it back to one frame per slide — so on
    // any resolver that hands back the real images instead, every carousel
    // failed as "no video url". Reading the slides directly also gets them at
    // FULL resolution rather than the 720px a video frame is downscaled to.
    const isCarousel = !videoUrl && slides?.length;

    let videoPath = null, wavPath = null, frames = [];
    if (isCarousel) {
      console.log(`  carousel: ${slides.length} slide(s), no video`);
      frames = await downloadSlides(slides, path.join(work, "slides"));
      console.log(`  ${frames.length} slide(s) to OCR`);
    } else {
      // 2. download
      videoPath = path.join(work, "video.mp4");
      await downloadVideo(videoUrl, videoPath);

      // 3. audio + frames. Frames now cover the WHOLE video: sampled at
      //    config.ocr.fps, near-duplicates dropped locally by mpdecimate, each
      //    survivor carrying its real timestamp.
      // wavPath is null when the reel has no audio track (silent video) — the
      // on-screen text and caption still carry it, so that's not a failure.
      wavPath = await extractAudio(videoPath, path.join(work, "audio.wav"));
      frames = await sampleTextFrames(videoPath, path.join(work, "frames"), config.ocr);
      console.log(`  ${frames.length} distinct frame(s) to OCR` +
        (frames.length ? ` (${frames[0].t.toFixed(1)}s to ${frames[frames.length - 1].t.toFixed(1)}s)` : ""));
    }

    // 4. transcript (best-effort) + on-screen text (best-effort)
    let transcript = "";
    let segments = [];
    if (wavPath) {
      try {
        const asr = await transcribe(wavPath);
        transcript = asr.text;
        segments = asr.segments;
      } catch (e) { console.warn("Transcription failed:", e.message); }
    }

    let onScreen = [];
    try { onScreen = await ocrTimeline(frames); }
    catch (e) { console.warn("OCR failed:", e.message); }

    const onScreenText = onScreen.map((o) => o.text).join("\n");

    if (!transcript && !onScreenText && !caption) {
      throw new Error(isCarousel
        ? "No readable content (no text on any slide, and no caption)."
        : "No readable content (no speech, on-screen text, or caption).");
    }

    // 5. classify + structure, from one interleaved timeline
    const out = await structure({ transcript, caption, onScreenText, segments, onScreen, knownCategories });
    // Shared with backfill-entities so the two cannot interpret a result
    // differently (see selectResult's note).
    const { type, sub, title: rawTitle, summary } = selectResult(out);
    const category = normalizeCategory(out.category, type);   // library bucket, or null
    const title = rawTitle || "Untitled";

    // Verify every entity link the model proposed (it has no web access, so it
    // guesses official URLs); dead ones are dropped, entities with none flagged.
    if (sub.entities?.length) {
      const before = sub.entities.reduce((n, e) => n + (e.links?.length || 0), 0);
      sub.entities = await verifyEntities(sub.entities);
      const after = sub.entities.reduce((n, e) => n + (e.links?.length || 0), 0);
      console.log(`  entities: ${sub.entities.length}, links ${before} proposed → ${after} verified`);
    }

    // 6. archive a permanent thumbnail (IG's expires) while we still have the video
    const thumbUrl = await persistThumbnail(row, thumbnail, videoPath, work, frames[0]?.path || null);

    // 7. persist result + mark queue done
    const record = {
      queue_id: row.id,
      source_url: row.url,
      content_type: type,
      category,
      title,
      summary,
      structured_json: sub,
      transcript,
      transcript_segments: segments,
      on_screen_text: onScreen,
      caption,
      thumbnail_url: thumbUrl,
    };
    let { data: result, error: insErr } = await supabase
      .from("reel_results").insert(record).select().single();
    // patch_019 adds `caption`. If the worker ships before the patch is applied,
    // PostgREST rejects the WHOLE insert over the unknown column — which would
    // fail a reel for a field that is only nice to have. Retry without it rather
    // than lose the item (same defensive rule as the reel list query).
    if (insErr && /caption/i.test(insErr.message)) {
      console.warn("  caption column missing (run patch_019); saving without it");
      const { caption: _omit, ...noCaption } = record;
      ({ data: result, error: insErr } = await supabase
        .from("reel_results").insert(noCaption).select().single());
    }
    if (insErr) throw new Error("DB insert failed: " + insErr.message);

    // Pre-sort the subjects that are always for Rahul (fitness / personal dev):
    // onto the scale at "Want to try" and tagged to his workspace. Best effort —
    // the reel is already saved, so a failure here must not fail the item.
    let filed = [];
    try {
      filed = await autoFile(supabase, result);
    } catch (e) {
      console.warn("  auto-file skipped —", e?.message || e);
    }

    // A workspace picked in the Shortcut's menu at dump time (patch_029).
    // Additive to auto-file, not a replacement — a fitness reel manually sent
    // to a different workspace ends up tagged to both.
    if (row.workspace_id) {
      try {
        const { error } = await supabase
          .from("reel_board_tags")
          .upsert(
            { reel_result_id: result.id, workspace_id: row.workspace_id },
            { onConflict: "reel_result_id,workspace_id", ignoreDuplicates: true },
          );
        if (error) console.warn("  chosen-workspace tag failed —", error.message);
        else filed.push("tagged → chosen workspace");
      } catch (e) {
        console.warn("  chosen-workspace tag skipped —", e?.message || e);
      }
    }

    await supabase
      .from("reel_queue")
      .update({ status: "done", processed_at: new Date().toISOString(), error: null })
      .eq("id", row.id);

    console.log(`✓ ${row.url} → ${type}: "${title}"${filed.length ? ` [auto: ${filed.join(", ")}]` : ""}`);
    return { ok: true, result };
  } catch (e) {
    // Resolver quota fully spent — not this item's fault. Put it back to 'queued'
    // and bubble up so the run stops (all remaining items would fail the same way).
    if (e instanceof AllResolversExhausted || e?.code === "ALL_RESOLVERS_EXHAUSTED") {
      await supabase.from("reel_queue").update({ status: "queued" }).eq("id", row.id);
      throw e;
    }
    const reason = friendlyError(e);

    // Transient (network blip, provider 5xx / 503 capacity) and we still have
    // attempts left → back to 'queued' so tonight's blip clears tomorrow. The
    // in-process retries already fired, so this is the second line of defence.
    if (isTransient(e) && attempts < MAX_ATTEMPTS) {
      console.warn(`↻ ${row.url}: ${reason} — re-queued (attempt ${attempts}/${MAX_ATTEMPTS})`);
      await supabase
        .from("reel_queue")
        .update({ status: "queued", error: reason })
        .eq("id", row.id);
      return { ok: false, retrying: { url: row.url, reason, attempts } };
    }

    console.error(`✗ ${row.url}: ${reason}`);
    await supabase
      .from("reel_queue")
      .update({ status: "error", processed_at: new Date().toISOString(), error: reason })
      .eq("id", row.id);
    return { ok: false, failure: { url: row.url, reason } };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ── process mode: drain the queue, write results, NO email ────────────────
// Reels claimed by a run that never finished. Claiming is just-in-time, so a
// killed run strands only the ONE item it was mid-way through — but the job has
// a 30-minute `timeout-minutes`, and each cancellation left another row parked
// in 'processing' forever. Thirteen had piled up before anyone noticed, the
// oldest from three weeks earlier; nothing retries them because the drain only
// looks at 'queued'.
//
// Reclaiming ALL of them at start-of-run is safe because reel-process.yml sets
// `concurrency: {group: reel-process, cancel-in-progress: false}` — runs QUEUE
// rather than overlap, so when this line executes no other run holds a claim.
// Don't "improve" this into an age cutoff on created_at: that column is the
// ENQUEUE time, not the claim time, so an old reel claimed seconds ago would
// look stale and get yanked out from under the run processing it. There is no
// claimed_at column to key off, and the concurrency guarantee is stronger than
// a timestamp guess anyway.
async function reclaimStale() {
  const { data, error } = await supabase
    .from("reel_queue")
    .update({ status: "queued" })
    .eq("status", "processing")
    .select("id");
  if (error) {
    console.warn("Could not reclaim stale claims:", error.message); // never fatal
    return;
  }
  if (data?.length) console.log(`Reclaimed ${data.length} stale 'processing' row(s) → queued`);
}

async function runProcess() {
  console.log(`Resolver keys loaded: ${resolverStatus().total}`);
  await reclaimStale();
  const { data: queued, error } = await supabase
    .from("reel_queue")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(config.maxItemsPerRun);
  if (error) throw new Error("Could not read queue: " + error.message);

  if (!queued.length) {
    console.log("Queue empty — nothing to do.");
    return;
  }
  console.log(`Processing ${queued.length} item(s)…`);

  const knownCategories = await fetchKnownCategories();

  let ok = 0;
  let failed = 0;
  let requeued = 0;
  let exhausted = false;
  for (const row of queued) {
    try {
      const r = await processItem(row, knownCategories); // claims the row itself
      if (r.ok) ok++;
      else if (r.retrying) requeued++;   // transient — stays 'queued' for the next run
      else failed++;
    } catch (e) {
      if (e instanceof AllResolversExhausted || e?.code === "ALL_RESOLVERS_EXHAUSTED") {
        exhausted = true;
        break; // stop; remaining items stay 'queued' for the next run
      }
      throw e;
    }
  }

  // Results are left with emailed_at NULL; the digest run reports them. Errors
  // are persisted on their queue rows and the digest picks them up too.
  // Re-queued items are deliberately NOT reported — they're still 'queued' and
  // will be retried, so telling you about them would be noise.
  //
  // (The stashed branch sent the digest from here. That predates the
  // process/digest split — process mode must never email, or every incremental
  // per-dump run would fire its own message.)

  // Out of resolver quota? Tell the owner to add another RapidAPI key (this
  // alert is separate from the digest — it's urgent, so it fires right away).
  const status = resolverStatus();
  if (status.total > 0 && status.live === 0) {
    const { count } = await supabase
      .from("reel_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    await sendResolverAlert(status, count ?? 0);
  }

  console.log(
    `Done. ${ok} succeeded, ${failed} failed` +
      (requeued ? `, ${requeued} re-queued for the next run` : "") + "." +
      (exhausted ? " Resolver quota exhausted — stopped early." : ""),
  );
  console.log(`AI providers — ${llmUsageSummary()}`);
}

// ── digest mode: one email of everything not yet reported ─────────────────
async function runDigest() {
  const test = config.digestTest;

  // TEST: preview the email from the most recent reels regardless of emailed_at
  // (and never stamp). Normal: only unreported items (emailed_at IS NULL).
  let resQ = supabase.from("reel_results").select("*");
  let errQ = supabase.from("reel_queue").select("id, url, error, created_at").eq("status", "error");
  if (test) {
    resQ = resQ.order("created_at", { ascending: false }).limit(config.digestTestLimit);
    errQ = errQ.order("created_at", { ascending: false }).limit(5);
  } else {
    resQ = resQ.is("emailed_at", null).order("created_at", { ascending: true });
    errQ = errQ.is("emailed_at", null).order("created_at", { ascending: true });
  }

  let { data: results, error: rErr } = await resQ;
  if (rErr) throw new Error("Could not read results: " + rErr.message);
  let { data: errored, error: eErr } = await errQ;
  if (eErr) throw new Error("Could not read failures: " + eErr.message);

  // Test pulls newest-first; show them oldest-first like the real digest.
  if (test) {
    results = (results ?? []).reverse();
    errored = (errored ?? []).reverse();
  }

  const failures = (errored ?? []).map((r) => ({ url: r.url, reason: r.error || "Something went wrong.", at: r.created_at }));

  // Weave every save into one action-first brief for the top of the email. Best
  // effort: a null return (too few items, or the call failed) just omits it.
  const brief = await synthesize(results ?? []);

  // Send first; only stamp emailed_at if it actually went out, so a send
  // failure leaves everything to be retried by the next digest.
  const sent = await sendDigest(results ?? [], failures, brief);
  if (!sent) {
    console.warn("Digest not sent — leaving items unmarked for the next run.");
    return;
  }

  // Test send never stamps — it must not disturb the real 4am digest.
  if (test) {
    console.log(`TEST digest sent: ${results?.length ?? 0} result(s), ${failures.length} failure(s). Nothing stamped.`);
    return;
  }

  const now = new Date().toISOString();
  if (results?.length) {
    await supabase.from("reel_results").update({ emailed_at: now }).in("id", results.map((r) => r.id));
  }
  if (errored?.length) {
    await supabase.from("reel_queue").update({ emailed_at: now }).in("id", errored.map((r) => r.id));
  }
  console.log(`Digest run: ${results?.length ?? 0} result(s), ${failures.length} failure(s).`);
}

async function main() {
  if (config.mode === "digest") return runDigest();
  return runProcess();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
