const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = "../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/";
const downloadsModule = require(path + "downloads-background.js");
const { dispatch } = require(path + "agent-kernel-bridge.js");
const { createAgent } = require(path + "agent-background.js");

function webRequestFixture() {
  const events = {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived"]) {
    const listeners = new Set();
    events[name] = { addListener(listener, filter, extra) { assert.equal(filter.urls.some(url => /:\d+\//.test(url)), false, "Safari match patterns cannot carry a port"); listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }, emit(details) { for (const listener of [...listeners]) listener(details); }, size() { return listeners.size; } };
  }
  return events;
}
function pageFixture(configuration = {}) {
  const listeners = new Set(), writes = [], requests = [], body = Buffer.from("Signed-in synchronous Safari anchor ✓\n"), webRequest = webRequestFixture();
  const document = { addEventListener(type, callback) { assert.equal(type, "click"); listeners.add(callback); },
    removeEventListener(_type, callback) { listeners.delete(callback); } };
  const source = { tagName: "BUTTON", isConnected: true, ownerDocument: document };
  const live = { documentId: "doc", snapshotId: "snap", url: "https://example.test/owned", nodes: new Map([["source", source]]) };
  const context = vm.createContext({ document, navigator: { userActivation: { isActive: true } },
    location: { href: live.url, origin: "https://example.test" }, __chatGPTSafariLiveDocument: live,
    URL, Uint8Array, TextEncoder, AbortController, setTimeout, clearTimeout, btoa, addEventListener() {}, removeEventListener() {},
    async fetch(url, options) {
      requests.push({ url, options }); let sent = false;
      const route = configuration.routes?.[url] || {}, requestId = "request-" + requests.length;
      const details = { tabId: 12, frameId: 0, requestId, documentId: "native-document", url };
      webRequest.onBeforeRequest.emit(details);
      webRequest.onBeforeSendHeaders.emit({ ...details, requestHeaders: Object.entries(options.headers || {}).map(([name, value]) => ({ name, value })) });
      webRequest.onHeadersReceived.emit({ ...details, statusCode: route.status || 200, responseHeaders: route.location ? [{ name: "Location", value: route.location }] : [] });
      if (route.corsDenied) throw new TypeError("Credentialed CORS access denied");
      if (route.location) return { ok: false, type: "opaqueredirect", url: "", status: 0, redirected: false };
      return { ok: true, type: "basic", url, status: 200, redirected: false,
        headers: new Headers({ "content-type": "text/plain", "content-disposition": "attachment; filename=observed.txt" }),
        body: { getReader() { return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(body) }; }, async cancel() {} }; } } };
    } });
  const args = { handle: "live:profile:12", documentId: "doc", snapshotId: "snap", expectedUrl: live.url, node: "source",
    intentId: "11111111-1111-4111-8111-111111111111", scope: "original-owner-account-profile-session-turn-tab", timeout_ms: 1 };
  const unwrap = value => { if (!value?.ok) throw Object.assign(new Error(value?.error?.message), value?.error); return value.result; };
  const invoke = async (func, operation, value = args) => unwrap(await vm.runInContext(`(${func.toString()})(operation,args)`, Object.assign(context, { operation, args: value })));
  const emit = (node, trusted = false, cancelable = true) => {
    const event = { isTrusted: trusted, cancelable, defaultPrevented: false, eventPhase: 1,
      composedPath: () => [node, document], preventDefault() { if (this.cancelable) this.defaultPrevented = true; } };
    for (const listener of [...listeners]) listener(event);
    return event;
  };
  const anchor = (href = "https://example.test/synchronous.txt") => ({ tagName: "A", ownerDocument: document, isConnected: true,
    href, hasAttribute: name => name === "download", getAttribute: name => name === "download" ? "hint.txt" : null });
  const gesture = (callback, trusted = true) => { const event = emit(source, trusted); event.eventPhase = 3; callback(event); event.eventPhase = 0; return event; };
  let sequence = 0, written = 0;
  const adapter = downloadsModule.createDownloads({ api: { webRequest, scripting: { async executeScript(request) {
    assert.equal(request.target.tabId, 12); assert.deepEqual(request.target.frameIds, [0]);
    if (configuration.hangCancel && request.args[0] === "cancel") return new Promise(() => {});
    try { return [{ result: { ok: true, result: await invoke(request.func, ...request.args) } }]; }
    catch (error) { return [{ result: { ok: false, error: { code: error.code, message: error.message } } }]; }
  } } }, async target(handle, expectedUrl) { assert.equal(handle, args.handle); if (expectedUrl && context.location.href !== expectedUrl) throw new Error("Navigated"); return { id: 12 }; },
  async send(command) {
    writes.push(command); const input = command.input;
    if (input.action === "begin") return { ok: true, result: { transferId: "transfer" } };
    if (input.action === "append") { assert.equal(input.sequence, sequence++); written += Buffer.from(input.data, "base64").length; return { ok: true, result: { sequence, bytesWritten: written } }; }
    return { ok: true, result: { state: "complete", path: "/Downloads/observed.txt", bytesWritten: written } };
  }, profileId: "profile", sessionId: "background", assertTime() {}, unwrap });
  return { args, context, live, source, emit, anchor, gesture, adapter, requests, writes, body, webRequest,
    arm: () => invoke(downloadsModule.downloadIntentPageOperation, "arm"),
    read: () => invoke(downloadsModule.downloadIntentPageOperation, "read"),
    cancel: () => invoke(downloadsModule.downloadIntentPageOperation, "cancel") };
}

test("a trusted source click captures and cancels its synchronous script anchor before one exact credentialed transfer", async () => {
  const f = pageFixture(); await f.arm(); const anchor = f.anchor(); let anchorClick;
  const sourceClick = f.gesture(() => { anchorClick = f.emit(anchor); anchor.isConnected = false; });
  assert.equal(sourceClick.defaultPrevented, true); assert.equal(anchorClick.defaultPrevented, true);
  const receipt = await f.read(); assert.equal(receipt.href, anchor.href); assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
  const result = await f.adapter.executeIntent({ id: "native-operation" }, { id: 12 }, { ...f.args, href: receipt.href });
  assert.equal(result.path, "/Downloads/observed.txt"); assert.equal(result.state, "complete"); assert.equal(result.bytesWritten, f.body.length);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.credentials, "same-origin"); assert.equal(f.requests[0].options.redirect, "manual"); assert.equal(f.requests[0].options.headers, undefined, "default accepted downloads do not acquire redirect headers or new request semantics");
  assert.deepEqual(Buffer.concat(f.writes.filter(call => call.input.action === "append").map(call => Buffer.from(call.input.data, "base64"))), f.body);
  assert.equal(f.live.downloadIntents.size, 0);
  await assert.rejects(f.adapter.executeIntent({ id: "replayed" }, { id: 12 }, { ...f.args, href: receipt.href }), /current visible DOM/);
  assert.equal(f.requests.length, 1);
});

