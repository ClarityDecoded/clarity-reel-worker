// Unit test for caption extraction across the provider response shapes that
// actually show up. No network, no DB, no keys:
//   cd worker && node test-caption.mjs
//
// This exists because a reel whose entire substance was in its caption came
// back summarised from the background song's lyrics: the caption lookup was
// TOP LEVEL only, so a nested shape silently yielded "". These cases lock in
// that a caption is found wherever a provider chooses to put it.
process.env.SUPABASE_URL ||= "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub";
process.env.NVIDIA_API_KEY ||= "stub";
process.env.RAPIDAPI_KEY ||= "stub";
process.env.RAPIDAPI_HOST ||= "stub.example.com";
process.env.RAPIDAPI_URL_TEMPLATE ||= "https://stub.example.com/?url={url}";

const { __testables } = await import("./resolve.mjs");
const { normalize } = __testables;

let failed = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) console.log(`   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
}

const LONG = "I'm a cybersecurity architect and I bet you'd call me nuts. it's called BadHost. one character added to a web request bypasses the login on Starlette.";

// 1. top level — the shape that already worked
eq(normalize({ caption: LONG, video_url: "https://x/v.mp4" }).caption, LONG, "top-level caption");

// 2. capitalised key (this provider uses Title/Url/Type)
eq(normalize({ Caption: LONG, video_url: "https://x/v.mp4" }).caption, LONG, "capitalised Caption");

// 3. the classic Instagram nesting — previously LOST
eq(normalize({ items: [{ caption: { text: LONG } }], video_url: "https://x/v.mp4" }).caption, LONG,
  "nested items[0].caption.text");

// 4. graphql edge shape nested one level deeper than the hardcoded path
eq(normalize({ data: { media: { edge_media_to_caption: { edges: [{ node: { text: LONG } }] } } } }).caption, LONG,
  "nested edge_media_to_caption");

// 5. truncated title alongside the full caption — the LONGER one must win
eq(normalize({ title: "please stop me from breaking into your MCP server", data: { caption_text: LONG } }).caption,
  LONG, "full caption beats truncated title");

// 6. a URL under a caption-ish key is not a caption
eq(normalize({ description: "https://instagram.com/reel/abc", video_url: "https://x/v.mp4" }).caption, "",
  "url is not a caption");

// 7. genuinely absent
eq(normalize({ video_url: "https://x/v.mp4" }).caption, "", "no caption present");

// 8. the video url must still resolve while we are in here
eq(normalize({ Media: [{ Type: "video", Url: "https://cdn/v.mp4" }], caption: LONG }).videoUrl,
  "https://cdn/v.mp4", "video url still extracted from Media array");

// 9. carousel post — a Media array of several image entries, no video at all.
// Every slide must come back, in order, so all of a carousel's text is read.
function arrEq(actual, expected, label) {
  const ok = Array.isArray(actual) && actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) console.log(`   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
}
const carousel = normalize({
  Media: [
    { Type: "image", Url: "https://cdn/slide1.jpg" },
    { Type: "image", Url: "https://cdn/slide2.jpg" },
    { Type: "image", Url: "https://cdn/slide3.jpg" },
  ],
  caption: LONG,
});
eq(carousel.videoUrl, null, "carousel post has no video url");
arrEq(carousel.imageUrls, ["https://cdn/slide1.jpg", "https://cdn/slide2.jpg", "https://cdn/slide3.jpg"],
  "carousel post — every slide's image url extracted, in order");
eq(carousel.caption, LONG, "carousel post caption still extracted");

// 10. a video post's own cover/thumbnail must NOT be misread as carousel slides.
const video = normalize({ Media: [{ Type: "video", Url: "https://cdn/v.mp4", thumbnail: "https://cdn/cover.jpg" }] });
arrEq(video.imageUrls, [], "video post never carries imageUrls, even with a jpg thumbnail");

// 11. a known carousel container key outside the Media[] shape.
arrEq(normalize({ carousel_media: [{ url: "https://cdn/a.jpg" }, { url: "https://cdn/b.png" }] }).imageUrls,
  ["https://cdn/a.jpg", "https://cdn/b.png"], "carousel_media container key");

// 12. single photo post (not a reel) — one image, no video, resolvable at all.
eq(normalize({ Media: [{ Type: "image", Url: "https://cdn/only.webp" }] }).imageUrls.length > 0, true,
  "single-photo post resolves via imageUrls");

console.log(failed ? `\n${failed} test(s) failed.` : "\nAll caption tests passed.");
process.exit(failed ? 1 : 0);
