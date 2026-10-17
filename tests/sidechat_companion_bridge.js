const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("companion/SideChatBridge.js", "utf8");
class MockEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  stopPropagation() { this.cancelBubble = true; }
}
class MockCustomEvent extends MockEvent {}
function fixture(options = {}) {
  const listeners = new Map(), documentListeners = new Map(), attributes = new Map();
  const requests = [], messages = [], events = [], reports = [], intervals = new Map();
  const publishedCandidates = [];
  const rect = { left: 10, top: 100, right: 900, bottom: 200, width: 890, height: 100 };
  const composer = { textContent: "", isConnected: true, isContentEditable: true, tagName: "DIV", parentElement: null,
    getClientRects: () => [rect], contains: () => false };
  const actualOrigin = options.relay ? "http://chatgpt-provider-test.localhost:1234" : "https://chatgpt.com";
  const on = (map, type, callback) => { if (!map.has(type)) map.set(type, []); map.get(type).push(callback); };
  const off = (map, type, callback) => map.set(type, (map.get(type) || []).filter(item => item !== callback));
  const emit = (map, event) => { for (const callback of map.get(event.type) || []) callback(event); };
  const context = { instanceId: "safari-test", tabId: 10, windowId: 20, url: "https://example.com" };
  const capabilities = { "browserSideChat.tabContext.read": true, "browserTabMentions.search": true };
  const window = {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: element => ({ display: "block", visibility: "visible", opacity: "1", ...element.style }),
    addEventListener: (type, callback) => on(listeners, type, callback),
    removeEventListener: (type, callback) => off(listeners, type, callback),
    dispatchEvent: event => { events.push(event.type); emit(listeners, event); },
    webkit: { messageHandlers: { chatgptSidechat: { async postMessage(message) {
      requests.push(message);
      if (message.method === "capabilities") return { browserContext: { instanceId: "safari-test" }, capabilities };
      if (message.method === "context") return { context, capabilities };
      if (message.method === "tabContext") return { tabId: 10, url: "https://example.com" };
      if (message.method === "tabMentions") return { candidates: [{ tabId: 10, title: "Example" }] };
      return { ok: true };
    } } } },
  };
  if (options.stopInputAtWindow) window.addEventListener("input", event => event.stopPropagation(), true);
  window.top = window;
  window.parent = window;
  if (options.relay) {
    window.top = {};
    window.parent = { postMessage: (data, origin) => messages.push({ data, targetOrigin: origin }) };
    window.ChatGPTSafariProviderRelay = {
      providerOrigin: actualOrigin, parentExtensionOrigin: "safari-web-extension://actual-owner",
      bridgeToken: "test-owner-token-at-least-32-characters", runtimeURL: "https://chatgpt.com/cdn/assets/633146.c3403bd103.js",
      report: async value => { reports.push(value); },
      importURL: value => value.replace("https://chatgpt.com", actualOrigin),
      upstreamURL: value => value.replace(actualOrigin, "https://chatgpt.com"),
    };
  }
  window.postMessage = (data, targetOrigin) => {
    messages.push({ data, targetOrigin });
    emit(listeners, { type: "message", data, source: window, origin: actualOrigin, isTrusted: true });
  };
  const document = {
    querySelector: selector => selector === "#prompt-textarea" ? composer : null,
    querySelectorAll: selector => selector === "textarea, [contenteditable]" ? [composer] : [],
    documentElement: {
      setAttribute: (name, value) => { attributes.set(name, value); if (name === "data-chatgpt-extension-browser-tabs") publishedCandidates.push(JSON.parse(value)); },
      removeAttribute: name => attributes.delete(name),
    },
    addEventListener: (type, callback) => on(documentListeners, type, callback),
    removeEventListener: (type, callback) => off(documentListeners, type, callback),
  };
  let intervalID = 0;
  const sandbox = { window, document, location: { origin: actualOrigin, href: actualOrigin + "/?surface=browser_side_chat" },
    URL, Event: MockEvent, CustomEvent: MockCustomEvent, Date, console: { ...console }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    crypto: require("node:crypto").webcrypto, __testRuntime: options.runtime };
  if (options.manualIntervals) {
    sandbox.setInterval = (callback, milliseconds) => { intervals.set(++intervalID, { callback, milliseconds }); return intervalID; };
    sandbox.clearInterval = id => intervals.delete(id);
  }
  const runtimeImport = 'import(relayMode ? relay.importURL(runtimeURL) : runtimeURL)';
  const input = options.runtime ? source.replace(runtimeImport, "Promise.resolve({ __webpack_require__: globalThis.__testRuntime })") : source;
  vm.runInNewContext(input, sandbox);
  return { window, document, composer, requests, messages, events, attributes, publishedCandidates, reports,
    ready: sandbox.__CHATGPT_SAFARI_ADAPTER_READY__,
    emitMessage: event => emit(listeners, { type: "message", isTrusted: true, ...event }),
    input: () => emit(documentListeners, new MockEvent("input", { isTrusted: true })),
    emitInput: value => {
      const event = value instanceof MockEvent ? value : new MockEvent("input", value);
      emit(listeners, event); if (!event.cancelBubble) emit(documentListeners, event);
    },
    tickReport: () => { for (const item of intervals.values()) if (item.milliseconds === 2000) item.callback(); },
    gesture: trusted => emit(documentListeners, new MockEvent("pointerdown", { isTrusted: trusted })) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

async function invocationFixture(options = {}) {
  const runtime = { m: {}, c: {}, d(exports, getters) {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get });
  } };
  const f = fixture({ ...options, relay: true, runtime });
  await f.ready;
  const relay = f.window.ChatGPTSafariProviderRelay, sent = [];
  const port = { close() { this.closed = true; }, postMessage(message) {
    sent.push(message);
    if (message.type === "request" && message.method !== "openInvocation") queueMicrotask(() => {
      port.onmessage({ data: { type: "reply", id: message.id, result: message.method === "tabMentions" ? { candidates: f.candidates || [] } : { ok: true } } });
    });
  } };
  f.emitMessage({ source: f.window.parent, origin: relay.parentExtensionOrigin,
    data: { type: "chatgpt-safari-provider:connect", token: relay.bridgeToken, documentRecoverySequence: 0 }, ports: [port] });
  runtime.m.Kxt = () => {};
  const exports = {};
  runtime.m.Kxt({}, exports, runtime);
  let account = "account-a";
  const connection = new exports.BrowserSideChatConnection({ pageWindow: f.window, getAuthScope: () => account });
  return { ...f, sent, port, connection, setAccount(value) { account = value; }, setCandidates(value) { f.candidates = value; },
    respond(invocation) {
      const request = sent.filter(item => item.method === "openInvocation").at(-1);
      assert.ok(request);
      port.onmessage({ data: { type: "reply", id: request.id, result: { invocation } } });
    },
    cleanup() { connection.dispose(); f.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: true })); } };
}

