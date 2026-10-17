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
test("original creation and claiming of a blank tab do not require console capture before navigating that same tab", async () => {
  const { createAgent } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-background.js");
  let url = "about:blank"; const calls = [], owner = { instanceId: "owner", profileId: "profile", accountScope: "account" };
  const metadata = { session_id: "session", turn_id: "turn" }, session = { currentTurnId: "turn", async requireOwnedTab(id) { assert.equal(id, 12); } };
  const agent = createAgent({ tabs: { async get() { return { id: 12, url }; } } }, { async agentOwner() { return owner; }, async runAgentCommand(command) {
    calls.push(command); if (command.action === "navigate") { assert.equal(command.arguments.expectedUrl, "about:blank"); url = command.arguments.url; }
    return {};
  } });
  const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(request) {
    if (request.type === "browser_safari_context") return agent.authorize(session, metadata);
    return agent.execute(request.command, session, metadata);
  } } };
  for (const type of ["create_tab", "browser_user_claim_tab"]) {
    assert.deepEqual(await dispatch(context, { type, browser_id: "0", tab_id: "12" }, async () => ({ id: "12" })), { id: "12" });
  }
  assert.equal(calls.length, 0, "blank original inventory/claim must not require website scripting or console capture");
  await agent.execute({ type: "navigate_tab_url", browser_id: "0", tab_id: "12", url: "https://example.test/owned" }, session, metadata);
  assert.deepEqual(calls.map(command => command.action), ["navigate", "dom_query"]);
  assert.equal(calls[1].arguments.command.type, "safari_logs_start");
});
test("new-tab URL omissions retain original create/claim and use actual native blank-frame proof before same-tab goto", async () => {
  const { createAgent } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-background.js");
  const { createLive } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");
  const previous = globalThis.ChatGPTSafariLive;
  try {
    for (const missing of [undefined, ""]) {
      let url = missing, claims = 0, frameProofs = 0; const calls = [];
      const owner = { instanceId: "owner", profileId: "profile", accountScope: "account" };
      const metadata = { session_id: "session", turn_id: "turn" }, session = { currentTurnId: "turn", async requireOwnedTab(id) { assert.equal(id, 12); } };
      const api = { runtime: { onMessage: { addListener() {} } }, tabs: { async get(id) { return { id, windowId: 8, url }; } },
        webNavigation: { async getAllFrames({ tabId }) { assert.equal(tabId, 12); frameProofs++; return [{ frameId: 0, parentFrameId: -1, url: "about:blank", errorOccurred: false }]; } } };
      globalThis.ChatGPTSafariLive = createLive(api, { crypto: require("node:crypto") });
      const agent = createAgent(api, { async agentOwner() { return owner; }, async runAgentCommand(command) {
        calls.push(command); if (command.action === "navigate") { assert.equal(command.arguments.expectedUrl, "about:blank"); url = command.arguments.url; }
        return {};
      } });
      const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(request) {
        if (request.type === "browser_safari_context") return agent.authorize(session, metadata);
        return agent.execute(request.command, session, metadata);
      } } };
      for (const type of ["create_tab", "browser_user_claim_tab"]) {
        await dispatch(context, { type, browser_id: "0", tab_id: "12" }, async () => { claims++; return { id: "12" }; });
      }
      assert.equal(claims, 2); assert.equal(calls.length, 0); assert.equal(frameProofs, 0, "original claim does not invent website/blank metadata");
      await agent.execute({ type: "navigate_tab_url", browser_id: "0", tab_id: "12", url: "https://example.test/new" }, session, metadata);
      assert.equal(frameProofs, 1); assert.equal(calls[0].action, "navigate"); assert.equal(calls[0].arguments.handle, "live:profile:12");
    }
  } finally { globalThis.ChatGPTSafariLive = previous; }
});
test("actual native create provenance completes new/claim/goto and blank close when Safari reports no URL or blank frame", async () => {
  const { createAgent } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-background.js");
  const { createLive } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");
  const { createSessionWindows } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/session-windows.js");
  const previous = { live: globalThis.ChatGPTSafariLive, manager: globalThis.ChatGPTSafariSessionWindows };
  try {
    const profileId = "55555555-5555-4555-8555-555555555555", tabs = new Map(), leased = new Set(), changes = [], removed = [];
    let nextId = 12, frameReads = 0;
    const api = { runtime: { onMessage: { addListener() {} }, async sendNativeMessage() { return { ok: true, requests: [] }; } },
      storage: { local: { async get() { return { safariLiveProfileId: profileId }; } }, session: { async get() { return {}; }, async set() {} } },
      browserAction: { async setTitle() {} },
      tabs: { onRemoved: { addListener() {} }, async get(id) { return { ...tabs.get(id) }; },
        async create(value) { assert.equal(value.url, "about:blank"); const tab = { id: nextId++, windowId: value.windowId, url: "", title: "", status: "complete" }; tabs.set(tab.id, tab); return { ...tab }; },
        async update(id, value) { changes.push([id, value]); Object.assign(tabs.get(id), value); return { ...tabs.get(id) }; },
        async remove(id) { removed.push(id); tabs.delete(id); } },
      webNavigation: { async getAllFrames() { frameReads++; return []; } },
      scripting: { async executeScript() { return [{ result: { ok: true, result: { token: "logs" } } }]; } } };
    const owner = { instanceId: "owner", profileId, accountScope: "account" }, metadata = { session_id: "session", turn_id: "turn" };
    const session = { currentTurnId: "turn", async requireOwnedTab(id) { assert.equal(leased.has(id), true, "the original claim gate must stay active"); } };
    const manager = createSessionWindows(api), live = createLive(api, { crypto: require("node:crypto"), ChatGPTSafariSessionWindows: manager,
      setInterval() {}, clearInterval() {}, setTimeout });
    globalThis.ChatGPTSafariSessionWindows = manager; globalThis.ChatGPTSafariLive = live; await live.start();
    const agent = createAgent(api, { async agentOwner() { return owner; }, async runAgentCommand(command) {
      return live.execute({ id: "owned-command", agentOwner: owner.instanceId, deadline: Date.now() + 10000, command });
    } });
    const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(request) {
      return request.type === "browser_safari_context" ? agent.authorize(session, metadata) : agent.execute(request.command, session, metadata);
    } } };
    async function create() {
      return dispatch(context, { type: "create_tab", browser_id: "0" }, async () => {
        const tab = await manager.createTab("session", 8, "turn"); leased.add(tab.id); return { id: String(tab.id) };
      });
    }
    const fresh = await create();
    await dispatch(context, { type: "browser_user_claim_tab", browser_id: "0", tab_id: fresh.id }, async () => ({ id: fresh.id }));
    await agent.execute({ type: "navigate_tab_url", browser_id: "0", tab_id: fresh.id, url: "https://example.test/new" }, session, metadata);
    assert.deepEqual(changes, [[12, { url: "https://example.test/new" }]]); assert.equal(frameReads, 0);
    const blank = await create(); await agent.execute({ type: "close_tab", browser_id: "0", tab_id: blank.id }, session, metadata);
    assert.deepEqual(removed, [13]); assert.equal(frameReads, 0);
    const ended = await create(); await agent.release("session", "turn");
    await assert.rejects(agent.execute({ type: "close_tab", browser_id: "0", tab_id: ended.id }, session, metadata), /native top frame did not prove/);
    assert.deepEqual(removed, [13], "an ended turn cannot replay creation authority against an unknown tab");
  } finally { globalThis.ChatGPTSafariLive = previous.live; globalThis.ChatGPTSafariSessionWindows = previous.manager; }
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
test("page asset bundles approve the real page and each observed fetch origin before native writing", async () => {
  const events = [], command = { type: "tab_page_assets_bundle", browser_id: "0", tab_id: "12", inventoryId: "inventory" };
  const context = { clientInfo: { family: "safari" }, security: {
    async ensurePageAssetDownloadAllowed(url) { events.push(["page", url]); },
    async ensurePageAssetFallbackFetchAllowed(page, url) { events.push(["fetch", page, url]); },
  }, api: { async executeUnhandledCommand(value) {
    events.push([value.command.type]);
    return value.command.type === "safari_assets_inspect" ? { pageUrl: "https://example.com/", assets: [
      { id: "svg", inline: true, url: "inline-svg:svg" }, { id: "image", url: "https://cdn.example/image.png" }, { id: "font", url: "https://cdn.example/font.woff2" },
    ] } : { directoryPath: "/Downloads/Bundle" };
  } } };
  assert.deepEqual(await dispatch(context, command, () => assert.fail("No CDP asset handler")), { directoryPath: "/Downloads/Bundle" });
  assert.deepEqual(events.map(x => x[0]), ["safari_assets_inspect", "page", "fetch", "tab_page_assets_bundle"]);
  context.security.ensurePageAssetDownloadAllowed = async () => { throw new Error("Asset policy denied"); };
  await assert.rejects(dispatch(context, command, () => assert.fail("No CDP asset handler")), /policy denied/);
});
test("the original upload policy runs once after chooser validation and before native file selection", async () => {
  const events = [], command = { type: "playwright_file_chooser_set_files", browser_id: "0", tab_id: "12", file_chooser_id: "real-native-chooser", files: ["/tmp/one", "/tmp/two"] };
  const context = { clientInfo: { family: "safari" }, security: { async ensureFileUploadAllowed(id) { assert.equal(id, 12); events.push("policy"); } },
    api: { async executeUnhandledCommand(value) { events.push(value.command.type); return {}; } } };
  await dispatch(context, command, () => assert.fail("File selection must not enter Chrome's CDP executor"));
  assert.deepEqual(events, ["safari_file_chooser_inspect", "policy", "playwright_file_chooser_set_files"]);
  events.length = 0;
  context.security.ensureFileUploadAllowed = async () => { events.push("policy"); throw new Error("Original upload denied"); };
  await assert.rejects(dispatch(context, command, () => assert.fail("No CDP")), /Original upload denied/);
  assert.deepEqual(events, ["safari_file_chooser_inspect", "policy"]);
});
test("preregistered uploads approve the exact source before the single original click command", async () => {
  const events = [], source = { url: "https://example.test/", documentId: "doc", snapshotId: "snapshot", node: "n1", isMultiple: false };
  const command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12", selector: "input[type=file]",
    safari_native_modal: { kind: "upload", files: ["/owned/file.txt"], timeout_ms: 10000 } };
  const context = { clientInfo: { family: "safari" }, security: { async ensureFileUploadAllowed(id) { assert.equal(id, 12); events.push("policy"); } },
    api: { async executeUnhandledCommand(value) { events.push(value.command.type); return value.command.type === "safari_native_upload_inspect" ? source : value.command; } } };
  const result = await dispatch(context, command, () => assert.fail("No Chrome/CDP upload handler"));
  assert.deepEqual(events, ["safari_native_upload_inspect", "policy", "playwright_locator_click"]);
  assert.equal(result.safari_upload_source, source); assert.equal(result.safari_native_modal, command.safari_native_modal);
  events.length = 0; context.security.ensureFileUploadAllowed = async () => { events.push("denied"); throw new Error("Upload denied"); };
  await assert.rejects(dispatch(context, command, () => assert.fail("No fallback")), /Upload denied/);
  assert.deepEqual(events, ["safari_native_upload_inspect", "denied"]);
  await assert.rejects(dispatch(context, { ...command, type: "dom_cua_click" }, () => assert.fail("No fallback")), /single native locator click/);
});
test("content exports approve only the derived official source before starting source fetch or native writing", async () => {
  for (const denied of [false, true]) {
    const events = [], command = { type: "tab_content_export_gsuite", browser_id: "0", tab_id: "12", format: "pdf", href: "https://model-override.test/" };
    const context = { clientInfo: { family: "safari" }, security: { async ensureDownloadAllowed(id, href) {
      assert.equal(id, 12); assert.equal(href, "https://docs.google.com/document/d/id/export?format=pdf"); events.push("policy"); if (denied) throw new Error("Original download denied");
    } }, api: { async executeUnhandledCommand(value) {
      events.push(value.command.type);
      if (value.command.type === "safari_content_export_inspect") return { href: "https://docs.google.com/document/d/id/export?format=pdf", exportId: "verified-export-id" };
      assert.equal(value.command.exportId, "verified-export-id"); return { path: "/Downloads/real.pdf" };
    } } };
    const result = dispatch(context, command, () => assert.fail("No original CDP export or no-op filesystem"));
    if (denied) await assert.rejects(result, /Original download denied/); else assert.deepEqual(await result, { path: "/Downloads/real.pdf" });
    assert.deepEqual(events, ["safari_content_export_inspect", "policy", ...(denied ? [] : ["tab_content_export_gsuite"])]);
  }
});
test("original browser viewport commands retain the security transport without requiring a model-selected tab ID", async () => {
  const calls = [], command = { type: "browser_viewport_set", browser_id: "0", width: 1000, height: 700 };
  const context = { clientInfo: { family: "safari" }, api: { async executeUnhandledCommand(value) { calls.push(value); return {}; } } };
  assert.deepEqual(await dispatch(context, command, () => assert.fail("Viewport must not use Chrome emulation")), {});
  assert.deepEqual(calls, [{ type: "browser_safari_command", command }]);
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
function kernelLifecycleFixture() {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-kernel-bridge.js", "utf8");
  const origin = "safari-web-extension://actual-extension";
  const fixture = { frames: [], checks: 0, autoReply: true,
    url: "http://chatgpt-kernel-55555555-5555-4555-8555-555555555555.localhost:1234/sandbox?cap=" + "a".repeat(64) };
  const window = { addEventListener(type, callback) { this.listener = callback; } }; window.parent = window;
  const document = { body: { append(frame) { fixture.frames.push(frame); queueMicrotask(() => frame.events.get("load")()); } },
    createElement() {
      const frame = { events: new Map(), children: [], messages: [], setAttribute() {},
        addEventListener(type, callback) { this.events.set(type, callback); },
        removeEventListener(type) { this.events.delete(type); }, remove() { this.removed = true; } };
      frame.contentDocument = { querySelectorAll: () => frame.children };
      frame.contentWindow = { postMessage(request, _origin, ports) {
        frame.messages.push(request);
        if (fixture.autoReply) ports[0].postMessage({ id: request.id, ok: true });
      } };
      return frame;
    } };
  const environment = { window, document, MessageChannel, URL, setTimeout, clearTimeout, module: { exports: {} },
    chrome: { runtime: { getURL: path => origin + "/" + path } },
    ChatGPTSafariSidebarOptions: { companion: { async agentKernelURL() {
      fixture.checks++; if (fixture.error) throw fixture.error; return fixture.url;
    } } } };
  vm.runInNewContext(source, environment);
  return Object.assign(fixture, { bridge: environment.module.exports, window, origin });
}
test("current native kernel capability replaces the cached offscreen only after a real service change", async () => {
  const f = kernelLifecycleFixture();
  await f.bridge.ensureHostDocument();
  await Promise.all([f.bridge.ensureHostDocument(), f.bridge.ensureHostDocument()]);
  assert.equal(f.frames.length, 1, "same-service provider remounts retain the original kernel and scopes");
  assert.ok(f.checks > 1, "a persistent background must observe the current native service");
  f.url = f.url.replace(":1234/", ":5678/").replace("cap=" + "a".repeat(64), "cap=" + "b".repeat(64));
  await Promise.all([f.bridge.ensureHostDocument(), f.bridge.ensureHostDocument()]);
  assert.equal(f.frames.length, 2, "one changed native capability creates exactly one replacement");
  assert.equal(f.frames[0].removed, true);
  assert.equal(new URL(f.frames[1].src).searchParams.get("kernel"), f.url);
  assert.equal((await f.bridge.sendRequest({ type: "js-kernel:execute", id: "fresh", scopeId: "original" })).ok, true);
  assert.equal(f.frames[0].messages.length, 0); assert.equal(f.frames[1].messages.length, 1);
});
test("native kernel replacement closes old browser RPC and rejects a delivered execution without replay", async () => {
  const f = kernelLifecycleFixture();
  await f.bridge.ensureHostDocument();
  let accepted;
  f.bridge.onBrowserConnection((_scope, transport) => { accepted = transport; });
  const source = {}, channel = new MessageChannel();
  f.frames[0].children.push({ src: f.origin + "/js-kernel-host.html?scopeId=original", contentWindow: source });
  f.window.listener({ isTrusted: true, source, origin: f.origin, ports: [channel.port2],
    data: { type: "chatgpt-safari:kernel-browser", scopeId: "original" } });
  const closed = new Promise(resolve => { channel.port1.onmessage = event => { if (event.data?.type === "close") resolve(); }; });
  f.autoReply = false;
  const active = f.bridge.sendRequest({ type: "js-kernel:execute", id: "delivered", scopeId: "original" });
  const rejected = assert.rejects(active, /changed.*not retried/);
  await new Promise(setImmediate);
  assert.equal(f.frames[0].messages.length, 1);
  await f.bridge.ensureHostDocument();
  assert.doesNotThrow(() => accepted.sendMessage({ original: "same-service active RPC" }));
  assert.equal(f.frames[0].removed, undefined, "unchanged app sessions must not interrupt delivered work");
  f.url = f.url.replace("cap=" + "a".repeat(64), "cap=" + "b".repeat(64));
  await f.bridge.ensureHostDocument(); await rejected; await closed;
  assert.throws(() => accepted.sendMessage({}), /closed/);
  f.autoReply = true;
  await f.bridge.sendRequest({ type: "js-kernel:execute", id: "next", scopeId: "original" });
  assert.deepEqual(f.frames[1].messages.map(item => item.id), ["next"]);
  assert.equal(f.bridge.status().failures, 1);
  channel.port1.close();
});
test("a missing or invalid current native kernel capability never dispatches through a cached host", async () => {
  const f = kernelLifecycleFixture(); await f.bridge.ensureHostDocument();
  f.error = new Error("The native sidebar owner has changed");
  await assert.rejects(f.bridge.sendRequest({ id: "wrong-owner" }), /owner has changed/);
  f.error = undefined; f.url = "http://127.0.0.1:1234/command";
  await assert.rejects(f.bridge.sendRequest({ id: "invalid-capability" }), /Invalid isolated/);
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].messages.length, 0);
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
