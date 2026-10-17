const test = require("node:test");
const assert = require("node:assert/strict");
const { createLive, pageOperation, consoleCapture } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");
test("native focus delivery is observed without replaying the click", async () => {
  const element = { isConnected: true, contains() { return false; } };
  const document = { activeElement: {} }, location = { href: "https://example.com/" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map([["n1", element]]) };
  const context = { document, location, setTimeout, __chatGPTSafariLiveDocument: state };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, context);
  setTimeout(() => { document.activeElement = element; }, 25);
  const response = await operation("focused", { documentId: "doc", snapshotId: "snap", node: "n1" });
  assert.equal(response.ok, true);
  assert.equal(response.result.focused, true);
});
test("clipboard receipts require a trusted exact source event and wait for event completion without reading data", () => {
  const listeners = new Map(), timers = new Map(), sent = []; let nextTimer = 0;
  const source = { isConnected: true, contains() { return false; } }, other = { nodeType: 1 };
  const document = { activeElement: source, addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); } };
  const location = { href: "https://example.test/" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map([["n1", source]]) };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, {
    document, location, __chatGPTSafariLiveDocument: state,
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    browser: { runtime: { async sendMessage(message) { sent.push(message); } } } });
  assert.equal(operation("clipboard_arm", { documentId: "doc", snapshotId: "snap", node: "n1", token: "opaque-once", clipboardOperation: "paste" }).result.armed, true);
  const observe = listeners.get("paste"), event = (trusted, node) => ({ isTrusted: trusted, composedPath: () => [node],
    get clipboardData() { throw new Error("Observer must never read clipboard contents"); } });
  observe(event(false, source)); observe(event(true, other));
  state.documentId = "other"; observe(event(true, source)); state.documentId = "doc";
  assert.equal(sent.length, 0); assert.equal(listeners.get("paste"), observe);
  observe(event(true, source));
  assert.equal(sent.length, 0, "capture-phase arrival is not completion"); assert.equal(listeners.has("paste"), false);
  assert.equal([...timers.values()].some(timer => timer.ms === 120000), false);
  for (const timer of timers.values()) timer.callback();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: "chatgpt-safari:clipboard-receipt", token: "opaque-once", clipboardOperation: "paste",
    documentId: "doc", snapshotId: "snap", url: location.href }]);
});
test("turn-scoped console capture preserves real page console methods, bounds messages, and cleans up without changing later site wrappers", () => {
  const vm = require("node:vm"), listeners = new Map(); let consoleCalls = 0;
  const original = () => { consoleCalls++; };
  const location = { href: "https://example.com/", origin: "https://example.com" };
  const window = { addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(data) { for (const listener of listeners.get("message") || []) listener({ isTrusted: true, source: window, origin: location.origin, data }); } };
  const scope = vm.createContext({ window, location, crypto: require("node:crypto").webcrypto, Uint8Array, setTimeout, clearTimeout,
    console: Object.fromEntries(["debug", "info", "log", "warn", "error"].map(level => [level, original])) });
  vm.runInContext(`globalThis.operation=${pageOperation.toString()};globalThis.capture=${consoleCapture.toString()}`, scope);
  const binding = scope.operation("logs_bind", { scope: "session-owner-turn" }).result;
  scope.capture("start", binding.token);
  for (let i = 0; i < 503; i++) scope.console.log("message " + i);
  assert.equal(consoleCalls, 503);
  const captured = scope.operation("logs_read", { scope: "session-owner-turn", limit: 500 }).result;
  assert.equal(captured.logs.length, 500); assert.equal(captured.logs[0].message, "message 3");
  assert.equal(scope.operation("logs_read", { scope: "different-owner" }).ok, false);
  const laterSiteWrapper = () => {}; scope.console.warn = laterSiteWrapper;
  assert.equal(scope.operation("logs_release", { scope: "session-owner-turn" }).result.token, binding.token);
  scope.capture("stop", binding.token);
  assert.equal(scope.console.log, original); assert.equal(scope.console.warn, laterSiteWrapper);
  assert.equal(scope.operation("logs_read", { scope: "session-owner-turn" }).ok, false);
});
test("typing rejects submit inputs before an implicit native click can activate them", async () => {
  const element = { tagName: "INPUT", type: "submit", isConnected: true, matches() { return false; }, getAttribute() { return null; },
    scrollIntoView() {}, getBoundingClientRect() { return { width: 100, height: 30 }; } };
  const location = { href: "https://example.com/" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map([["n1", element]]) };
  const context = { location, requestAnimationFrame(callback) { callback(); }, getComputedStyle() { return { opacity: "1" }; }, __chatGPTSafariLiveDocument: state };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, context);
  const response = await operation("prepare", { documentId: "doc", snapshotId: "snap", node: "n1", type: "type" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOT_EDITABLE");
});
test("WebMCP detection reports only actual document provider methods without installing a provider", () => {
  for (const modelContext of [undefined, { getTools() {}, executeTool() {} }]) {
    const document = { modelContext }, location = { href: "https://example.test/", origin: "https://example.test" };
    const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, { document, location, crypto: require("node:crypto").webcrypto, Uint8Array });
    const result = operation("query", { command: { type: "safari_webmcp_probe" } }).result;
    assert.equal(result.getTools, modelContext ? "function" : "undefined");
    assert.equal(result.executeTool, modelContext ? "function" : "undefined");
    assert.equal(result.originOpaque, false); assert.equal(Object.keys(result).length, 3);
    assert.equal(document.modelContext, modelContext);
  }
});
test("live page text excludes shadow stylesheet/script/template sources while retaining visible shadow and iframe text", () => {
  const location = { href: "https://example.test/" }, document = { nodeType: 9, title: "Owned fixture", body: { innerText: "Visible page body" } };
  document.defaultView = { getComputedStyle: element => ({ display: "block", opacity: "1", visibility: "visible", ...element.style }) };
  const element = (tagName, style = {}, doc = document) => ({ tagName, style, ownerDocument: doc, parentElement: null,
    getRootNode() { return document; }, getBoundingClientRect() { return { width: 100, height: 20 }; } });
  const host = element("SECTION"), shadow = { nodeType: 11, ownerDocument: document, host, querySelectorAll() { return []; } }; host.shadowRoot = shadow;
  const parent = (tagName, style) => { const node = element(tagName, style); node.getRootNode = () => shadow; return node; };
  shadow.textNodes = [
    { textContent: "[data-darkreader-inline-bgcolor] { background: secret-style; }", parentElement: parent("STYLE") },
    { textContent: "provider script source", parentElement: parent("SCRIPT") },
    { textContent: "template-only text", parentElement: parent("TEMPLATE") },
    { textContent: "noscript-only text", parentElement: parent("NOSCRIPT") },
    { textContent: "hidden shadow text", parentElement: parent("DIV", { display: "none" }) },
    { textContent: "invisible shadow text", parentElement: parent("DIV", { visibility: "hidden" }) },
    { textContent: "Visible shadow button", parentElement: parent("BUTTON") },
    { textContent: "Visible direct shadow text", parentElement: null },
  ];
  document.createTreeWalker = root => { let index = 0; return { nextNode() { return root.textNodes[index++] || null; } }; };
  document.createRange = () => ({ selectNodeContents() {}, getClientRects() { return [{ width: 20, height: 10 }]; } });
  const frame = element("IFRAME"); frame.title = "Owned same-origin frame"; frame.src = "https://example.test/frame";
  const frameDocument = { nodeType: 9, body: { innerText: "Visible iframe body" }, defaultView: { frameElement: frame }, querySelectorAll() { return []; } }; frame.contentDocument = frameDocument;
  document.querySelectorAll = selector => selector === "*" ? [host, frame] : selector === "iframe" ? [frame] : [];
  const operation = vmOperation({ document, location, crypto: require("node:crypto").webcrypto, Uint8Array,
    getComputedStyle: document.defaultView.getComputedStyle, innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0 });
  const result = operation("read", { maxLength: 3000 }).result;
  assert.match(result.text, /Visible page body/); assert.match(result.text, /Visible shadow button/);
  assert.match(result.text, /Visible direct shadow text/); assert.match(result.text, /Visible iframe body/);
  assert.doesNotMatch(result.text, /darkreader|secret-style|script source|template-only|noscript-only|hidden shadow|invisible shadow/);
  assert.equal(result.truncated, false);
  frame.style.display = "none";
  assert.doesNotMatch(operation("read", { maxLength: 3000 }).result.text, /Visible iframe body/);
  function vmOperation(context) { return require("node:vm").runInNewContext(`(${pageOperation.toString()})`, context); }
});
function fixture(fastLoadingObservation = false) {
  const profileId = "55555555-5555-4555-8555-555555555555", calls = [], scripts = [], listeners = [];
  const tab = { id: 12, windowId: 8, url: "https://example.com/", title: "Existing session", status: "complete", active: true };
  let nativeResponse = { ok: true, requests: [] };
  let focused = true;
  let pageResponse = { ok: true, result: { url: tab.url, documentId: "doc", snapshotId: "snap", nodes: [] } };
  const api = {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendNativeMessage(_, message) { calls.push(message.command); return typeof nativeResponse === "function" ? nativeResponse(message.command) : nativeResponse; } },
    storage: { local: { async get() { return { safariLiveProfileId: profileId }; } } },
    tabs: { async query() { return [{ ...tab }, { id: 13, url: "https://private.example/", incognito: true }]; },
      async get() { return { ...tab }; }, async update(id, value) { calls.push({ update: { id, ...value } }); return { ...tab }; },
      async create(value) { calls.push({ create: value }); return { ...tab }; }, async remove(id) { calls.push({ remove: id }); } },
    windows: { async get() { return { focused, left: 0, top: 0, width: 1000, height: 800 }; }, async update() {} },
    scripting: { async executeScript(value) { scripts.push(value); return [{ result: typeof pageResponse === "function" ? await pageResponse(value) : pageResponse }]; } },
  };
  const environment = { crypto: require("node:crypto"), setInterval() {}, clearInterval() {},
    setTimeout: fastLoadingObservation ? (callback, ms) => ms === 100 ? queueMicrotask(callback) : setTimeout(callback, ms) : setTimeout };
  const binding = createLive(api, environment);
  const request = (action, arguments_ = {}) => ({ id: "operation", deadline: Date.now() + 10000, command: { action, arguments: arguments_ } });
  return { profileId, tab, calls, scripts, binding, request, api, environment, setNative(x) { nativeResponse = x; }, setPage(x) { pageResponse = x; }, setFocused(x) { focused = x; },
    message(value, sender) { for (const listener of listeners) listener(value, sender); },
    setSidebar(value) { environment.ChatGPTSafariSidebar = value; } };
}
test("only owner-bound original-agent input enters the operation-scoped sidebar selection transaction", async () => {
  const f = fixture(); await f.binding.start();
  const events = [];
  f.setSidebar({ async withAgentSelection(owner, tab, operation) {
    assert.equal(owner, "real-inline-owner"); assert.equal(tab.id, 12);
    events.push("begin");
    const result = await operation({ async select(value) { assert.equal(value.id, 12); events.push("select"); },
      assertCurrent() { events.push("current"); } });
    events.push("restore"); return result;
  } });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(() => ({ ok: true, result: { eventsPosted: 2 } }));
  const request = { ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "click", node: "n1" }] }), agentOwner: "real-inline-owner" };
  await f.binding.execute(request);
  assert.deepEqual(events, ["begin", "select", "current", "current", "restore"]);
  assert.equal(f.calls.some(value => value.update), false, "the transaction owns the selection update");
  events.length = 0;
  await f.binding.execute({ ...request, agentOwner: undefined });
  assert.deepEqual(events, [], "ordinary live/MCP callers retain their existing selection behavior");
  assert.equal(f.calls.some(value => value.update), true);
  f.setSidebar(undefined);
  const before = f.calls.length;
  await assert.rejects(f.binding.execute(request), { code: "INVALID_OWNER" });
  assert.equal(f.calls.length, before, "a missing sidebar owner cannot fall back to unscoped input");
});
test("an explicit native modal plan travels with one click before any blocked callback or page observation", async () => {
  const f = fixture(); await f.binding.start();
  const policy = { kind: "dialog", type: "prompt", message: "Exact?", accept: true, promptText: "Answer", timeout_ms: 10000 };
  const actual = { kind: "dialog", type: "prompt", message: "Exact?", accepted: true, responseVerified: true, done: true };
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) { return operation({ async select() {}, assertCurrent() {} }); } });
  f.setPage(script => ({ ok: true, result: script.args[0] === "read" ? { url: f.tab.url, documentId: "doc", snapshotId: "after", nodes: [] }
    : { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } }));
  f.setNative(command => {
    if (command.input?.action === "click") {
      assert.deepEqual(command.input.modalPlan, { policy, scope: { profileId: f.profileId, tabId: "12", documentId: "doc", node: "n1",
        ownerId: "owner", accountScope: "account", sessionId: "work-session", turnId: "work-turn" } });
      assert.equal(f.scripts.some(script => script.args[0] === "filechooser_arm"), false, "no modal-time extension message is needed");
      return { ok: true, result: { eventsPosted: 4, nativeModal: actual } };
    }
    return { ok: true, result: { eventsPosted: 0 } };
  });
  const request = { ...f.request("interact", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, documentId: "doc", snapshotId: "snap", nativeModal: policy,
    agentScope: { ownerId: "owner", accountScope: "account", sessionId: "work-session", turnId: "work-turn" },
    interactions: [{ type: "click", node: "n1" }] }), agentOwner: "owner" };
  const result = await f.binding.execute(request);
  assert.equal(result.completed[0].result.nativeModal, actual);
  assert.deepEqual(f.calls.filter(call => call.input?.action).map(call => call.input.action), ["focus", "click"]);
  await assert.rejects(f.binding.execute({ ...request, agentOwner: undefined }), { code: "INVALID_NATIVE_MODAL" });
});
test("approved native upload source cannot rebind to another node, document, snapshot, or multiple flag", () => {
  const crypto = require("node:crypto").webcrypto, location = { href: "https://example.test/" };
  let element = { disabled: false, multiple: false, matches: value => value === "input[type=file]" };
  const state = { documentId: "document", snapshotId: "snapshot", url: location.href, nodes: new Map() };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, { document: {}, location, crypto, Uint8Array,
    __chatGPTSafariLiveDocument: state, __chatGPTSafariPlaywright: { parseSelector: value => value, querySelectorAll: () => [element], elementState: () => ({ matches: true }) } });
  const source = operation("query", { command: { type: "safari_native_upload_inspect", selector: "input[type=file]" } }).result;
  assert.equal(source.isMultiple, false); assert.equal(source.documentId, "document");
  const inspect = () => operation("query", { command: { type: "safari_native_upload_inspect", selector: "input[type=file]", safari_upload_source: source } });
  assert.equal(inspect().ok, true);
  element.multiple = true; assert.equal(inspect().error.code, "UPLOAD_SOURCE_CHANGED"); element.multiple = false;
  state.snapshotId = "other-snapshot"; assert.equal(inspect().error.code, "UPLOAD_SOURCE_CHANGED"); state.snapshotId = "snapshot";
  state.documentId = "other-document"; assert.equal(inspect().error.code, "UPLOAD_SOURCE_CHANGED"); state.documentId = "document";
  element = { ...element }; assert.equal(inspect().error.code, "UPLOAD_SOURCE_CHANGED");
});
test("rich session paste uses one scoped trusted shortcut with explicit MIME bytes and no implicit click", async () => {
  const f = fixture(); await f.binding.start();
  const items = [{ entries: [{ mime_type: "text/plain", text: "Plain" }, { mime_type: "text/html", text: "<b>Rich</b>" }] }];
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) { return operation({ async select() {}, assertCurrent() {} }); } });
  f.setPage(script => ({ ok: true, result: script.args[0] === "read" ? { url: f.tab.url, documentId: "doc", snapshotId: "after", nodes: [] }
    : { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } }));
  f.setNative(command => {
    if (command.input?.action === "key") {
      assert.equal(command.input.key, "Meta+v");
      assert.match(command.input.clipboardPlan.receiptToken, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(command.input.clipboardPlan, { operation: "paste", items, receiptToken: command.input.clipboardPlan.receiptToken, scope: { profileId: f.profileId, ownerId: "owner", accountScope: "account",
        sessionId: "work-session", turnId: "work-turn", tabId: "12", documentId: "doc", node: "n1" } });
      return { ok: true, result: { eventsPosted: 2, nativeClipboard: { operation: "paste", nativeKeyDelivered: true, trustedPageReceipt: true, nativeDataRead: true, clipboardRestoration: "restored" } } };
    }
    return { ok: true, result: { eventsPosted: 0 } };
  });
  const request = { ...f.request("interact", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, documentId: "doc", snapshotId: "snap",
    agentScope: { ownerId: "owner", accountScope: "account", sessionId: "work-session", turnId: "work-turn" },
    interactions: [{ type: "clipboard", operation: "paste", node: "n1", items }] }), agentOwner: "owner" };
  const result = await f.binding.execute(request);
  assert.equal(result.completed[0].type, "clipboard"); assert.equal(result.completed[0].result.nativeClipboard.clipboardRestoration, "restored");
  assert.deepEqual(f.calls.filter(call => call.input?.action).map(call => call.input.action), ["focus", "key"]);
  assert.equal(f.scripts.some(script => script.args[0] === "filechooser_arm"), false);
  const arm = f.scripts.find(script => script.args[0] === "clipboard_arm").args[1];
  assert.equal(arm.clipboardItems, undefined, "event observers receive no clipboard bytes");
  const observation = { type: "chatgpt-safari:clipboard-receipt", token: arm.token, clipboardOperation: "paste", documentId: "doc", snapshotId: "snap", url: f.tab.url };
  const sender = { tab: { id: 12 }, frameId: 0, url: f.tab.url };
  for (const changed of [{ token: "wrong" }, { clipboardOperation: "copy" }, { documentId: "other" }, { snapshotId: "other" }, { url: "https://other.test/" }]) f.message({ ...observation, ...changed }, sender);
  for (const changed of [{ tab: { id: 13 } }, { frameId: 1 }, { url: "https://other.test/" }]) f.message(observation, { ...sender, ...changed });
  assert.equal(f.calls.some(call => call.action === "liveClipboardReceipt"), false);
  f.message(observation, sender); f.message(observation, sender);
  const receipts = f.calls.filter(call => call.action === "liveClipboardReceipt");
  assert.equal(receipts.length, 1);
  assert.deepEqual(Object.keys(receipts[0].input).sort(), ["scope", "token"]);
  assert.equal(receipts[0].input.scope.node, "n1");
  await assert.rejects(f.binding.execute({ ...request, agentOwner: undefined }), { code: "INVALID_NATIVE_CLIPBOARD" });
});
test("only native group moves connect their confirmed native result to the sidebar transition lease", async () => {
  const f = fixture(); await f.binding.start();
  const calls = [];
  f.setSidebar({ async withAgentSelection(owner, tab, operation, scope) {
    assert.equal(owner, "owner"); assert.equal(tab.id, 12); calls.push(scope.nativeGroupMove);
    return operation({ async select() {}, assertCurrent() {}, async runNativeGroupMove(action, perform) {
      calls.push(action); const result = await perform(); assert.equal(result.mutationApplied, true); return result;
    } });
  } });
  f.setNative(command => ({ ok: true, result: command.action === "liveOrganize"
    ? { action: command.input.action, mutationApplied: true, selectedTab: { index: 0, title: f.tab.title, url: f.tab.url } }
    : { eventsPosted: 0 } }));
  const request = operation => ({ ...f.request("organize", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, operation }), agentOwner: "owner" });
  await f.binding.execute(request("createGroup"));
  assert.deepEqual(calls, ["createGroup", "createGroup"]);
  calls.length = 0;
  await f.binding.execute(request("inspect"));
  assert.deepEqual(calls, [undefined], "read-only native inventory cannot defer arbitrary user activation");
  calls.length = 0;
  await f.binding.execute(request("inspectWindowSource"));
  assert.deepEqual(calls, [undefined], "read-only window-source proof cannot acquire a native group-move lease");
});
test("poll discovery never launches the companion; real handles bind the profile and tab", async () => {
  const f = fixture(); await f.binding.start();
  assert.deepEqual(f.calls.map(x => x.action), ["livePoll"]);
  const result = await f.binding.execute(f.request("list_tabs"));
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].handle, `live:${f.profileId}:12`);
  assert.equal(result.tabs[0].profileId, f.profileId);
  await assert.rejects(f.binding.execute(f.request("read_page", { handle: "live:other-profile:12" })), { code: "INVALID_HANDLE" });
});
test("live polling keeps scoped selection diagnostics available independently of sidebar ownership", async () => {
  const f = fixture();
  const selection = { phase: "rejected", action: "createGroup", before: [{ tabId: 12, windowId: 8, active: true }],
    after: [{ tabId: 99, windowId: 9, active: true }], events: [{ type: "windowFocusChanged", windowId: 9 }] };
  f.setSidebar({ selectionDiagnostics: () => structuredClone(selection) });
  await f.binding.start();
  assert.deepEqual(f.calls[0].selection, selection);
  assert.equal(f.calls[0].action, "livePoll");
});
test("a batch activates Safari once and does not undo a later manual focus change", async () => {
  const f = fixture();
  const request = f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "click", node: "n1" }, { type: "click", node: "n2" }] });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => {
    if (command.action === "livePoll") return { ok: true, requests: [request] };
    if (command.action === "liveInput") {
      if (command.input.action === "click") f.setFocused(false);
      return { ok: true, result: { action: command.input.action, eventsPosted: command.input.action === "click" ? 2 : 0 } };
    }
    return { ok: true };
  });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
  assert.equal(f.calls.at(-1).response.error.code, "FOCUS_CHANGED");
  assert.equal(f.calls.at(-1).response.error.data.completed.length, 1);
});
test("a still-loading page keeps its real handle and completed input instead of replaying navigation", async () => {
  const f = fixture(true); await f.binding.start();
  f.tab.status = "loading";
  const created = await f.binding.execute(f.request("create_tab", { profileId: f.profileId, url: f.tab.url }));
  assert.equal(created.status, "loading");
  assert.equal(created.handle, `live:${f.profileId}:12`);
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(() => ({ ok: true, result: { eventsPosted: 2 } }));
  const result = await f.binding.execute(f.request("interact", { handle: created.handle, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] }));
  assert.equal(result.pagePending, true);
  assert.equal(result.tab.handle, created.handle);
  assert.equal(result.completed.length, 1);
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
});
test("stale snapshots and navigation are rejected before any native input", async () => {
  const f = fixture(); await f.binding.start();
  const handle = `live:${f.profileId}:12`;
  f.setPage({ ok: false, error: { code: "STALE_TARGET", message: "Read again" } });
  await assert.rejects(f.binding.execute(f.request("interact", { handle, documentId: "old", snapshotId: "old", interactions: [{ type: "click", node: "n1" }] })), { code: "STALE_TARGET" });
  assert.equal(f.calls.filter(x => x.action === "liveInput").length, 0);
  await assert.rejects(f.binding.execute(f.request("navigate", { handle, expectedUrl: "https://old.example/", url: "https://next.example/" })), { code: "STALE_TARGET" });
  assert.equal(f.calls.filter(x => x.update).length, 0);
});
test("a newly leased about:blank tab can navigate but cannot be read as a website", async () => {
  const f = fixture(); await f.binding.start(); f.tab.url = "about:blank";
  await assert.rejects(f.binding.execute(f.request("read_page", { handle: `live:${f.profileId}:12` })), { code: "BLANK_DOCUMENT" });
  const result = await f.binding.execute(f.request("navigate", { handle: `live:${f.profileId}:12`, expectedUrl: "about:blank", url: "https://example.com/created" }));
  assert.equal(f.calls.at(-1).update.url, "https://example.com/created");
  assert.equal(result.tabId, 12);
});
test("the exact newly claimed about:blank tab can close without opening an internal-page control path", async () => {
  const f = fixture(); await f.binding.start(); f.tab.url = "about:blank";
  const handle = `live:${f.profileId}:12`;
  await assert.rejects(f.binding.execute(f.request("close_tab", { handle })), /expectedUrl|HTTP\/HTTPS/);
  await assert.rejects(f.binding.execute(f.request("close_tab", { handle: "live:other-profile:12", expectedUrl: "about:blank" })), { code: "INVALID_HANDLE" });
  const result = await f.binding.execute(f.request("close_tab", { handle, expectedUrl: "about:blank" }));
  assert.deepEqual(result, { closed: true, handle });
  assert.deepEqual(f.calls.filter(value => value.remove), [{ remove: 12 }]);
  assert.equal(f.scripts.length, 0);
  f.tab.url = "safari://Bookmarks";
  await assert.rejects(f.binding.execute(f.request("close_tab", { handle, expectedUrl: f.tab.url })), { code: "INVALID_URL" });
  assert.equal(f.calls.filter(value => value.remove).length, 1);
});
test("missing and empty tab URLs permit blank navigation only with an exact native top-frame proof", async () => {
  for (const missing of [undefined, ""]) {
    const f = fixture(); await f.binding.start(); f.tab.url = missing;
    const nativeQueries = [];
    f.api.webNavigation = { async getAllFrames(query) { nativeQueries.push(query); return [{ frameId: 0, parentFrameId: -1, url: "about:blank", errorOccurred: false }]; } };
    assert.equal(await f.binding.navigationSourceUrl(12), "about:blank");
    await assert.rejects(f.binding.execute(f.request("read_page", { handle: `live:${f.profileId}:12` })), { code: "TAB_URL_UNAVAILABLE" });
    assert.equal(f.scripts.length, 0);
    const result = await f.binding.execute(f.request("navigate", { handle: `live:${f.profileId}:12`, expectedUrl: "about:blank", url: "https://example.test/new" }));
    assert.equal(result.tabId, 12); assert.equal(f.calls.at(-1).update.url, "https://example.test/new");
    assert.deepEqual(nativeQueries, [{ tabId: 12 }, { tabId: 12 }]);
    assert.equal(f.tab.url, missing, "native Tab metadata is not rewritten or retained as a blank alias");
    await f.binding.execute(f.request("close_tab", { handle: `live:${f.profileId}:12`, expectedUrl: "about:blank" }));
    assert.equal(f.calls.at(-1).remove, 12);
  }
});
test("unknown, errored, pending, ambiguous, stale or internal native frame metadata never becomes blank authority", async () => {
  for (const frames of [null, [], [{ frameId: 1, parentFrameId: 0, url: "about:blank" }],
    [{ frameId: 0, parentFrameId: -1, url: "safari://Bookmarks" }], [{ frameId: 0, parentFrameId: -1, url: "https://example.test/" }],
    [{ frameId: 0, parentFrameId: -1, url: "about:blank", errorOccurred: true }],
    [{ frameId: 0, parentFrameId: -1, url: "about:blank" }, { frameId: 0, parentFrameId: -1, url: "about:blank" }]]) {
    const f = fixture(); await f.binding.start(); f.tab.url = undefined;
    f.api.webNavigation = { async getAllFrames() { return frames; } };
    await assert.rejects(f.binding.navigationSourceUrl(12), { code: "TAB_URL_UNAVAILABLE" });
    assert.equal(f.scripts.length, 0); assert.equal(f.calls.some(value => value.update || value.remove), false);
  }
  const f = fixture(); await f.binding.start(); f.tab.url = undefined;
  await assert.rejects(f.binding.navigationSourceUrl(12), { code: "TAB_URL_UNAVAILABLE" });
  f.api.webNavigation = { async getAllFrames() { f.tab.windowId = 9; return [{ frameId: 0, parentFrameId: -1, url: "about:blank" }]; } };
  await assert.rejects(f.binding.navigationSourceUrl(12), { code: "STALE_TARGET" });
  f.tab.pendingUrl = "https://example.test/pending";
  await assert.rejects(f.binding.navigationSourceUrl(12), { code: "STALE_TARGET" });
  assert.equal(f.calls.some(value => value.update || value.remove), false);
});
test("a real native modal stops input before DOM focus/readback and holds the sidebar selection", async () => {
  const f = fixture(); await f.binding.start(); const events = [];
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) {
    return operation({ async select() {}, assertCurrent() {}, holdDialog() { events.push("hold"); } });
  } });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => ({ ok: true, result: { eventsPosted: command.input?.action === "click" ? 2 : 0,
    ...(command.input?.action === "click" ? { dialogOpen: true } : {}) } }));
  const result = await f.binding.execute({ ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "click", node: "n1" }, { type: "type", node: "n2", value: "must not enter" }] }), agentOwner: "owner" });
  assert.equal(result.dialogOpen, true); assert.equal(result.completed.length, 1); assert.deepEqual(events, ["hold"]);
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
  assert.equal(f.scripts.some(x => ["focused", "read"].includes(x.args?.[0])), false);
});
test("native input receipts are acknowledged before page work and before unwrapping a native failure", async () => {
  for (const failed of [false, true]) {
    const f = fixture(); await f.binding.start(); const events = []; let sequence = 0;
    f.setPage(script => { events.push(script.args?.[0]); return { ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } }; });
    f.setNative(command => {
      if (command.action === "liveInput") {
        events.push(command.input.action);
        const inputReceiptSequence = ++sequence;
        if (command.input.action === "click" && failed) return { ok: false, inputReceiptSequence, error: { code: "NATIVE_FAILURE", message: "Observed native failure", eventsPosted: 2, mayHavePostedInput: true } };
        return { ok: true, inputReceiptSequence, result: { eventsPosted: command.input.action === "click" ? 2 : 0, ...(command.input.action === "click" ? { dialogOpen: true } : {}) } };
      }
      if (command.action === "liveInputAck") { events.push("ack-" + command.receiptSequence); assert.deepEqual(Object.keys(command).sort(), ["action", "id", "profileId", "receiptSequence", "sessionId"]); }
      return { ok: true, result: {} };
    });
    const action = f.binding.execute(f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] }));
    if (failed) await assert.rejects(action, { code: "NATIVE_FAILURE" }); else assert.equal((await action).dialogOpen, true);
    assert.equal(events[events.indexOf("focus") + 1], "ack-1"); assert.equal(events[events.indexOf("click") + 1], "ack-2");
    assert.equal(events.at(-1), "ack-2", "Native outcome unwrapping cannot schedule page work before its receipt acknowledgement");
  }
});
test("an unsettled native callback reports one payload-free timeout without retrying or completing the input", async () => {
  const f = fixture(); await f.binding.start(); let releaseClick, reportTimeout, complete = false;
  const reported = new Promise(resolve => { reportTimeout = resolve; });
  f.environment.setTimeout = (callback, ms) => setTimeout(callback, ms === 2000 ? 5 : ms);
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => {
    if (command.action === "liveInput" && command.input.action === "click") return new Promise(resolve => { releaseClick = resolve; });
    if (command.action === "liveInputCallbackTimeout") { assert.deepEqual(Object.keys(command).sort(), ["action", "id", "profileId", "sessionId"]); reportTimeout(); }
    return { ok: true, result: { eventsPosted: 0 } };
  });
  const input = f.binding.execute(f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] })).then(result => { complete = true; return result; });
  await reported; assert.equal(complete, false); assert.equal(f.calls.filter(call => call.input?.action === "click").length, 1);
  releaseClick({ ok: true, inputReceiptSequence: 2, result: { eventsPosted: 2, dialogOpen: true } });
  assert.equal((await input).dialogOpen, true); assert.equal(f.calls.filter(call => call.action === "liveInputCallbackTimeout").length, 1);
  assert.equal(f.calls.at(-1).action, "liveInputAck");
});
test("download API detection reports only Safari's actual extension methods and never reads download history", async () => {
  const f = fixture(); await f.binding.start();
  const absent = await f.binding.execute(f.request("dom_query", { handle: `live:${f.profileId}:12`, command: { type: "safari_downloads_probe" } }));
  assert.deepEqual(absent, { download: "undefined", search: "undefined", onCreated: "undefined", onChanged: "undefined" });
  f.api.downloads = { search() { assert.fail("Detection must not read download history"); }, onCreated: { addListener() {} } };
  const actual = await f.binding.execute(f.request("dom_query", { handle: `live:${f.profileId}:12`, command: { type: "safari_downloads_probe" } }));
  assert.equal(actual.search, "function"); assert.equal(actual.onCreated, "function"); assert.equal(actual.onChanged, "undefined");
  assert.equal(f.scripts.length, 0);
});
test("viewport native transactions receive the real background session and original sidebar selection owner", async () => {
  const f = fixture(); await f.binding.start(); let received, selected;
  f.setSidebar({ async withAgentSelection(owner, tab, operation, scope) {
    assert.equal(owner, "owner"); assert.equal(tab.id, 12); assert.equal(scope.action, "viewport");
    selected = { async select() {}, assertCurrent() {} }; return operation(selected);
  } });
  f.environment.ChatGPTSafariViewport = { async run(request, selection) { received = request; assert.equal(selection, selected); return {}; } };
  const request = { ...f.request("viewport", { handle: `live:${f.profileId}:12` }), agentOwner: "owner", sessionId: "model-cannot-override" };
  assert.deepEqual(await f.binding.execute(request), {}); assert.notEqual(received.sessionId, "model-cannot-override");
  assert.equal(typeof received.sessionId, "string"); assert.equal(received.agentOwner, "owner");
});
test("native JavaScript dialogs bypass page scripts and preserve their actual lease ID", async () => {
  const f = fixture(); await f.binding.start(); const events = [];
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) {
    return operation({ async select() {}, holdDialog() { events.push("hold"); }, releaseDialog() { events.push("release"); } });
  } });
  f.setNative(command => ({ ok: true, result: command.action === "liveDialog" && command.input.action === "inspect"
    ? { dialog: { id: "real-native-lease", type: "prompt", message: "Fixture" } } : { done: true } }));
  const call = operation => f.binding.execute({ ...f.request("dialog", { handle: `live:${f.profileId}:12`, operation,
    ...(operation === "accept" ? { dialogId: "real-native-lease", promptText: "Native response" } : {}) }), agentOwner: "owner" });
  assert.deepEqual(await call("inspect"), { dialog: { id: "real-native-lease", type: "prompt", message: "Fixture" } });
  assert.deepEqual(await call("accept"), {}); assert.deepEqual(events, ["hold", "release"]);
  assert.equal(f.scripts.length, 0, "modal operations must not wait for page JavaScript");
  assert.equal(f.calls.filter(x => x.action === "liveDialog").at(-1).input.dialogId, "real-native-lease");
});
test("a blocked post-click read performs one native modal inspection and frees polling without replay or late continuation", async () => {
  for (const dialogOpen of [true, false]) {
    const f = fixture(); let finishRead, polls = 0, held = 0;
    f.environment.setTimeout = (callback, ms) => setTimeout(callback, ms === 2000 ? 5 : ms);
    f.setSidebar({ selectionDiagnostics() {}, async withAgentSelection(_owner, _tab, operation) {
      return operation({ async select() {}, assertCurrent() {}, holdDialog() { held++; } });
    } });
    const input = { ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] }), agentOwner: "owner" };
    const listing = { ...f.request("list_tabs"), id: "next-listing" };
    f.setPage(script => script.args?.[0] === "read" ? new Promise(resolve => { finishRead = resolve; })
      : { ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
    f.setNative(command => {
      if (command.action === "livePoll") return { ok: true, requests: [++polls === 1 ? input : listing] };
      if (command.action === "liveModal") return { ok: true, result: { dialogOpen, fileChooserOpen: false } };
      return { ok: true, result: { eventsPosted: command.input?.action === "click" ? 2 : 0 } };
    });
    await f.binding.start();
    const resolved = f.calls.find(call => call.action === "liveResolve").response;
    if (dialogOpen) { assert.equal(resolved.result.dialogOpen, true); assert.equal(resolved.result.completed.length, 1); assert.equal(held, 1); }
    else { assert.equal(resolved.error.code, "POST_INPUT_READBACK_TIMEOUT"); assert.equal(resolved.error.data.completed.length, 1); assert.equal(resolved.error.data.doNotReplay, true); assert.equal(held, 0); }
    assert.equal(f.calls.filter(call => call.action === "liveModal").length, 1);
    assert.equal(f.calls.filter(call => call.input?.action === "click").length, 1);
    await f.binding.poll();
    assert.ok(f.calls.some(call => call.action === "liveResolve" && call.id === "next-listing" && call.response.ok));
    const count = f.calls.length, scripts = f.scripts.length;
    finishRead({ ok: true, result: { url: f.tab.url, documentId: "late-doc", snapshotId: "late-snap", nodes: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, count, "A late script result must not continue the abandoned read/target pipeline");
    assert.equal(f.scripts.length, scripts);
  }
});
test("a delayed dialog after an implicit click cannot allow pending typing to resume", async () => {
  const f = fixture(); await f.binding.start(); let finishFocus;
  f.environment.setTimeout = (callback, ms) => setTimeout(callback, ms === 2000 ? 5 : ms);
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) { return operation({ async select() {}, assertCurrent() {}, holdDialog() {} }); } });
  f.setPage(script => script.args?.[0] === "focused" ? new Promise(resolve => { finishFocus = resolve; })
    : { ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => ({ ok: true, result: command.action === "liveModal" ? { dialogOpen: true, fileChooserOpen: false }
    : { eventsPosted: command.input?.action === "click" ? 2 : 0 } }));
  const result = await f.binding.execute({ ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "type", node: "n1", value: "never deliver" }] }), agentOwner: "owner" });
  assert.equal(result.dialogOpen, true); assert.deepEqual(result.completed.map(step => step.type), ["click"]);
  finishFocus({ ok: true, result: { focused: true } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(call => call.action === "liveInput").map(call => call.input.action), ["focus", "click"]);
});
test("an expired queued post-input script cannot scroll, focus, or arm another action after a modal closes", () => {
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, {});
  for (const action of ["prepare", "query", "filechooser_arm"]) {
    const response = operation(action, { _nativeObservationDeadline: Date.now() - 1 });
    assert.equal(response.ok, false); assert.equal(response.error.code, "POST_INPUT_READBACK_TIMEOUT");
  }
});
test("file input observation requires an actual trusted gesture and binds the real input without invoking it", async () => {
  const listeners = new Set(), reports = [], location = { href: "https://example.com/upload" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map() };
  const document = { nodeType: 9, querySelectorAll() { return []; }, addEventListener(type, callback) { if (type === "click") listeners.add(callback); },
    removeEventListener(type, callback) { listeners.delete(callback); } };
  const navigator = { userActivation: { isActive: false } };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, { document, location, navigator,
    crypto: require("node:crypto").webcrypto, Uint8Array, setTimeout, clearTimeout, __chatGPTSafariLiveDocument: state,
    browser: { runtime: { async sendMessage(value) { reports.push(value); } } } });
  assert.equal(operation("filechooser_arm", { documentId: "doc", snapshotId: "snap", token: "capability", point: { x: 10, y: 20 } }).ok, true);
  const input = { tagName: "INPUT", type: "file", isConnected: true, disabled: false, multiple: true,
    click() { assert.fail("An observer must not invoke the file input"); } };
  const event = { isTrusted: false, composedPath: () => [input] };
  for (const listener of listeners) listener(event);
  assert.equal(reports.length, 0, "A script without a native user activation cannot bind a chooser");
  navigator.userActivation.isActive = true;
  for (const listener of listeners) listener(event);
  assert.equal(reports.length, 0, "An unrelated earlier user activation is not this native input's trusted gesture");
  for (const listener of [...listeners]) listener({ isTrusted: true, target: {}, clientX: 10, clientY: 20, composedPath: () => [] });
  for (const listener of [...listeners]) listener(event);
  assert.equal(reports.length, 1); assert.equal(reports[0].isMultiple, true); assert.equal(reports[0].documentId, "doc");
  assert.equal(state.nodes.get(reports[0].node), input); assert.equal(listeners.size, 0);
});
test("a native file chooser binds its observed input, stops DOM work, and resumes only its exact upload scope", async () => {
  const f = fixture(); await f.binding.start(); const events = [];
  const agentScope = { ownerId: "owner", sessionId: "original-session", turnId: "original-turn" };
  let opened = false;
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation, scope) {
    events.push(scope.action);
    return operation({ async select() {}, assertCurrent() {}, holdDialog(kind) { events.push(kind); }, releaseDialog() { events.push("release"); } });
  } });
  f.setPage(script => {
    assert.equal(opened, false, "No page JavaScript may run after the native upload panel opens");
    if (script.args?.[0] === "filechooser_arm") {
      const args = script.args[1];
      const message = { type: "chatgpt-safari:file-input", token: args.token, documentId: "doc", snapshotId: "snap",
        node: "u" + "a".repeat(32), isMultiple: true, url: f.tab.url };
      f.message(message, { tab: { id: 99 }, frameId: 0, url: f.tab.url });
      f.message(message, { tab: { id: 12 }, frameId: 0, url: f.tab.url });
    }
    return { ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } };
  });
  f.setNative(command => {
    if (command.action === "liveInput" && command.input.action === "click") { opened = true; return { ok: true, result: { eventsPosted: 2, fileChooserOpen: true } }; }
    if (command.action === "liveFileChooser") return { ok: true, result: command.input.operation === "inspect" ? { fileChooser: { id: "native-chooser", isMultiple: true } } : { done: true } };
    return { ok: true, result: { eventsPosted: 0 } };
  });
  const result = await f.binding.execute({ ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap", agentScope,
    fileChooserScope: { profileId: f.profileId, tabId: "12", documentId: "doc", ...agentScope },
    interactions: [{ type: "click", node: "button" }, { type: "type", node: "n2", value: "must not enter" }] }), agentOwner: "owner" });
  assert.equal(result.fileChooserOpen, true); assert.equal(result.completed.length, 1); assert.equal(result.fileChooser.id, "native-chooser");
  assert.deepEqual(events, ["interact", "filechooser"]);
  assert.equal(f.scripts.some(script => ["focused", "read"].includes(script.args?.[0])), false);
  const scope = result.fileChooser.scope, upload = { ...f.request("filechooser", { handle: `live:${f.profileId}:12`, operation: "setFiles", chooserId: "native-chooser", scope,
    files: ["/tmp/first", "/tmp/second"], agentScope }), agentOwner: "owner" };
  await assert.rejects(f.binding.execute({ ...upload, command: { ...upload.command, arguments: { ...upload.command.arguments, scope: { ...scope, documentId: "next-document" } } } }), { code: "STALE_FILE_CHOOSER" });
  assert.deepEqual(await f.binding.execute(upload), { done: true });
  assert.equal(events.at(-1), "release");
  const native = f.calls.filter(call => call.action === "liveFileChooser");
  assert.deepEqual(native.map(call => call.input.operation), ["inspect", "setFiles"]);
  assert.deepEqual(native[1].input.scope, scope);
  await assert.rejects(f.binding.execute(upload), { code: "STALE_FILE_CHOOSER" });
});
test("a late native file chooser retains the original input observation through blocked read recovery", async () => {
  const f = fixture(); await f.binding.start(); let arm;
  f.environment.setTimeout = (callback, ms) => setTimeout(callback, ms === 2000 ? 5 : ms);
  const agentScope = { ownerId: "owner", sessionId: "original-session", turnId: "original-turn" }, held = [];
  f.setSidebar({ async withAgentSelection(_owner, _tab, operation) { return operation({ async select() {}, assertCurrent() {}, holdDialog(kind) { held.push(kind); } }); } });
  f.setPage(script => {
    if (script.args?.[0] === "filechooser_arm") arm = script.args[1];
    if (script.args?.[0] === "read") return new Promise(() => {});
    return { ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } };
  });
  f.setNative(command => {
    if (command.action === "liveModal") {
      f.message({ type: "chatgpt-safari:file-input", token: arm.token, documentId: "doc", snapshotId: "snap",
        node: "u" + "b".repeat(32), isMultiple: false, url: f.tab.url }, { tab: { id: 12 }, frameId: 0, url: f.tab.url });
      return { ok: true, result: { dialogOpen: false, fileChooserOpen: true } };
    }
    if (command.action === "liveFileChooser") return { ok: true, result: { fileChooser: { id: "late-native-chooser", isMultiple: false } } };
    return { ok: true, result: { eventsPosted: command.input?.action === "click" ? 2 : 0 } };
  });
  const result = await f.binding.execute({ ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap", agentScope,
    fileChooserScope: { profileId: f.profileId, tabId: "12", documentId: "doc", ...agentScope }, interactions: [{ type: "click", node: "n1" }] }), agentOwner: "owner" });
  assert.equal(result.fileChooser.id, "late-native-chooser"); assert.equal(result.fileChooser.scope.node, "u" + "b".repeat(32));
  assert.deepEqual(held, ["filechooser"]); assert.equal(result.completed.length, 1);
  assert.equal(f.calls.filter(call => call.input?.action === "click").length, 1);
  assert.equal(f.calls.filter(call => call.action === "liveFileChooser").length, 1);
});
test("full-page captures stitch real viewport tiles and restore the precise original scroll after success or failure", async () => {
  for (const failCapture of [false, true]) {
    const f = fixture(); await f.binding.start(); const drawings = [], scrolls = [];
    const before = { documentId: "doc", url: f.tab.url, x: 0, y: 123, viewport: { width: 1000, height: 700 }, contentWidth: 1000, width: 1000, height: 1500 };
    f.setPage(script => {
      if (script.args?.[0] === "capture_state") return { ok: true, result: before };
      const args = script.args[1]; scrolls.push({ x: args.x, y: args.y });
      return { ok: true, result: { x: args.x, y: Math.min(args.y, 800) } };
    });
    let captures = 0;
    f.api.tabs.captureVisibleTab = async () => {
      if (++captures === 2 && failCapture) throw new Error("Actual capture failed");
      return "data:image/png;base64,Zml4dHVyZQ==";
    };
    f.environment.Image = class { naturalWidth = 2000; naturalHeight = 1400; set src(_) { queueMicrotask(() => this.onload()); } };
    f.environment.document = { createElement() { return { width: 0, height: 0,
      getContext() { return { drawImage(...args) { drawings.push(args.slice(1)); } }; }, toDataURL() { return "data:image/png;base64,c3RpdGNoZWQ="; } }; } };
    const request = f.request("screenshot", { handle: `live:${f.profileId}:12`, fullPage: true });
    if (failCapture) await assert.rejects(f.binding.execute(request), /Actual capture failed/);
    else {
      const result = await f.binding.execute(request); assert.equal(result.height, 1500); assert.equal(captures, 3);
      assert.deepEqual(drawings.map(x => x.slice(-4)), [[0, 0, 1000, 700], [0, 700, 1000, 700], [0, 1400, 1000, 100]]);
    }
    assert.deepEqual(scrolls.at(-1), { x: 0, y: 123 });
  }
});
test("native errors are resolved once with no synthetic input or mutation replay", async () => {
  const f = fixture();
  const handle = `live:${f.profileId}:12`;
  const request = f.request("interact", { handle, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] });
  f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] }
    : command.action === "liveInput" && command.input.action === "focus" ? { ok: true, result: { action: "focus", eventsPosted: 0 } }
    : command.action === "liveInput" ? { ok: false, error: { code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Grant access", eventsPosted: 0, mayHavePostedInput: false, data: { stage: "input" } } } : { ok: true });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
  assert.equal(f.calls.filter(x => x.action === "liveResolve").length, 1);
  assert.equal(f.calls.at(-1).response.error.code, "ACCESSIBILITY_PERMISSION_REQUIRED");
  assert.equal(f.calls.at(-1).response.error.data.mayHavePostedInput, false);
  assert.equal(f.calls.at(-1).response.error.data.details.stage, "input");
  assert.equal(f.scripts.every(x => typeof x.func === "function" && x.target.frameIds[0] === 0), true);
});

