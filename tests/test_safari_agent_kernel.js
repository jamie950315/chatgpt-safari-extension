const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatch, sandboxURL } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-kernel-bridge.js");
test("Safari high-level commands retain the original RPC session transport rather than CDP", async () => {
  const calls = [];
  const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(value) { calls.push(value); return "real result"; } } };
  const command = { type: "dom_cua_get_visible_dom", browser_id: "0", tab_id: "12" };
  assert.equal(await dispatch(context, command, () => assert.fail("Must not enter the CDP handler")), "real result");
  assert.deepEqual(calls, [{ type: "browser_safari_command", command }]);
  assert.equal(await dispatch(context, { type: "browser_user_claim_tab", tab_id: "12" }, async () => "original lease"), "original lease");
  await assert.rejects(dispatch(context, { type: "playwright_evaluate" }, async () => "bad"), /does not support/);
  await assert.rejects(dispatch(context, { ...command, tab_id: "12-other" }, async () => "bad"), /claimed tab IDs/);
});
test("non-Safari clients retain their existing executor", async () => {
  assert.equal(await dispatch({ clientInfo: { family: "chrome" } }, { type: "tab_cdp_call" }, async () => "original Chrome result"), "original Chrome result");
});
test("the original worker accepts only its dedicated capability-bound local sandbox URL", () => {
  const previous = globalThis.location;
  try {
    const url = "http://chatgpt-kernel-55555555-5555-4555-8555-555555555555.localhost:1234/sandbox?cap=" + "a".repeat(64);
    const set = value => { globalThis.location = { search: "?kernel=" + encodeURIComponent(value) }; };
    set(url); assert.equal(sandboxURL(), url);
    for (const invalid of [url.replace("chatgpt-kernel-", "chatgpt-provider-"), url.replace("/sandbox?", "/command?"),
      url + "&extra=parameter", url.replace("http:", "https:"), url.replace("cap=", "token="), "http://127.0.0.1:1234/sandbox"]) {
      set(invalid); assert.throws(sandboxURL, /Invalid isolated/);
    }
  } finally { globalThis.location = previous; }
});
