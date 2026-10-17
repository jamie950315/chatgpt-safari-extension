const test = require("node:test");
const assert = require("node:assert/strict");
const { createLive, pageOperation } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");
test("native focus delivery is observed without replaying the click", async () => {
  const element = { isConnected: true, contains() { return false; } };
  const document = { activeElement: {} }, location = { href: "https://example.com/" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map([["n1", element]]) };
  const context = { document, location, setTimeout, __chatGPTSafariLiveDocument: state };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, context);
  setTimeout(() => { document.activeElement = element; }, 25);
  const response = await operation("focused", { documentId: "doc", snapshotId: "snap", node: "n1" });
  assert.equal(response.ok, true);
  assert.equal(response.result.focused, true);
});
test("typing rejects submit inputs before an implicit native click can activate them", async () => {
  const element = { tagName: "INPUT", type: "submit", isConnected: true, matches() { return false; }, getAttribute() { return null; },
    scrollIntoView() {}, getBoundingClientRect() { return { width: 100, height: 30 }; } };
  const location = { href: "https://example.com/" };
  const state = { documentId: "doc", snapshotId: "snap", url: location.href, nodes: new Map([["n1", element]]) };
  const context = { location, requestAnimationFrame(callback) { callback(); }, getComputedStyle() { return { opacity: "1" }; }, __chatGPTSafariLiveDocument: state };
  const operation = require("node:vm").runInNewContext(`(${pageOperation.toString()})`, context);
  const response = await operation("prepare", { documentId: "doc", snapshotId: "snap", node: "n1", type: "type" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOT_EDITABLE");
});
function fixture(fastLoadingObservation = false) {
  const profileId = "55555555-5555-4555-8555-555555555555", calls = [], scripts = [];
  const tab = { id: 12, windowId: 8, url: "https://example.com/", title: "Existing session", status: "complete", active: true };
  let nativeResponse = { ok: true, requests: [] };
  let focused = true;
  let pageResponse = { ok: true, result: { url: tab.url, documentId: "doc", snapshotId: "snap", nodes: [] } };
  const api = {
    runtime: { async sendNativeMessage(_, message) { calls.push(message.command); return typeof nativeResponse === "function" ? nativeResponse(message.command) : nativeResponse; } },
    storage: { local: { async get() { return { safariLiveProfileId: profileId }; } } },
    tabs: { async query() { return [{ ...tab }, { id: 13, url: "https://private.example/", incognito: true }]; },
      async get() { return { ...tab }; }, async update(id, value) { calls.push({ update: { id, ...value } }); return { ...tab }; },
      async create(value) { calls.push({ create: value }); return { ...tab }; }, async remove(id) { calls.push({ remove: id }); } },
    windows: { async get() { return { focused, left: 0, top: 0, width: 1000, height: 800 }; }, async update() {} },
    scripting: { async executeScript(value) { scripts.push(value); return [{ result: pageResponse }]; } },
  };
  const environment = { crypto: require("node:crypto"), setInterval() {}, clearInterval() {},
    setTimeout: fastLoadingObservation ? (callback, ms) => ms === 100 ? queueMicrotask(callback) : setTimeout(callback, ms) : setTimeout };
  const binding = createLive(api, environment);
  const request = (action, arguments_ = {}) => ({ id: "operation", deadline: Date.now() + 10000, command: { action, arguments: arguments_ } });
  return { profileId, tab, calls, scripts, binding, request, setNative(x) { nativeResponse = x; }, setPage(x) { pageResponse = x; }, setFocused(x) { focused = x; },
    setSidebar(value) { environment.ChatGPTSafariSidebar = value; } };
}
test("only owner-bound original-agent input enters the operation-scoped sidebar selection transaction", async () => {
  const f = fixture(); await f.binding.start();
  const events = [];
  f.setSidebar({ async withAgentSelection(owner, tab, operation) {
    assert.equal(owner, "real-inline-owner"); assert.equal(tab.id, 12);
    events.push("begin");
    const result = await operation({ async select(value) { assert.equal(value.id, 12); events.push("select"); },
      assertCurrent() { events.push("current"); } });
    events.push("restore"); return result;
  } });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(() => ({ ok: true, result: { eventsPosted: 2 } }));
  const request = { ...f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "click", node: "n1" }] }), agentOwner: "real-inline-owner" };
  await f.binding.execute(request);
  assert.deepEqual(events, ["begin", "select", "current", "current", "restore"]);
  assert.equal(f.calls.some(value => value.update), false, "the transaction owns the selection update");
  events.length = 0;
  await f.binding.execute({ ...request, agentOwner: undefined });
  assert.deepEqual(events, [], "ordinary live/MCP callers retain their existing selection behavior");
  assert.equal(f.calls.some(value => value.update), true);
  f.setSidebar(undefined);
  const before = f.calls.length;
  await assert.rejects(f.binding.execute(request), { code: "INVALID_OWNER" });
  assert.equal(f.calls.length, before, "a missing sidebar owner cannot fall back to unscoped input");
});
test("only native group moves connect their confirmed native result to the sidebar transition lease", async () => {
  const f = fixture(); await f.binding.start();
  const calls = [];
  f.setSidebar({ async withAgentSelection(owner, tab, operation, scope) {
    assert.equal(owner, "owner"); assert.equal(tab.id, 12); calls.push(scope.nativeGroupMove);
    return operation({ async select() {}, assertCurrent() {}, async runNativeGroupMove(action, perform) {
      calls.push(action); const result = await perform(); assert.equal(result.mutationApplied, true); return result;
    } });
  } });
  f.setNative(command => ({ ok: true, result: command.action === "liveOrganize"
    ? { action: command.input.action, mutationApplied: true, selectedTab: { index: 0, title: f.tab.title, url: f.tab.url } }
    : { eventsPosted: 0 } }));
  const request = operation => ({ ...f.request("organize", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, operation }), agentOwner: "owner" });
  await f.binding.execute(request("createGroup"));
  assert.deepEqual(calls, ["createGroup", "createGroup"]);
  calls.length = 0;
  await f.binding.execute(request("inspect"));
  assert.deepEqual(calls, [undefined], "read-only native inventory cannot defer arbitrary user activation");
});
test("poll discovery never launches the companion; real handles bind the profile and tab", async () => {
  const f = fixture(); await f.binding.start();
  assert.deepEqual(f.calls.map(x => x.action), ["livePoll"]);
  const result = await f.binding.execute(f.request("list_tabs"));
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].handle, `live:${f.profileId}:12`);
  assert.equal(result.tabs[0].profileId, f.profileId);
  await assert.rejects(f.binding.execute(f.request("read_page", { handle: "live:other-profile:12" })), { code: "INVALID_HANDLE" });
});
test("live polling keeps scoped selection diagnostics available independently of sidebar ownership", async () => {
  const f = fixture();
  const selection = { phase: "rejected", action: "createGroup", before: [{ tabId: 12, windowId: 8, active: true }],
    after: [{ tabId: 99, windowId: 9, active: true }], events: [{ type: "windowFocusChanged", windowId: 9 }] };
  f.setSidebar({ selectionDiagnostics: () => structuredClone(selection) });
  await f.binding.start();
  assert.deepEqual(f.calls[0].selection, selection);
  assert.equal(f.calls[0].action, "livePoll");
});
test("a batch activates Safari once and does not undo a later manual focus change", async () => {
  const f = fixture();
  const request = f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "click", node: "n1" }, { type: "click", node: "n2" }] });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => {
    if (command.action === "livePoll") return { ok: true, requests: [request] };
    if (command.action === "liveInput") {
      if (command.input.action === "click") f.setFocused(false);
      return { ok: true, result: { action: command.input.action, eventsPosted: command.input.action === "click" ? 2 : 0 } };
    }
    return { ok: true };
  });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
  assert.equal(f.calls.at(-1).response.error.code, "FOCUS_CHANGED");
  assert.equal(f.calls.at(-1).response.error.data.completed.length, 1);
});
test("a still-loading page keeps its real handle and completed input instead of replaying navigation", async () => {
  const f = fixture(true); await f.binding.start();
  f.tab.status = "loading";
  const created = await f.binding.execute(f.request("create_tab", { profileId: f.profileId, url: f.tab.url }));
  assert.equal(created.status, "loading");
  assert.equal(created.handle, `live:${f.profileId}:12`);
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(() => ({ ok: true, result: { eventsPosted: 2 } }));
  const result = await f.binding.execute(f.request("interact", { handle: created.handle, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] }));
  assert.equal(result.pagePending, true);
  assert.equal(result.tab.handle, created.handle);
  assert.equal(result.completed.length, 1);
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
});
test("stale snapshots and navigation are rejected before any native input", async () => {
  const f = fixture(); await f.binding.start();
  const handle = `live:${f.profileId}:12`;
  f.setPage({ ok: false, error: { code: "STALE_TARGET", message: "Read again" } });
  await assert.rejects(f.binding.execute(f.request("interact", { handle, documentId: "old", snapshotId: "old", interactions: [{ type: "click", node: "n1" }] })), { code: "STALE_TARGET" });
  assert.equal(f.calls.filter(x => x.action === "liveInput").length, 0);
  await assert.rejects(f.binding.execute(f.request("navigate", { handle, expectedUrl: "https://old.example/", url: "https://next.example/" })), { code: "STALE_TARGET" });
  assert.equal(f.calls.filter(x => x.update).length, 0);
});
test("native errors are resolved once with no synthetic input or mutation replay", async () => {
  const f = fixture();
  const handle = `live:${f.profileId}:12`;
  const request = f.request("interact", { handle, documentId: "doc", snapshotId: "snap", interactions: [{ type: "click", node: "n1" }] });
  f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] }
    : command.action === "liveInput" && command.input.action === "focus" ? { ok: true, result: { action: "focus", eventsPosted: 0 } }
    : command.action === "liveInput" ? { ok: false, error: { code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Grant access", eventsPosted: 0, mayHavePostedInput: false, data: { stage: "input" } } } : { ok: true });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "click"]);
  assert.equal(f.calls.filter(x => x.action === "liveResolve").length, 1);
  assert.equal(f.calls.at(-1).response.error.code, "ACCESSIBILITY_PERMISSION_REQUIRED");
  assert.equal(f.calls.at(-1).response.error.data.mayHavePostedInput, false);
  assert.equal(f.calls.at(-1).response.error.data.details.stage, "input");
  assert.equal(f.scripts.every(x => typeof x.func === "function" && x.target.frameIds[0] === 0), true);
});

