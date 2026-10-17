const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

test("provider readiness connects before load, only for the exact frame, origin, token and document", async () => {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/embedded-sidechat.js", "utf8");
  const owner = { version: 1, tabId: 12, windowId: 2, instanceId: "synthetic-owner" };
  const origin = "http://chatgpt-provider-fixture.localhost:1234", token = "a".repeat(64);
  const listeners = new Map(), sent = [], pairs = [], tabListeners = new Map(), runtimeListeners = new Set();
  const attributes = new Map();
  const frame = { contentWindow: { postMessage(...args) { sent.push(args); } }, setAttribute(key, value) { attributes.set(key, value); } };
  const window = { name: "chatgpt-safari-sidebar:" + JSON.stringify(owner), addEventListener(type, callback) { listeners.set(type, callback); } };
  const document = { querySelector: () => ({ replaceChildren() {}, setAttribute() {} }), createElement: () => frame };
  const browser = { tabs: Object.fromEntries(["onUpdated", "onRemoved", "onReplaced"].map(name => [name, {
    addListener(callback) { tabListeners.set(name, callback); }, removeListener(callback) { if (tabListeners.get(name) === callback) tabListeners.delete(name); },
  }])), runtime: { id: "synthetic-extension", onMessage: {
    addListener(listener) { runtimeListeners.add(listener); }, removeListener(listener) { runtimeListeners.delete(listener); },
  }, async sendMessage(message) {
    if (message.type.endsWith("authorize-frame")) return { ok: true };
    if (message.payload.operation === "entry") return { ok: true, value: { providerOrigin: origin, providerURL: origin + "/", bridgeToken: token, documentRecoverySequence: 0 } };
    return { ok: true, value: { context: {} } };
  } } };
  class MessageChannel {
    constructor() { this.port1 = { posted: [], close() { this.closed = true; }, postMessage(value) { this.posted.push(value); } }; this.port2 = {}; pairs.push(this); }
  }
  await vm.runInNewContext("(async()=>{" + source + "})()", { window, document, browser, URL, MessageChannel, console, queueMicrotask, setInterval: () => 1, clearInterval() {} });
  assert.equal(attributes.get("allow"), `autoplay ${origin}; camera ${origin}; clipboard-write ${origin}; microphone ${origin}`);
  assert.equal(sent.length, 0, "Neither source assignment nor iframe loading establishes a channel");
  const ready = { isTrusted: true, source: frame.contentWindow, origin,
    data: { type: "chatgpt-safari-provider:ready", token, documentId: "55555555-5555-4555-8555-555555555555" } };
  const emit = value => listeners.get("message")(value);
  for (const event of [{ ...ready, source: {} }, { ...ready, origin: "https://unrelated.invalid" },
    { ...ready, isTrusted: false }, { ...ready, data: { ...ready.data, token: "wrong" } }]) emit(event);
  assert.equal(sent.length, 0);
  emit(ready); assert.equal(sent.length, 1);
  assert.equal(sent[0][0].type, "chatgpt-safari-provider:connect"); assert.equal(sent[0][1], origin);
  emit(ready); assert.equal(sent.length, 1, "The later load cannot replace a live document channel");
  emit({ ...ready, data: { ...ready.data, documentId: "66666666-6666-4666-8666-666666666666" } });
  assert.equal(sent.length, 2); assert.equal(pairs[0].port1.closed, true);
  tabListeners.get("onUpdated")(); tabListeners.get("onRemoved")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairs[1].port1.posted.filter(item => item.payload?.type === "browser_tab_mentions_invalidated").length, 1);
  const invalidate = [...runtimeListeners][0];
  const message = { type: "chatgpt-safari:tab-mentions-invalidated", ...owner };
  for (const [value, sender] of [[{ ...message, instanceId: "old-owner" }, { id: browser.runtime.id }],
    [message, { id: "another-extension" }], [message, { id: browser.runtime.id, tab: { id: 99 } }]]) invalidate(value, sender);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairs[1].port1.posted.filter(item => item.payload?.type === "browser_tab_mentions_invalidated").length, 1);
  invalidate(message, { id: browser.runtime.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairs[1].port1.posted.filter(item => item.payload?.type === "browser_tab_mentions_invalidated").length, 2);
  listeners.get("pagehide")(); assert.equal(pairs[1].port1.closed, true);
  assert.equal(tabListeners.size, 0); assert.equal(runtimeListeners.size, 0);
  emit(ready); assert.equal(sent.length, 2);
});