test("the original invocation callback receives one signed-in prefill without submitting or overwriting drafts", async () => {
  const f = await invocationFixture(), received = [];
  const value = { type: "browser_side_chat_prompt_prefill", createdAtMs: Date.now(), prompt: "Original website prompt", selectedText: "Context-menu selection" };
  try {
    f.composer.textContent = "Existing user draft";
    f.connection.subscribeOpenInvocation(item => received.push(item));
    await flush();
    assert.equal(f.sent.some(item => item.method === "openInvocation"), false);
    f.connection.setAuthState("signed_in");
    await flush(); f.respond(value); await flush();
    assert.equal(received.length, 0);
    assert.equal(f.composer.textContent, "Existing user draft");
    f.composer.textContent = ""; f.input();
    assert.equal(received.length, 1);
    assert.equal(received[0].prompt, value.prompt);
    assert.equal(received[0].selectedText, value.selectedText);
    f.input(); assert.equal(received.length, 1, "manual input never replays consumed prefill");
    assert.deepEqual([...new Set(f.sent.filter(item => item.type === "request").map(item => item.method))], ["authStateChanged", "openInvocation"]);
  } finally { f.cleanup(); }
});

test("pending and in-flight invocation payloads cannot cross an account change", async () => {
  const f = await invocationFixture(), received = [];
  const value = { type: "browser_side_chat_prompt_prefill", createdAtMs: Date.now(), prompt: "Account A only" };
  try {
    f.connection.subscribeOpenInvocation(item => received.push(item));
    f.connection.setAuthState("signed_in");
    await flush();
    f.setAccount("account-b"); f.respond(value); await flush();
    assert.equal(received.length, 0);
    f.connection.setAuthState("signed_in"); await flush();
    f.composer.textContent = "Account B draft"; f.respond(value); await flush();
    f.setAccount("account-c"); f.composer.textContent = ""; f.input();
    assert.equal(received.length, 0);
  } finally { f.cleanup(); }
});
test("original stream observations preserve iterators, arguments, live exports and cancellation", async () => {
  const runtime = { m: {}, c: {}, d(exports, getters) {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get, enumerable: true });
  } };
  const f = fixture({ runtime });
  await f.ready;
  const scope = {}, signal = new AbortController().signal;
  let cleanup = 0, input, forwardedSignal, receiver;
  runtime.m.tI = (module, exports, require) => require.d(exports, {
    untouched: () => signal,
    uj: () => async function*(body, abort) { receiver = this; forwardedSignal = abort; try { yield { data: body }; yield { data: "second" }; } finally { cleanup++; } },
    sj: () => async function*() { throw new Error("Original parse failure"); },
  });
  runtime.m.sY = (module, exports, require) => require.d(exports, { i: () => async function*(events) {
    input = events; for await (const event of events) yield event;
  } });
  const streams = {}, delta = {};
  runtime.m.tI({}, streams, runtime); runtime.m.sY({}, delta, runtime);
  const parsed = streams.uj.call(scope, "original body", signal);
  assert.equal(parsed[Symbol.asyncIterator](), parsed);
  assert.equal(Object.prototype.toString.call(parsed), "[object AsyncGenerator]");
  const decoded = delta.i(parsed);
  assert.deepEqual(await decoded.next(), { value: { data: "original body" }, done: false });
  assert.equal(input, parsed, "Observation preserves the original parser input exactly");
  assert.equal(receiver, scope); assert.equal(forwardedSignal, signal); assert.equal(streams.untouched, signal);
  await decoded.return(); assert.equal(cleanup, 1, "Cancellation reaches both original generators");
  await assert.rejects(streams.sj().next(), /Original parse failure/);
  const failed = streams.uj("body", signal); await failed.next();
  await assert.rejects(failed.throw(new Error("Original consumer failure")), /Original consumer failure/);
  assert.equal(cleanup, 2);
  assert.equal(f.window.__CHATGPT_SAFARI_SIDECAR__.diagnostics().siteAdapter.streamCalls, 4);
});
test("top-level side chat routes original context and capability messages without a self-message loop", async () => {
  const f = fixture();
  assert.equal(f.window.__CODEX_BROWSER_SIDE_CHAT__, true);
  f.window.parent.postMessage({ type: "browser_side_chat_context_requested", protocolVersion: 2,
    requestId: "context-1", includeSelection: true }, "safari-web-extension://known-owner");
  f.window.parent.postMessage({ type: "browser_side_chat_capabilities_requested" }, "safari-web-extension://known-owner");
  await flush();
  assert.equal(f.requests.length, 2);
  const context = f.messages.find(item => item.data.type === "browser_side_chat_context");
  assert.equal(context.data.requestId, "context-1");
  assert.equal(context.data.context.tabId, 10);
  assert.equal(context.targetOrigin, "https://chatgpt.com");
  assert.equal(JSON.parse(f.attributes.get("data-chatgpt-extension-status")).capabilities["browserTabMentions.search"], true);
  f.window.postMessage({ type: "unrelated", value: "ordinary message" }, "https://chatgpt.com");
  assert.equal(f.messages.at(-1).data.value, "ordinary message");
  assert.equal(f.requests.length, 2);
});