test("native organization failure preserves confirmed mutation and no-replay outcomes alongside existing error data", async () => {
  for (const mutationApplied of [false, true]) {
    const f = fixture();
    const request = f.request("organize", { handle: `live:${f.profileId}:12`, expectedUrl: f.tab.url, operation: "createGroup" });
    const native = { code: "FOCUS_CHANGED", message: "Native selection changed", actionsPerformed: mutationApplied ? 5 : 0,
      mutationApplied, doNotReplay: mutationApplied, mayHavePostedInput: mutationApplied,
      tabBarRestoration: "unconfirmed", nativeSidebarRestoration: "restored", data: { stage: "native-result", retained: true } };
    f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] }
      : command.action === "liveOrganize" ? { ok: false, error: native } : { ok: true, result: { eventsPosted: 0 } });
    await f.binding.start();
    const resolved = f.calls.find(command => command.action === "liveResolve");
    assert.equal(resolved.response.error.code, native.code);
    assert.deepEqual(resolved.response.error.data, { ...native.data, actionsPerformed: native.actionsPerformed,
      mutationApplied, doNotReplay: mutationApplied, mayHavePostedInput: mutationApplied,
      tabBarRestoration: "unconfirmed", nativeSidebarRestoration: "restored" });
    assert.equal(f.calls.filter(command => command.action === "liveOrganize").length, 1);
  }
});

test("original agent typing requires existing focus and never posts an implicit click", async () => {
  const f = fixture();
  const request = f.request("interact", { handle: `live:${f.profileId}:12`, documentId: "doc", snapshotId: "snap",
    interactions: [{ type: "type", node: "n1", value: "agent text", requireFocused: true }] });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  f.setNative(command => command.action === "livePoll" ? { ok: true, requests: [request] } : { ok: true, result: { eventsPosted: 2 } });
  await f.binding.start();
  assert.deepEqual(f.calls.filter(x => x.action === "liveInput").map(x => x.input.action), ["focus", "type"]);
  assert.ok(f.scripts.some(x => x.args[0] === "focused"));
  assert.equal(f.calls.at(-1).response.ok, true);
});