test("a direct connected download anchor retains its actual native source default and URL", async () => {
  const f = pageFixture(); Object.assign(f.source, f.anchor()); f.source.ownerDocument = f.context.document;
  await f.arm(); const event = f.gesture(() => {}); assert.equal(event.defaultPrevented, true);
  const receipt = await f.read(); assert.equal(receipt.href, f.source.href); assert.equal(f.requests.length, 0);
  await f.cancel(); assert.equal(f.live.downloadIntents.size, 0);
});

test("untrusted and later-task clicks cannot become a source receipt or completed path", async () => {
  for (const mode of ["untrusted", "later-task", "detached", "noncancelable", "blob", "multiple"]) {
    const f = pageFixture(); await f.arm();
    if (mode === "untrusted") f.gesture(() => f.emit(f.anchor()), false);
    else if (mode === "later-task") { f.gesture(() => {}); f.emit(f.anchor()); }
    else if (mode === "detached") f.gesture(() => { const detached = f.anchor(); detached.isConnected = false; /* A detached anchor dispatch never reaches the document observer. */ });
    else if (mode === "noncancelable") f.gesture(() => f.emit(f.anchor(), false, false));
    else if (mode === "blob") f.gesture(() => f.emit(f.anchor("blob:https://example.test/opaque")));
    else f.gesture(() => { f.emit(f.anchor()); f.emit(f.anchor("https://example.test/second")); });
    await assert.rejects(f.read(), /no verified|no synchronous|could not cancel|Only a synchronous|multiple download/);
    assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.live.downloadIntents.size, 0);
  }
});

test("stale document, removed source, changed account scope and cancellation cannot consume a captured intent", async () => {
  for (const change of ["document", "source", "scope", "cancel"]) {
    const f = pageFixture(); await f.arm(); f.gesture(() => f.emit(f.anchor())); const receipt = await f.read();
    if (change === "document") f.live.documentId = "new-document";
    if (change === "source") f.source.isConnected = false;
    if (change === "scope") f.args.scope = "another-account";
    if (change === "cancel") await f.cancel();
    await assert.rejects(f.adapter.executeIntent({ id: "owned" }, { id: 12 }, { ...f.args, href: receipt.href }), /current visible DOM/);
    assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
    if (change === "scope") { f.args.scope = "original-owner-account-profile-session-turn-tab"; await f.cancel(); }
  }
});