test("isolated provider uses its real parent/origin and a capability-bound channel", async () => {
  const runtime = { m: {}, c: {}, d(exports, getters) {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get });
  } };
  const f = fixture({ relay: true, runtime });
  await f.ready;
  const relay = f.window.ChatGPTSafariProviderRelay;
  const sent = [];
  const port = { postMessage: value => sent.push(value), close() {} };
  const connect = { source: f.window.parent, origin: relay.parentExtensionOrigin,
    data: { type: "chatgpt-safari-provider:connect", token: relay.bridgeToken, documentRecoverySequence: 0 }, ports: [port] };
  f.emitMessage({ ...connect, origin: "https://unrelated.example" });
  assert.equal(port.onmessage, undefined);
  f.emitMessage({ ...connect, isTrusted: false });
  assert.equal(port.onmessage, undefined, "Synthetic MessageEvents cannot establish an authenticated navigation channel");
  f.emitMessage({ ...connect, data: { ...connect.data, documentRecoverySequence: -1 } });
  assert.equal(port.onmessage, undefined);
  f.emitMessage({ ...connect, origin: "safari-web-extension://ACTUAL-OWNER" });
  assert.equal(typeof port.onmessage, "function");
  assert.equal(sent[0].type, "ready");
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.type, "chatgpt-safari-provider:ready", "The parent can connect before iframe load or original context initialization");
  assert.equal(f.messages[0].data.token, relay.bridgeToken);
  runtime.m.aH = (module, exports, require) => require.d(exports, { a: () => () => undefined });
  runtime.m.Kxt = () => {};
  runtime.m.ipG = (module, exports, require) => require.d(exports, { a: () => () => false });
  const originExports = {}, connectionExports = {};
  const presentationExports = {};
  runtime.m.ipG({}, presentationExports, runtime);
  assert.equal(presentationExports.a(), true, "The actual provider iframe initializes the original side-chat connection");
  const top = f.window.top;
  f.window.top = f.window;
  assert.equal(presentationExports.a(), false, "A top-level provider document keeps the official classification");
  f.window.top = top;
  runtime.m.aH({}, originExports, runtime);
  assert.equal(originExports.a(f.window), relay.parentExtensionOrigin);
  assert.equal(originExports.a(f.window.parent), undefined);
  runtime.m.Kxt({}, connectionExports, runtime);
  const connection = new connectionExports.BrowserSideChatConnection({ pageWindow: f.window, getAuthScope: () => "account-a" });
  const waiting = connection.getContext();
  await flush();
  const request = sent.find(value => value.method === "context");
  assert.ok(request);
  port.onmessage({ data: { type: "reply", id: request.id,
    result: { context: { instanceId: "browser-a", tabId: 10, windowId: 20, url: "https://example.com" } } } });
  assert.equal((await waiting).tabId, 10);
  assert.equal(f.requests.length, 0);
  const conversationURL = "https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc?surface=browser_side_chat";
  connection.setLocation(conversationURL);
  await flush();
  const changed = sent.find(value => value.method === "locationChanged");
  assert.equal(changed.params.url, conversationURL);
  port.onmessage({ data: { type: "reply", id: changed.id, result: { ok: true } } });
  connection.dispose();
  f.window.dispatchEvent(new MockEvent("pagehide"));
});
test("tab mentions require a recent trusted gesture and publish the upstream temporary DOM contract", async () => {
  const runtime = { m: {}, c: {}, d(exports, getters) {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get });
  } };
  const f = fixture({ runtime });
  await f.ready;
  runtime.m.Kxt = () => {};
  const exports = {}; runtime.m.Kxt({}, exports, runtime);
  const connection = new exports.BrowserSideChatConnection({ pageWindow: f.window, getAuthScope: () => "account-a" });
  f.window.dispatchEvent(new MockEvent("chatgpt-extension-request-status"));
  await flush();
  const search = () => f.window.dispatchEvent(new MockCustomEvent("chatgpt-extension-request-browser-tab-mentions", {
    detail: { query: "Example", limit: 5 },
  }));
  search();
  f.gesture(false); search();
  await flush();
  assert.equal(f.requests.filter(item => item.method === "tabMentions").length, 0);
  f.gesture(true); search();
  await flush();
  assert.equal(f.requests.filter(item => item.method === "tabMentions").length, 1);
  assert.ok(f.events.includes("chatgpt-extension-browser-tabs"));
  assert.equal(f.attributes.has("data-chatgpt-extension-browser-tabs"), false);
  connection.dispose();
});

