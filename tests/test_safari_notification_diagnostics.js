const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const resources = path.join(__dirname, "../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources");
const settings = { authorization: "not_determined", alertsEnabled: false, notificationCenterEnabled: false, permissionRequestAvailable: true };

test("only the exact extension diagnostics page can inspect or request app notification permission", async () => {
  let listener;
  const calls = [];
  const runtime = { id: "extension", getURL: file => `safari-web-extension://extension/${file}`,
    onMessage: { addListener(callback) { listener = callback; } } };
  vm.runInNewContext(fs.readFileSync(path.join(resources, "safari/diagnostics-background.js"), "utf8"), {
    browser: { runtime }, ChatGPTSafariNotifications: {
      async status() { calls.push("status"); return settings; },
      async requestPermission() { calls.push("requestPermission"); return { ...settings, granted: false }; },
    },
  });
  const sender = { id: "extension", url: runtime.getURL("diagnostics.html") };
  for (const spoof of [{ ...sender, id: "other" }, { ...sender, url: "https://example.test/diagnostics.html" },
    { ...sender, url: runtime.getURL("diagnostics.html?permission=true") }]) {
    assert.equal(listener({ type: "chatgpt-safari:notification-request-permission" }, spoof, () => assert.fail("An untrusted sender received a response")), false);
  }
  assert.deepEqual(calls, []);
  const result = await new Promise(resolve => assert.equal(listener({ type: "chatgpt-safari:notification-status" }, sender, resolve), true));
  assert.equal(result.result.authorization, "not_determined");
  assert.deepEqual(calls, ["status"]);
  await new Promise(resolve => listener({ type: "chatgpt-safari:notification-request-permission" }, sender, resolve));
  assert.deepEqual(calls, ["status", "requestPermission"]);
  const transport = await new Promise(resolve => listener({ type: "chatgpt-safari:transport-status" }, sender, resolve));
  assert.equal(typeof transport.safariAPIs.createWindow, "boolean", "existing Safari API diagnostics remain available");
});

function diagnosticsFixture(initial) {
  const elements = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", disabled: selector === "#notifications-enable", listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; } });
    return elements.get(selector);
  };
  let response = initial;
  vm.runInNewContext(fs.readFileSync(path.join(resources, "chunks/native-diagnostics.js"), "utf8"), {
    browser: { runtime: { async sendMessage(message) {
      calls.push(message.type);
      if (message.type === "chatgpt-safari:transport-status") return { manager: {} };
      return response;
    } } }, document: { querySelector: element }, console,
  });
  return { calls, element, setResponse(value) { response = value; } };
}

test("loading diagnostics checks status only; a deliberate Enable click requests native permission", async () => {
  const f = diagnosticsFixture({ ok: true, result: settings });
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(type => type === "chatgpt-safari:notification-request-permission").length, 0);
  assert.equal(f.element("#notifications-enable").disabled, false);
  f.setResponse({ ok: true, result: { authorization: "authorized", alertsEnabled: true,
    notificationCenterEnabled: true, permissionRequestAvailable: false, granted: true } });
  await f.element("#notifications-enable").listeners.click();
  assert.equal(f.calls.filter(type => type === "chatgpt-safari:notification-request-permission").length, 1);
  assert.equal(f.element("#notifications-result").textContent, "Notifications are allowed.");
  assert.equal(f.element("#notifications-enable").disabled, true);
});

test("an unavailable signed-in owner gives a usable recovery message and never enables the permission action", async () => {
  const f = diagnosticsFixture({ ok: false, error: { code: "NOTIFICATION_OWNER_REQUIRED",
    message: "Open the ChatGPT sidebar in an ordinary Safari tab and sign in before managing app notifications." } });
  await new Promise(setImmediate);
  assert.match(f.element("#notifications-result").textContent, /Open the ChatGPT sidebar.*sign in/);
  assert.equal(f.element("#notifications-enable").disabled, true);
  await f.element("#notifications-enable").listeners.click();
  assert.equal(f.calls.includes("chatgpt-safari:notification-request-permission"), false);
  f.setResponse({ ok: true, result: { ...settings, authorization: "denied", permissionRequestAvailable: false } });
  await f.element("#notifications-refresh").listeners.click();
  assert.match(f.element("#notifications-result").textContent, /System Settings > Notifications/);
  assert.equal(f.element("#notifications-enable").disabled, true);
});