test("original kernel policy runs after a real captured intent and before transfer, and denial only cancels", async () => {
  const command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12", selector: "#known-download", safari_download_intent: { timeout_ms: 1000 } };
  for (const deny of [false, true]) {
    const calls = [];
    const context = { clientInfo: { family: "safari" }, security: { async ensureDownloadAllowed(tabId, href) {
      calls.push("approval"); assert.equal(tabId, 12); assert.equal(href, "https://example.test/actual"); if (deny) throw new Error("Download denied");
    } }, api: { async executeUnhandledCommand(request) {
      calls.push(request.command.type);
      if (request.command.type === "safari_download_capture") return { intentId: "actual-receipt", href: "https://example.test/actual" };
      if (request.command.type === "safari_download_complete") { assert.equal(request.command.intentId, "actual-receipt"); assert.equal(request.command.href, "https://example.test/actual"); return { path: "/Downloads/actual", state: "complete" }; }
      return {};
    } } };
    if (deny) await assert.rejects(dispatch(context, command, () => assert.fail("No Chrome/CDP download")), /Download denied/);
    else assert.equal((await dispatch(context, command, () => assert.fail("No Chrome/CDP download"))).state, "complete");
    assert.deepEqual(calls, deny ? ["safari_download_capture", "approval", "safari_download_cancel"] : ["safari_download_capture", "approval", "safari_download_complete", "safari_download_cancel"]);
  }
});

test("agent receipts bind original owner/account/profile/session/turn/tab and one posted source click", async () => {
  const originalCrypto = globalThis.crypto; if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;
  try {
    const metadata = { session_id: "session", turn_id: "turn" }, owner = { instanceId: "owner", profileId: "profile", accountScope: "account" }, calls = [];
    const session = { currentTurnId: "turn", async requireOwnedTab(id) { assert.equal(id, 12); } };
    const companion = { async agentOwner() { return owner; }, async runAgentCommand(command) {
      calls.push(command); const args = command.arguments;
      if (command.action === "dom_query") return { node: "source", documentId: "doc", snapshotId: "snap", url: "https://example.test/owned" };
      if (command.action === "interact") {
        assert.equal(args.interactions.length, 1); assert.equal(args.interactions[0].node, "source");
        assert.equal(args.downloadIntent.scope, JSON.stringify(["session", "turn", "owner", "profile", "account", "12"]));
        return { downloadIntent: { intentId: args.downloadIntent.intentId, href: "https://example.test/actual" } };
      }
      if (command.action === "download_intent_transfer") { assert.equal(args.href, "https://example.test/actual"); return { path: "/Downloads/actual", state: "complete", bytesWritten: 45 }; }
      return {};
    } };
    const agent = createAgent({}, companion), command = { browser_id: "0", tab_id: "12", selector: "#known-download", safari_download_intent: { timeout_ms: 1000 } };
    const captured = await agent.execute({ ...command, type: "safari_download_capture" }, session, metadata);
    await assert.rejects(agent.execute({ ...command, type: "safari_download_complete", intentId: captured.intentId, href: "https://attacker.test/override" }, session, metadata), /exact captured/);
    const result = await agent.execute({ ...command, type: "safari_download_complete", ...captured }, session, metadata);
    assert.equal(result.bytesWritten, 45); assert.deepEqual(calls.map(call => call.action), ["dom_query", "interact", "download_intent_transfer"]);
    await assert.rejects(agent.execute({ ...command, type: "safari_download_complete", ...captured }, session, metadata), /no longer belongs/);
    const second = await agent.execute({ ...command, type: "safari_download_capture" }, session, metadata);
    await agent.release("session", "turn");
    await assert.rejects(agent.execute({ ...command, type: "safari_download_complete", ...second }, session, metadata), /no longer belongs/);
  } finally { if (!originalCrypto) delete globalThis.crypto; }
});


test("manual same-origin hops expose a real nonce-bound Location before any next request or body write", async () => {
  const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: "/final.txt" } } });
  await f.arm(); f.gesture(() => f.emit(f.anchor())); const capture = await f.read();
  const args = { ...f.args, href: capture.href, redirectPolicy: "same-origin-policy" };
  const first = await f.adapter.redirectStep({ id: 12 }, args);
  assert.equal(first.kind, "redirect"); assert.equal(first.href, "https://example.test/final.txt");
  assert.equal(f.requests.length, 1, "the next request must wait for the original full-URL policy"); assert.equal(f.writes.length, 0);
  assert.equal(f.requests[0].options.redirect, "manual"); assert.equal(f.requests[0].options.mode, "same-origin");
  assert.match(f.requests[0].options.headers["X-ChatGPT-Safari-Transfer"], /^[a-f0-9-]{36}$/i);
  const ready = await f.adapter.redirectStep({ id: 12 }, { ...args, href: first.href });
  assert.equal(ready.kind, "ready"); assert.equal(f.requests.length, 2); assert.equal(f.writes.length, 0);
  assert.notEqual(f.requests[0].options.headers["X-ChatGPT-Safari-Transfer"], f.requests[1].options.headers["X-ChatGPT-Safari-Transfer"]);
  const saved = await f.adapter.executeIntent({ id: "final-body-writer" }, { id: 12 }, { ...args, href: ready.href });
  assert.equal(saved.bytesWritten, f.body.length); assert.equal(f.requests.length, 2, "body adoption must not fetch the final URL again");
  assert.equal(f.writes.filter(call => call.input.action === "finish").length, 1); assert.equal(f.live.downloadIntents.size, 0);
  assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
});

