// Source detection + canonical URLs for the YouTube / Facebook dump. No network.
import { sourceOf, canonicalUrl } from "./sources.mjs";
let fail = 0;
const eq = (a, b, m) => { if (a !== b) { fail++; console.error(`✗ ${m}: got ${a}, want ${b}`); } else console.log(`✓ ${m}`); };

eq(sourceOf("https://www.instagram.com/reel/ABC/"), "instagram", "instagram");
eq(sourceOf("https://youtu.be/dQw4w9WgXcQ?si=x"), "youtube", "youtu.be");
eq(sourceOf("https://m.youtube.com/shorts/abcdefghijk"), "youtube", "shorts");
eq(sourceOf("https://fb.watch/abc123/"), "facebook", "fb.watch");
eq(sourceOf("https://www.facebook.com/reel/123456789"), "facebook", "fb reel");
eq(sourceOf("https://evil.com/youtube.com/watch?v=abc"), "unknown", "host is judged, not the path");
eq(sourceOf("https://notyoutube.com/watch?v=abc"), "unknown", "lookalike host");
eq(sourceOf("garbage"), "unknown", "garbage");

const want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
eq(canonicalUrl("https://youtu.be/dQw4w9WgXcQ?si=abc&t=30"), want, "youtu.be canonical");
eq(canonicalUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&t=9s"), want, "watch strips list/t");
eq(canonicalUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), want, "shorts canonical");
eq(canonicalUrl("https://www.facebook.com/watch/?v=123&ref=x"), "https://www.facebook.com/watch/?v=123&ref=x", "facebook untouched");
eq(canonicalUrl("https://www.youtube.com/channel/UCxyz"), "https://www.youtube.com/channel/UCxyz", "no video id: passthrough");
process.exit(fail ? 1 : 0);
