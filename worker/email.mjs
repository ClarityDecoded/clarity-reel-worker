// Morning digest email via Resend (same account + verified sender the portal
// already uses). One email summarizing everything processed overnight: recipes
// first, then synopses, then anything that failed. Built with plain string
// concatenation (no backticks) to match the house Edge Function style.

import { config } from "./config.mjs";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function list(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return "<ul style='margin:6px 0 12px;padding-left:20px;color:#333;font-size:14px;line-height:1.6;'>" +
    items.map((i) => "<li>" + esc(i) + "</li>").join("") + "</ul>";
}

function card(inner) {
  return "<div style='border:1px solid #eee;border-radius:12px;padding:18px 20px;margin:0 0 16px;'>" +
    inner + "</div>";
}

function recipeCard(r) {
  const j = r.structured_json?.recipe || r.structured_json || {};
  const meta = [
    j.servings ? "Serves " + esc(j.servings) : "",
    j.prep_time ? "Prep " + esc(j.prep_time) : "",
    j.cook_time ? "Cook " + esc(j.cook_time) : "",
  ].filter(Boolean).join("  •  ");
  return card(
    "<div style='font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#AD8800;margin-bottom:6px;'>Recipe</div>" +
    "<div style='font-size:18px;font-weight:600;color:#111;'>" + esc(r.title || j.title) + "</div>" +
    (j.description ? "<p style='color:#555;font-size:14px;margin:6px 0;'>" + esc(j.description) + "</p>" : "") +
    (meta ? "<p style='color:#888;font-size:13px;margin:4px 0 10px;'>" + meta + "</p>" : "") +
    (j.ingredients?.length ? "<div style='font-weight:600;font-size:13px;color:#333;'>Ingredients</div>" + list(j.ingredients) : "") +
    (j.missing_information?.length
      ? "<div style='font-weight:600;font-size:13px;color:#D15604;'>Not stated in the video</div>" + list(j.missing_information)
      : "") +
    "<a href='" + config.appUrl + "/reel/" + r.id + "' style='color:#AD8800;font-size:14px;font-weight:600;'>Open full recipe →</a>",
  );
}

// Compact entity list for the email: name (author) + first verified link each.
function entityList(entities) {
  if (!Array.isArray(entities) || !entities.length) return "";
  const rows = entities.map((e) => {
    const rank = e.rank ? "<span style='color:#AD8800;font-weight:700;'>" + esc(e.rank) + "</span> " : "";
    const name = "<strong>" + esc(e.name) + "</strong>";
    const by = e.author ? " <span style='color:#888;'>" + esc(e.author) + "</span>" : "";
    const link = e.links?.[0]?.url
      ? " — <a href='" + esc(e.links[0].url) + "' style='color:#AD8800;'>" + esc(e.links[0].label || "link") + " →</a>"
      : "";
    return "<li>" + rank + name + by + link + "</li>";
  }).join("");
  return "<ul style='margin:6px 0 12px;padding-left:20px;color:#333;font-size:14px;line-height:1.7;'>" + rows + "</ul>";
}

function synopsisCard(r) {
  const j = r.structured_json?.synopsis || r.structured_json || {};
  return card(
    "<div style='font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin-bottom:6px;'>" +
      esc(r.content_type || "Video") + "</div>" +
    "<div style='font-size:18px;font-weight:600;color:#111;'>" + esc(r.title || j.title) + "</div>" +
    // The transferable principle leads the card too — it's the part still worth
    // reading a month later. Absent on purely procedural reels.
    (j.universal_point
      ? "<p style='border-left:3px solid #AD8800;padding:2px 0 2px 11px;margin:8px 0;color:#111;font-size:15px;font-weight:600;line-height:1.45;'>" + esc(j.universal_point) + "</p>"
      : "") +
    (j.summary ? "<p style='color:#555;font-size:14px;margin:6px 0;'>" + esc(j.summary) + "</p>" : "") +
    (j.entities?.length
      ? "<div style='font-weight:600;font-size:13px;color:#333;'>" + j.entities.length + " things named</div>" + entityList(j.entities)
      : "") +
    (j.action_items?.length ? "<div style='font-weight:600;font-size:13px;color:#333;'>Action items</div>" + list(j.action_items) : "") +
    (j.verification_note
      ? "<p style='background:#FCFAF2;border:1px solid #EAD9A0;border-radius:8px;padding:8px 11px;color:#7a5f00;font-size:13px;margin:6px 0 10px;'>⚠️ " + esc(j.verification_note) + "</p>"
      : "") +
    "<a href='" + config.appUrl + "/reel/" + r.id + "' style='color:#AD8800;font-size:14px;font-weight:600;'>Open full summary →</a>",
  );
}

