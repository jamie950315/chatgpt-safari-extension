const test = require("node:test");
const assert = require("node:assert/strict");
const { createPersonalData } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/personal-data-background.js");

function fixture() {
  const owner = { instanceId: "synthetic-owner", profileId: "synthetic-profile" };
  const calls = [];
  let response = { ok: true, result: [{ url: "https://example.test/", title: "Synthetic", dateVisited: "2026-10-17T00:00:00.000Z" }] };
  const api = { runtime: { async sendNativeMessage(_, message) { calls.push(message); return typeof response === "function" ? response() : response; } } };
  const data = createPersonalData(api, { async agentOwner() { return { ...owner }; } });
  return { data, owner, calls, setResponse(value) { response = value; } };
}

test("the original history request forwards only normalized query fields and the real companion owner", async () => {
  const f = fixture();
  const result = await f.data.history({ browser_id: "original-browser", session_id: "original-session", queries: ["Research"], limit: 2, from: "2026-10-01", to: "2026-10-17T12:00:00+08:00" });
  assert.equal(result[0].title, "Synthetic");
  assert.deepEqual(f.calls[0].command, { action: "personalData", ownerToken: "synthetic-owner", profileId: "synthetic-profile",
    command: { action: "history", profileId: "synthetic-profile", arguments: { queries: ["Research"], limit: 2,
      from: "2026-10-01T00:00:00.000Z", to: "2026-10-17T04:00:00.000Z" } } });
  for (const request of [{ limit: 0 }, { queries: [] }, { queries: [1] }, { from: "invalid" }]) await assert.rejects(f.data.history(request));
  assert.equal(f.calls.length, 1);
});

test("native permission errors and profile changes are explicit, not empty history successes", async () => {
  const f = fixture();
  f.setResponse({ ok: false, error: { code: "HISTORY_ACCESS_DENIED", message: "macOS denied access to Safari history" } });
  await assert.rejects(f.data.history({}), { code: "HISTORY_ACCESS_DENIED" });
  f.setResponse(() => { f.owner.profileId = "replacement-profile"; return { ok: true, result: [] }; });
  await assert.rejects(f.data.history({}), /owner changed/);
});

function bookmarkFixture(lateSidebar = false) {
  const owner = { instanceId: "synthetic-owner", profileId: "synthetic-profile", accountScope: "account-a", tabId: 1, windowId: 10 };
  const url = "http://chatgpt-utility-11111111-1111-4111-8111-111111111111.localhost:1234/bookmarks/22222222-2222-4222-8222-222222222222";
  const tabs = [{ id: 1, windowId: 10, url: "https://example.test/original", active: true, status: "complete" }];
  const windows = new Map([[10, { id: 10, type: "normal", focused: true, left: 1, top: 2, width: 1000, height: 800 }]]);
  const events = [], calls = [], removed = [], updates = new Set();
  let response = { ok: true, result: [{ id: "bookmark-root", title: "Safari Bookmarks", children: [] }] };
  let createdId = 20, afterNative, afterCreate, duringSelect, restore = true;
  const api = { runtime: { async sendNativeMessage(_, value) {
    const command = value.command.command;
    calls.push(value);
    if (command.action === "utilityEntry") return { ok: true, result: { url } };
    events.push("native");
    tabs.find(tab => tab.id === 2).url = "bookmarks://";
    afterNative?.();
    return response;
  } }, windows: {
    async getAll() { return [...windows.values()].map(value => ({ ...value })); },
    async create(options) {
      events.push(["create", options]);
      if (createdId !== 10) {
        windows.set(createdId, { id: createdId, type: "normal", focused: false, left: 100, top: 120, width: 900, height: 700 });
        tabs.push({ id: 2, windowId: createdId, url, active: true, status: "complete" });
      }
      afterCreate?.();
      return { id: createdId };
    },
    async get(id) { if (!windows.has(id)) throw new Error("Unknown window"); return { ...windows.get(id) }; },
    async remove(id) { events.push("remove"); removed.push(id); windows.delete(id); },
  }, tabs: {
    async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error("Unknown tab"); return { ...tab }; },
    async query(query) { return tabs.filter(tab => tab.windowId === query.windowId).map(value => ({ ...value })); },
    onUpdated: { addListener(listener) { updates.add(listener); }, removeListener(listener) { updates.delete(listener); } },
  } };
  const sidebar = { async withAgentSelection(token, tab, operation) {
    assert.equal(token, owner.instanceId); assert.equal(tab.id, 2);
    const result = await operation({
      async select(target) {
        events.push("select");
        for (const window of windows.values()) window.focused = window.id === target.windowId;
        duringSelect?.();
      },
      assertCurrent() { if (!restore) throw new Error("Safari selection changed"); },
    });
    if (restore) {
      events.push("restore");
      for (const window of windows.values()) window.focused = window.id === 10;
    }
    return result;
  } };
  const data = createPersonalData(api, { async agentOwner() { return { ...owner }; } }, lateSidebar ? undefined : sidebar);
  if (lateSidebar) globalThis.ChatGPTSafariSidebar = sidebar;
  return { data, owner, url, calls, events, tabs, windows, removed, updates, api,
    response(value) { response = value; }, createdId(value) { createdId = value; }, afterNative(value) { afterNative = value; },
    afterCreate(value) { afterCreate = value; }, duringSelect(value) { duringSelect = value; }, manualFocus() { restore = false; } };
}