test("agent cross-origin receipts retain their original policy and exact pending URL across the claimed-tab lease", async () => {
  const calls = [], metadata = { session_id: "session", turn_id: "turn" }, owner = { instanceId: "owner", profileId: "profile", accountScope: "account" };
  const session = { currentTurnId: "turn", async requireOwnedTab(id) { assert.equal(id, 12); } };
  const companion = { async agentOwner() { return owner; }, async runAgentCommand(command) {
    calls.push(command); const args = command.arguments;
    if (command.action === "dom_query") return { node: "source", documentId: "doc", snapshotId: "snap", url: "https://example.test/owned" };
    if (command.action === "interact") return { downloadIntent: { intentId: args.downloadIntent.intentId, href: "https://example.test/initial" } };
    assert.equal(args.redirectPolicy, "cross-origin-policy");
    if (command.action === "download_intent_redirect") return args.href.endsWith("initial")
      ? { kind: "redirect", href: "https://destination.test/final?exact=1" } : { kind: "ready", href: args.href };
    assert.equal(command.action, "download_intent_transfer"); assert.equal(args.href, "https://destination.test/final?exact=1");
    return { path: "/Downloads/actual", state: "complete", bytesWritten: 45 };
  } };
  const agent = createAgent({ webRequest: webRequestFixture() }, companion), command = { browser_id: "0", tab_id: "12", selector: "#known-download", safari_download_intent: { timeout_ms: 1000, redirects: "cross-origin-policy" } };
  const captured = await agent.execute({ ...command, type: "safari_download_capture" }, session, metadata);
  const next = await agent.execute({ ...command, type: "safari_download_redirect_step", ...captured }, session, metadata);
  await assert.rejects(agent.execute({ ...command, type: "safari_download_redirect_step", intentId: captured.intentId, href: "https://destination.test/not-approved" }, session, metadata), /exact pending redirect URL/);
  const ready = await agent.execute({ ...command, type: "safari_download_redirect_step", intentId: captured.intentId, href: next.href }, session, metadata);
  assert.equal((await agent.execute({ ...command, type: "safari_download_complete", intentId: captured.intentId, href: ready.href }, session, metadata)).state, "complete");
  assert.deepEqual(calls.map(call => call.action), ["dom_query", "interact", "download_intent_redirect", "download_intent_redirect", "download_intent_transfer"]);
});

test("cross-origin, cyclic and sixth-hop redirects stop before the next request without producing a file", async () => {
  for (const mode of ["cross-origin", "cycle", "limit"]) {
    const routes = mode === "cross-origin" ? { "https://example.test/synchronous.txt": { status: 302, location: "https://other.test/forbidden" } }
      : mode === "cycle" ? { "https://example.test/synchronous.txt": { status: 302, location: "/synchronous.txt" } }
      : Object.fromEntries(["synchronous.txt", "hop1", "hop2", "hop3", "hop4"].map((name, index) => ["https://example.test/" + name, { status: 302, location: "/hop" + (index + 1) }]));
    const f = pageFixture({ routes }); await f.arm(); f.gesture(() => f.emit(f.anchor())); const captured = await f.read();
    let href = captured.href;
    await assert.rejects((async () => { for (let request = 0; request < 6; request++) {
      const result = await f.adapter.redirectStep({ id: 12 }, { ...f.args, href, redirectPolicy: "same-origin-policy" }); href = result.href;
    } })(), /same origin|repeated a URL|five-request/);
    assert.equal(f.requests.length, mode === "limit" ? 5 : 1); assert.equal(f.writes.length, 0); assert.equal(f.live.downloadIntents.size, 0);
    assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
  }
});

