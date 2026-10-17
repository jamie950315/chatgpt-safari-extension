const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagement } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/management-background.js");
function fixture() {
  const tabs = [{ id: 10, windowId: 20, index: 0, url: "https://example.com/one", title: "One" },
    { id: 11, windowId: 20, index: 1, url: "https://example.com/other", title: "Other" },
    { id: 12, windowId: 20, index: 2, url: "https://example.com/owner", title: "Owner" }];
  const owned = new Set([10, 11, 12]), native = [], changes = [];
  const groups = new Set(), owner = { instanceId: "owner", profileId: "profile", tabId: 12, windowId: 20 };
  let active = true, selected = null;
  const api = { tabs: { get: async id => ({ ...tabs.find(item => item.id === id) }), query: async () => tabs,
    update: async (...args) => { changes.push(args); return tabs[0]; }, move: async (...args) => { changes.push(args); return tabs; },
    remove: async (...args) => changes.push(args) }, windows: { get: async id => ({ id, type: "normal", focused: true }) } };
  const companion = { async runAgentCommand(command) {
    native.push(command);
    const { operation, groupTitle, newTitle, handle } = command.arguments;
    if (operation === "createGroup" || operation === "moveToGroup") { groups.add(groupTitle); selected = groupTitle; }
    if (operation === "renameGroup") { groups.delete(groupTitle); groups.add(newTitle); }
    if (operation === "moveToUngrouped") selected = null;
    return { action: operation, mutationApplied: operation !== "inspect",
      sourceCollection: { title: "Source", nativeWindowIdentifier: "native-window", restored: true },
      groupTitles: [...groups], currentGroupTitle: selected, windowIdentifier: "native-window",
      ...(operation === "renameGroup" ? { renamedGroup: { kind: "safari-native-title", title: newTitle, windowIdentifier: "native-window" } } : {}) };
  } };
  const management = createManagement(api, companion);
  const session = { async requireOwnedTab(id) { if (!owned.has(id)) throw new Error("Tab must be claimed"); } };
  const metadata = { session_id: "session", turn_id: "turn" };
  const authorize = async () => { if (!active) throw new Error("Sidebar owner changed"); };
  const call = (namespace, method, ...args) => management.execute({ type: "browser_management_call", namespace, method, args }, session, metadata, owner, authorize);
  return { call, native, changes, owned, groups, tabs, companion, deactivate() { active = false; },
    audit: () => management.execute({ type: "browser_management_get_audit_trail" }, session, metadata, owner, authorize) };
}
test("native Safari groups use observed identities for requested nonowner tabs, rename and ungroup", async () => {
  const f = fixture();
  const { value: group } = await f.call("tabs", "group", { tabIds: [10, 11] });
  assert.equal(f.native[0].arguments.handle, "live:profile:10");
  assert.equal(f.native[1].arguments.handle, "live:profile:11");
  assert.deepEqual(f.native.map(item => item.arguments.operation), ["createGroup", "moveToGroup"]);
  const { value: renamed } = await f.call("tabGroups", "update", group, { title: "Research" });
  assert.equal(renamed.title, "Research");
  assert.equal(renamed.nativeIdentity.windowIdentifier, "native-window");
  assert.equal(f.native.at(-1).arguments.handle, "live:profile:12", "session-created group renames use the visible source owner");
  assert.equal("color" in renamed, false); assert.equal("collapsed" in renamed, false);
  await f.call("tabs", "ungroup", [11]);
  assert.equal(f.native.at(-1).arguments.operation, "moveToUngrouped");
  assert.equal((await f.audit()).changes.length, 3);
});
test("a group batch containing the sidebar owner fails before any native mutation", async () => {
  const f = fixture();
  await assert.rejects(f.call("tabs", "group", { tabIds: [10, 12] }), /active sidebar tab/);
  await assert.rejects(f.call("tabs", "ungroup", [10, 12]), /active sidebar tab/);
  assert.equal(f.native.length, 0);
});
test("native failure messages retain only fixed diagnostics across the upstream kernel boundary", async () => {
  const f = fixture();
  const data = { stage: "sidebar_layout_confirmation", requestedVisible: false, sidebarHit: true,
    pickerHit: false, nativeMenuFocused: true, sidebarToggleHitCount: 1, mutationApplied: true,
    doNotReplay: true, nativeSidebarRestoration: "restored", url: "https://private.example/secret", token: "private-token" };
  let calls = 0;
  f.companion.runAgentCommand = async () => {
    calls += 1;
    throw Object.assign(new Error("Native layout was not confirmed."), { code: "GROUP_UI_UNAVAILABLE", data });
  };
  await assert.rejects(f.call("tabs", "group", { tabIds: [10, 11] }), error => {
    assert.equal(error.code, "GROUP_UI_UNAVAILABLE");
    assert.equal(error.data, data);
    assert.match(error.message, /"stage":"sidebar_layout_confirmation"/);
    assert.match(error.message, /"mutationApplied":true/);
    assert.match(error.message, /"doNotReplay":true/);
    assert.equal(error.message.includes("private.example"), false);
    assert.equal(error.message.includes("private-token"), false);
    return true;
  });
  assert.equal(calls, 1);
});
test("a single claimed batch resolves Safari's observed source-tab rekey without granting a later lease", async () => {
  const f = fixture(), run = f.companion.runAgentCommand;
  f.companion.runAgentCommand = async command => {
    const result = await run(command);
    if (command.arguments.operation === "createGroup") f.tabs[1].id = 111;
    return result;
  };
  await f.call("tabs", "group", { tabIds: [10, 11] });
  assert.equal(f.native[1].arguments.handle, "live:profile:111");
  await assert.rejects(f.call("tabs", "update", 111, { pinned: true }), /claimed/);
});
test("an ambiguous rekey fails after creation without repeating the delivered mutation", async () => {
  const f = fixture(), run = f.companion.runAgentCommand;
  f.tabs.push({ ...f.tabs[1], id: 13 });
  f.companion.runAgentCommand = async command => {
    const result = await run(command);
    if (command.arguments.operation === "createGroup") f.tabs[1].id = 111;
    return result;
  };
  await assert.rejects(f.call("tabs", "group", { tabIds: [10, 11] }), /unambiguous restored source/);
  assert.equal(f.native.length, 1);
});
test("observing an existing hidden group does not grant rename authority", async () => {
  const f = fixture();
  f.groups.add("Existing");
  const { value: groups } = await f.call("tabGroups", "query", {});
  await assert.rejects(f.call("tabGroups", "update", groups[0].id, { title: "Changed" }), /Claim a currently visible tab/);
  assert.equal(f.native.some(command => command.arguments.operation === "renameGroup"), false);
});
test("a rename's native identity must match before publishing the new name", async () => {
  const f = fixture(), run = f.companion.runAgentCommand;
  const { value: group } = await f.call("tabs", "group", { tabIds: [10] });
  f.companion.runAgentCommand = async command => {
    const result = await run(command);
    if (command.arguments.operation === "renameGroup") {
      result.renamedGroup.windowIdentifier = "another-window";
      result.mutationApplied = true;
    }
    return result;
  };
  await assert.rejects(f.call("tabGroups", "update", group, { title: "Changed" }), error =>
    error.doNotReplay === true && error.mutationApplied === true && /did not confirm/.test(error.message));
  assert.equal(f.native.filter(command => command.arguments.operation === "renameGroup").length, 1);
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
