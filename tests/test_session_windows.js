const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionWindows } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/session-windows.js");

function fixture(failCreate = false, browserActionOnly = false) {
  const tabs = new Map([[1, { id: 1, windowId: 1 }]]);
  const data = {}, titles = [], removed = [], removedListeners = [];
  let nextWindow = 10, nextTab = 11;
  const api = {
    storage: { session: { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); } } },
    tabs: {
      onRemoved: { addListener(listener) { removedListeners.push(listener); } },
      async get(id) { if (!tabs.has(id)) throw new Error("Missing tab"); return { ...tabs.get(id) }; },
      async query() { return Array.from(tabs.values()); },
      async create({ windowId }) { const tab = { id: nextTab++, windowId }; tabs.set(tab.id, tab); return { ...tab }; },
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
  return { manager: createSessionWindows(api), tabs, data, titles, removed, api, removedListeners };
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
