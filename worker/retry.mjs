// Retry + transient-failure classification.
//
// Two real failures on 2026-07-24 were both transient and both killed their item
// outright because nothing in the pipeline retried:
//   • "fetch failed"  — Node/undici's generic network error (DNS blip, socket
//     reset, CDN hiccup). No HTTP status attached.
//   • NVIDIA 503 "ResourceExhausted: Worker local total request limit reached
//     (28/16)" — NVIDIA's shared inference pool was momentarily full. Nothing to
//     do with our quota; the same call succeeds seconds later.
//
// So: retry these in place with exponential backoff, and if they still fail,
// let the caller put the item BACK in the queue rather than burying it as an
// error (see process-queue.mjs). Backoff also PACES the calls, which is what
// keeps a burst from tripping NVIDIA's per-window request ceiling.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fetch that never got an HTTP response. undici reports this as the bare
// string "fetch failed" with the real cause nested underneath.
export function isNetworkError(err) {
  const msg = String(err?.message || "");
  if (/fetch failed|network|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg)) return true;
  const code = String(err?.cause?.code || err?.code || "");
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/i.test(code);
}

// HTTP statuses worth trying again: rate limit + anything 5xx (NVIDIA's 503
// capacity error included).
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

// Errors thrown by our own modules carry the status in the message
// ("NVIDIA … 503: …", "Download failed: 502"). Pull it back out.
function statusFromMessage(err) {
  const m = String(err?.message || "").match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

// Is this worth another go — now (withRetry) or on the next run (process-queue
// re-queue)? Deliberately conservative: a private/deleted reel or an exhausted
// resolver is PERMANENT for this item and must NOT loop forever.
//
// Stricter than the earlier version, which treated ANY error without a `.status`
// as transient. That meant a private reel got retried several times for nothing
// and could not be told apart from a genuine network blip — which is exactly the
// distinction the re-queue logic depends on.
export function isTransient(err) {
  if (!err) return false;
  if (err.code === "ALL_RESOLVERS_EXHAUSTED") return false;
  if (err.message === "PRIVATE_OR_UNAVAILABLE") return false;
  if (isNetworkError(err)) return true;
  if (typeof err.status === "number" && isRetryableStatus(err.status)) return true;
  const s = statusFromMessage(err);
  return s != null && isRetryableStatus(s);
}

// Retry an async fn on transient failure. `shouldRetry(err, attempt)` decides
// (defaults to isTransient). Backoff: base * 2^(attempt-1), capped, plus jitter.
//
// SIGNATURE IS DELIBERATELY UNCHANGED — media.mjs, nvidia.mjs and resolve.mjs
// all call this with { retries, base, cap, shouldRetry, onRetry }. The stashed
// branch had rewritten it to { tries, baseMs, label }, which would have silently
// ignored every option those callers pass (nvidia's widened 5-retry / 20s budget
// among them). Classification improved; the contract did not change.
export async function withRetry(
  fn,
  { retries = 3, base = 500, cap = 8000, shouldRetry = isTransient, onRetry } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries || !shouldRetry(e, attempt)) throw e;
      const delay = Math.min(cap, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      if (onRetry) onRetry(e, attempt, delay);
      await sleep(delay);
    }
  }
}
