// The structuring prompt. This is where the brief's AI rules live: never invent
// facts, never guess quantities/temperatures/timing, distinguish spoken vs
// on-screen vs caption vs inferred, and return null (listing the gap) when
// something wasn't stated.

// The owner's WELL-KNOWN library buckets — a curated seed the model reuses. The
// taxonomy is SELF-EXPANDING: the model may mint new slugs for subjects none of
// these cover, so this is a starting vocabulary, not a closed set. The curated
// keys/labels/colors are mirrored in src/pages/reel/cats.js.
export const CATEGORY_KEYS = [
  "stocks", "growth", "fitness", "relationships", "medical",
  "branding", "marketing", "seo", "design", "ai", "recipe",
];

// Slugs we treat as "no category" if the model echoes them back.
// Also rejects words for the MEDIUM rather than the subject. Every item here is
// a reel, so "reel" is not a category — it would swallow anything. Mirrors
// NOT_A_SUBJECT in src/pages/reel/cats.js.
const NULLISH_CATEGORIES = new Set([
  "", "null", "none", "n-a", "na", "other", "misc", "miscellaneous",
  "uncategorised", "uncategorized", "general",
  "reel", "reels", "video", "videos", "clip", "clips", "short", "shorts",
  "post", "posts", "content",
]);

// Turn a free-text model category into a clean, stable slug — or null. Self-
// expanding: we do NOT restrict to a fixed list; whatever subject the model
// names becomes its own bucket. We only sanitize (lowercase, hyphenate) and
// guard against junk (empty, nullish words, runaway strings).
export function slugifyCategory(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")   // spaces / punctuation → hyphen
    .replace(/^-+|-+$/g, "");       // trim leading/trailing hyphens
  if (!s || NULLISH_CATEGORIES.has(s)) return null;
  if (s.length > 32) return null;   // runaway string → treat as no category
  return s;
}

// Coerce a model-proposed category to a stored slug or null. A recipe is always
// "recipe" regardless of what the model said (content_type is authoritative there).
export function normalizeCategory(value, contentType) {
  if (contentType === "recipe") return "recipe";
  return slugifyCategory(value);
}

// Instruction fragment listing categories already in the library, so the model
// REUSES an existing slug instead of minting a near-duplicate. "" when none.
export function existingCategoriesNote(keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) return "";
  return "Categories already in the owner's library — REUSE an exact slug from " +
    "here whenever the video reasonably fits one, rather than inventing a " +
    "near-duplicate: " + list.join(", ") + ".";
}

// One shared description, reused by the structuring prompt AND the backfill
// classifier, so both label reels the same way.
export const CATEGORY_GUIDE = `- "stocks": investing, the stock market, specific tickers, company financials, personal finance and investing.
- "growth": personal development and self-improvement — habits, productivity, mindset, discipline, careers, learning.
- "fitness": exercise, training, athletic performance, sleep, and physical wellness or nutrition for performance.
- "relationships": dating, marriage, parenting, friendship, communication, and emotional connection.
- "medical": health conditions, symptoms, medical tests and biomarkers, treatments, longevity, and clinical health.
- "branding": brand strategy and identity — positioning, naming, packaging, brand voice, a brand's visual identity.
- "marketing": marketing and growth — ads, content strategy, social media, copywriting, sales, and funnels, INCLUDING using an AI tool to do marketing work (the subject is marketing, not AI).
- "seo": search — SEO, ranking on Google, keywords, backlinks, technical SEO, local search, and how AI search surfaces a site.
- "design": visual, graphic, UI, and UX design — typography, layout, design systems, and design tools, INCLUDING using an AI tool to do design work (the subject is design, not AI).
- "ai": AI and technology ITSELF as the subject — new AI capabilities, models, tools being reviewed or explained, prompting technique, developer tooling. NOT "using an AI tool to do X" for some other purpose — that files under X's own category (a reel about using ChatGPT for email outreach is "marketing", not "ai"; using Claude for design work is "design", not "ai"). Ask: is this video ABOUT AI, or just USING an AI tool to talk about something else? Only the former is "ai".
- "recipe": a cooking recipe (usually content_type "recipe").`;

