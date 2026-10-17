const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagement } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/management-background.js");
function fixture() {
  const tabs = [{ id: 10, windowId: 20, index: 0, url: "https://example.com/one", title: "One" },
    { id: 11, windowId: 20, index: 1, url: "https://example.com/other", title: "Other" },
    { id: 12, windowId: 20, index: 2, url: "https://example.com/owner", title: "Owner" }];
  const owned = new Set([10, 11, 12]), native = [], changes = [], creations = [];
  const groups = new Set(), owner = { instanceId: "owner", profileId: "profile", accountScope: "account-a", tabId: 12, windowId: 20 };
  const windows = new Map([[20, { id: 20, type: "normal", incognito: false, focused: true, left: 0, top: 0, width: 1200, height: 800, state: "normal" }]]);
  const stored = {};
  let active = true, selected = null;
  const api = { tabs: { get: async id => {
    const found = tabs.find(item => item.id === id);
    if (!found) throw new Error("Tab not found");
    return { ...found };
  }, query: async query => tabs.filter(item => query?.windowId === undefined || item.windowId === query.windowId).map(item => ({ ...item })),
    update: async (...args) => { changes.push(args); return tabs[0]; }, move: async (...args) => { changes.push(args); return tabs; },
    remove: async (...args) => changes.push(args) }, windows: {
      get: async id => { const found = windows.get(id); if (!found) throw new Error("Window not found"); return { ...found }; },
      getAll: async () => [...windows.values()].map(item => ({ ...item })),
      create: async options => {
        creations.push(options);
        const id = 50 + creations.length;
        const created = { id, type: "normal", incognito: false, focused: options.focused ?? true, state: options.state ?? "normal" };
        windows.set(id, created);
        if (options.tabId !== undefined) {
          const tab = tabs.find(item => item.id === options.tabId), source = tab.windowId;
          tab.windowId = id; tab.index = 0;
          if (!tabs.some(item => item.windowId === source)) windows.delete(source);
        } else tabs.push({ id: 100 + creations.length, windowId: id, index: 0, url: "about:blank", title: "" });
        return { ...created };
      },
    }, storage: { session: {
      get: async key => JSON.parse(JSON.stringify({ [key]: stored[key] })),
      set: async value => Object.assign(stored, JSON.parse(JSON.stringify(value))),
    } } };
  const companion = { async runAgentCommand(command) {
    native.push(command);
    const { operation, groupTitle, newTitle, handle } = command.arguments;
    if (operation === "inspectWindowSource") return { action: operation, mutationApplied: false, actionsPerformed: 0,
      currentGroupTitle: null, currentGroupSharingState: "unshared", windowIdentifier: "native-window",
      sourceCollection: { kind: "ungrouped", sharingState: "unshared", nativeWindowIdentifier: "native-window" } };
    if (operation === "createGroup" || operation === "moveToGroup") { groups.add(groupTitle); selected = groupTitle; }
    if (operation === "renameGroup") { groups.delete(groupTitle); groups.add(newTitle); }
    if (operation === "moveToUngrouped") selected = null;
    return { action: operation, mutationApplied: operation !== "inspect",
      sourceCollection: { title: "Source", nativeWindowIdentifier: "native-window", restored: true },
      groupTitles: [...groups], currentGroupTitle: selected, windowIdentifier: "native-window",
      ...(operation === "renameGroup" ? { renamedGroup: { kind: "safari-native-title", title: newTitle, windowIdentifier: "native-window" } } : {}) };
  } };
  const bookmarkCalls = [];
  const bookmarkNode = { id: "bookmark-one", parentId: "folder-one", index: 0, title: "One", url: "https://example.test/one" };
  const personalData = { async bookmarks(method, args, expectedOwner) {
    bookmarkCalls.push({ method, args, owner: { ...expectedOwner } });
    if (method === "getTree") return [{ id: "root", title: "Safari Bookmarks", children: [{ ...bookmarkNode }] }];
    if (method === "get") return [{ ...bookmarkNode }];
    if (method === "move") return Object.assign(bookmarkNode, { parentId: args[1].parentId });
    if (method === "update") return Object.assign(bookmarkNode, args[1]);
    if (method === "create") return { id: "new-bookmark", ...args[0] };
    if (["remove", "removeTree"].includes(method)) return null;
    if (method === "createFolder") return { id: "new-folder", title: args[0].title, parentId: args[0].parentId ?? "root" };
    return [{ ...bookmarkNode }];
  } };
  const management = createManagement(api, companion, personalData);
  const session = { async requireOwnedTab(id) { if (!owned.has(id)) throw new Error("Tab must be claimed"); } };
  const metadata = { session_id: "session", turn_id: "turn" };
  const authorize = async () => { if (!active) throw new Error("Sidebar owner changed"); return { ...owner }; };
  const call = (namespace, method, ...args) => management.execute({ type: "browser_management_call", namespace, method, args }, session, metadata, owner, authorize);
  return { call, native, changes, owned, groups, tabs, companion, api, windows, creations, owner, stored, management, session, metadata, authorize, bookmarkCalls, bookmarkNode, personalData, deactivate() { active = false; },
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
  await assert.rejects(f.call("bookmarks", "move", "bookmark-one", { parentId: "folder-one", index: 0 }), /unsupported/);
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
test("blank windows use the real Safari creation API and record the prior window layout", async () => {
  const f = fixture();
  const { value } = await f.call("windows", "create");
  assert.equal(value.id, 51);
  assert.deepEqual(f.creations, [{ type: "normal" }]);
  assert.equal(f.native.length, 0);
  assert.equal(f.tabs.find(item => item.windowId === value.id).url, "about:blank");
  const { changes } = await f.audit();
  assert.equal(changes[0].result, value.id);
  assert.deepEqual(changes[0].before.windows, [{ id: 20, focused: true, left: 0, top: 0, width: 1200, height: 800, state: "normal" }]);
  assert.deepEqual(changes[0].args, []);
});
test("window creation moves only its exact claimed unpinned nonowner tab", async () => {
  const f = fixture(), before = f.tabs.map(item => ({ ...item }));
  const { value } = await f.call("windows", "create", { tabId: 10, focused: false });
  assert.deepEqual(f.creations, [{ tabId: 10, focused: false, type: "normal" }]);
  assert.equal(value.focused, false);
  assert.deepEqual(f.native.map(command => command.arguments.operation), ["inspectWindowSource"],
    "an ungrouped source must not open the native group-inventory menu");
  assert.equal(f.tabs[0].id, before[0].id);
  assert.equal(f.tabs[0].url, before[0].url);
  assert.equal(f.tabs[0].windowId, value.id);
  assert.deepEqual(f.tabs.slice(1), before.slice(1));
  assert.equal((await f.audit()).changes[0].result, value.id);
});
test("moving the last claimed tab allows Safari to close its now-empty source window", async () => {
  const f = fixture();
  f.tabs[0].windowId = 30;
  f.windows.set(30, { id: 30, type: "normal", incognito: false, focused: false });
  const { value } = await f.call("windows", "create", { tabId: 10 });
  assert.equal(f.windows.has(30), false);
  assert.equal(f.tabs[0].windowId, value.id);
  assert.equal(f.tabs.find(item => item.id === f.owner.tabId).windowId, 20);
});
test("window creation rejects unsafe arguments, claims, owners, pinning and unverifiable groups before delivery", async () => {
  const f = fixture();
  await assert.rejects(f.call("windows", "create", { url: "https://example.com" }), /unsupported/);
  await assert.rejects(f.call("windows", "create", { incognito: true }), /unsupported/);
  await assert.rejects(f.call("windows", "create", { type: "popup" }), /normal/);
  await assert.rejects(f.call("windows", "create", {}, {}), /at most one/);
  await assert.rejects(f.call("windows", "create", { width: 0 }), /positive dimensions/);
  await assert.rejects(f.call("windows", "create", { state: "fullscreen", width: 800 }), /state normal/);
  await assert.rejects(f.call("windows", "create", { tabId: 12 }), /active sidebar tab/);
  f.owned.delete(10);
  await assert.rejects(f.call("windows", "create", { tabId: 10 }), /claimed/);
  f.owned.add(10); f.tabs[0].pinned = true;
  await assert.rejects(f.call("windows", "create", { tabId: 10 }), /pinned tab/);
  f.tabs[0].pinned = false; f.tabs[0].incognito = true;
  await assert.rejects(f.call("windows", "create", { tabId: 10 }), /ordinary/);
  f.tabs[0].incognito = false;
  const run = f.companion.runAgentCommand;
  f.companion.runAgentCommand = async command => ({ ...await run(command), currentGroupTitle: "Unverified sharing" });
  await assert.rejects(f.call("windows", "create", { tabId: 10 }), /unshared/);
  assert.equal(f.creations.length, 0);
  assert.equal((await f.audit()).changes.length, 0);
});
test("window transfer requires an exact ungrouped native source proof without group inventory", async () => {
  for (const alter of [
    result => ({ ...result, sourceCollection: undefined }),
    result => ({ ...result, currentGroupSharingState: "unknown" }),
    result => ({ ...result, windowIdentifier: "" }),
    result => ({ ...result, sourceCollection: { ...result.sourceCollection, nativeWindowIdentifier: "another-window" } }),
    result => ({ ...result, sourceCollection: { ...result.sourceCollection, sharingState: "unknown" } }),
    result => ({ ...result, sourceCollection: { ...result.sourceCollection, kind: "named-tab-group" } }),
  ]) {
    const f = fixture(), run = f.companion.runAgentCommand;
    f.companion.runAgentCommand = async command => {
      assert.equal(command.arguments.operation, "inspectWindowSource");
      return alter(await run(command));
    };
    await assert.rejects(f.call("windows", "create", { tabId: 10 }), /unshared/);
    assert.equal(f.creations.length, 0);
    assert.equal((await f.audit()).changes.length, 0);
  }
});
test("window creation cannot invent success when the Safari API is missing or rejects", async () => {
  const unavailable = fixture();
  delete unavailable.api.windows.create;
  await assert.rejects(unavailable.call("windows", "create"), /does not expose native windows.create/);
  const failed = fixture();
  let calls = 0;
  failed.api.windows.create = async () => { calls++; throw new Error("Safari rejected creation"); };
  await assert.rejects(failed.call("windows", "create"), error => error.doNotReplay === true && /delivered once/.test(error.message));
  assert.equal(calls, 1);
  assert.equal((await failed.audit()).changes.length, 0);
});
test("an owner change or unrelated tab transfer after window delivery reports uncertainty without replay", async () => {
  const movedOther = fixture(), create = movedOther.api.windows.create;
  movedOther.api.windows.create = async options => {
    const result = await create(options);
    movedOther.tabs[1].windowId = result.id;
    return result;
  };
  await assert.rejects(movedOther.call("windows", "create", { tabId: 10 }), error =>
    error.doNotReplay === true && /unrelated original tabs/.test(error.message));
  assert.equal(movedOther.creations.length, 1);
  assert.equal((await movedOther.audit()).changes.length, 0);
  const reordered = fixture(), createBeforeReorder = reordered.api.windows.create;
  reordered.api.windows.create = async options => {
    const result = await createBeforeReorder(options);
    reordered.tabs[1].index = 3;
    return result;
  };
  await assert.rejects(reordered.call("windows", "create", { tabId: 10 }), error =>
    error.doNotReplay === true && /original order/.test(error.message));
  assert.equal(reordered.creations.length, 1);
  const changedOwner = fixture(), createBeforeChange = changedOwner.api.windows.create;
  changedOwner.api.windows.create = async options => {
    const result = await createBeforeChange(options); changedOwner.deactivate(); return result;
  };
  await assert.rejects(changedOwner.call("windows", "create"), error =>
    error.doNotReplay === true && /owner changed/.test(error.message));
  assert.equal(changedOwner.creations.length, 1);
});
test("management audit survives task release and controller recreation in the same browser session", async () => {
  const f = fixture();
  await f.call("tabs", "update", 10, { pinned: true });
  f.management.release(f.metadata.session_id);
  f.metadata.session_id = "another-task";
  await f.call("windows", "create", { focused: false });
  const restored = createManagement(f.api, f.companion);
  const result = await restored.execute({ type: "browser_management_get_audit_trail" }, f.session,
    { session_id: "restored-task", turn_id: "restored-turn" }, f.owner, f.authorize);
  assert.deepEqual(result.changes.map(item => item.method), ["create", "update"]);
  assert.equal(result.changes[0].result, 51);
  assert.equal(JSON.stringify(f.stored).includes("example.com"), false, "audit persists no page URLs or content");
  assert.equal(JSON.stringify(result).includes("account-a"), false, "internal account scopes are not query results");
});
test("management audit is isolated by verified account and Safari profile", async () => {
  const f = fixture();
  await f.call("tabs", "update", 10, { pinned: true });
  f.owner.accountScope = "account-b";
  assert.deepEqual((await f.audit()).changes, []);
  await f.call("tabs", "move", [10], { index: -1 });
  assert.deepEqual((await f.audit()).changes.map(item => item.method), ["move"]);
  f.owner.accountScope = "account-a";
  assert.deepEqual((await f.audit()).changes.map(item => item.method), ["update"]);
  f.owner.profileId = "another-profile";
  assert.deepEqual((await f.audit()).changes, []);
});
test("management audit preserves the original 50-entry and 72-hour session limits", async () => {
  const f = fixture();
  for (let index = 0; index < 51; index++) await f.call("tabs", "update", 10, { pinned: index % 2 === 0 });
  assert.equal((await f.audit()).changes.length, 50);
  const key = "safariManagementAuditTrail";
  f.stored[key][0].change.createdAt = Date.now() - 72 * 60 * 60 * 1000 - 1000;
  assert.equal((await f.audit()).changes.length, 49);
  assert.equal((await f.audit()).changes[0].args[1].pinned, true, "newest completed mutation comes first");
});
test("a missing audit scope or storage cannot leak another account or replay a completed mutation", async () => {
  const f = fixture();
  await f.call("tabs", "update", 10, { pinned: true });
  delete f.owner.accountScope;
  await assert.rejects(f.audit(), /verified ChatGPT account scope is unavailable/);
  f.owner.accountScope = "account-a";
  f.api.storage.session.get = async () => { throw new Error("Session storage unavailable"); };
  await f.call("tabs", "update", 11, { pinned: true });
  assert.equal(f.changes.length, 2, "storage failure does not replay or fail a completed change");
  await assert.rejects(f.audit(), /Session storage unavailable/);
});
test("an account change during a management command stops it without recording cross-account history", async () => {
  const f = fixture(), create = f.api.windows.create;
  f.api.windows.create = async options => {
    const result = await create(options); f.owner.accountScope = "account-b"; return result;
  };
  await assert.rejects(f.call("windows", "create"), error => error.doNotReplay === true && /account changed/.test(error.message));
  assert.equal(f.creations.length, 1);
  assert.deepEqual((await f.audit()).changes, []);
});

test("bookmark management delegates genuine native reads without claiming unrelated tabs", async () => {
  const f = fixture(); f.owned.clear();
  assert.equal((await f.call("bookmarks", "getTree")).value[0].id, "root");
  await f.call("bookmarks", "search", { query: "One" });
  await f.call("bookmarks", "get", ["bookmark-one"]);
  await f.call("bookmarks", "getChildren", "folder-one");
  await f.call("bookmarks", "getSubTree", "folder-one");
  assert.deepEqual(f.bookmarkCalls.map(call => call.method), ["getTree", "search", "get", "getChildren", "getSubTree"]);
  assert.equal(f.bookmarkCalls.every(call => call.owner.instanceId === "owner" && call.owner.accountScope === "account-a"), true);
  assert.deepEqual(f.native, []); assert.deepEqual(f.changes, []); assert.equal((await f.audit()).changes.length, 0);
});

test("bookmark rename and folder creation retain original node snapshots and string results in the audit", async () => {
  const f = fixture(), before = { ...f.bookmarkNode };
  const updated = (await f.call("bookmarks", "update", "bookmark-one", { title: "Changed" })).value;
  assert.equal(updated.title, "Changed");
  const folder = (await f.call("bookmarks", "create", { title: "Research", parentId: "folder-one" })).value;
  assert.equal(folder.id, "new-folder");
  assert.deepEqual(f.bookmarkCalls.map(call => call.method), ["get", "update", "createFolder"]);
  const { changes } = await f.audit();
  assert.deepEqual(changes[0].result, { id: "new-folder" }); assert.deepEqual(changes[0].before, {});
  assert.deepEqual(changes[1].before, { bookmarks: [before] }); assert.deepEqual(changes[1].result, { id: "bookmark-one" });
});

test("unsupported bookmark insertion indices, unsafe URLs and malformed arguments stop before the native editor", async () => {
  const f = fixture();
  for (const [method, args] of [["create", [{ title: "Link", url: "javascript:alert(1)" }]],
    ["move", ["bookmark-one", { parentId: "folder-one", index: 0 }]], ["remove", []], ["removeTree", []],
    ["getTree", [{}]], ["get", [[]]], ["search", [{ unknown: "x" }]], ["search", [{ title: 2 }]],
    ["update", ["bookmark-one", { title: 1 }]], ["create", [{ title: "" }]]]) {
    await assert.rejects(f.call("bookmarks", method, ...args));
  }
  assert.equal(f.bookmarkCalls.length, 0); assert.equal((await f.audit()).changes.length, 0);
});

test("bookmark URL creation and explicit deletion delegate once and preserve original audit snapshots", async () => {
  const f = fixture();
  const created = (await f.call("bookmarks", "create", { title: "Synthetic", parentId: "folder-one", url: "https://example.test/new" })).value;
  assert.equal(created.id, "new-bookmark");
  const previous = { ...f.bookmarkNode };
  assert.equal((await f.call("bookmarks", "remove", "bookmark-one")).value, null);
  assert.equal((await f.call("bookmarks", "removeTree", "bookmark-one")).value, null);
  assert.deepEqual(f.bookmarkCalls.map(call => call.method), ["create", "get", "remove", "get", "removeTree"]);
  const { changes } = await f.audit();
  assert.deepEqual(changes.map(change => change.method), ["removeTree", "remove", "create"]);
  assert.deepEqual(changes[0].before, { bookmarks: [previous] });
  assert.deepEqual(changes[2].result, { id: "new-bookmark" });
  for (const url of ["file:///tmp/bookmark", "https://user:secret@example.test/", 2]) await assert.rejects(f.call("bookmarks", "create", { url }), /HTTP or HTTPS/);
  assert.equal(f.bookmarkCalls.length, 5);
});

test("bookmark folder moves retain the real prior node and actual returned parent in the audit", async () => {
  const f = fixture(), before = { ...f.bookmarkNode };
  const moved = (await f.call("bookmarks", "move", "bookmark-one", { parentId: "owned-destination" })).value;
  assert.equal(moved.parentId, "owned-destination");
  assert.deepEqual(f.bookmarkCalls.map(call => call.method), ["get", "move"]);
  const { changes } = await f.audit();
  assert.deepEqual(changes[0].before, { bookmarks: [before] });
  assert.deepEqual(changes[0].result, { id: "bookmark-one" });
  for (const properties of [{}, { index: 0 }, { parentId: "folder", index: 1 }, { parentId: 2 }]) await assert.rejects(f.call("bookmarks", "move", "bookmark-one", properties));
  assert.equal(f.bookmarkCalls.length, 2);
});
