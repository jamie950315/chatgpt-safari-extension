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
    if (message.payload.operation === "entry") return { ok: true, value: { providerOrigin: origin, providerURL: origin + "/", bridgeToken: token } };
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
      ? { providerOrigin: origin, providerURL: origin + "/", bridgeToken: token }
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
  const calls = [], frames = [], pairs = [], listeners = new Map();
  let accountScope = "account-a", providerOrigin = origin;
  const surface = { current: null, replaceChildren(value) { this.current = value; } };
  const status = { setAttribute() {}, textContent: "" };
  const browser = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.type.endsWith("authorize-frame")) return { ok: true };
    if (message.payload.operation === "entry") return { ok: true, value: {
      providerOrigin, providerURL: providerOrigin + "/c/same-conversation?surface=browser_side_chat&__chatgpt_key=" + "b".repeat(64),
      accountScope, bridgeToken: token,
    } };
    return { ok: true, value: { context: {} } };
  } } };
  const window = { name: "chatgpt-safari-sidebar:" + JSON.stringify(owner), addEventListener(type, callback) { listeners.set(type, callback); } };
  const document = { querySelector: selector => selector === "#surface" ? surface : status, createElement() {
    const frame = { contentWindow: { postMessage() {} }, setAttribute() {} }; frames.push(frame); return frame;
  } };
  class MessageChannel {
    constructor() { this.port1 = { close() { this.closed = true; }, postMessage() {} }; this.port2 = {}; pairs.push(this); }
  }
  await vm.runInNewContext("(async()=>{" + source + "})()", { window, document, browser, URL, MessageChannel, console, queueMicrotask, setInterval: () => 1, clearInterval() {} });
  const emit = (frame, data, extra = {}) => listeners.get("message")({ isTrusted: true, source: frame.contentWindow, origin, data, ...extra });
  const ready = frame => emit(frame, { type: "chatgpt-safari-provider:ready", token, documentId: "11111111-1111-4111-8111-11111111111" + frames.indexOf(frame) });
  const recovery = (frame, extra) => emit(frame, { type: "chatgpt-safari-provider:document-capability-missing" }, extra);
  return { calls, frames, pairs, surface, status, recovery, ready, close() { listeners.get("pagehide")(); },
    account(value) { accountScope = value; }, origin(value) { providerOrigin = value; } };
}

test("a clean-URL reload remounts only its exact current wrapper with the same account, origin and conversation", async () => {
  const f = await reloadFixture(), initial = f.frames[0];
  const entries = () => f.calls.filter(call => call.payload?.operation === "entry");
  f.ready(initial); assert.equal(f.pairs.length, 1);
  for (const extra of [{ isTrusted: false }, { source: {} }, { origin: "https://attacker.invalid" }]) f.recovery(initial, extra);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entries().length, 1);
  f.recovery(initial); f.recovery(initial);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries().length, 2, "Duplicate hints cannot create multiple recovery requests");
  assert.equal(f.frames.length, 2); assert.equal(f.surface.current, f.frames[1]);
  assert.equal(f.frames[1].src, initial.src, "The native entry retains the same provider storage origin and conversation for the original draft");
  assert.equal(f.pairs[0].port1.closed, true);
  assert.equal(f.calls.some(call => call.payload?.operation === "authentication"), false, "Reload must not refresh credentials or sign out");
  f.recovery(initial); await new Promise(resolve => setImmediate(resolve)); assert.equal(entries().length, 2);
  f.recovery(f.frames[1]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries().length, 2, "Without a successful exact bootstrap, recovery stops rather than looping");
  assert.match(f.status.textContent, /Close and reopen/);
  f.close();
});

test("a recovery rejects a changed account or provider origin without remounting a different draft scope", async () => {
  for (const change of [f => f.account("account-b"), f => f.origin("http://chatgpt-provider-changed.localhost:1234")]) {
    const f = await reloadFixture(), initial = f.frames[0]; change(f);
    f.recovery(initial); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.frames.length, 1); assert.match(f.status.textContent, /changed/);
    assert.equal(f.calls.some(call => call.payload?.operation === "authentication"), false);
    f.close();
  }
});

test("a successful exact document bootstrap allows a later deliberate reload, but stale ports cannot revive it", async () => {
  const f = await reloadFixture(); f.ready(f.frames[0]);
  const stale = f.pairs[0].port1;
  f.recovery(f.frames[0]); await new Promise(resolve => setImmediate(resolve));
  f.ready(f.frames[1]); assert.equal(f.pairs.length, 2);
  await stale.onmessage({ data: { type: "failure", error: "Stale document error" } });
  assert.equal(f.status.textContent, "");
  f.recovery(f.frames[1]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.frames.length, 3);
  f.close();
});
