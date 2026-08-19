// Unit tests for parseTiledOcr — the split that maps a tiled OCR answer back to
// each panel's TIMESTAMP. Getting this wrong is worse than not tiling at all:
// text would be attached to the wrong moment, and the timed timeline is what
// lets the model tell that a temperature flashed on screen while the narrator
// said "bake it" (gotcha #22). So anything ambiguous must return null and fall
// back to reading frames one at a time.
//
//   node test-tiled-ocr.mjs     (no network, no DB, no keys)

process.env.NVIDIA_API_KEY = "test";
process.env.SUPABASE_URL = "http://x";
process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
process.env.GROQ_API_KEY = "x";
process.env.RESEND_API_KEY = "x";

const { parseTiledOcr } = await import("./nvidia.mjs");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) { console.log(`   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); failed++; }
}

check("clean 4-panel answer",
  parseTiledOcr("[1]\nPreheat oven\n[2]\n350F\n[3]\nNONE\n[4]\nServe hot", 4),
  ["Preheat oven", "350F", "NONE", "Serve hot"]);

check("markers on the same line as text",
  parseTiledOcr("[1] Hello\n[2] World", 2),
  ["Hello", "World"]);

check("multi-line panel text is kept whole",
  parseTiledOcr("[1]\nline one\nline two\n[2]\nlast", 2),
  ["line one\nline two", "last"]);

// Everything below must refuse rather than guess.
check("too few panels → null", parseTiledOcr("[1]\nonly one", 4), null);
check("too many panels → null", parseTiledOcr("[1]\na\n[2]\nb\n[3]\nc", 2), null);
check("out of order → null", parseTiledOcr("[2]\nb\n[1]\na", 2), null);
check("gap in numbering → null", parseTiledOcr("[1]\na\n[3]\nc", 2), null);
check("no markers at all → null", parseTiledOcr("Preheat oven to 350", 2), null);
check("empty answer → null", parseTiledOcr("", 4), null);
check("null answer → null", parseTiledOcr(null, 4), null);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