test("open tab-mention queries refresh on real tab changes and stop with their owner, account or dropdown", async () => {
  const f = await invocationFixture();
  f.window.__CHATGPT_SAFARI_SIDECAR__.receive({ type: "browser_side_chat_capabilities", capabilities: { "browserTabMentions.search": true } });
  const search = () => f.window.dispatchEvent(new MockCustomEvent("chatgpt-extension-request-browser-tab-mentions", { detail: { query: "Research", limit: 5 } }));
  const invalidate = () => f.window.__CHATGPT_SAFARI_SIDECAR__.receive({ type: "browser_tab_mentions_invalidated" });
  try {
    f.setCandidates([{ tabId: 1, title: "Before" }]); f.gesture(true); search(); await flush();
    assert.equal(f.publishedCandidates.at(-1)[0].title, "Before");
    f.setCandidates([{ tabId: 1, title: "After" }]); invalidate(); await flush();
    assert.equal(f.publishedCandidates.at(-1)[0].title, "After");
    f.window.dispatchEvent(new MockEvent("chatgpt-extension-stop-browser-tabs"));
    const stopped = f.sent.filter(item => item.method === "tabMentions").length;
    invalidate(); await flush();
    assert.equal(f.sent.filter(item => item.method === "tabMentions").length, stopped);
    f.gesture(true); search(); await flush();
    f.setAccount("account-b"); invalidate(); await flush();
    assert.equal(f.sent.filter(item => item.method === "tabMentions").length, stopped + 1);
    f.connection.dispose(); invalidate(); await flush();
    assert.equal(f.sent.filter(item => item.method === "tabMentions").length, stopped + 1);
  } finally { f.cleanup(); }
});
test("invalid protocol messages do not reach native tab operations", async () => {
  const f = fixture();
  f.window.postMessage({ type: "browser_side_chat_context_requested", protocolVersion: 1, requestId: "bad" }, "*");
  f.window.postMessage({ type: "browser_side_chat_open_in_browser", url: "https://evil.example/" }, "*");
  f.window.postMessage({ type: "browser_side_chat_auth_state_changed", state: "made-up" }, "*");
  await flush();
  assert.equal(f.requests.length, 0);
});
test("fixed diagnostics preserve document identity and expose only public script paths", () => {
  const f = fixture();
  f.document.scripts = [
    { src: "https://cdn.oaistatic.com/assets/public.js?version=test#fragment" },
    { src: "https://chatgpt.com/assets/client.mjs?build=test" },
    { src: "https://third-party.example/private.js" },
    { src: "https://chatgpt.com/backend-api/session?token=secret" },
  ];
  const result = f.window.__CHATGPT_SAFARI_SIDECAR__.diagnostics();
  assert.equal(result.sideChatPreloadFlag, true);
  assert.equal(result.parentIsSelf, true);
  assert.deepEqual(Array.from(result.publicScripts), [
    "https://cdn.oaistatic.com/assets/public.js", "https://chatgpt.com/assets/client.mjs",
  ]);
});
test("the version-bound native host boundary drives the original context and submit lifecycle", async () => {
  const runtime = { m: {}, c: {}, d(exports, getters) {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get, enumerable: true });
  } };
  const f = fixture({ runtime });
  await flush();
  assert.equal(f.window.__CHATGPT_SAFARI_SIDECAR__.diagnostics().siteAdapter.state, "installed");
  runtime.m.aH = (module, exports, require) => require.d(exports, { a: () => () => undefined });
  runtime.m.Kxt = () => { throw new Error("The Chrome-only connection was not replaced"); };
  runtime.m.ipG = (module, exports, require) => require.d(exports, { a: () => () => false });
  const presentationExports = {};
  runtime.m.ipG({}, presentationExports, runtime);
  assert.equal(presentationExports.a(), false, "Native-profile presentation still uses the official bootstrap");
  const originExports = {};
  runtime.m.aH({}, originExports, runtime);
  assert.equal(originExports.a(f.window), "https://chatgpt.com");
  assert.equal(originExports.a({}), undefined);
  const connectionExports = {};
  runtime.m.Kxt({}, connectionExports, runtime);
  let account = "account-a";
  const connection = new connectionExports.BrowserSideChatConnection({
    pageWindow: f.window, parentOrigin: "https://chatgpt.com", getAuthScope: () => account,
  });
  const context = await connection.waitForContext();
  assert.equal(context.tabId, 10);
  assert.equal(connection.confirmed, true);
  assert.equal(connection.extensionStatus.toolbar.pin, "unsupported");
  const submit = await connection.prepareSubmit("Context changed");
  submit.assertCurrent();
  account = "account-b";
  assert.throws(submit.assertCurrent, /Context changed/);
  account = "account-a";
  f.window.__CHATGPT_SAFARI_SIDECAR__.receive({ type: "browser_side_chat_context_invalidated", protocolVersion: 2 });
  assert.throws(submit.assertCurrent, /Context changed/);
  await flush();
  connection.dispose();
  await assert.rejects(connection.getContext(), /not available/);
});


