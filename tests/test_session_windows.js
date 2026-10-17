const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionWindows } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/session-windows.js");

function fixture(failCreate = false, browserActionOnly = false) {
  const tabs = new Map([[1, { id: 1, windowId: 1 }]]);
  const data = {}, titles = [], removed = [], removedListeners = [], updatedListeners = [], attachedListeners = [], created = [];
  let nextWindow = 10, nextTab = 11;
  const api = {
    storage: { session: { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); } } },
    tabs: {
      onRemoved: { addListener(listener) { removedListeners.push(listener); } },
      onUpdated: { addListener(listener) { updatedListeners.push(listener); } }, onAttached: { addListener(listener) { attachedListeners.push(listener); } },
      async get(id) { if (!tabs.has(id)) throw new Error("Missing tab"); return { ...tabs.get(id) }; },
      async query() { return Array.from(tabs.values()); },
      async create(value) { created.push(value); const tab = { id: nextTab++, windowId: value.windowId }; tabs.set(tab.id, tab); return { ...tab }; },
      async remove(id) { tabs.delete(id); removed.push(id); },
    },
    windows: { async create() {
      if (failCreate) throw new Error("Window creation rejected");
      const id = nextWindow++;
      return { id, tabs: [await api.tabs.create({ windowId: id })] };
    } },
    action: { async setTitle(value) { titles.push(value); } },
  };
  if (browserActionOnly) { api.browserAction = api.action; delete api.action; }
  return { manager: createSessionWindows(api), tabs, data, titles, removed, api, removedListeners, updatedListeners, attachedListeners, created };
}

test("persistent Safari session labels use native browserAction", async () => {
  const f = fixture(false, true);
  await f.manager.createTab("session");
  assert.equal(f.titles[0].title, "ChatGPT");
});

test("agent tabs are created in a real session window without moving user tabs", async () => {
  const f = fixture();
  await f.manager.setSessionGroupTitle("session", "Safari probe");
  const first = await f.manager.createTab("session");
  const second = await f.manager.createTab("session");
  await f.manager.ensureAgentTabGroup("session", second.id, [first.id]);
  assert.equal(first.windowId, 10);
  assert.equal(second.windowId, 10);
  assert.equal(f.tabs.get(1).windowId, 1);
  assert.equal(f.titles.at(-1).title, "ChatGPT — Safari probe");
  assert.deepEqual(f.data.chatgptSafariSessionWindowsV1.session.tabs, [first.id, second.id]);
});

test("a delivered tab keeps its window while later agent tabs receive another", async () => {
  const f = fixture();
  const first = await f.manager.createTab("session");
  await f.manager.releaseTabsFromManagedGroups([first.id]);
  const second = await f.manager.createTab("session");
  assert.equal(f.tabs.get(first.id).windowId, 10);
  assert.equal(second.windowId, 11);
});

test("an explicit preferred window is honored and popup tab IDs are not changed", async () => {
  const f = fixture();
  const first = await f.manager.createTab("session", 2);
  const popup = await f.api.tabs.create({ windowId: 3 });
  await f.manager.ensureAgentTabGroup("session", popup.id, [first.id]);
  assert.equal(first.windowId, 2);
  assert.equal(f.tabs.get(popup.id).windowId, 3);
  assert.equal(f.tabs.get(1).windowId, 1);
});

test("a native creation error is preserved without attempting to remove a nonexistent tab", async () => {
  const f = fixture(true);
  await assert.rejects(f.manager.createTab("session"), /Window creation rejected/);
  assert.deepEqual(f.removed, []);
  await f.manager.refreshManagedGroupsFromChrome();
  assert.deepEqual(f.data.chatgptSafariSessionWindowsV1, {});
});

test("a manually closed session window does not leave a stale creation target", async () => {
  const f = fixture();
  const first = await f.manager.createTab("session");
  f.tabs.delete(first.id);
  for (const listener of f.removedListeners) listener(first.id);
  const second = await f.manager.createTab("session");
  assert.equal(second.windowId, 11);
});
test("native creation receipts are exact, owner/turn bound, once-only and invalidated without rewriting unknown URLs", async () => {
  const f = fixture(), scope = { profileId: "profile", ownerId: "owner", accountScope: "account", sessionId: "session", turnId: "turn" };
  const created = await f.manager.createTab("session", 2, "turn");
  assert.equal(f.created[0].url, "about:blank"); assert.equal(created.url, undefined);
  assert.equal(f.manager.bindCreatedTab(1, scope), false, "existing unknown user tabs have no creation authority");
  assert.equal(f.manager.bindCreatedTab(created.id, { ...scope, turnId: "other" }), false);
  assert.equal(f.manager.bindCreatedTab(created.id, scope), true);
  const receipt = await f.manager.createdTabReceipt(created.id, scope);
  assert.match(receipt.id, /^[0-9a-f-]{36}$/i); assert.equal(created.url, undefined);
  for (const key of Object.keys(scope)) assert.equal(await f.manager.createdTabReceipt(created.id, { ...scope, [key]: "other" }), null);
  assert.equal(f.manager.validateCreatedTabReceipt({ ...receipt, windowId: 99 }, scope, created), false);
  assert.equal(f.manager.validateCreatedTabReceipt(receipt, scope, created, true), true);
  assert.equal(f.manager.validateCreatedTabReceipt(receipt, scope, created, true), false, "a delivered navigation/close is never replayed");
  for (const invalidate of [
    id => f.manager.releaseCreatedTabs("session", "turn"),
    id => f.updatedListeners.forEach(listener => listener(id, { url: "https://other.test/" }, f.tabs.get(id))),
    id => f.attachedListeners.forEach(listener => listener(id)),
    id => f.removedListeners.forEach(listener => listener(id)),
    id => { f.tabs.get(id).pendingUrl = "https://pending.test/"; },
  ]) {
    const tab = await f.manager.createTab("session", 2, "turn"); f.manager.bindCreatedTab(tab.id, scope);
    invalidate(tab.id); assert.equal(await f.manager.createdTabReceipt(tab.id, scope), null);
  }
  assert.equal(JSON.stringify(f.data).includes(receipt.id), false, "creation capabilities never persist with session labels");
});