test("signed-out entry opens the app profile and resumes without exposing authentication controls to provider RPC", async () => {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/embedded-sidechat.js", "utf8");
  const owner = { version: 1, tabId: 12, windowId: 2, instanceId: "synthetic-owner" };
  const origin = "http://chatgpt-provider-fixture.localhost:1234", token = "a".repeat(64);
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.attributes = {}; this.contentWindow = { postMessage() {} }; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    remove() {}
  }
  const surface = new Element("main"), status = new Element("p"), calls = [], listeners = new Map();
  let signedIn = false, rejectResume = true;
  const browser = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.type.endsWith("authorize-frame")) return { ok: true };
    const payload = message.payload;
    if (payload.operation === "entry") return { ok: true, value: signedIn
      ? { providerOrigin: origin, providerURL: origin + "/", bridgeToken: token, documentRecoverySequence: 0 }
      : { authentication: { state: "signed_out" } } };
    if (payload.operation === "authentication") {
      if (payload.action === "resume") {
        if (rejectResume) return { ok: false, error: "Sign in in the app window, then choose Continue." };
        signedIn = true;
      }
      return { ok: true, value: { ok: true } };
    }
    return { ok: true, value: { context: {} } };
  } } };
  const window = { name: "chatgpt-safari-sidebar:" + JSON.stringify(owner), addEventListener(type, callback) { listeners.set(type, callback); } };
  const document = { querySelector: selector => selector === "#surface" ? surface : status, createElement: tag => new Element(tag) };
  await vm.runInNewContext("(async()=>{" + source + "})()", { window, document, browser, URL, console, queueMicrotask, setInterval: () => 1, clearInterval() {} });
  const screen = surface.children[0];
  assert.equal(screen.className, "authentication");
  assert.equal(screen.children[0].textContent, "Sign in to ChatGPT");
  const open = screen.children[2], resume = screen.children[3], feedback = screen.children[4];
  open.listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).payload.action, "open");
  assert.match(feedback.textContent, /Finish in the app window/);
  resume.listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(feedback.textContent, /Sign in in the app window/);
  assert.equal(surface.children[0], screen, "failed official verification keeps recovery controls usable");
  rejectResume = false;
  resume.listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(surface.children[0].tag, "iframe");
  assert.equal(surface.children[0].src, origin + "/");
  assert.equal(calls.filter(call => call.payload?.operation === "authentication").every(call => call.payload.method === undefined), true);
  listeners.get("pagehide")();
});