test("provider reload arms only on trusted pagehide and uses its authenticated pre-navigation checkpoint", async () => {
  for (const receiptBeforePagehide of [false, true]) {
    const f = await invocationFixture();
    f.port.onmessage({ data: { type: "document_recovery_checkpoint", sequence: 2 } });
    assert.equal(f.messages.some(message => message.data?.type === "document_recovery_checkpoint"), false,
      "Native recovery checkpoints are private host transport, never published to the website");
    f.window.dispatchEvent(new MockEvent("beforeunload", { isTrusted: false }));
    f.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: false }));
    assert.equal(f.sent.some(item => item.type === "provider_document_unloaded"), false);
    f.window.dispatchEvent(new MockEvent("beforeunload", { isTrusted: true }));
    assert.equal(f.sent.some(item => item.type === "provider_document_unloaded"), false,
      "A cancelled beforeunload cannot itself trigger a remount");
    if (receiptBeforePagehide) f.port.onmessage({ data: { type: "document_recovery_checkpoint", sequence: 3 } });
    f.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: true }));
    const unloads = f.sent.filter(item => item.type === "provider_document_unloaded");
    assert.equal(unloads.length, 1); assert.equal(unloads[0].recoverySequence, 2);
    assert.equal(f.port.closed, true);
    f.cleanup();
  }
});

