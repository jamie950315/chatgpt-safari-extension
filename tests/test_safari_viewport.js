const test = require("node:test");
const assert = require("node:assert/strict");
const { createViewport, observeViewport } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/viewport-background.js");

function fixture({ scale = 1, clamp = false, separateOwner = false } = {}) {
  const owner = { instanceId: "owner", profileId: "profile", accountScope: "account", tabId: separateOwner ? 24 : 12, windowId: 20 };
  const metadata = { session_id: "work-session", turn_id: "turn" };
  const original = { left: 10, top: 30, width: 1000, height: 800 };
  let bounds = { ...original }, lease, focused = true, documentId = "document-a", nativeCalls = [], requests = [];
  const tabs = [{ id: 12, active: true, windowId: 20, url: "http://fixture.test/viewport", incognito: false }];
  if (separateOwner) tabs.push({ id: 24, active: false, windowId: 20, url: "http://fixture.test/sidebar", incognito: false });
  const leases = new Map([[12, { state: "active", sessionId: metadata.session_id, turnId: metadata.turn_id }]]);
  const session = { sessionId: metadata.session_id, currentTurnId: metadata.turn_id,
    listSessionTabs: async () => tabs.map(tab => ({ ...tab })), requireOwnedTab: async id => assert(leases.has(id)),
    tabLeases: { getSessionActiveLeases: async () => leases } };
  const measure = () => ({ documentId, url: tabs[0].url, width: Math.round((bounds.width - 20) / scale), height: Math.round((bounds.height - 100) / scale) });
  const api = {
    tabs: { get: async id => ({ ...tabs.find(tab => tab.id === id) }) },
    windows: { get: async () => ({ id: 20, type: "normal", state: "normal", focused, ...bounds }) },
    scripting: { executeScript: async options => { assert.equal(options.world, "ISOLATED"); assert.equal(options.func, observeViewport); return [{ result: measure() }]; } },
    runtime: { sendNativeMessage: async (host, payload) => {
      assert.equal(host, "dev.jamie.chatgpt-safari"); const command = payload.command, input = command.input;
      nativeCalls.push(input.operation); assert.equal(command.sessionId, "actual-background-session");
      assert.equal(input.scope.documentId, "document-a");
      if (!focused) return { ok: false, error: { code: "FOCUS_CHANGED", message: "Manual focus changed" } };
      if (input.operation === "begin") { lease ||= "native-lease"; return { ok: true, result: { leaseId: lease, windowBounds: { ...bounds } } }; }
      assert.equal(input.leaseId, lease);
      if (input.operation === "commitReturnPage") return { ok: true, result: { committed: true } };
      if (input.operation === "resize") {
        if (!clamp) bounds = { ...bounds, width: input.width, height: input.height };
      }
      if (input.operation === "restore") { bounds = { ...original }; lease = null; return { ok: true, result: { restored: true, windowBounds: bounds } }; }
      return { ok: true, result: { windowBounds: { ...bounds } } };
    } },
  };
  let viewport;
  const companion = { runAgentCommand: async (command, expectedOwner) => {
    assert.deepEqual(expectedOwner, owner); requests.push(command);
    const request = { id: "operation", agentOwner: owner.instanceId, sessionId: "actual-background-session", deadline: Date.now() + 10000, command };
    if (command.arguments.operation === "set") { tabs[0].active = true; if (separateOwner) tabs[1].active = false; }
    const value = await viewport.run(request, { assertCurrent() {} });
    if (separateOwner && command.arguments.operation === "set") {
      tabs[0].active = false; tabs[1].active = true;
      await viewport.commitReturnPage(request, { ...tabs[1] });
    }
    return value;
  } };
  viewport = createViewport(api, companion, { setTimeout: callback => setTimeout(callback, 0) });
  const call = (type, options = {}) => viewport.execute({ type, browser_id: "safari", ...options }, session, metadata, owner, async () => owner);
  return { call, viewport, bounds: () => ({ ...bounds }), measure, original, nativeCalls, requests, leases, tabs, session, metadata,
    blur() { focused = false; }, refocus() { focused = true; }, navigate() { documentId = "document-b"; } };
}
test("exact CSS sizing, repeated set and reset retain the first actual native bounds", async () => {
  const f = fixture();
  assert.deepEqual(await f.call("browser_viewport_set", { width: 800, height: 600 }), {});
  assert.equal(f.measure().width, 800); assert.equal(f.measure().height, 600);
  await f.call("browser_viewport_set", { width: 700, height: 500 });
  assert.equal(f.measure().width, 700);
  await f.call("browser_viewport_reset"); assert.deepEqual(f.bounds(), f.original);
  assert.equal(f.nativeCalls.filter(action => action === "resize").length, 2);
});
test("measured adjustment accommodates CSS scale without claiming DPR emulation", async () => {
  const f = fixture({ scale: 2 });
  await f.call("browser_viewport_set", { width: 600, height: 400 });
  assert.deepEqual({ width: f.measure().width, height: f.measure().height }, { width: 600, height: 400 });
  assert(f.nativeCalls.filter(action => action === "resize").length <= 3);
  await f.viewport.release("work-session", "turn"); assert.deepEqual(f.bounds(), f.original);
});
test("a native minimum-size clamp fails after no progress and restores, without replay", async () => {
  const f = fixture({ clamp: true });
  await assert.rejects(f.call("browser_viewport_set", { width: 50, height: 50 }), error => error.code === "VIEWPORT_SIZE_UNATTAINABLE" && error.restoration === "restored" && error.doNotReplay);
  assert.deepEqual(f.bounds(), f.original);
  assert.equal(f.nativeCalls.filter(action => action === "resize").length, 1);
});
test("logical active and exact current-turn claim are required; no active user-tab guess", async () => {
  const f = fixture(); f.leases.get(12).turnId = "previous-turn";
  await assert.rejects(f.call("browser_viewport_set", { width: 800, height: 600 }), { code: "VIEWPORT_UNCLAIMED_TAB" });
  f.leases.get(12).turnId = "turn"; f.tabs[0].active = false;
  await assert.rejects(f.call("browser_viewport_set", { width: 800, height: 600 }), { code: "VIEWPORT_NO_ACTIVE_TAB" });
  assert.equal(f.nativeCalls.length, 0);
});
test("manual focus change prevents automatic teardown from reclaiming the window", async () => {
  const f = fixture(); await f.call("browser_viewport_set", { width: 800, height: 600 });
  const applied = f.bounds(); f.blur();
  await assert.rejects(f.viewport.release("work-session", "turn"), { code: "FOCUS_CHANGED" });
  assert.deepEqual(f.bounds(), applied);
});
test("stale document fails and invalid dimensions never reach native resize", async () => {
  const f = fixture();
  for (const width of [0, -1, 1.5, true, Infinity]) await assert.rejects(f.call("browser_viewport_set", { width, height: 600 }), { code: "INVALID_VIEWPORT" });
  assert.equal(f.nativeCalls.length, 0);
  await f.call("browser_viewport_set", { width: 800, height: 600 }); f.navigate();
  await assert.rejects(f.call("browser_viewport_set", { width: 700, height: 500 }), { code: "VIEWPORT_DOCUMENT_CHANGED" });
});
test("the observed original owner page is committed only for rollback; teardown does not select a tab", async () => {
  const f = fixture({ separateOwner: true });
  await f.call("browser_viewport_set", { width: 800, height: 600 });
  assert.equal(f.tabs[0].active, false); assert.equal(f.tabs[1].active, true);
  assert(f.nativeCalls.includes("commitReturnPage"));
  await f.viewport.release("work-session", "turn");
  assert.deepEqual(f.bounds(), f.original);
  assert.equal(f.tabs[0].active, false); assert.equal(f.tabs[1].active, true);
});
test("a fresh explicit reset recovers a previous refused teardown only under the same owner/account/profile", async () => {
  const f = fixture(); await f.call("browser_viewport_set", { width: 800, height: 600 }); f.blur();
  await assert.rejects(f.viewport.release("work-session", "turn"), { code: "FOCUS_CHANGED" });
  f.refocus(); f.metadata.turn_id = "next-turn"; f.session.currentTurnId = "next-turn";
  await f.call("browser_viewport_reset"); assert.deepEqual(f.bounds(), f.original);
});