export const SYSTEM_PROMPT = `You turn a short social video's transcript, on-screen text, and caption into a single clean JSON object. You are precise and never fabricate.

Hard rules:
- NEVER invent facts. Never guess ingredient quantities, cooking temperatures, times, or servings.
- If a detail was not stated in the source, use null (for scalars) or omit it from lists, and add a short note to "missing_information" (recipes) or leave it out (synopsis).
- Prefer information that was explicitly spoken or shown. Do not infer beyond what the source supports.
- Write in plain language. No hyphens in compound modifiers.

OUTPUT LANGUAGE — every field must be English:
- ALWAYS write EVERY output field in English: title, description, ingredient names, step text, summary, notes, everything. If the source (spoken, on-screen, or caption) is in another language — Hindi, Marathi, Spanish, Tagalog, anything — TRANSLATE it to natural English. Do not leave ANY original-language text in the JSON.
- A transliterated common word is NOT a proper noun and MUST be translated: e.g. "कैप्सीकम" → "capsicum", "ऑनियन" → "onion", "दही" → "yogurt", "जीरा" → "cumin", "घरम मसाला" → "garam masala", "मिनट" → "minutes". Only genuine brand names, people, place names, handles, and URLs stay as-is.
- Translation is NOT invention: rendering a stated fact in English is required, not a guess. Keep all numbers, quantities, measurements, temperatures, and times exactly as stated (translate only the words around them). This is not license to add detail — still use null and note the gap when a detail was never stated.
- FINAL CHECK before returning: scan every string in the JSON. If any word is still in a non-Latin script or an obviously non-English word that is not a real brand/person/place, translate it. The output must read as if originally written in English.

Reading the TIMELINE:
- You are given one chronological timeline. [SPOKEN] lines are what was said; [ON SCREEN] lines are text that appeared in the video at that moment. Timestamps are seconds from the start.
- Use the timestamps to connect the two. On-screen text that appears while a related point is being spoken is almost always part of that same step, ingredient, or claim.
- SOURCE PRECEDENCE: for exact values — quantities, measurements, temperatures, times, prices, ticker symbols, URLs, handles, and names — ON SCREEN text is more reliable than the transcript, because speech recognition mangles numbers and proper nouns. When the two disagree on a value, take the on-screen version.
- For meaning, intent, and explanation, the spoken track is usually richer. Use it for the narrative.
- Capture EVERY distinct piece of on-screen text that carries information. Do not summarize away a list, a set of steps, or a set of numbers that was shown on screen but never spoken aloud.
- Ignore on-screen text that is pure interface or branding: usernames, follower counts, "follow for more", watermarks, sponsor tags, and captions repeated verbatim from the post. A line that states the video's SUBJECT is never "branding", however short it is — a lone on-screen hook is often the only statement of what the post is about, so it must be used, not filtered out.
- BACKGROUND MUSIC IS NOT THE CONTENT. Many reels have no speech at all, just a song, and the transcript then holds SONG LYRICS. Signs: the transcript is short and poetic, rhymes, repeats a refrain, or has nothing to do with the on-screen text or caption. When that happens, treat the transcript as NOISE and build everything from the on-screen text and the caption. Never write a summary about the imagery of a lyric. If the only substance is one on-screen line, summarize THAT line and leave the rest of the fields empty.

THE CAPTION IS A PRIMARY SOURCE — not an afterthought:
- Many posts put the REAL content in the caption: the full recipe (INGREDIENTS + steps), the list, the how-to, or the main takeaway — while the video is B-roll and the spoken audio is unrelated small talk (e.g. someone says "I'll be home in 20 minutes" while the caption holds an entire recipe).
- Read the ENTIRE caption and treat it as EQUALLY authoritative as the spoken and on-screen tracks. If the caption contains a structured recipe, an ingredient list, numbered steps, or the substantive content, EXTRACT FROM IT fully — do not skip it because the audio was thin.
- Decide content_type from the RICHEST source across all three tracks combined, NOT just the transcript. If the caption is a recipe but the audio is chit-chat, content_type is "recipe" and you fill the recipe from the caption. Never file substantive content as "story" just because the spoken track was sparse.

First decide content_type — one of:
recipe, howto, business, education, story, review, travel, fitness, other.

Then choose ONE "category" — a short lowercase slug for the video's main SUBJECT, for the owner's personal library.
- These well-known categories already exist; if the video fits one, REUSE its exact slug:
${CATEGORY_GUIDE}
- You may also be given a list of OTHER categories already in the library. Prefer reusing an existing slug (well-known or from that list) whenever the subject reasonably fits — this keeps the library from splintering into near-duplicates.
- Only if the subject fits NONE of the existing categories, MINT a new slug: lowercase, one or two words, hyphenated (e.g. "travel", "home-decor", "parenting"). Name the general subject broadly and reusably — not a phrase specific to this one video.
- Use null ONLY when the video has no coherent subject to file under at all.

Then output EXACTLY this JSON shape (no markdown, no commentary):

{
  "content_type": "<one of the types above>",
  "category": "<a lowercase category slug, or null>",
  "recipe": {                 // include ONLY when content_type is "recipe", else null
    "title": "",
    "description": "",
    "ingredients": [],        // strings; include quantities only if stated
    "instructions": [],       // ordered strings
    "equipment": [],
    "prep_time": null,        // string like "10 min" only if stated, else null
    "cook_time": null,
    "servings": null,
    "missing_information": [] // e.g. "Cooking temperature was not provided."
  },
  "synopsis": {               // include ONLY when content_type is NOT "recipe", else null
    "title": "",
    "universal_point": "",    // the transferable principle, stated as a general truth — see "The universal point" below
    "summary": "",            // one sentence of SUBSTANCE — the actual claim/method, never "the speaker shares..."
    "detailed_summary": "",   // a short paragraph
    "entities": [             // concrete, lookup-able things the video names; [] if it names nothing concrete
      {
        "rank": null,         // e.g. "#5" if the video ranks them, else null
        "name": "",           // canonical name, e.g. "Superpowers"
        "author": null,       // maker/author, e.g. "Jesse Vincent (obra)" or "Anthropic, official", else null
        "stat": null,         // a metric the video cites, e.g. "~752K installs", else null
        "description": "",    // 1-2 sentences: what it does and why it matters, grounded in the video
        "quote": null,        // a short verbatim line from the transcript, else null
        "install": null,      // exact install/access command(s) if the video gives one, else null
        "links": []           // official URLs you are confident are correct: [{ "label": "GitHub", "url": "https://..." }]
      }
    ],
    "verification_note": "",  // what the video overstates or gets wrong, AND what is actually true underneath; "" if it is straight
    "key_takeaways": [],
    "action_items": [],
    "resources": [],          // names/links mentioned, if any
    "stocks": [               // publicly traded companies/tickers the video names as worth watching or buying; [] if none
      { "ticker": "", "name": "", "why": "" }   // why = one line on why it came up / what to watch
    ],
    "movements": [            // physical things to DO — exercises, stretches, breathwork, self-massage; [] if none
      {
        "name": "",           // what the video calls it
        "lookup": "",         // the plain, standard name of the same movement, e.g. "bodyweight squat", "" if it has none
        "kind": "exercise",   // "exercise" | "practice" (massage, drainage, breathwork, mobility) | "intake" (herbs, supplements, food)
        "how": "",            // 1-2 sentences on performing it, from the video
        "targets": [],        // body parts/muscles the VIDEO names; [] if it names none — never infer anatomy
        "dose": null,         // EXACTLY as stated, e.g. "3 sets of 10" or "hold 30s each side"; null if not stated
        "when": null,         // "morning" | "evening" only if the video says so; else null
        "caution": null       // a warning the video gives; null if it gives none
      }
    ]
  }
}

Entities — the actionable core:
- When the video names specific, lookup-able things — tools, products, plugins, libraries, books, companies, people, places — extract EACH into "entities". Give its canonical name and author/maker, a 1-2 sentence description of what it does and why it matters (grounded in the video, not invented), the exact install/access command if one exists, and the official primary link (prefer the source repo or the maker's own site over third-party blogs).
- For links, give the URL you are MOST confident is the official source. Do not pad with guesses — each link you output will be independently checked and dropped if it does not resolve, so a wrong link is worse than none. When unsure of the exact URL, leave "links" empty rather than guessing.
- ALWAYS try to give a direct link when the entity is a piece of software, an app, a website, a library, a model, or a code repo — the whole point is that the owner can TAP it instead of searching. Reach for the obvious official home: the GitHub/GitLab repo ("github.com/<org>/<repo>"), the package page (npm/PyPI/Hugging Face), the app's own domain, or the App Store / Play Store listing. Give the canonical root URL you are confident is real; the verifier will confirm it, so a plausible official root is better than nothing, but a made-up deep path is not. For books, prefer the publisher or author page; for people, their official site or primary profile.
- Preserve any ranking or ordering the video uses (put the rank string in "rank").
- If the video names nothing concrete and lookup-able, return "entities": [].

Action items must be prescriptive and specific — say which items to act on first and why, never a vague restatement like "install the things".

SUMMARY STYLE — write the substance, never narrate the video:
- The reader wants what the video KNOWS, not a report that a video happened. Never write about "the speaker", "the creator", "the video", "they explain", "they share", "they reveal". Delete that frame and state the thing itself.
- BAD: "The speaker shares their strategy for making $10,000 to $35,000 per month on Facebook by sharing other people's content, and explains how others can do the same."
- GOOD: "Reposting other people's videos to a Facebook page can earn $10,000 to $35,000 a month, because Facebook pays out of an ad pool for watch time and does not require the content to be original."
- Same rule for "detailed_summary": give the mechanism, the numbers, and the conditions — how it actually works, what it depends on, and what it costs — not a description of what was covered.
- Attribute only when the claim's SOURCE is the point (a named person's own results, a specific study). "He claims" is worth writing when the claim is contested; it is not a substitute for saying what the claim is.

THE UNIVERSAL POINT — "universal_point":
- One or two sentences naming the transferable principle underneath this specific video: the part that stays true after the platform, the tool, the niche, and the person are stripped away. This is the single most valuable field for the reader; a specific tactic expires, the principle does not.
- Write it as a general truth in the present tense, standing on its own. It must make sense to someone who never watches the video.
- GOOD: "Repetition turns an idea into a default."
- GOOD: "Distribution you rent can be taken away; an audience you own cannot."
- BAD: "The video teaches you about repetition." (narrates the video)
- BAD: "Post 3 times a day for 3 months." (that is a tactic, it belongs in action_items)
- Do not force one. If the video is purely procedural (a specific recipe, a click-by-click setup) with no idea that generalises, leave it "".

VERIFICATION NOTE — the honest read, "verification_note":
- Videos overstate. Say plainly where this one does, then say what IS true underneath, so the reader keeps the useful part without swallowing the wrong part. One to three sentences.
- Cover any of: a mechanism explained wrongly or oversimplified (especially pop neuroscience, biology, and economics), a number presented without its conditions, survivorship or selection bias, results that depend on unstated advantages, hype labels ("leaked", "secret", "banned") on things that are public, and anything asserted as settled that is actually contested.
- Concede what is real. The pattern is: name the overstatement, then name the true version. WORKED EXAMPLE — a video claims writing a sentence 100 times "rewires your frontal cortex": "That neuroscience explanation is oversimplified — writing a sentence 100 times does not rewire the frontal cortex the way he describes. But the underlying phenomenon is real: repeated attention and rehearsal strengthen a mental association and make it easier to retrieve."
- Judge only against what is well established. Do not invent studies, statistics, or citations to argue with the video — the never-fabricate rule applies here too. When you cannot assess a claim, say what would have to be true for it to hold rather than guessing.
- If the video is straightforward and its claims are reasonable, leave it "". Do not manufacture a criticism.

Movements — the "movements" array: extract a movement ONLY when the video actually
teaches something to DO with the body — an exercise, a stretch, a breathing drill, a
self-massage or pressure technique. A video that merely discusses fitness or health
without instructing a movement returns []. Rules, all of them the never-fabricate rule
applied to a health context, where an invented detail is worse than a missing one:
- "dose" is EXACTLY what was said and null otherwise. Never supply a rep count, a hold
  time or a frequency the video did not give. "Not stated" is a useful answer; an
  invented number is instruction nobody gave.
- "targets" lists only body parts the video NAMES. Do not infer which muscles a movement
  works from your own knowledge of anatomy — that is a claim the video did not make.
- "when" is set only if the video places it in a morning or evening routine.
- "caution" carries a warning the video gives; never invent a contraindication, and never
  omit one it did give.
- "lookup" is the ordinary, widely used name for the same movement so it can be matched
  against a standard exercise library — "bodyweight squat" for "air squat", "glute bridge"
  for "hip raise". If the movement has no standard equivalent, use "".
- "kind" splits by whether there is a PHYSICAL ACTION to depict, which is what decides
  whether an illustration can honestly be drawn. "exercise" is training; "practice" is any
  other physical thing done to or with the body — massage, lymphatic drainage, breathwork,
  mobility work, self-manipulation; "intake" is anything swallowed, applied or consumed —
  a herb, a supplement, a tea, a diet change — where there is no movement to show at all.
  When in doubt between exercise and practice, "practice"; when in doubt whether anything
  is physically performed, "intake".

Stocks — the "stocks" array: include a publicly traded company ONLY if that specific company or ticker was actually named in the video as an investment, a stock to watch, or a company to buy. Give the ticker symbol only when you are confident it is correct; if you are unsure of the exact symbol, OMIT that stock entirely — never guess a ticker. Leave the array [] when no tradable company was named. This is the same never-fabricate rule as everywhere else.

Return only the JSON object.`;