// A stock the synthesis surfaced: real chart image plus a link out to the quote
// page. The chart is Finviz's node endpoint hit DIRECTLY (the old chart.ashx path
// now 301/302-redirects, which Gmail's image proxy can drop) — one hop, real PNG.
// If the image is ever blocked the surrounding link still works.
function stockRow(s) {
  const t = String(s?.ticker || "").trim().toUpperCase().replace(/[^A-Z.\-]/g, "");
  if (!t) return "";
  const chart = "https://charts2-node.finviz.com/chart?w=466&h=219&bw=2&bm=1&bb=1" +
    "&t=" + t + "&tf=d&s=linear&pm=0&am=0&ct=candle_stick";
  const quote = "https://finance.yahoo.com/quote/" + t;
  return "<div style='margin:0 0 14px;'>" +
    "<a href='" + quote + "' style='font-size:15px;font-weight:700;color:#111;text-decoration:none;'>" +
      esc(t) + (s.name ? " <span style='color:#888;font-weight:500;'>" + esc(s.name) + "</span>" : "") + "</a>" +
    (s.why ? "<div style='color:#555;font-size:13px;margin:2px 0 6px;'>" + esc(s.why) + "</div>" : "") +
    "<a href='" + quote + "'><img src='" + chart + "' alt='" + esc(t) + " chart' width='466' " +
      "style='display:block;max-width:100%;border:1px solid #eee;border-radius:8px;'/></a>" +
    "<a href='" + quote + "' style='color:#AD8800;font-size:12px;font-weight:600;'>Quote, news &amp; fundamentals →</a>" +
    "</div>";
}

function briefBlock(label, inner) {
  if (!inner) return "";
  return "<div style='font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#AD8800;margin:16px 0 6px;'>" +
    label + "</div>" + inner;
}

// The overnight synthesis — one action-first brief woven from every save, shown
// above the individual cards. Any empty section is simply omitted.
function briefSection(b) {
  if (!b) return "";
  const hasContent = b.theme || b.direction || b.synthesis ||
    b.action_items?.length || b.business_ideas?.length ||
    b.concepts?.length || b.stocks?.length;
  if (!hasContent) return "";

  let inner = "";
  if (b.theme) {
    inner += "<div style='font-size:18px;font-weight:700;color:#111;line-height:1.4;margin:0 0 4px;'>" +
      esc(b.theme) + "</div>";
  }
  if (b.direction) {
    inner += briefBlock("Where this is pointing",
      "<p style='color:#333;font-size:14px;line-height:1.6;margin:0;'>" + esc(b.direction) + "</p>");
  }
  if (b.action_items?.length) {
    inner += briefBlock("Do this next", list(b.action_items));
  }
  if (b.business_ideas?.length) {
    inner += briefBlock("Business ideas to act on", list(b.business_ideas));
  }
  if (b.stocks?.length) {
    const rows = b.stocks.map(stockRow).filter(Boolean).join("");
    if (rows) inner += briefBlock("Stocks mentioned", rows);
  }
  if (b.synthesis) {
    inner += briefBlock("How it connects",
      "<p style='color:#333;font-size:14px;line-height:1.6;margin:0;'>" + esc(b.synthesis) + "</p>");
  }
  if (b.concepts?.length) {
    inner += briefBlock("Threads",
      "<div style='margin:2px 0;'>" + b.concepts.map((c) =>
        "<span style='display:inline-block;background:#f4f0e2;color:#7a5f00;font-size:12px;" +
        "padding:4px 10px;border-radius:999px;margin:0 6px 6px 0;'>" + esc(c) + "</span>").join("") +
      "</div>");
  }

  return "<div style='border:1px solid #EAD9A0;background:#FCFAF2;border-radius:14px;padding:20px 22px;margin:0 0 24px;'>" +
    "<div style='font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#AD8800;font-weight:700;margin-bottom:8px;'>The big picture</div>" +
    inner + "</div>";
}