test("native header receipts require the actual nonce, request ID, exact tab/frame/URL and native document identity", async () => {
  const href = "http://127.0.0.1:62356/start", nonce = "11111111-1111-4111-8111-111111111111";
  for (const fault of ["none", "document", "request", "duplicate", "missing-location"]) {
    const webRequest = webRequestFixture(), observer = downloadsModule.observeRedirectHeaders({ webRequest }, { id: 12 }, href, nonce);
    const request = { tabId: 12, frameId: 0, url: href, requestId: "actual", documentId: "native-document" };
    const sent = { ...request, requestHeaders: [{ name: "x-chatgpt-safari-transfer", value: nonce }] };
    webRequest.onBeforeRequest.emit(request);
    webRequest.onBeforeSendHeaders.emit({ ...sent, requestHeaders: [{ name: "x-chatgpt-safari-transfer", value: "different" }] });
    webRequest.onBeforeSendHeaders.emit(fault === "request" ? { ...sent, requestId: "unobserved" } : fault === "document" ? { ...sent, documentId: "other-document" } : sent);
    if (fault === "duplicate") { webRequest.onBeforeRequest.emit({ ...request, requestId: "second" }); webRequest.onBeforeSendHeaders.emit({ ...sent, requestId: "second" }); }
    webRequest.onHeadersReceived.emit({ ...request, statusCode: 302, responseHeaders: fault === "missing-location" ? [] : [{ name: "location", value: "/next" }] });
    if (fault === "none") { const receipt = await observer.promise; assert.equal(receipt.href, "http://127.0.0.1:62356/next"); }
    else await assert.rejects(observer.promise, /exact nonce\/request\/document/);
    observer.cleanup(); assert.equal(Object.values(webRequest).every(event => event.size() === 0), true);
  }
  assert.throws(() => downloadsModule.observeRedirectHeaders({}, { id: 12 }, href, nonce), /unavailable/);
});

test("the original full-URL download policy approves each next hop before that request, and denial cancels without replay", async () => {
  for (const denyNext of [false, true]) {
    const events = [], command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12", selector: "#known-download",
      safari_download_intent: { timeout_ms: 1000, redirects: "same-origin-policy" } };
    const context = { clientInfo: { family: "safari" }, security: { async ensureDownloadAllowed(_tab, href) {
      events.push("approve:" + href); if (denyNext && href.endsWith("final")) throw new Error("Next full URL denied");
    } }, api: { async executeUnhandledCommand({ command: operation }) {
      if (operation.type === "safari_download_capture") return { intentId: "receipt", href: "https://example.test/initial" };
      if (operation.type === "safari_download_redirect_step") { events.push("request:" + operation.href); return operation.href.endsWith("initial") ? { kind: "redirect", href: "https://example.test/final" } : { kind: "ready", href: operation.href }; }
      events.push(operation.type); return { path: "/Downloads/real", state: "complete" };
    } } };
    if (denyNext) await assert.rejects(dispatch(context, command, () => assert.fail("No Chrome/CDP response")), /Next full URL denied/);
    else assert.equal((await dispatch(context, command, () => assert.fail("No Chrome/CDP response"))).state, "complete");
    assert.deepEqual(events, denyNext ? ["approve:https://example.test/initial", "request:https://example.test/initial", "approve:https://example.test/final", "safari_download_cancel"]
      : ["approve:https://example.test/initial", "request:https://example.test/initial", "approve:https://example.test/final", "request:https://example.test/final", "safari_download_complete", "safari_download_cancel"]);
  }
});


test("redirect source cancellation and an exhausted active budget cannot start another request or leave observers", async () => {
  for (const reason of ["cancel", "budget"]) {
    const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: "/final.txt" } } });
    await f.arm(); f.gesture(() => f.emit(f.anchor())); const capture = await f.read();
    const args = { ...f.args, href: capture.href, redirectPolicy: "same-origin-policy" };
    if (reason === "budget") f.live.downloadIntents.get(f.args.intentId).activeMs = 30000;
    else { const next = await f.adapter.redirectStep({ id: 12 }, args); args.href = next.href; await f.cancel(); }
    await assert.rejects(f.adapter.redirectStep({ id: 12 }, args), /active transfer budget|no longer belongs/);
    assert.equal(f.requests.length, reason === "cancel" ? 1 : 0); assert.equal(f.writes.length, 0);
    assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
  }
});

