// Unit test: the router adapts to a provider rejecting a request PARAMETER,
// rather than us pinning another assumption about which models take what.
//
// OpenAI's gpt-5 / o-series renamed max_tokens -> max_completion_tokens and
// refuse a non-default temperature. Found live: every gpt-5 model 400'd with
// "Unsupported parameter: 'max_tokens'". Pattern-matching model ids to decide
// the body is the same brittleness that already cost this pipeline two
// outages (gotcha #57), so instead we read the 400 — which names the offending
// parameter — and retry without it.
//
// The two properties that matter are that it TERMINATES (a fix cannot
// re-trigger itself) and that it NEVER INVENTS a parameter that was not sent.
//   node test-adapt-payload.mjs      no network, no keys
import { adaptPayload } from "./router.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n); };

const base={model:"m",messages:[],temperature:0.2,max_tokens:2048,response_format:{type:"json_object"}};

const a=adaptPayload(base,400,`{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`);
ok("renames max_tokens -> max_completion_tokens", a && a.max_completion_tokens===2048 && !("max_tokens" in a));
ok("rename keeps everything else", a && a.temperature===0.2 && a.response_format);

const b=adaptPayload({...base},400,`{"error":{"message":"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) is supported."}}`);
ok("drops temperature", b && !("temperature" in b) && b.max_tokens===2048);

const c=adaptPayload({...base},400,`{"error":{"message":"response_format is not supported"}}`);
ok("drops response_format", c && !("response_format" in c));

ok("ignores non-400", adaptPayload({...base},429,"rate limited")===null);
ok("ignores unknown 400", adaptPayload({...base},400,`{"error":{"message":"you broke something else"}}`)===null);

// Must terminate: once renamed, the same error can't re-trigger the rename.
const once=adaptPayload(base,400,"use max_completion_tokens instead");
ok("does not loop on the same fix", adaptPayload(once,400,"use max_completion_tokens instead")===null);

// Never invents a parameter it wasn't given.
ok("never adds a param that wasn't sent",
   adaptPayload({model:"m",messages:[]},400,"use max_completion_tokens instead")===null);

// REAL 400 bodies from vendors that refuse a non-default temperature. The rule
// used to require "unsupported / not supported / only the default", which missed
// Kimi's wording entirely — so kimi-k3, SECOND in the structure chain, 400'd on
// every call, adapted nothing, and scored 0/29 on the Comprehension Test while
// being one of only two models that can score 100%.
{
  const bodies = [
    ['{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}', "moonshot/kimi"],
    ['{"error":{"message":"Unsupported value: \'temperature\' does not support 0.2 with this model. Only the default (1) is supported."}}', "openai/gpt-5"],
    ['{"error":{"message":"temperature must be 1 for this model"}}', "hypothetical phrasing"],
    ['{"error":{"message":"temperature can only be 1"}}', "another phrasing"],
  ];
  for (const [body, who] of bodies) {
    const out = adaptPayload({ model: "m", temperature: 0.2, max_tokens: 100 }, 400, body);
    ok(`drops temperature for ${who}`, out && !("temperature" in out));
    ok(`  ...and keeps everything else for ${who}`, out && out.max_tokens === 100 && out.model === "m");
  }
  // It must NOT fire on an unrelated 400, or a real error gets silently retried
  // with a mangled payload and the actual cause is lost.
  const unrelated = adaptPayload({ model: "m", temperature: 0.2 }, 400,
    '{"error":{"message":"messages: at least one message is required"}}');
  ok("leaves an unrelated 400 alone", unrelated === null);
  // And never on a non-400 — a 429 or 503 is transient, not a bad parameter.
  ok("ignores a 429", adaptPayload({ model: "m", temperature: 0.2 }, 429, "rate limited") === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
