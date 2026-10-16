const test = require("node:test");
const assert = require("node:assert/strict");
const { createLive } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");
function fixture() {
  const profileId = "55555555-5555-4555-8555-555555555555", calls = [], scripts = [];
  const tab = { id: 12, windowId: 8, url: "https://example.com/", title: "Existing session", status: "complete", active: true };
  let nativeResponse = { ok: true, requests: [] };
  let pageResponse = { ok: true, result: { url: tab.url, documentId: "doc", snapshotId: "snap", nodes: [] } };
  const api = {
    runtime: { async sendNativeMessage(_, message) { calls.push(message.command); return typeof nativeResponse === "function" ? nativeResponse(message.command) : nativeResponse; } },
    storage: { local: { async get() { return { safariLiveProfileId: profileId }; } } },
    tabs: { async query() { return [{ ...tab }, { id: 13, url: "https://private.example/", incognito: true }]; },
      async get() { return { ...tab }; }, async update(id, value) { calls.push({ update: { id, ...value } }); return { ...tab }; },
      async create(value) { calls.push({ create: value }); return { ...tab }; }, async remove(id) { calls.push({ remove: id }); } },
    windows: { async get() { return { focused: true, left: 0, top: 0, width: 1000, height: 800 }; }, async update() {} },
    scripting: { async executeScript(value) { scripts.push(value); return [{ result: pageResponse }]; } },
  };
  const environment = { crypto: require("node:crypto"), setInterval() {}, clearInterval() {}, setTimeout };
  const binding = createLive(api, environment);
  const request = (action, arguments_ = {}) => ({ id: "operation", deadline: Date.now() + 10000, command: { action, arguments: arguments_ } });
  return { profileId, tab, calls, scripts, binding, request, setNative(x) { nativeResponse = x; }, setPage(x) { pageResponse = x; } };
}
test("poll discovery never launches the companion; real handles bind the profile and tab", async () => {
  const f = fixture(); await f.binding.start();
  assert.deepEqual(f.calls.map(x => x.action), ["livePoll"]);
  const result = await f.binding.execute(f.request("list_tabs"));
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].handle, `live:${f.profileId}:12`);
  assert.equal(result.tabs[0].profileId, f.profileId);
  await assert.rejects(f.binding.execute(f.request("read_page", { handle: "live:other-profile:12" })), { code: "INVALID_HANDLE" });
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
    : command.action === "liveInput" ? { ok: false, error: { code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Grant access", eventsPosted: 0, mayHavePostedInput: false } } : { ok: true });
  f.setPage({ ok: true, result: { expectedUrl: f.tab.url, point: { x: 50, y: 50 }, viewport: { width: 1000, height: 700 } } });
  await f.binding.start();
  assert.equal(f.calls.filter(x => x.action === "liveInput").length, 1);
  assert.equal(f.calls.filter(x => x.action === "liveResolve").length, 1);
  assert.equal(f.calls.at(-1).response.error.code, "ACCESSIBILITY_PERMISSION_REQUIRED");
  assert.equal(f.calls.at(-1).response.error.data.mayHavePostedInput, false);
  assert.equal(f.scripts.every(x => typeof x.func === "function" && x.target.frameIds[0] === 0), true);
});
