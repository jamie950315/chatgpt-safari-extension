const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/native-transport.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(sendNativeMessage) {
  const runtime = { getURL: () => "safari-web-extension://test/", sendNativeMessage };
  Object.defineProperty(runtime, "connectNative", {
    value() { throw new Error("The Safari built-in native method must not be used"); }, writable: false,
  });
  const context = { chrome: { runtime }, location: { protocol: "safari-web-extension:" }, console: { warn() {}, error() {} } };
  vm.runInNewContext(source, context);
  return { ...runtime, connectNative: context.ChatGPTSafariConnectNative };
}

test("queued writes are ordered snapshots; poll delivers real reply objects; close emits once", async () => {
  const sent = [];
  let waiting;
  let closed = 0;
  const runtime = setup(async (_application, request) => {
    switch (request.operation) {
      case "open": return { ok: true, connectionId: "connection" };
      case "poll": return new Promise(resolve => { waiting = resolve; });
      case "send":
        sent.push(request.message);
        if (waiting) { const resolve = waiting; waiting = null; resolve({ ok: true, messages: [{ id: request.message.id, result: "pong" }] }); }
        return { ok: true };
      case "close":
        closed++;
        waiting?.({ ok: true, messages: [] });
        return { ok: true };
    }
  });
  const port = runtime.connectNative("com.openai.codexextension");
  const replies = [];
  let disconnects = 0;
  port.onMessage.addListener(message => replies.push(message));
  port.onDisconnect.addListener(() => disconnects++);
  const message = { jsonrpc: "2.0", id: 1, method: "ping" };
  port.postMessage(message);
  message.method = "mutated-after-send";
  port.postMessage({ jsonrpc: "2.0", id: 2, method: "ping" });
  await tick();
  assert.deepEqual(sent.map(message => message.method), ["ping", "ping"]);
  assert.deepEqual(replies.map(message => message.id), [1, 2]);
  port.disconnect();
  port.disconnect();
  await tick();
  assert.equal(disconnects, 1);
  assert.equal(closed, 1);
  assert.throws(() => port.postMessage({}), /disconnected/);
});

test("native failure disconnects instead of inventing a success", async () => {
  const runtime = setup(async () => ({ ok: false, error: { code: "HOST_MISSING", message: "Missing host" } }));
  const port = runtime.connectNative("com.openai.codexextension");
  let disconnects = 0;
  let messages = 0;
  port.onDisconnect.addListener(() => disconnects++);
  port.onMessage.addListener(() => messages++);
  port.postMessage({ id: 1, method: "ping" });
  await tick();
  assert.equal(disconnects, 1);
  assert.equal(messages, 0);
  assert.throws(() => runtime.connectNative("unregistered.host"), /only supports/);
});