test("native bookmarks use a fresh ordinary window, exact bounds, selection restoration and own-window cleanup", async () => {
  const f = bookmarkFixture();
  assert.equal((await f.data.getBookmarks())[0].id, "bookmark-root");
  assert.deepEqual(f.events, [["create", { url: f.url, focused: false, type: "normal" }], "select", "native", "restore", "remove"]);
  assert.deepEqual(f.calls[1].command, { action: "personalData", ownerToken: f.owner.instanceId, profileId: f.owner.profileId,
    command: { action: "bookmarks", expectedUrl: f.url, profileId: f.owner.profileId, method: "getTree", arguments: [],
      windowBounds: { left: 100, top: 120, width: 900, height: 700 } } });
  assert.deepEqual(f.removed, [20]); assert.equal(f.windows.has(10), true);
  assert.equal(f.tabs[0].url, "https://example.test/original"); assert.equal(f.updates.size, 0);
});

test("bookmark calls resolve the sidebar installed later in the production background order", async () => {
  const previous = globalThis.ChatGPTSafariSidebar;
  delete globalThis.ChatGPTSafariSidebar;
  try {
    const f = bookmarkFixture(true);
    assert.equal((await f.data.getBookmarks())[0].id, "bookmark-root");
    assert.deepEqual(f.removed, [20]);
  } finally {
    if (previous === undefined) delete globalThis.ChatGPTSafariSidebar;
    else globalThis.ChatGPTSafariSidebar = previous;
  }
});

test("native bookmark failures restore before reporting and never replay delivered mutations", async () => {
  const f = bookmarkFixture();
  f.response({ ok: false, error: { code: "BOOKMARK_UPDATE_UNCONFIRMED", message: "Native update unconfirmed", data: { mutationApplied: true, doNotReplay: true } } });
  await assert.rejects(f.data.bookmarks("update", ["bookmark-one", { title: "Changed" }]), error => {
    assert.equal(error.code, "BOOKMARK_UPDATE_UNCONFIRMED"); assert.equal(error.mutationApplied, true); assert.equal(error.doNotReplay, true);
    return true;
  });
  assert.deepEqual(f.events.slice(2), ["native", "restore", "remove"]);
  assert.equal(f.calls.filter(call => call.command.command.action === "bookmarks").length, 1);
});

