const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotifications } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/notifications-background.js");
const id = "chatgpt-safari-11111111-2222-3333-4444-555555555555";

function fixture() {
  const owner = { instanceId: "owner", profileId: "profile", accountScope: "verified-account" }, calls = [];
  let result = { ok: true, result: { id, status: "scheduled", authorization: "authorized" } };
  const api = { runtime: { async sendNativeMessage(host, message) {
    calls.push({ host, message }); return typeof result === "function" ? result() : result;
  } } };
  const notifications = createNotifications(api, { async agentOwner() { return { ...owner }; } });
  return { owner, calls, notifications, setResult(value) { result = value; } };
}

test("the original notification call forwards only typed plain text with its real owner and returns the native scheduling ID", async () => {
  const f = fixture();
  assert.equal(await f.notifications.create({ session_id: "session", turn_id: "turn", title: "Café", message: "第一行\nSecond line", icon: "ignored" }), id);
  assert.deepEqual(f.calls, [{ host: "dev.jamie.chatgpt-safari", message: { operation: "companion", command: {
    action: "personalData", ownerToken: "owner", profileId: "profile",
    command: { action: "notification", profileId: "profile", title: "Café", message: "第一行\nSecond line" },
  } } }]);
  for (const request of [null, { title: true, message: "x" }, { title: " ", message: "x" },
    { title: "x".repeat(201), message: "x" }, { title: "x", message: "x".repeat(4001) }, { title: "x", message: "\0" }]) {
    await assert.rejects(f.notifications.create(request), TypeError);
  }
  assert.equal(f.calls.length, 1);
});

test("status and explicit permission requests return actual native settings without fabricating a notification", async () => {
  const f = fixture();
  f.setResult({ ok: true, result: { authorization: "not_determined", alertsEnabled: false,
    notificationCenterEnabled: false, permissionRequestAvailable: true } });
  assert.equal((await f.notifications.status()).authorization, "not_determined");
  assert.equal(f.calls[0].message.command.command.operation, "status");
  f.setResult({ ok: true, result: { authorization: "denied", alertsEnabled: false,
    notificationCenterEnabled: false, permissionRequestAvailable: false, granted: false } });
  assert.equal((await f.notifications.requestPermission()).granted, false);
  assert.equal(f.calls[1].message.command.command.operation, "requestPermission");
  assert.equal("title" in f.calls[1].message.command.command, false);
});

test("permission and native scheduling failures stay explicit across the original host boundary", async () => {
  const f = fixture();
  f.setResult({ ok: false, error: { code: "NOTIFICATION_PERMISSION_REQUIRED", message: "Enable app notifications first" } });
  await assert.rejects(f.notifications.create({ title: "Title", message: "Body" }), { code: "NOTIFICATION_PERMISSION_REQUIRED" });
  f.setResult({ ok: false, error: { code: "NOTIFICATION_SCHEDULE_FAILED", message: "Scheduling unconfirmed", data: { doNotReplay: true } } });
  await assert.rejects(f.notifications.create({ title: "Title", message: "Body" }), error => error.doNotReplay === true && error.code === "NOTIFICATION_SCHEDULE_FAILED");
  f.setResult({ ok: true, result: {} });
  await assert.rejects(f.notifications.create({ title: "Title", message: "Body" }), /invalid/);
  assert.equal(f.calls.length, 3);
});

test("owner, profile, and account changes reject late notification results without replay", async () => {
  for (const field of ["instanceId", "profileId", "accountScope"]) {
    const f = fixture();
    f.setResult(() => { f.owner[field] = "replacement"; return { ok: true, result: { id, status: "scheduled", authorization: "authorized" } }; });
    await assert.rejects(f.notifications.create({ title: "Title", message: "Body" }), error => error.code === "STALE_NOTIFICATION_OWNER" && error.doNotReplay === true);
    assert.equal(f.calls.length, 1);
  }
  const disconnected = fixture();
  disconnected.setResult(() => { throw new Error("Native channel disconnected"); });
  await assert.rejects(disconnected.notifications.create({ title: "Title", message: "Body" }), error => error.doNotReplay === true && /may already have completed/.test(error.message));
  assert.equal(disconnected.calls.length, 1);
  const unsigned = fixture();
  delete unsigned.owner.accountScope;
  await assert.rejects(unsigned.notifications.create({ title: "Title", message: "Body" }), /verified ChatGPT account scope/);
  assert.equal(unsigned.calls.length, 0);
});