test("native organization failure preserves confirmed mutation and no-replay outcomes alongside existing error data", async () => {
  for (const mutationApplied of [false, true]) {
    const f = fixture();
    const request = f.request("organize", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, operation: "createGroup" });
    const native = { code: "FOCUS_CHANGED", message: "Native selection changed", actionsPerformed: mutationApplied ? 5 : 0,
      mutationApplied, doNotReplay: mutationApplied, mayHavePostedInput: mutationApplied,
      tabBarRestoration: "unconfirmed", nativeSidebarRestoration: "restored", data: { stage: "native-result", retained: true } };
    f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] }
      : command.action === "liveOrganize" ? { ok: false, error: native } : { ok: true, result: { eventsPosted: 0 } });
    await f.binding.start();
    const resolved = f.calls.find(command => command.action === "liveResolve");
    assert.equal(resolved.response.error.code, native.code);
    assert.deepEqual(resolved.response.error.data, { ...native.data, actionsPerformed: native.actionsPerformed,
      mutationApplied, doNotReplay: mutationApplied, mayHavePostedInput: mutationApplied,
      tabBarRestoration: "unconfirmed", nativeSidebarRestoration: "restored" });
    assert.equal(f.calls.filter(command => command.action === "liveOrganize").length, 1);
  }
});

test("original agent typing requires existing focus and never posts an implicit click", async () => {
  const f = fixture();
  const request = f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "type", node: "n1", value: "agent text", requireFocused: true }] });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] } : { ok: true, result: { eventsPosted: 2 } });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "type"]);
  assert.ok(f.scripts.some(x => x.args[0] === "focused"));
  assert.equal(f.calls.at(-1).response.ok, true);
});