test("the actual bookmark caller keeps bounded native wait evidence in the original kernel message without private data", async () => {
  const f = bookmarkFixture();
  f.response({ ok: false, error: { code: "BOOKMARK_OPERATION_UNCONFIRMED", message: "Native field wait unconfirmed", data: {
    stage: "url_focus", guardStage: "none", waitMS: 2048, queueWaitMS: 3, elapsedMS: 6721, expansionMS: 1800, inventoryMS: 1420,
    focusedElementMatches: false, fieldFocused: true, valueMatches: false, mutationApplied: false, doNotReplay: false,
    title: "Private title must not cross the message boundary", url: "https://private.test/secret", inventory: ["Private folder"],
  } } });
  await assert.rejects(f.data.bookmarks("update", ["bookmark-one", { url: "https://example.test/changed" }]), error => {
    assert.match(error.message, /Native bookmark result: /);
    const safe = JSON.parse(error.message.match(/Native bookmark result: (\{[^}]+\})\./)[1]);
    assert.deepEqual(safe, { code: "BOOKMARK_OPERATION_UNCONFIRMED", stage: "url_focus", guardStage: "none",
      waitMS: 2048, queueWaitMS: 3, elapsedMS: 6721, expansionMS: 1800, inventoryMS: 1420,
      focusedElementMatches: false, fieldFocused: true, valueMatches: false, mutationApplied: false, doNotReplay: false });
    assert.equal(/Private|private\.test/.test(error.message), false);
    assert.equal(error.doNotReplay, true, "A delivered mutation request is never replayed even if the field value was not yet changed");
    return true;
  });
  assert.equal(f.calls.filter(call => call.command.command.action === "bookmarks").length, 1);
  assert.deepEqual(f.events.slice(-2), ["restore", "remove"]);

  const invalid = bookmarkFixture();
  invalid.response({ ok: false, error: { code: "PRIVATE_CODE", message: "Native wait unconfirmed", data: {
    stage: "Private folder", guardStage: "Private URL", waitMS: "Private value", queueWaitMS: -1, elapsedMS: 1_000_000_001,
    expansionMS: NaN, inventoryMS: 1.25, focusedElementMatches: "Private text", fieldFocused: 1,
  } } });
  await assert.rejects(invalid.data.bookmarks("update", ["bookmark-one", { title: "Changed" }]), error => {
    assert.equal(error.message.includes("Native bookmark result:"), false);
    assert.equal(error.message.includes("Private"), false);
    return true;
  });
});

test("manual focus change leaves the utility window and never forces owner restoration", async () => {
  const f = bookmarkFixture();
  f.duringSelect(() => f.manualFocus());
  await assert.rejects(f.data.getBookmarks(), /selection changed/);
  assert.equal(f.events.includes("restore"), false); assert.deepEqual(f.removed, []);
  assert.equal(f.calls.filter(call => call.command.command.action === "bookmarks").length, 0);
});

test("a user-added tab, manual navigation, or account change prevents utility cleanup", async () => {
  for (const change of [f => f.tabs.push({ id: 3, windowId: 20, url: "https://example.test/user" }),
    f => { f.tabs.find(tab => tab.id === 2).url = "https://example.test/user"; },
    f => { f.owner.accountScope = "account-b"; }]) {
    const f = bookmarkFixture(); f.afterNative(() => change(f));
    if (change.toString().includes("accountScope")) await assert.rejects(f.data.getBookmarks(), /owner changed/);
    else await f.data.getBookmarks();
    assert.deepEqual(f.removed, []); assert.equal(f.windows.has(10), true);
  }
});

test("mismatched creation cannot grant cleanup authority over an existing window", async () => {
  const f = bookmarkFixture(); f.createdId(10);
  await assert.rejects(f.data.getBookmarks(), error => error.doNotReplay === true && /newly created/.test(error.message));
  assert.deepEqual(f.removed, []); assert.equal(f.windows.has(10), true);
  assert.equal(f.events.includes("select"), false);
});

test("bookmark expected owners and unsupported methods fail without opening a window", async () => {
  const f = bookmarkFixture();
  await assert.rejects(f.data.bookmarks("getTree", [], { ...f.owner, accountScope: "account-b" }), /owner changed/);
  for (const method of ["unknown"]) await assert.rejects(f.data.bookmarks(method), /unsupported/);
  assert.equal(f.events.length, 0);
});

