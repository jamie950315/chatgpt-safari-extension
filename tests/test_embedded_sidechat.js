const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

test("provider readiness connects before load, only for the exact frame, origin, token and document", async () => {
  const source = fs.readFileSync("safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/embedded-sidechat.js", "utf8");
  const owner = { version: 1, tabId: 12, windowId: 2, instanceId: "synthetic-owner" };
  const origin = "http://chatgpt-provider-fixture.localhost:1234", token = "a".repeat(64);
  const listeners = new Map(), sent = [], pairs = [];
  const frame = { contentWindow: { postMessage(...args) { sent.push(args); } } };
  const window = { name: "chatgpt-safari-sidebar:" + JSON.stringify(owner), addEventListener(type, callback) { listeners.set(type, callback); } };
  const document = { querySelector: () => ({ replaceChildren() {}, setAttribute() {} }), createElement: () => frame };
  const browser = { runtime: { async sendMessage(message) {
    if (message.type.endsWith("authorize-frame")) return { ok: true };
    if (message.payload.operation === "entry") return { ok: true, value: { providerOrigin: origin, providerURL: origin + "/", bridgeToken: token } };
    return { ok: true, value: { context: {} } };
  } } };
  class MessageChannel {
    constructor() { this.port1 = { close() { this.closed = true; }, postMessage() {} }; this.port2 = {}; pairs.push(this); }
  }
  await vm.runInNewContext("(async()=>{" + source + "})()", { window, document, browser, URL, MessageChannel, console, setInterval: () => 1, clearInterval() {} });
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
  listeners.get("pagehide")(); assert.equal(pairs[1].port1.closed, true);
  emit(ready); assert.equal(sent.length, 2);
});
