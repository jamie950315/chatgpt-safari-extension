const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { MessageChannel } = require("node:worker_threads");
const { dispatch, sandboxURL } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-kernel-bridge.js");
test("Safari high-level commands retain the original RPC session transport rather than CDP", async () => {
  const calls = [];
  const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(value) { calls.push(value); return "real result"; } } };
  const command = { type: "dom_cua_get_visible_dom", browser_id: "0", tab_id: "12" };
  assert.equal(await dispatch(context, command, () => assert.fail("Must not enter the CDP handler")), "real result");
  assert.deepEqual(calls, [{ type: "browser_safari_command", command }]);
  assert.equal(await dispatch(context, { type: "browser_user_claim_tab", tab_id: "12" }, async () => "original lease"), "original lease");
  assert.deepEqual(calls.at(-1), { type: "browser_safari_context" });
  await assert.rejects(dispatch(context, { type: "playwright_evaluate" }, async () => "bad"), /does not support/);
  await assert.rejects(dispatch(context, { ...command, tab_id: "12-other" }, async () => "bad"), /claimed tab IDs/);
});
test("non-Safari clients retain their existing executor", async () => {
  assert.equal(await dispatch({ clientInfo: { family: "chrome" } }, { type: "tab_cdp_call" }, async () => "original Chrome result"), "original Chrome result");
});
test("Safari downloads inspect the real node before original consent, then transfer only the approved href", async () => {
  const events = [], actualHref = "https://example.com/authenticated-report.txt";
  const command = { type: "dom_cua_download_media", browser_id: "0", tab_id: "12", node_id: "d1_n3",
    href: "https://untrusted.example/model-supplied-override" };
  const context = { clientInfo: { family: "safari" },
    security: { async ensureDownloadAllowed(tabId, href) { events.push({ type: "policy", tabId, href }); } },
    api: { async executeUnhandledCommand(value) {
      events.push(value);
      if (value.command.type === "safari_download_inspect") return { href: actualHref };
      return { saved: true };
    } } };
  assert.deepEqual(await dispatch(context, command, () => assert.fail("Downloads must not enter the Chrome/CDP handler")), { saved: true });
  assert.deepEqual(events.map(event => event.type === "policy" ? event.type : event.command.type),
    ["safari_download_inspect", "policy", "dom_cua_download_media"]);
  assert.deepEqual(events[1], { type: "policy", tabId: 12, href: actualHref });
  assert.equal(events[2].command.href, actualHref);
  assert.equal(events[2].command.node_id, command.node_id);
});
test("a rejected download policy or failed preflight cannot start a transfer", async () => {
  for (const failure of ["preflight", "policy"]) {
    const events = [];
    const context = { clientInfo: { family: "safari" },
      security: { async ensureDownloadAllowed() { events.push("policy"); throw new Error("Download denied by original policy"); } },
      api: { async executeUnhandledCommand(value) {
        events.push(value.command.type);
        if (failure === "preflight") throw new Error("The download document changed");
        if (value.command.type === "safari_download_inspect") return { href: "https://example.com/file.txt" };
        assert.fail("A rejected download must not transfer bytes");
      } } };
    await assert.rejects(dispatch(context, { type: "dom_cua_download_media", browser_id: "0", tab_id: "12", node_id: "d1_n3" },
      () => assert.fail("Must not enter the original executor")), /document changed|denied by original policy/);
    assert.deepEqual(events, failure === "preflight" ? ["safari_download_inspect"] : ["safari_download_inspect", "policy"]);
  }
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
test("same-document kernel browser RPC uses a real exact-host MessageChannel and propagates close", async () => {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-kernel-bridge.js", "utf8");
  const origin = "safari-web-extension://actual-extension", hostWindow = {};
  const child = { src: origin + "/js-kernel-host.html?scopeId=original-scope", contentWindow: hostWindow };
  const events = new Map();
  const offscreen = { hidden: true, setAttribute() {}, contentDocument: { querySelectorAll: () => [child] },
    addEventListener(type, callback) { events.set(type, callback); }, removeEventListener() {}, remove() {} };
  const backgroundWindow = { addEventListener(type, callback) { this.listener = callback; } };
  backgroundWindow.parent = backgroundWindow;
  const background = { window: backgroundWindow, document: { body: { append() { queueMicrotask(() => events.get("load")()); } }, createElement: () => offscreen },
    MessageChannel, URL, setTimeout, clearTimeout, module: { exports: {} },
    chrome: { runtime: { getURL: path => origin + "/" + path } },
    ChatGPTSafariSidebarOptions: { companion: { agentKernelURL: async () => "http://chatgpt-kernel-55555555-5555-4555-8555-555555555555.localhost:1234/sandbox?cap=" + "a".repeat(64) } } };
  vm.runInNewContext(source, background);
  const bridge = background.module.exports;
  await bridge.ensureHostDocument();
  let accepted;
  bridge.onBrowserConnection((scope, transport) => { assert.equal(scope, "original-scope"); accepted = transport; });
  const message = { isTrusted: true, source: hostWindow, origin, data: { type: "chatgpt-safari:kernel-browser", scopeId: "original-scope" } };
  for (const invalid of [{ ...message, source: {} }, { ...message, origin: "https://unrelated.invalid" },
    { ...message, data: { ...message.data, scopeId: "another-scope" } }]) {
    const channel = new MessageChannel();
    backgroundWindow.listener({ ...invalid, ports: [channel.port2] });
    channel.port1.close(); channel.port2.close();
  }
  assert.equal(accepted, undefined);
  backgroundWindow.postMessage = (data, _origin, ports) => backgroundWindow.listener({ ...message, data, ports });
  hostWindow.parent = { parent: backgroundWindow };
  const host = { window: hostWindow, MessageChannel, module: { exports: {} } };
  vm.runInNewContext(source, host);
  const client = host.module.exports.connectBrowser("original-scope");
  const received = new Promise(resolve => accepted.setMessageCallback(resolve));
  client.sendMessage({ original: "RPC request" });
  assert.deepEqual(await received, { original: "RPC request" });
  const response = new Promise(resolve => client.setMessageCallback(resolve));
  accepted.sendMessage({ original: "RPC response" });
  assert.deepEqual(await response, { original: "RPC response" });
  const closed = new Promise(resolve => client.addCloseListener(resolve));
  accepted.close(); await closed;
  assert.equal(bridge.status().connections, 1);
  assert.throws(() => client.sendMessage({}), /closed/);
});