// Returns true when the digest was sent OR there was nothing to send (both are
// "safe to stamp emailed_at"); false only when a send was needed but failed.
export async function sendDigest(results, failures, brief) {
  if (!config.resend.key) {
    console.warn("RESEND_API_KEY not set — skipping digest email.");
    return false;
  }
  if (!results.length && !failures.length) {
    console.log("Nothing to report; no digest sent.");
    return true;
  }

  const recipes = results.filter((r) => r.content_type === "recipe");
  const others = results.filter((r) => r.content_type !== "recipe");

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  let body = "<div style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px;'>";
  body += "<div style='font-size:13px;color:#888;'>" + esc(dateStr) + "</div>";
  body += "<h1 style='font-size:22px;color:#111;margin:4px 0 20px;'>Your overnight extract" +
    (results.length ? " — " + results.length + " item" + (results.length === 1 ? "" : "s") : "") + "</h1>";

  body += briefSection(brief);

  if (recipes.length) {
    body += "<h2 style='font-size:14px;color:#AD8800;text-transform:uppercase;letter-spacing:.06em;'>Recipes</h2>";
    body += recipes.map(recipeCard).join("");
  }
  if (others.length) {
    body += "<h2 style='font-size:14px;color:#888;text-transform:uppercase;letter-spacing:.06em;'>Summaries</h2>";
    body += others.map(synopsisCard).join("");
  }
  if (failures.length) {
    body += "<h2 style='font-size:14px;color:#D15604;text-transform:uppercase;letter-spacing:.06em;'>Couldn't process</h2>";
    body += "<ul style='color:#777;font-size:13px;line-height:1.7;'>" +
      failures.map((f) => {
        const day = f.at
          ? "<span style='color:#999;'>" + esc(new Date(f.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })) + "</span> · "
          : "";
        return "<li>" + day + esc(f.url) + " — " + esc(f.reason) + "</li>";
      }).join("") + "</ul>";
  }
  body += "</div>";

  const ok = await sendEmail("Your overnight extract — " + dateStr, body);
  if (ok) console.log("Digest sent to", config.ownerEmail);
  return ok;
}

// Low-level send. Strips any stray non-printable-ASCII from the key (a pasted
// secret can carry an invisible U+2028 etc.) — fetch header values must be Latin1.
async function sendEmail(subject, html) {
  if (!config.resend.key) {
    console.warn("RESEND_API_KEY not set — skipping email.");
    return false;
  }
  const authKey = String(config.resend.key).replace(/[^\x21-\x7E]/g, "");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + authKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: [config.ownerEmail],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error("Email failed:", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

// Where to get a new key, and where it goes. The secret link points at
// RAPIDAPI_KEYS (plural) on purpose — config.mjs reads KEYS first and only falls
// back to the singular RAPIDAPI_KEY, so a key added to the singular one is
// IGNORED whenever the plural is set.
const RAPIDAPI_SIGNUP_URL =
  "https://rapidapi.com/safesite15/api/instagram-downloader-download-instagram-stories-videos4";
// Derived from GITHUB_REPOSITORY, which Actions sets on every run — so the
// "add a key here" link follows the worker if it moves to another repo instead
// of sending you to a settings page that no longer runs this job.
const RAPIDAPI_SECRET_URL =
  "https://github.com/" +
  (process.env.GITHUB_REPOSITORY || "ClarityDecoded/clarity-portal") +
  "/settings/secrets/actions/RAPIDAPI_KEYS";

// Sent when every RapidAPI key's monthly quota is spent and reels are still waiting.
export async function sendResolverAlert(status, stillQueued) {
  const html =
    "<div style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;'>" +
    "<h1 style='font-size:20px;color:#111;margin:0 0 12px;'>Reel tool: out of resolver quota</h1>" +
    "<p style='font-size:15px;line-height:1.6;color:#3a3a40;'>All <strong>" + status.total +
    "</strong> RapidAPI key" + (status.total === 1 ? "" : "s") + " hit their monthly limit, so " +
    "<strong>" + stillQueued + "</strong> reel" + (stillQueued === 1 ? "" : "s") +
    " couldn't be processed and are still queued.</p>" +
    "<p style='font-size:15px;line-height:1.6;color:#3a3a40;'>Add another RapidAPI account key to the " +
    "<strong>RAPIDAPI_KEYS</strong> secret (comma-separated) and they'll clear on the next run.</p>" +
    "<p style='font-size:15px;line-height:1.6;color:#3a3a40;margin:18px 0 6px;'>Get additional keys here:<br>" +
    "<a href='" + RAPIDAPI_SIGNUP_URL + "' style='color:#AD8800;'>" + RAPIDAPI_SIGNUP_URL + "</a></p>" +
    "<p style='font-size:15px;line-height:1.6;color:#3a3a40;margin:12px 0 0;'>Add them here:<br>" +
    "<a href='" + RAPIDAPI_SECRET_URL + "' style='color:#AD8800;'>" + RAPIDAPI_SECRET_URL + "</a></p>" +
    "</div>";
  if (await sendEmail("Reel tool: add a RapidAPI key (" + stillQueued + " reels waiting)", html)) {
    console.log("Resolver-exhausted alert sent to", config.ownerEmail);
  }
}