test("opt-in cross-origin policy approves every full URL before one credentialed CORS request and adopts the final body once", async () => {
  const initial = "https://example.test/synchronous.txt", final = "https://destination.test/private/export?report=exact";
  const f = pageFixture({ routes: { [initial]: { status: 302, location: final } } }), approvals = [];
  const command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12", selector: "#known-download",
    safari_download_intent: { timeout_ms: 1000, redirects: "cross-origin-policy" } };
  const context = { clientInfo: { family: "safari" }, security: { async ensureDownloadAllowed(tab, href) {
    assert.equal(tab, 12); assert.equal(f.requests.some(request => request.url === href), false);
    approvals.push(href);
  } }, api: { async executeUnhandledCommand({ command: operation }) {
    if (operation.type === "safari_download_capture") { await f.arm(); f.gesture(() => f.emit(f.anchor())); return f.read(); }
    const args = { ...f.args, href: operation.href, redirectPolicy: "cross-origin-policy" };
    if (operation.type === "safari_download_redirect_step") return f.adapter.redirectStep({ id: 12 }, args);
    if (operation.type === "safari_download_complete") return f.adapter.executeIntent({ id: "original-work" }, { id: 12 }, args);
    await f.cancel(); return {};
  } } };
  const result = await dispatch(context, command, () => assert.fail("No alternate transport"));
  assert.deepEqual(approvals, [initial, final]); assert.equal(result.state, "complete"); assert.equal(result.path, "/Downloads/observed.txt");
  assert.equal(result.bytesWritten, f.body.length); assert.deepEqual(f.requests.map(request => request.url), approvals);
  for (const request of f.requests) {
    assert.equal(request.options.mode, "cors"); assert.equal(request.options.credentials, "include"); assert.equal(request.options.redirect, "manual");
    assert.deepEqual(Object.keys(request.options.headers), ["X-ChatGPT-Safari-Transfer"], "never copy Cookie or Authorization between hosts");
  }
  assert.deepEqual(Buffer.concat(f.writes.filter(call => call.input.action === "append").map(call => Buffer.from(call.input.data, "base64"))), f.body);
  assert.equal(f.writes.filter(call => call.input.action === "finish").length, 1);
  assert.equal(f.live.downloadIntents.size, 0); assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
});

test("cross-origin approval denial leaves the destination uncontacted and cancels the captured source", async () => {
  const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: "https://destination.test/private" } } });
  const command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12", safari_download_intent: { redirects: "cross-origin-policy" } };
  const context = { clientInfo: { family: "safari" }, security: { async ensureDownloadAllowed(_tab, href) {
    if (href.startsWith("https://destination.test/")) { assert.equal(f.requests.length, 1); throw new Error("Destination denied"); }
  } }, api: { async executeUnhandledCommand({ command: operation }) {
    if (operation.type === "safari_download_capture") { await f.arm(); f.gesture(() => f.emit(f.anchor())); return f.read(); }
    if (operation.type === "safari_download_redirect_step") return f.adapter.redirectStep({ id: 12 }, { ...f.args, href: operation.href, redirectPolicy: "cross-origin-policy" });
    assert.equal(operation.type, "safari_download_cancel"); await f.cancel(); return {};
  } } };
  await assert.rejects(dispatch(context, command, () => assert.fail("No alternate transport")), /Destination denied/);
  assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.live.downloadIntents.size, 0);
});

test("cross-origin CORS failure, cancellation and document change never retry or produce a completion path", async () => {
  const final = "https://destination.test/private";
  for (const reason of ["cors", "cancel", "document", "scope", "budget"]) {
    const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: final }, [final]: { corsDenied: reason === "cors" } } });
    await f.arm(); f.gesture(() => f.emit(f.anchor())); const captured = await f.read();
    const args = { ...f.args, href: captured.href, redirectPolicy: "cross-origin-policy" };
    const next = await f.adapter.redirectStep({ id: 12 }, args); assert.equal(next.href, final);
    if (reason === "cancel") await f.cancel();
    if (reason === "document") f.live.documentId = "different-document";
    if (reason === "scope") args.scope = "different-owner";
    if (reason === "budget") f.live.downloadIntents.get(f.args.intentId).activeMs = 30000;
    await assert.rejects(f.adapter.redirectStep({ id: 12 }, { ...args, href: next.href }), /credentialed CORS|no longer belongs|active transfer budget/);
    assert.equal(f.requests.length, reason === "cors" ? 2 : 1); assert.equal(f.writes.length, 0);
    assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
    // Cleanup uses only the original owner scope, including when the attempted
    // command deliberately provided the wrong owner and could not cancel it.
    await f.cancel(); assert.equal(f.live.downloadIntents.size, 0);
  }
});

