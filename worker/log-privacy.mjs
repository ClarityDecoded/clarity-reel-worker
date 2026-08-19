// Redact identifying detail from run logs.
//
// WHY THIS EXISTS: on a PUBLIC repo, Actions run logs are public too. The reel
// worker's logs are a running list of what Rahul saves — reel urls, titles,
// summaries, the universal point it extracted. Moving the worker to a public
// repo to stop paying for Actions minutes must not turn a private library into
// a public feed.
//
// It filters at the BOUNDARY (a console patch) rather than at the ~26 call
// sites that print a title or a url. A call-site approach is one forgotten
// template literal away from leaking, and this codebase has been bitten twice
// by exactly that shape — an option that has to be passed by every caller in a
// chain silently stops applying (gotchas #24, #52b). A boundary filter also
// covers code that doesn't exist yet, and output from libraries we don't own.
//
// OFF by default: a private repo's logs are the debugging surface and should
// stay complete. `PUBLIC_LOGS=1` turns it on, and the public repo's workflows
// set it.

const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
// Quoted text is how every log line here carries a title.
const QUOTED_RE = /"[^"\n]{1,400}"/g;
// The success line prints an UNQUOTED title after "→ <category>: ", which no
// quoted-string rule can see. Found in a real public log — the url was redacted
// and the title sat right next to it in the clear. Stops at "[" so the
// "[auto: …]" diagnostic on the same line survives.
const ARROW_TITLE_RE = /(→\s*[\w-]+:\s*)([^[\n]+)/g;
// Value-bearing prefixes: these print extracted CONTENT after the colon.
const LABELLED_RE = /^(\s*)(universal point|summary|verification|caption|transcript|title|proposed|kept|dropped|on screen|entities?)(\s*:)(.*)$/gim;

export function redact(input) {
  if (typeof input !== "string") return input;
  return input
    .replace(URL_RE, "<url>")
    .replace(ARROW_TITLE_RE, "$1…")
    .replace(EMAIL_RE, "<email>")
    .replace(QUOTED_RE, '"…"')
    .replace(LABELLED_RE, (_m, indent, label, colon) => `${indent}${label}${colon} …`);
}

// An Error's message and stack go through the same filter — a thrown string
// here often carries the url that failed.
function scrubArg(a) {
  if (typeof a === "string") return redact(a);
  if (a instanceof Error) {
    const e = new Error(redact(a.message));
    e.stack = redact(a.stack || "");
    if (a.status) e.status = a.status;
    return e;
  }
  // Objects are not printed by this worker's own logs; stringifying one to
  // filter it would change what a future caller sees. Left alone deliberately —
  // if you start logging rows, redact at the call site.
  return a;
}

export function installPrivateLogging(enabled = process.env.PUBLIC_LOGS === "1") {
  if (!enabled) return false;
  for (const level of ["log", "warn", "error", "info", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(...args.map(scrubArg));
  }
  console.log("[log-privacy] PUBLIC_LOGS=1 — urls, titles and extracted text are redacted from this log.");
  return true;
}