async function reloadFixture() {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/embedded-sidechat.js", "utf8");
  const owner = { version: 1, tabId: 12, windowId: 2, instanceId: "synthetic-owner" };
  const origin = "http://chatgpt-provider-fixture.localhost:1234", token = "a".repeat(64);
  const calls = [], frames = [], pairs = [], listeners = new Map(), runtimeListeners = new Set();
  let accountScope = "account-a", providerOrigin = origin, sequence = 0, heldContext;
  const surface = { current: null, replaceChildren(value) { this.current = value; } };
  const status = { setAttribute() {}, textContent: "" };
  const browser = { runtime: { id: "synthetic-extension", onMessage: {
    addListener(listener) { runtimeListeners.add(listener); }, removeListener(listener) { runtimeListeners.delete(listener); },
  }, async sendMessage(message) {
    calls.push(message);
    if (message.type.endsWith("authorize-frame")) return { ok: true };
    if (message.payload.operation === "entry") return { ok: true, value: {
      providerOrigin, providerURL: providerOrigin + "/c/same-conversation?surface=browser_side_chat&__chatgpt_key=" + "b".repeat(64),
      accountScope, bridgeToken: token, documentRecoverySequence: sequence,
    } };
    if (message.payload.operation === "host" && message.payload.method === "context" && heldContext) {
      const pending = heldContext; heldContext = undefined; return pending;
    }
    return { ok: true, value: { context: {} } };
  } } };
  const window = { name: "chatgpt-safari-sidebar:" + JSON.stringify(owner), addEventListener(type, callback) { listeners.set(type, callback); } };
  const document = { querySelector: selector => selector === "#surface" ? surface : status, createElement() {
    const frame = { contentWindow: { postMessage() {} }, setAttribute() {} }; frames.push(frame); return frame;
  } };
  class MessageChannel {
    constructor() { this.port1 = { posted: [], close() { this.closed = true; }, postMessage(value) { this.posted.push(value); } }; this.port2 = {}; pairs.push(this); }
  }
  await vm.runInNewContext("(async()=>{" + source + "})()", { window, document, browser, URL, MessageChannel, console, queueMicrotask, setInterval: () => 1, clearInterval() {} });
  const emit = (frame, data, extra = {}) => listeners.get("message")({ isTrusted: true, source: frame.contentWindow, origin, data, ...extra });
  const ready = (frame, extra) => emit(frame, { type: "chatgpt-safari-provider:ready", token, documentId: "11111111-1111-4111-8111-11111111111" + frames.indexOf(frame) }, extra);
  const receipt = (value, extra = {}, sender = { id: browser.runtime.id }) => {
    sequence = value;
    for (const listener of runtimeListeners) listener({ type: "chatgpt-safari:provider-document-recovery", ...owner, sequence: value, ...extra }, sender);
  };
  return { calls, frames, pairs, surface, status, receipt, ready,
    holdContext() {
      let resolve, reject; heldContext = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { resolve, reject };
    },
    hint(frame, extra) { emit(frame, { type: "chatgpt-safari-provider:document-capability-missing" }, extra); },
    close() { listeners.get("pagehide")(); }, account(value) { accountScope = value; }, origin(value) { providerOrigin = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const entries = fixture => fixture.calls.filter(call => call.payload?.operation === "entry");
const unload = (port, recoverySequence) => port.onmessage({ data: { type: "provider_document_unloaded", recoverySequence } });

test("native reload receipts cannot remount an active page or cross the background owner boundary", async () => {
  const f = await reloadFixture(), initial = f.frames[0];
  f.ready(initial); const port = f.pairs[0].port1;
  for (const extra of [{ isTrusted: false }, { source: {} }, { origin: "https://attacker.invalid" }, {}]) f.hint(initial, extra);
  for (const [extra, sender] of [[{ instanceId: "old-owner" }], [{ tabId: 99 }], [{ windowId: 99 }],
    [{}, { id: "another-extension" }], [{}, { id: "synthetic-extension", tab: { id: 12 } }]]) f.receipt(1, extra, sender);
  for (const invalid of [-1, 0, 1.5, "1", 1_000_000_001]) f.receipt(invalid);
  await flush(); assert.equal(entries(f).length, 1);
  f.receipt(1); await flush();
  assert.equal(entries(f).length, 1, "A receipt without authenticated pagehide only updates the active document checkpoint");
  assert.equal(port.posted.at(-1).type, "document_recovery_checkpoint");
  assert.equal(port.posted.at(-1).sequence, 1);
  for (const invalid of [-1, 1.5, "1", 2]) await unload(port, invalid);
  await flush(); assert.equal(entries(f).length, 1);
  await unload(port, 1); f.receipt(1); await flush();
  assert.equal(entries(f).length, 1, "A prior receipt cannot authorize a later navigation");
  f.receipt(2); f.receipt(2); await flush();
  assert.equal(entries(f).length, 2); assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].src, initial.src, "Native entry preserves the provider storage origin and conversation for the original draft");
  assert.equal(port.closed, true);
  assert.equal(f.calls.some(call => call.payload?.operation === "authentication"), false, "Reload must not refresh credentials or sign out");
  f.hint(initial); f.receipt(3); await unload(port, 2); await flush();
  assert.equal(entries(f).length, 2, "A failed bootstrap cannot loop or reuse an old document port");
  f.close();
});

test("an authenticated pre-navigation checkpoint survives native-receipt-before-pagehide ordering", async () => {
  for (const receiptFirst of [true, false]) {
    const f = await reloadFixture(); f.ready(f.frames[0]); const port = f.pairs[0].port1;
    if (receiptFirst) f.receipt(1);
    await unload(port, 0);
    if (!receiptFirst) f.receipt(1);
    await flush();
    assert.equal(entries(f).length, 2); assert.equal(f.frames.length, 2);
    f.close();
  }
});

test("reload recovery rejects a changed account or provider origin instead of crossing draft scope", async () => {
  for (const change of [f => f.account("account-b"), f => f.origin("http://chatgpt-provider-changed.localhost:1234")]) {
    const f = await reloadFixture(); f.ready(f.frames[0]); change(f);
    await unload(f.pairs[0].port1, 0); f.receipt(1); await flush();
    assert.equal(f.frames.length, 1); assert.match(f.status.textContent, /changed/);
    assert.equal(f.calls.some(call => call.payload?.operation === "authentication"), false);
    f.close();
  }
});

test("a successful exact document bootstrap permits a later deliberate reload, but stale ports cannot revive it", async () => {
  const f = await reloadFixture(); f.ready(f.frames[0]); const stale = f.pairs[0].port1;
  await unload(stale, 0); f.receipt(1); await flush();
  f.ready(f.frames[1], { origin: "https://attacker.invalid" }); assert.equal(f.pairs.length, 1);
  f.ready(f.frames[1]); assert.equal(f.pairs.length, 2);
  await stale.onmessage({ data: { type: "failure", error: "Stale document error" } });
  await unload(stale, 0); f.receipt(1); await flush();
  assert.equal(f.status.textContent, ""); assert.equal(entries(f).length, 2);
  const port = f.pairs[1].port1;
  await unload(port, 0); f.receipt(2); await flush();
  assert.equal(entries(f).length, 2, "A checkpoint older than this document entry cannot authorize its reload");
  await unload(port, 1); await flush();
  assert.equal(f.frames.length, 3);
  f.close();
});


test("a context observation from the unloaded document cannot fail or update its replacement", async () => {
  for (const rejects of [false, true]) {
    const f = await reloadFixture(); f.ready(f.frames[0]);
    const held = f.holdContext(), oldPort = f.pairs[0].port1;
    await oldPort.onmessage({ data: { type: "ready" } });
    await unload(oldPort, 0); f.receipt(1); await flush();
    f.ready(f.frames[1]); const current = f.pairs[1].port1;
    if (rejects) held.reject(new Error("Old context observation disconnected"));
    else held.resolve({ ok: true, value: { context: { obsolete: true } } });
    await flush();
    assert.equal(f.status.textContent, ""); assert.equal(current.closed, undefined);
    assert.equal(current.posted.some(item => item.payload?.type === "browser_side_chat_context_invalidated"), false);
    f.close();
  }
});