test("cross-origin policy retains cycle and five-request limits across hosts", async () => {
  for (const mode of ["cycle", "limit"]) {
    const urls = ["https://example.test/synchronous.txt", "https://destination.test/one", "https://third.test/two", "https://destination.test/three", "https://fourth.test/four", "https://fifth.test/five"];
    const routes = Object.fromEntries(urls.slice(0, 5).map((url, index) => [url, { status: 302, location: mode === "cycle" && index === 1 ? urls[0] : urls[index + 1] }]));
    const f = pageFixture({ routes }); await f.arm(); f.gesture(() => f.emit(f.anchor())); const captured = await f.read(); let href = captured.href;
    await assert.rejects((async () => { for (let i = 0; i < 6; i++) { const next = await f.adapter.redirectStep({ id: 12 }, { ...f.args, href, redirectPolicy: "cross-origin-policy" }); href = next.href; } })(), /repeated a URL|five-request/);
    assert.equal(f.requests.length, mode === "cycle" ? 2 : 5); assert.equal(f.writes.length, 0); assert.equal(f.live.downloadIntents.size, 0);
    assert.equal(Object.values(f.webRequest).every(event => event.size() === 0), true);
  }
});

function destinationAdapter(f, configuration = {}) {
  const href = "https://destination.test/private", pageURL = "https://destination.test/login", body = Buffer.from("Destination realm, ordinary login, no CORS.\n");
  const destination = vm.createContext({ URL, Headers, Response, Uint8Array, AbortController, setTimeout, clearTimeout, btoa, addEventListener() {},
    location: { href: pageURL, origin: "https://destination.test" },
    __chatGPTSafariLiveDocument: { documentId: "destination-document", snapshotId: "destination-snapshot", url: pageURL },
    async fetch(url, options) {
      f.requests.push({ url, options }); assert.equal(options.credentials, "same-origin"); assert.equal(options.mode, "same-origin"); assert.equal(options.redirect, "manual");
      const details = { tabId: 13, frameId: 0, requestId: "destination-request", documentId: "native-destination-document", url };
      f.webRequest.onBeforeRequest.emit(details);
      f.webRequest.onBeforeSendHeaders.emit({ ...details, requestHeaders: Object.entries(options.headers).map(([name, value]) => ({ name, value })) });
      f.webRequest.onHeadersReceived.emit({ ...details, statusCode: 200, responseHeaders: [] });
      const response = new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=destination.bin" } });
      Object.defineProperty(response, "url", { value: url }); return response;
    } });
  let sequence = 0, bytes = 0;
  const unwrap = value => { if (!value?.ok) throw Object.assign(new Error(value?.error?.message), value?.error); return value.result; };
  const adapter = downloadsModule.createDownloads({ profileId: "profile", sessionId: "background", assertTime() {}, unwrap,
    api: { webRequest: f.webRequest, scripting: { async executeScript(request) {
      const context = request.target.tabId === 12 ? f.context : destination;
      assert.ok([12, 13].includes(request.target.tabId));
      const result = await vm.runInContext(`(${request.func.toString()})(...parameters)`, Object.assign(context, { parameters: request.args }));
      return [{ result }];
    } } }, async target(handle, expectedUrl) {
      const context = handle.endsWith(":13") ? destination : f.context;
      if (expectedUrl !== context.location.href) throw new Error("Document navigation changed its exact URL");
      return { id: handle.endsWith(":13") ? 13 : 12 };
    }, async send(command) {
      f.writes.push(command); const input = command.input;
      if (input.action === "begin") return { ok: true, result: { transferId: "realm-writer" } };
      if (input.action === "append") { assert.equal(input.sequence, sequence++); bytes += Buffer.from(input.data, "base64").length; configuration.afterAppend?.(f, destination); return { ok: true, result: { sequence, bytesWritten: bytes } }; }
      return { ok: true, result: { state: "complete", path: "/Downloads/destination.bin", bytesWritten: bytes } };
    } });
  return { adapter, href, destination, body, document: { tabId: 13, handle: "live:profile:13", documentId: "destination-document", snapshotId: "destination-snapshot", expectedUrl: pageURL } };
}

test("explicit destination-tab policy binds both documents, actual destination headers and a single non-CORS body", async () => {
  const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: "https://destination.test/private" } } });
  const realm = destinationAdapter(f); await f.arm(); f.gesture(() => f.emit(f.anchor())); const captured = await f.read();
  const args = { ...f.args, href: captured.href, redirectPolicy: "tab-origin-policy", transportDocuments: [realm.document] };
  const next = await realm.adapter.redirectStep({ id: 12 }, args);
  assert.equal(next.href, realm.href); assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 0);
  const approved = { ...args, href: next.href };
  const ready = await realm.adapter.redirectStep({ id: 12 }, approved); assert.equal(ready.kind, "ready"); assert.equal(f.requests.length, 2);
  const result = await realm.adapter.executeIntent({ id: "owned-operation" }, { id: 12 }, approved);
  assert.equal(result.state, "complete"); assert.equal(result.bytesWritten, realm.body.length); assert.equal(f.requests.length, 2);
  assert.deepEqual(Buffer.concat(f.writes.filter(value => value.input.action === "append").map(value => Buffer.from(value.input.data, "base64"))), realm.body);
  assert.equal(f.writes.filter(value => value.input.action === "finish").length, 1);
  assert.equal(f.live.downloadIntents.size, 0);
});

