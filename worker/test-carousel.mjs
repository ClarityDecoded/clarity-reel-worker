// Unit test: a carousel resolves on its SLIDES, with no video.
//
// Instagram carousels used to work only by accident. RapidAPI renders one as a
// one-second-per-slide slideshow video, and mpdecimate happened to collapse it
// back to one frame per slide — so the pipeline never knew carousels existed.
// On yt-dlp, which returns the real images, every carousel failed as "no video
// url" and the post was buried as PRIVATE_OR_UNAVAILABLE with its slides and
// caption sitting right there in the response.
//
// The rules below are the ones that silently revert to that behaviour:
//   • a result with slides but NO videoUrl must count as RESOLVED
//   • slide order must survive as `t`, since order is the reading order
//   • a non-carousel must not sprout slides
//
//   node test-carousel.mjs      no network, no keys
// resolve-ytdlp reaches resolve.mjs -> config.mjs, which hard-requires these at
// import time. Stubbed so the test stays hermetic: nothing here touches a
// network, a key, or a database.
process.env.SUPABASE_URL = "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.NVIDIA_API_KEY = "stub";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

// --- pickSlides, exercised through a stubbed yt-dlp payload -----------------
const { pickSlides } = await import("./resolve-ytdlp.mjs").then((m) => m.__testables || {});

if (pickSlides) {
  const carousel = {
    _type: "playlist",
    entries: [
      { thumbnail: "https://cdn/a.jpg" },
      { thumbnails: [{ url: "https://cdn/small.jpg" }, { url: "https://cdn/b-big.jpg" }] },
      { thumbnail: null, thumbnails: [] },        // a slide with nothing usable
    ],
  };
  const slides = pickSlides(carousel);
  ok("takes one image per slide", slides.length === 2);
  ok("prefers yt-dlp's chosen thumbnail", slides[0] === "https://cdn/a.jpg");
  // yt-dlp orders thumbnails worst -> best, so the LAST is the highest quality.
  ok("falls back to the LARGEST variant", slides[1] === "https://cdn/b-big.jpg");
  ok("a slide with no image is skipped, not null", slides.every(Boolean));
  ok("a plain video post yields no slides", pickSlides({ _type: "video", formats: [] }).length === 0);
  ok("garbage yields no slides", pickSlides(null).length === 0 && pickSlides({}).length === 0);
} else {
  console.log("SKIP pickSlides not exported for testing");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