test("temporary utility loading observes completion without navigating again", async () => {
  const f = bookmarkFixture();
  f.afterCreate(() => {
    f.tabs[1].status = "loading";
    setImmediate(() => {
      for (const listener of f.updates) listener(2, { title: "Loading" });
      setImmediate(() => {
        f.tabs[1].status = "complete";
        for (const listener of f.updates) listener(2, { status: "complete" });
      });
    });
  });
  await f.data.getBookmarks();
  assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === "create").length, 1);
  assert.equal(f.updates.size, 0);
});

test("URL creation and bookmark deletions use the same one-shot native owner transaction", async () => {
  for (const [method, args] of [["create", [{ title: "Synthetic", parentId: "folder-synthetic", url: "https://example.test/bookmarked-only" }]],
    ["remove", ["owned-synthetic-bookmark"]], ["removeTree", ["owned-synthetic-folder"]], ["move", ["owned-synthetic-bookmark", { parentId: "owned-synthetic-folder" }]]]) {
    const f = bookmarkFixture();
    f.response({ ok: false, error: { code: "BOOKMARK_OPERATION_UNCONFIRMED", message: "Native result unconfirmed", data: { mutationApplied: true } } });
    await assert.rejects(f.data.bookmarks(method, args), error => error.doNotReplay === true && error.mutationApplied === true);
    const native = f.calls.filter(call => call.command.command.action === "bookmarks");
    assert.equal(native.length, 1); assert.equal(native[0].command.command.method, method);
    assert.deepEqual(native[0].command.command.arguments, args);
    assert.deepEqual(f.events.slice(-2), ["restore", "remove"]);
  }
});

test("Safari create acknowledgement can precede about:blank, pending navigation and exact utility commit", async () => {
  for (const initialURL of ["about:blank", "", undefined]) {
    const f = bookmarkFixture();
    f.afterCreate(() => {
      Object.assign(f.tabs[1], { url: initialURL, status: "loading" });
      setImmediate(() => {
        assert.equal(f.events.includes("select"), false); assert.equal(f.events.includes("native"), false);
        f.tabs[1].pendingUrl = f.url;
        for (const listener of f.updates) listener(2, { status: "loading", pendingUrl: f.url });
        setImmediate(() => {
          assert.equal(f.events.includes("select"), false); assert.equal(f.events.includes("native"), false);
          f.tabs[1].url = f.url;
          for (const listener of f.updates) listener(2, { url: f.url, status: "loading" });
          setImmediate(() => {
            assert.equal(f.events.includes("select"), false);
            f.tabs[1].status = "complete"; delete f.tabs[1].pendingUrl;
            for (const listener of f.updates) listener(2, { status: "complete" });
          });
        });
      });
    });
    await f.data.getBookmarks();
    assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === "create").length, 1);
    assert.equal(f.calls.filter(call => call.command.command.action === "bookmarks").length, 1);
    assert.deepEqual(f.removed, [20]); assert.equal(f.updates.size, 0);
  }
});

test("a foreign pending navigation or user URL invalidates the initial utility lease without native work or cleanup", async () => {
  for (const kind of ["pendingUrl", "url"]) {
    const f = bookmarkFixture();
    f.afterCreate(() => {
      Object.assign(f.tabs[1], { url: "about:blank", pendingUrl: f.url, status: "loading" });
      setImmediate(() => {
        f.tabs[1][kind] = "https://example.test/user-navigation";
        for (const listener of f.updates) listener(2, { [kind]: f.tabs[1][kind] });
        // A quick return cannot erase the observed foreign navigation.
        Object.assign(f.tabs[1], { url: f.url, pendingUrl: undefined, status: "complete" });
      });
    });
    await assert.rejects(f.data.getBookmarks(), /changed/);
    assert.equal(f.events.includes("select"), false); assert.equal(f.events.includes("native"), false);
    assert.deepEqual(f.removed, []); assert.equal(f.updates.size, 0);
  }
});

test("a tab changed after utility readiness cannot reach the native editor", async () => {
  const f = bookmarkFixture();
  f.duringSelect(() => { f.tabs[1].url = "https://example.test/user-after-ready"; });
  await assert.rejects(f.data.getBookmarks(), /changed before native/);
  assert.equal(f.events.includes("native"), false); assert.deepEqual(f.removed, []); assert.equal(f.updates.size, 0);
});