test("missing carrier, source cancellation, and destination navigation cannot contact a next hop or finish a partial", async () => {
  for (const mode of ["missing", "source", "destination", "destination-url"]) {
    const f = pageFixture({ routes: { "https://example.test/synchronous.txt": { status: 302, location: "https://destination.test/private" } } });
    const realm = destinationAdapter(f, { afterAppend(source, destination) {
      if (mode === "source") source.live.documentId = "new-source";
      if (mode === "destination") destination.__chatGPTSafariLiveDocument.documentId = "new-destination";
      if (mode === "destination-url") destination.location.href += "#manual-change";
    } });
    await f.arm(); f.gesture(() => f.emit(f.anchor())); const captured = await f.read();
    const args = { ...f.args, href: captured.href, redirectPolicy: "tab-origin-policy", transportDocuments: mode === "missing" ? [] : [realm.document] };
    const next = await realm.adapter.redirectStep({ id: 12 }, args), approved = { ...args, href: next.href };
    if (mode === "missing") { await assert.rejects(realm.adapter.redirectStep({ id: 12 }, approved), /already-claimed/); assert.equal(f.requests.length, 1); await f.cancel(); }
    else {
      await realm.adapter.redirectStep({ id: 12 }, approved);
      await assert.rejects(realm.adapter.executeIntent({ id: "owned-operation" }, { id: 12 }, approved), /source|destination|document/i);
      assert.equal(f.writes.some(value => value.input.action === "finish"), false);
      assert.equal(f.writes.some(value => value.input.action === "abort"), true);
      assert.equal(realm.destination.__chatGPTSafariDownloadRealms.leases.size, 0);
    }
  }
});

test("destination transports require original claims and recheck them through the source operation", async () => {
  const owner = { instanceId: "owner", profileId: "profile", accountScope: "account" }, metadata = { session_id: "session", turn_id: "turn" };
  const claimed = new Set([12, 13]), calls = [];
  const session = { currentTurnId: "turn", async requireOwnedTab(id) { if (!claimed.has(id)) throw new Error("Destination claim released"); } };
  const companion = { async agentOwner() { return owner; }, async runAgentCommand(command) {
    calls.push(command);
    if (command.action === "dom_query") return { node: "source", documentId: "source-doc", snapshotId: "source-snapshot", url: "https://example.test/owned" };
    if (command.action === "read_page") { assert.equal(command.arguments.maxLength, 1000, "retain the established live read-page minimum"); return { documentId: "dest-doc", snapshotId: "dest-snapshot", url: "https://destination.test/login", profileId: "profile" }; }
    if (command.action === "interact") return { downloadIntent: { intentId: command.arguments.downloadIntent.intentId, href: "https://example.test/file" } };
    throw new Error("Unexpected transfer before policy");
  } };
  const agent = createAgent({ webRequest: webRequestFixture() }, companion), command = { browser_id: "0", tab_id: "12", selector: "#owned",
    safari_download_intent: { timeout_ms: 1000, capture: "causal", wait_ms: 1000, redirects: "tab-origin-policy", transportTabs: ["13"] } };
  const captured = await agent.execute({ ...command, type: "safari_download_capture" }, session, metadata);
  const binding = { intentId: captured.intentId, documentId: "source-doc", snapshotId: "source-snapshot", expectedUrl: "https://example.test/owned",
    scope: JSON.stringify(["session", "turn", "owner", "profile", "account", "12"]) };
  await agent.assertDownloadIntent(binding);
  assert.deepEqual(calls.map(value => value.action), ["dom_query", "read_page", "interact"]);
  claimed.delete(13);
  await assert.rejects(agent.assertDownloadIntent(binding), /claim released/);
  await agent.release("session", "turn");
  await assert.rejects(agent.assertDownloadIntent(binding), /lost its original/);
});


test("a failed approved redirect request cannot hold its original error behind a lost cancellation callback", { timeout: 4000 }, async () => {
  const href = "https://example.test/synchronous.txt";
  const f = pageFixture({ hangCancel: true, routes: { [href]: { corsDenied: true } } });
  await f.arm(); f.gesture(() => f.emit(f.anchor(href))); await f.read();
  await assert.rejects(f.adapter.redirectStep({ id: 12 }, { ...f.args, href, redirectPolicy: "cross-origin-policy" }),
    /exact approved request failed.*cleanup was not acknowledged/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.writes.length, 0);
  for (const event of Object.values(f.webRequest)) assert.equal(event.size(), 0);
});
