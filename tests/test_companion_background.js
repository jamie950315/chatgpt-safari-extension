const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompanion } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/companion-background.js");

function fixture() {
  const tab = { id: 11, windowId: 3, url: "https://example.com/", status: "complete" };
  const calls = [], scripts = [];
  let afterCapture;
  let response = { ok: true, requests: [] };
  const api = {
    runtime: { async sendNativeMessage(_, value) { calls.push(value.command); return typeof response === "function" ? response(value.command) : response; } },
    tabs: { async get() { return { ...tab }; }, onUpdated: { addListener() {} } },
    windows: { async get() { return { left: 100, top: 100, width: 1000, height: 800 }; } },
    scripting: { async executeScript(value) { scripts.push(value); afterCapture?.(); return [{ documentId: "doc", result: { selectedText: "selected test text", revision: 2 } }]; } },
  };
  const environment = {
    ChatGPTSafariHooks: { async getInstanceId() { return "browser-instance"; }, async getTabMentions() { return [{ id: 11, title: "Test" }]; } },
    ChatGPTSafariSidebarFunctions: { selection() {}, removeSelection() {} },
  };
  return { api, tab, calls, scripts, binding: createCompanion(api, environment), setAfterCapture(value) { afterCapture = value; }, setResponse(value) { response = value; } };
}
const owner = { tabId: 11, windowId: 3, instanceId: "owner-token" };

test("native open and close retain the exact Safari owner and live browser identity", async () => {
  const f = fixture();
  await f.binding.open(owner);
  try {
    assert.equal(f.calls[0].action, "open");
    assert.equal(f.calls[0].ownerToken, owner.instanceId);
    assert.deepEqual(f.calls[0].context, { instanceId: "browser-instance", tabId: 11, windowId: 3, url: f.tab.url });
    const reply = await f.binding.handleRequest(owner, { ownerToken: owner.instanceId, method: "context", params: { includeSelection: true } });
    assert.equal(reply.context.selectedText, "selected test text");
    assert.equal(reply.context.selectionId, "doc:2");
    assert.deepEqual(f.scripts[0].args, [f.tab.url, owner.instanceId, "none"]);
  } finally { await f.binding.close(owner); }
  assert.equal(f.calls.at(-1).action, "close");
});

test("closing the native window releases its owner and stops further polling", async () => {
  const f = fixture(), closed = [];
  f.binding.onClosed.addListener(value => closed.push(value));
  await f.binding.open(owner);
  f.setResponse({ ok: true, closed: true, requests: [] });
  await f.binding.poll();
  assert.deepEqual(closed, [owner]);
  const count = f.calls.length;
  await f.binding.poll();
  assert.equal(f.calls.length, count);
  await assert.rejects(f.binding.context(owner), /owner has changed/);
});

test("a reloaded background resumes the native owner's requests without reopening its window", async () => {
  const f = fixture();
  f.setResponse({ ok: true, state: { ownerAvailable: true, ownerToken: owner.instanceId }, requests: [] });
  assert.deepEqual(await f.binding.restore([{ ...owner, instanceId: "old-owner" }, owner]), owner);
  try {
    assert.deepEqual(f.calls.map(value => value.action), ["status", "poll"]);
    f.setResponse({ ok: true, requests: [{ id: "fresh-context", ownerToken: owner.instanceId, method: "context", params: { includeSelection: true } }] });
    await f.binding.poll();
    const resolved = f.calls.at(-1);
    assert.equal(resolved.action, "resolve");
    assert.equal(resolved.id, "fresh-context");
    assert.equal(resolved.result.context.selectedText, "selected test text");
    assert.equal(f.calls.some(value => value.action === "open"), false);
  } finally { await f.binding.close(owner); }
});

test("restore does not claim an unmatched native owner", async () => {
  const f = fixture();
  f.setResponse({ ok: true, state: { ownerAvailable: true, ownerToken: "different-owner" } });
  assert.equal(await f.binding.restore([owner]), undefined);
  await f.binding.poll();
  assert.deepEqual(f.calls.map(value => value.action), ["status"]);
});

test("an earlier in-flight poll cannot resolve or disconnect a replacement owner", async () => {
  const f = fixture();
  await f.binding.open(owner);
  let finish;
  f.setResponse(command => command.action === "poll"
    ? new Promise(resolve => { finish = resolve; }) : { ok: true });
  const oldPoll = f.binding.poll();
  const replacement = { ...owner, instanceId: "replacement-owner" };
  await f.binding.open(replacement);
  finish({ ok: true, requests: [{ id: "old-context", ownerToken: owner.instanceId, method: "context" }] });
  await oldPoll;
  assert.equal(f.calls.some(value => value.action === "resolve"), false);
  f.setResponse({ ok: true, requests: [] });
  try { assert.equal((await f.binding.context(replacement)).tabId, replacement.tabId); }
  finally { await f.binding.close(replacement); }
});

test("native requests reject stale owners, moved/private tabs, and navigation during selection", async () => {
  const f = fixture();
  await f.binding.open(owner);
  try {
    await assert.rejects(f.binding.handleRequest(owner, { ownerToken: "old", method: "context" }), /earlier owner/);
    f.tab.incognito = true;
    await assert.rejects(f.binding.context(owner), /no longer owns/);
    f.tab.incognito = false;
    f.setAfterCapture(() => { f.tab.url = "https://example.org/"; });
    await assert.rejects(f.binding.context(owner, true), /changed during selection/);
    await assert.rejects(f.binding.handleRequest(owner, { ownerToken: owner.instanceId, method: "openInBrowser", params: { url: "https://evil.example/" } }), /Only ChatGPT/);
  } finally { await f.binding.close(owner); }
});