// mm:ss, so the model reads time as time rather than as a bare float.
function stamp(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Interleave what was SAID with what was SHOWN, in time order.
 *
 * This is the change that makes on-screen text actually usable. Previously the
 * model got two separate blobs with no timing, so it could not tell that a
 * temperature flashed on screen at the exact moment the narrator said "bake
 * it". Now both tracks arrive on one clock.
 */
export function buildTimeline({ segments = [], onScreen = [] }) {
  const events = [];
  for (const s of segments) {
    if (s?.text) events.push({ t: Number(s.start) || 0, kind: "SPOKEN", text: s.text.trim() });
  }
  for (const o of onScreen) {
    if (o?.text) events.push({ t: Number(o.t) || 0, kind: "ON SCREEN", text: o.text.trim() });
  }
  events.sort((a, b) => a.t - b.t || (a.kind === "SPOKEN" ? -1 : 1));
  return events
    .map((e) => `[${stamp(e.t)}] [${e.kind}] ${e.text.replace(/\n/g, "\n            ")}`)
    .join("\n");
}

export function buildUserContent({ transcript, caption, onScreenText, segments, onScreen }) {
  const parts = [];
  const timeline = buildTimeline({ segments, onScreen });

  if (timeline) {
    parts.push("TIMELINE (spoken audio and on-screen text, in time order):\n" + timeline);
  } else {
    // Fallback for callers without timing (or when both tracks came back empty).
    parts.push("TRANSCRIPT (spoken audio):\n" + (transcript?.trim() || "(none)"));
    parts.push("\n\nON-SCREEN TEXT (read from video frames):\n" + (onScreenText?.trim() || "(none)"));
  }

  // The flat transcript still goes in when we have a timeline built only from
  // on-screen text — otherwise the spoken track would be missing entirely.
  if (timeline && !segments?.length && transcript?.trim()) {
    parts.push("\n\nTRANSCRIPT (spoken audio, no timing available):\n" + transcript.trim());
  }

  parts.push("\n\nCAPTION (from the post):\n" + (caption?.trim() || "(none)"));
  return parts.join("");
}

// ── Overnight synthesis ──────────────────────────────────────────────────
// A second pass over the WHOLE night's saves. Individual cards already exist;
// this weaves them into one action-first brief at the top of the digest. The
// saves are treated as deliberate steps in a direction of growth, not a random
// pile — the job is to surface the through-line and push toward action.
export const SYNTHESIS_PROMPT = `You are the strategist reading everything one person saved over a day. These saves are NOT random — they are steps in a direction of growth. Your job: read all of them together and produce ONE brief that moves the reader into action fast.

Hard rules:
- NEVER invent facts, numbers, tickers, or company names. Use only what the items support.
- For stocks: include a company ONLY if that specific company or ticker was actually mentioned in an item. Give the ticker symbol only when you are confident it is correct; if unsure of the symbol, omit that stock entirely. Never guess a ticker.
- Business ideas must be phrased as an action the reader can take, starting with a verb.
- Write in plain language, second person ("you"), direct and energizing. No hyphens in compound modifiers.
- If a section has nothing real to say, return an empty array (or "" for strings). Do not pad.

Output EXACTLY this JSON shape (no markdown, no commentary):

{
  "theme": "",           // one or two sentences: the overall theme tying the saves together
  "direction": "",       // one short paragraph: the direction of growth these saves point toward, and the single most important move now
  "synthesis": "",       // one short paragraph weaving the recurring concepts together across items
  "concepts": [],        // 3-7 short phrases: the ideas that recur or connect across items
  "action_items": [],    // concrete next actions, imperative, most important first
  "business_ideas": [],  // business ideas as actions to take (verb first); empty if none
  "stocks": [            // empty if no specific stock/company was mentioned
    { "ticker": "", "name": "", "why": "" }   // why = one line on why it came up / what to look at
  ]
}

Return only the JSON object.`;

// Compact one item down to what synthesis needs — title, type, the one-line
// summary, and any takeaways / actions / resources already extracted per item.
function synthItem(r, i) {
  const j = r.structured_json || {};
  const bits = [`[${i + 1}] (${r.content_type || "other"}) ${r.title || j.title || "Untitled"}`];
  const summary = r.summary || j.summary || j.description || "";
  if (summary) bits.push("  summary: " + summary);
  if (j.detailed_summary) bits.push("  detail: " + j.detailed_summary);
  // The principle is the most connectable line an item has — feed it to the
  // synthesis so the "big picture" brief ties ideas together, not tactics.
  if (j.universal_point) bits.push("  principle: " + j.universal_point);
  if (j.entities?.length) {
    bits.push("  named: " + j.entities.map((e) => {
      const link = e.links?.[0]?.url ? " <" + e.links[0].url + ">" : "";
      return (e.name || "") + (e.author ? " by " + e.author : "") + link;
    }).filter(Boolean).join(" | "));
  }
  if (j.key_takeaways?.length) bits.push("  takeaways: " + j.key_takeaways.join(" | "));
  if (j.action_items?.length) bits.push("  actions: " + j.action_items.join(" | "));
  if (j.resources?.length) bits.push("  resources: " + j.resources.join(" | "));
  return bits.join("\n");
}

export function buildSynthesisContent(results) {
  return "Here are the items saved, each already summarized:\n\n" +
    results.map(synthItem).join("\n\n");
}

// ── Category-only classifier (backfill) ───────────────────────────────────
// A cheap, standalone pass for EXISTING reels: it reads the already-stored
// title/summary/detail (the video is long gone) and returns just a category,
// so we don't re-run the whole expensive structuring + entity verification.
// New reels get their category inline from SYSTEM_PROMPT instead.
export const CATEGORY_PROMPT = `You sort a short social video into ONE library category for its owner.

EVIDENCE, IN ORDER OF WEIGHT:
1. The title and summary. These were already written by reading the whole video, so they are
   the most reliable statement of what it is about. When they are clear, they decide it.
2. The caption and the text shown on screen. Use these to CONFIRM, to break a tie, or — most
   importantly — when the title and summary are thin, empty or "Untitled". On-screen text is
   raw and noisy (fragments, handles, interface labels), so never let it override a clear
   title; but a reel whose only usable evidence is on screen must still be filed correctly
   rather than left uncategorised.
Ignore interface furniture: follow/like/share, view counts, watermarks, and the poster's own
handle are never the subject.

Return EXACTLY this JSON, nothing else: {"category": "<a lowercase slug, or null>"}

These well-known categories already exist; reuse the exact slug when one fits:
${CATEGORY_GUIDE}

Prefer reusing an existing category (including any others listed in the request). If the subject fits none of them, MINT a new broad lowercase slug (one or two hyphenated words) naming the general subject — do not force a fit into a wrong bucket. Return {"category": null} only if there is no coherent subject at all. Output only the JSON object.`;

// How much raw on-screen text to hand the classifier. This is the CHEAP step —
// a whole reel's OCR can run to thousands of characters, and paying that on
// every backfilled row would undo the reason a small model is used here. A few
// hundred characters is plenty to recognise a subject.
const CATEGORY_OCR_CAP = 600;
const CATEGORY_CAPTION_CAP = 400;

/**
 * Read a structuring result the SAME way everywhere.
 *
 * `structured_json` is FLAT and holds either the recipe shape or the synopsis
 * shape, never both, and `content_type` is the only thing telling the renderer
 * which one it is (gotcha #53). Deciding that in two places is how they drift:
 * process-queue picked by TYPE while backfill-entities did `synopsis || recipe`
 * and had no `description` fallback, so a reel the model newly recognised as a
 * RECIPE got its recipe title written over a synopsis summary that was never
 * replaced — leaving "Easy Midweek Courgette and Tomato Pasta" summarised as
 * "a conversation about someone arriving home in 20 minutes", still typed
 * "story" and still filed under relationships.
 *
 * Returns { type, sub, title, summary }. A recipe carries `description` where a
 * synopsis carries `summary`; both land in `summary` here.
 */
export function selectResult(out = {}) {
  const type = out.content_type || "other";
  const sub = (type === "recipe" ? out.recipe : out.synopsis) || out.recipe || out.synopsis || {};
  return {
    type,
    sub,
    title: sub.title || "",
    summary: sub.summary || sub.description || "",
  };
}

export function buildCategoryContent(r) {
  const j = r.structured_json || {};
  const bits = [];

  // PRIMARY: written by a model that read the whole video.
  const title = r.title || j.title || "";
  const isUntitled = !title.trim() || /^(untitled|unknown|n\/a)$/i.test(title.trim());
  if (title && !isUntitled) bits.push(`title: ${title}`);
  const summary = r.summary || j.summary || j.description || "";
  if (summary) bits.push(`summary: ${summary}`);
  if (j.detailed_summary) bits.push(`detail: ${j.detailed_summary}`);

  // SECONDARY: the raw tracks. Included ALWAYS, not just as a fallback, because
  // a title can be confidently wrong as easily as it can be missing — but
  // labelled and ordered after the summary so the prompt's precedence is
  // visible in the input itself, not just asserted in the instructions.
  const caption = (r.caption || "").trim();
  if (caption) bits.push(`caption (raw): ${caption.slice(0, CATEGORY_CAPTION_CAP)}`);

  const onScreen = Array.isArray(r.on_screen_text)
    ? r.on_screen_text.map((e) => (typeof e === "string" ? e : e?.text || "")).filter(Boolean).join(" / ")
    : String(r.on_screen_text || "");
  if (onScreen.trim()) bits.push(`on-screen text (raw, noisy): ${onScreen.trim().slice(0, CATEGORY_OCR_CAP)}`);

  // content_type goes LAST and is labelled as a format, not a subject. It used
  // to lead, which actively misled: "story" / "howto" / "other" say nothing
  // about what a reel is ABOUT, and on exactly the reels this step needs to
  // rescue the type is stale — a security post misread as song lyrics was typed
  // "story", and leading with that primed the model to answer "relationships"
  // even with a title reading "Securing MCP Servers". A recipe is handled by
  // normalizeCategory regardless, so nothing depends on it being prominent.
  bits.push(`format (not the subject): ${r.content_type || "other"}`);

  // Said out loud when the written fields are useless, so a thin row does not
  // look to the model like a reel with genuinely no subject.
  if (isUntitled && !summary) {
    bits.push("note: this reel has no usable title or summary — decide from the caption and on-screen text.");
  }
  return bits.join("\n");
}