test("untrusted or regressing checkpoint data cannot authorize a provider reload", async () => {
  const f = await invocationFixture();
  f.port.onmessage({ data: { type: "document_recovery_checkpoint", sequence: 2 } });
  for (const sequence of [1, -1, "5", 2.5, 1_000_000_001]) f.port.onmessage({ data: { type: "document_recovery_checkpoint", sequence } });
  f.window.dispatchEvent(new MockEvent("beforeunload", { isTrusted: true }));
  f.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: true }));
  assert.equal(f.sent.find(item => item.type === "provider_document_unloaded").recoverySequence, 2);
  f.cleanup();
  const withoutBeforeUnload = await invocationFixture();
  withoutBeforeUnload.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: true }));
  assert.equal(withoutBeforeUnload.sent.some(item => item.type === "provider_document_unloaded"), false);
  withoutBeforeUnload.cleanup();
});

test("provider reports reveal only composer health and trusted native input counts, never draft or event contents", async t => {
  const f = await invocationFixture({ manualIntervals: true });
  t.after(() => f.cleanup());
  const nested = {}, unrelated = {}, send = { ...f.composer, disabled: true, getAttribute: () => null };
  f.composer.textContent = "Synthetic private draft never reported";
  f.composer.isContentEditable = true;
  f.composer.contains = value => value === nested;
  f.document.activeElement = nested;
  const query = f.document.querySelectorAll;
  f.document.querySelectorAll = selector => selector.startsWith("button[") ? [send] : query(selector);
  const input = (target, isTrusted) => Object.defineProperty(new MockEvent("input", { target, isTrusted }), "data", {
    get() { throw new Error("Diagnostic code must never read input contents"); },
  });
  f.emitInput(input(f.composer, false));
  f.emitInput(input(unrelated, true));
  f.tickReport();
  assert.equal(f.reports.at(-1).trustedInputCounter, 0);
  f.emitInput(input(nested, true));
  f.tickReport();
  const observed = f.reports.at(-1);
  assert.equal(observed.trustedInputCounter, 1);
  assert.equal(observed.composerCandidateCount, 1);
  assert.equal(observed.composerHasText, true);
  assert.equal(observed.composerFocused, true);
  assert.equal(observed.composerEditable, true);
  assert.equal(observed.composerPendingInput, false);
  assert.equal(observed.composerComposing, false);
  assert.equal(observed.sendDisabled, true);
  assert.equal(JSON.stringify(observed).includes("Synthetic private draft"), false);
  assert.equal(Object.hasOwn(observed, "draft"), false);
  f.composer.textContent = "   ";
  f.document.activeElement = unrelated; send.disabled = false;
  f.tickReport();
  assert.equal(f.reports.at(-1).composerHasText, false);
  assert.equal(f.reports.at(-1).composerFocused, false);
  assert.equal(f.reports.at(-1).composerEditable, true);
  assert.equal(f.reports.at(-1).sendDisabled, false);
  f.composer.isConnected = false;
  f.emitInput({ target: f.composer, isTrusted: true }); f.tickReport();
  const disconnected = f.reports.at(-1);
  assert.equal(disconnected.trustedInputCounter, 0);
  assert.equal(disconnected.composerCandidateCount, 0);
  for (const key of ["composerHasText", "composerFocused", "composerEditable", "composerPendingInput", "composerComposing", "sendDisabled"]) assert.equal(Object.hasOwn(disconnected, key), false);
  const count = f.reports.length;
  f.window.dispatchEvent(new MockEvent("pagehide", { isTrusted: true })); f.tickReport();
  assert.equal(f.reports.length, count, "Unloaded documents stop their diagnostic observer");
});

