const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("companion/SideChatBridge.js", "utf8");
class MockEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
class MockCustomEvent extends MockEvent {}
function fixture(options = {}) {
  const listeners = new Map(), documentListeners = new Map(), attributes = new Map();
  const requests = [], messages = [], events = [];
  const actualOrigin = options.relay ? "http://chatgpt-provider-test.localhost:1234" : "https://chatgpt.com";
  const on = (map, type, callback) => { if (!map.has(type)) map.set(type, []); map.get(type).push(callback); };
  const off = (map, type, callback) => map.set(type, (map.get(type) || []).filter(item => item !== callback));
  const emit = (map, event) => { for (const callback of map.get(event.type) || []) callback(event); };
  const context = { instanceId: "safari-test", tabId: 10, windowId: 20, url: "https://example.com" };
  const capabilities = { "browserSideChat.tabContext.read": true, "browserTabMentions.search": true };
  const window = {
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
  window.top = window;
  window.parent = window;
  if (options.relay) {
    window.top = {};
    window.parent = { postMessage: (data, origin) => messages.push({ data, targetOrigin: origin }) };
    window.ChatGPTSafariProviderRelay = {
      providerOrigin: actualOrigin, parentExtensionOrigin: "safari-web-extension://actual-owner",
      bridgeToken: "test-owner-token-at-least-32-characters", runtimeURL: "https://chatgpt.com/cdn/assets/633146.c3403bd103.js",
      report: async () => {},
      importURL: value => value.replace("https://chatgpt.com", actualOrigin),
      upstreamURL: value => value.replace(actualOrigin, "https://chatgpt.com"),
    };
  }
  window.postMessage = (data, targetOrigin) => {
    messages.push({ data, targetOrigin });
    emit(listeners, { type: "message", data, source: window, origin: actualOrigin, isTrusted: true });
  };
  const document = {
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
    },
    addEventListener: (type, callback) => on(documentListeners, type, callback),
  };
  const sandbox = { window, document, location: { origin: actualOrigin, href: actualOrigin + "/?surface=browser_side_chat" },
    URL, Event: MockEvent, CustomEvent: MockCustomEvent, Date, console: { ...console }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    crypto: require("node:crypto").webcrypto, __testRuntime: options.runtime };
  const runtimeImport = 'import(relayMode ? relay.importURL(runtimeURL) : runtimeURL)';
  const input = options.runtime ? source.replace(runtimeImport, "Promise.resolve({ __webpack_require__: globalThis.__testRuntime })") : source;
  vm.runInNewContext(input, sandbox);
  return { window, document, requests, messages, events, attributes,
    ready: sandbox.__CHATGPT_SAFARI_ADAPTER_READY__,
    emitMessage: event => emit(listeners, { type: "message", ...event }),
    gesture: trusted => emit(documentListeners, new MockEvent("pointerdown", { isTrusted: trusted })) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
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
    data: { type: "chatgpt-safari-provider:connect", token: relay.bridgeToken }, ports: [port] };
  f.emitMessage({ ...connect, origin: "https://unrelated.example" });
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
  const f = fixture();
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
