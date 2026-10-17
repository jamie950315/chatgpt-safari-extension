const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagement } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/management-background.js");
function fixture() {
  const tabs = [{ id: 10, windowId: 20, index: 0, url: "https://example.com/owner", title: "Owner" },
    { id: 11, windowId: 20, index: 1, url: "https://example.com/other", title: "Other" }];
  const owned = new Set([10, 11]), native = [], changes = [];
  const groups = new Set(), owner = { instanceId: "owner", profileId: "profile", tabId: 10, windowId: 20 };
  let active = true, selected = null;
  const api = { tabs: { get: async id => ({ ...tabs.find(item => item.id === id) }), query: async () => tabs,
    update: async (...args) => { changes.push(args); return tabs[0]; }, move: async (...args) => { changes.push(args); return tabs; },
    remove: async (...args) => changes.push(args) }, windows: { get: async id => ({ id, type: "normal", focused: true }) } };
  const companion = { async runAgentCommand(command) {
    native.push(command);
    const { operation, groupTitle, newTitle, handle } = command.arguments;
    if (operation === "createGroup" || operation === "moveToGroup") { groups.add(groupTitle); selected = groupTitle; }
    if (operation === "renameGroup") { groups.delete(groupTitle); groups.add(newTitle); selected = newTitle; }
    if (operation === "moveToUngrouped") selected = null;
    return { groupTitles: [...groups], currentGroupTitle: selected, windowIdentifier: "native-window" };
  } };
  const management = createManagement(api, companion);
  const session = { async requireOwnedTab(id) { if (!owned.has(id)) throw new Error("Tab must be claimed"); } };
  const metadata = { session_id: "session", turn_id: "turn" };
  const authorize = async () => { if (!active) throw new Error("Sidebar owner changed"); };
  const call = (namespace, method, ...args) => management.execute({ type: "browser_management_call", namespace, method, args }, session, metadata, owner, authorize);
  return { call, native, changes, owned, groups, tabs, deactivate() { active = false; },
    audit: () => management.execute({ type: "browser_management_get_audit_trail" }, session, metadata, owner, authorize) };
}
test("native Safari groups use observed identities, move the owner last, rename and ungroup", async () => {
  const f = fixture();
  const { value: group } = await f.call("tabs", "group", { tabIds: [10, 11] });
  assert.equal(f.native[0].arguments.handle, "live:profile:11");
  assert.equal(f.native[1].arguments.handle, "live:profile:10");
  assert.deepEqual(f.native.map(item => item.arguments.operation), ["createGroup", "moveToGroup"]);
  const { value: renamed } = await f.call("tabGroups", "update", group, { title: "Research" });
  assert.equal(renamed.title, "Research");
  assert.equal(renamed.nativeIdentity.windowIdentifier, "native-window");
  assert.equal("color" in renamed, false); assert.equal("collapsed" in renamed, false);
  await f.call("tabs", "ungroup", [11]);
  assert.equal(f.native.at(-1).arguments.operation, "moveToUngrouped");
  assert.equal((await f.audit()).changes.length, 3);
});
test("unclaimed, private, cross-window, unsupported or expired mutations are rejected", async () => {
  const f = fixture();
  f.owned.delete(11);
  await assert.rejects(f.call("tabs", "group", { tabIds: [10, 11] }), /claimed/);
  assert.equal(f.native.length, 0);
  f.owned.add(11); f.tabs[1].windowId = 30;
  await assert.rejects(f.call("tabs", "group", { tabIds: [10, 11] }), /same Safari window/);
  f.tabs[1].incognito = true;
  await assert.rejects(f.call("tabs", "remove", 11), /ordinary/);
  await assert.rejects(f.call("bookmarks", "getTree"), /does not support/);
  await assert.rejects(f.call("tabGroups", "update", 1, { color: "red" }), /unsupported|changed/);
  f.deactivate();
  await assert.rejects(f.call("tabs", "update", 10, { pinned: true }), /owner changed/);
  assert.equal(f.changes.length, 0);
});
test("pinning and reordering use Safari's actual APIs and preserve a call audit", async () => {
  const f = fixture();
  await f.call("tabs", "update", 10, { pinned: true });
  await f.call("tabs", "move", [10, 11], { index: -1 });
  assert.deepEqual(f.changes, [[10, { pinned: true }], [[10, 11], { index: -1 }]]);
  const audit = await f.audit();
  assert.equal(audit.changes[0].method, "move");
  assert.deepEqual(audit.changes[0].before, {}, "Chrome-only layout fields must not be invented");
});