test("composer health requires one connected visible semantic editing host and an exact unique send marker", async t => {
  const f = await invocationFixture({ manualIntervals: true }); t.after(() => f.cleanup());
  const hidden = { ...f.composer, getClientRects: () => [] };
  const offscreen = { ...f.composer, getClientRects: () => [{ left: 0, top: 900, right: 100, bottom: 1000, width: 100, height: 100 }] };
  const readonly = { ...f.composer, tagName: "TEXTAREA", readOnly: true };
  const nested = { ...f.composer, parentElement: f.composer };
  const transparent = { ...f.composer, parentElement: { style: { opacity: "0" }, parentElement: null } };
  const textarea = { ...f.composer, tagName: "TEXTAREA", isContentEditable: false, value: "Owned textarea draft" };
  const send = { ...f.composer, disabled: true, getAttribute: () => null };
  let candidates = [f.composer, hidden, offscreen, readonly, nested, transparent], sends = [];
  f.document.querySelector = () => null; // Work has no normal Chat composer ID.
  f.document.querySelectorAll = selector => selector === "textarea, [contenteditable]" ? candidates : sends;
  f.tickReport();
  assert.equal(f.reports.at(-1).composerCandidateCount, 1);
  assert.equal(f.reports.at(-1).composerEditable, true);
  assert.equal(Object.hasOwn(f.reports.at(-1), "sendDisabled"), false, "No arbitrary button stands in for Send");
  candidates.push(textarea); f.emitInput({ target: f.composer, isTrusted: true }); f.tickReport();
  const ambiguous = f.reports.at(-1);
  assert.equal(ambiguous.composerCandidateCount, 2); assert.equal(ambiguous.trustedInputCounter, 0);
  for (const key of ["composerHasText", "composerFocused", "composerEditable", "sendDisabled"]) assert.equal(Object.hasOwn(ambiguous, key), false);
  candidates = [textarea]; sends = [send, { ...send }]; f.document.activeElement = textarea;
  f.emitInput({ target: f.composer, isTrusted: true }); f.tickReport();
  assert.equal(f.reports.at(-1).trustedInputCounter, 0, "The previously observed editor cannot supply input evidence for its replacement");
  assert.equal(f.reports.at(-1).composerHasText, true); assert.equal(f.reports.at(-1).composerFocused, true);
  assert.equal(Object.hasOwn(f.reports.at(-1), "sendDisabled"), false, "Duplicate actual Send markers remain ambiguous");
  sends = [send]; f.emitInput({ target: textarea, isTrusted: true }); f.tickReport();
  assert.equal(f.reports.at(-1).trustedInputCounter, 1); assert.equal(f.reports.at(-1).sendDisabled, true);
  assert.equal(JSON.stringify(f.reports.at(-1)).includes("Owned textarea draft"), false);
});

test("window-capture diagnostics observe real pending input without changing its propagation or composition lifecycle", async t => {
  const f = await invocationFixture({ manualIntervals: true, stopInputAtWindow: true }); t.after(() => f.cleanup());
  f.composer.tagName = "TEXTAREA"; f.composer.isContentEditable = false;
  f.composer.dataset = { pendingInputInitialized: "true", composition: "active" };
  let reachedDocument = 0; f.document.addEventListener("input", () => reachedDocument++);
  const event = new MockEvent("input", { target: f.composer, isTrusted: true, defaultPrevented: false });
  Object.defineProperty(event, "data", { get() { throw new Error("Input contents cannot be inspected"); } });
  f.emitInput(event); f.tickReport();
  assert.equal(f.reports.at(-1).trustedInputCounter, 1, "Original pending-input window stopPropagation must not hide trusted input evidence");
  assert.equal(reachedDocument, 0); assert.equal(event.defaultPrevented, false);
  assert.equal(f.reports.at(-1).composerPendingInput, true); assert.equal(f.reports.at(-1).composerComposing, true);
  f.composer.dataset.composition = "ending"; f.tickReport();
  assert.equal(f.reports.at(-1).composerComposing, true);
  delete f.composer.dataset.composition; f.tickReport();
  assert.equal(f.reports.at(-1).composerComposing, false);
  assert.equal(f.composer.dataset.pendingInputInitialized, "true", "Observation never releases or alters the original hydration gate");
});
