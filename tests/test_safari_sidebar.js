const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const resources = path.join(__dirname, "../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari");
const { createSidebarAdapter, extensionOrigin, MESSAGE } = require(path.join(resources, "sidebar-adapter.js"));
const { createSidebarContent } = require(path.join(resources, "sidebar-content.js"));

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
    listeners,
  };
}

function fixture(options = {}) {
  const messages = [], scripts = [], rules = [], storage = {}, controllers = new Set();
  const selections = [];
  let focusedWindow = 3;
  if (options.savedState) storage.chatgptSafariSidebarStateV1 = structuredClone(options.savedState);
  const tabs = new Map([
    [11, { id: 11, windowId: 3, index: 0, title: "Owner", url: "https://example.com/", active: true }],
    [12, { id: 12, windowId: 3, index: 1, title: "Source sibling", url: "https://example.org/", active: false }],
  ]);
  const api = {
    runtime: {
      id: "test-extension",
      getURL: (resource) => "safari-web-extension://test-extension/" + resource.replace(/^\//, ""),
      onMessage: event(),
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error("Tab not found");
        return { ...tabs.get(tabId) };
      },
      async query(query) {
        return [...tabs.values()].filter((tab) => (!query.active || tab.active)
          && (query.windowId == null || tab.windowId === query.windowId));
      },
      async update(tabId, value) {
        const tab = tabs.get(tabId);
        if (value.active) {
          selections.push(tabId);
          for (const item of tabs.values()) if (item.windowId === tab.windowId) item.active = item.id === tabId;
          api.tabs.onActivated.emit({ tabId, windowId: tab.windowId });
        }
        return { ...tab };
      },
      async sendMessage() { assert.fail("Sidebar control must not use Safari tabs.sendMessage"); },
      onRemoved: event(),
      onActivated: event(),
      onUpdated: event(),
    },
    windows: {
      async get(windowId) { return { id: windowId, focused: focusedWindow === windowId }; },
      async update(windowId) { focusedWindow = windowId; api.windows.onFocusChanged.emit(windowId); },
      onFocusChanged: event(),
    },
    scripting: { async executeScript(args) {
      scripts.push(args);
      if (options.scriptFailure) throw new Error("Script rejected");
      if (args.files) { controllers.add(args.target.tabId); return [{ frameId: 0 }]; }
      if (args.func.name !== "callSidebarController") return [];
      if (options.noAcknowledgement) return [];
      if (!controllers.has(args.target.tabId)) return [{ frameId: 0, result: { ok: false, code: "SIDEBAR_CONTROLLER_MISSING" } }];
      const message = args.args[0], tabId = args.target.tabId;
      messages.push({ tabId, message, target: args.target });
      const mountFails = typeof options.mountFails === "function"
        ? options.mountFails(tabId, message) : options.mountFails;
      return [{ frameId: 0, result: mountFails && message.type === MESSAGE.mount
        ? { ok: false, error: "Mount rejected" } : { ok: true, instanceId: message.instanceId } }];
    } },
    declarativeNetRequest: { async updateSessionRules(args) { rules.push(args); } },
    action: { onClicked: event() },
  };
  if (options.browserActionOnly) { api.browserAction = api.action; delete api.action; }
  const adapter = createSidebarAdapter(api, { reportError: (error) => { throw error; }, ...options });
  function request(message, sender) {
    return new Promise((resolve) => {
      let handled = false;
      for (const listener of api.runtime.onMessage.listeners) {
        if (listener(message, sender, resolve)) handled = true;
      }
      if (!handled) resolve(undefined);
    });
  }
  return { api, adapter, messages, scripts, rules, tabs, storage, request, selections };
}

test("an original-agent batch selects its target and restores the genuine sidebar owner without remounting", async () => {
  const calls = [];
  const f = fixture({ companion: { embedded: true, onClosed: event(),
    async open(state) { calls.push(["open", state.tabId]); }, async close(state) { calls.push(["close", state.tabId]); } } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  const result = await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    selection.assertCurrent();
    assert.equal(f.tabs.get(12).active, true);
    assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 11);
    return "completed native input";
  });
  await f.adapter.sidePanel.getOptions();
  assert.equal(result, "completed native input");
  assert.deepEqual(f.selections, [12, 11]);
  assert.deepEqual(calls, [["open", 11]]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
  const message = { type: MESSAGE.authorize, tabId: 11, windowId: 3, instanceId: owner.instanceId };
  const sender = { id: f.api.runtime.id, url: owner.iframeUrl, tab: f.tabs.get(11), frameId: 7 };
  assert.equal((await f.request(message, sender)).ok, true);
  assert.equal((await f.request({ ...message, tabId: 12 }, { ...sender, tab: f.tabs.get(12) })).ok, false);
  await assert.rejects(f.adapter.withAgentSelection("stale-owner", f.tabs.get(12), async () => {}), /no longer owns/);
});

test("manual selection during an agent batch cancels it and does not restore or steal focus", async () => {
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
  f.tabs.set(13, { id: 13, windowId: 3, url: "https://manual.example/", active: false });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    await f.api.tabs.update(13, { active: true });
    assert.throws(() => selection.assertCurrent(), { code: "FOCUS_CHANGED" });
  });
  await f.adapter.sidePanel.getOptions();
  assert.deepEqual(f.selections, [12, 13]);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 13);
  assert.notEqual(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
});

test("failed agent batches and later window focus changes never force owner restoration", async () => {
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await assert.rejects(f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    throw new Error("Native input was rejected");
  }), /Native input was rejected/);
  assert.deepEqual(f.selections, [12]);
  await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    f.api.windows.onFocusChanged.emit(-1);
    assert.throws(() => selection.assertCurrent(), { code: "FOCUS_CHANGED" });
  });
  assert.deepEqual(f.selections, [12]);
});

test("an owner-target command does not suppress a user's ordinary tab switch", async () => {
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await f.adapter.withAgentSelection(owner.instanceId, f.tabs.get(11), async selection => {
    assert.equal(selection, null);
    await f.api.tabs.update(12, { active: true });
  });
  await f.adapter.sidePanel.getOptions();
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 12);
  assert.notEqual(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
});

test("a confirmed native group move retains the genuine owner when Safari activates its source sibling", async () => {
  const calls = [];
  const f = fixture({ companion: { embedded: true, onClosed: event(),
    async open(state) { calls.push(["open", state.tabId]); }, async close(state) { calls.push(["close", state.tabId]); } } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(11), async selection => {
    assert.ok(selection, "moving the owner needs the narrowly scoped native mutation lease too");
    await selection.select(await f.api.tabs.get(11));
    await selection.runNativeGroupMove("moveToGroup", async () => {
      f.tabs.get(12).index = 0;
      await f.api.tabs.update(12, { active: true });
      const tab = await f.api.tabs.get(12);
      return { action: "moveToGroup", mutationApplied: true, selectedTab: { index: tab.index, title: tab.title, url: tab.url } };
    });
    selection.assertCurrent();
    const get = f.api.tabs.get;
    f.api.tabs.get = async id => {
      if (id === 11 && !f.tabs.get(11).active) throw new Error("The moved owner is unavailable in this native group");
      return get(id);
    };
  }, { nativeGroupMove: "moveToGroup" });
  await f.adapter.sidePanel.getOptions();
  assert.deepEqual(calls, [["open", 11]]);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 11);
  assert.equal(f.tabs.get(12).active, true);
  assert.deepEqual(f.selections, [12], "a native source transition is never undone by refocusing its hidden moved owner");
  assert.equal(f.messages.length, 1, "the original frame was neither moved nor remounted on its source sibling");
  await f.api.tabs.update(11, { active: true });
  await f.api.tabs.update(12, { active: true });
  await f.adapter.sidePanel.getOptions();
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 12, "later manual activation resumes normal ownership");
  assert.notEqual(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
});

test("a source owner becomes visible again after the exact confirmed native sibling transition", async () => {
  for (const manualAfter of [false, true]) {
    const calls = [];
    const f = fixture({ companion: { embedded: true, onClosed: event(),
      async open(state) { calls.push(["open", state.tabId]); }, async close(state) { calls.push(["close", state.tabId]); } } });
    f.tabs.set(13, { id: 13, windowId: 3, index: 2, title: "Source fallback", url: "https://source.example/", active: false });
    f.tabs.set(14, { id: 14, windowId: 3, index: 3, title: "Manual", url: "https://manual.example/", active: false });
    await f.adapter.sidePanel.open({ tabId: 11 });
    const owner = f.messages[0].message;
    await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
      await selection.select(await f.api.tabs.get(12));
      const result = await selection.runNativeGroupMove("createGroup", async () => {
        f.tabs.get(13).index = 1;
        await f.api.tabs.update(13, { active: true });
        const selected = await f.api.tabs.get(13);
        return { action: "createGroup", mutationApplied: true,
          selectedTab: { index: selected.index, title: selected.title, url: selected.url } };
      });
      if (manualAfter) await f.api.tabs.update(14, { active: true });
      return result;
    }, { nativeGroupMove: "createGroup" });
    await f.adapter.sidePanel.getOptions();
    assert.deepEqual(f.selections, manualAfter ? [12, 13, 14] : [12, 13, 11]);
    assert.equal(f.tabs.get(manualAfter ? 14 : 11).active, true);
    assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, manualAfter ? 14 : 11);
    if (!manualAfter) {
      assert.deepEqual(calls, [["open", 11]]);
      assert.equal(f.messages.length, 1);
      assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
    }
  }
});

test("a changed native terminal identity is not overridden to restore the sidebar", async () => {
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
  f.tabs.set(13, { id: 13, windowId: 3, index: 2, title: "Source fallback", url: "https://source.example/", active: false });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    const result = await selection.runNativeGroupMove("createGroup", async () => {
      await f.api.tabs.update(13, { active: true });
      const selected = await f.api.tabs.get(13);
      return { action: "createGroup", mutationApplied: true,
        selectedTab: { index: selected.index, title: selected.title, url: selected.url } };
    });
    f.tabs.get(13).url += "?navigation";
    return result;
  }, { nativeGroupMove: "createGroup" });
  assert.deepEqual(f.selections, [12, 13]);
  assert.equal(f.tabs.get(13).active, true);
});

test("an unavailable source owner reports completed group mutation without replaying or fabricating restoration", async () => {
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
  f.tabs.set(13, { id: 13, windowId: 3, index: 2, title: "Source fallback", url: "https://source.example/", active: false });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const owner = f.messages[0].message;
  await assert.rejects(f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(12), async selection => {
    await selection.select(await f.api.tabs.get(12));
    const result = await selection.runNativeGroupMove("createGroup", async () => {
      await f.api.tabs.update(13, { active: true });
      const selected = await f.api.tabs.get(13);
      return { action: "createGroup", mutationApplied: true,
        selectedTab: { index: selected.index, title: selected.title, url: selected.url } };
    });
    const get = f.api.tabs.get;
    f.api.tabs.get = async id => { if (id === 11) throw new Error("Owner unavailable"); return get(id); };
    return result;
  }, { nativeGroupMove: "createGroup" }), error => {
    assert.match(error.message, /Owner unavailable.*group move completed/);
    assert.equal(error.data.mutationApplied, true);
    assert.equal(error.data.doNotReplay, true);
    assert.equal(error.data.nativeResult.action, "createGroup");
    return true;
  });
  assert.deepEqual(f.selections, [12, 13]);
});

test("failed or mismatched group results cannot authorize a deferred user activation", async () => {
  for (const result of [null, { mutationApplied: false }, { action: "inspect" }, { selectedTab: null },
    { selectedTab: { index: 1, title: "Forged", url: "https://example.org/" } }]) {
    const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
    await f.adapter.sidePanel.open({ tabId: 11 });
    const owner = f.messages[0].message;
    await assert.rejects(f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(11), selection =>
      selection.runNativeGroupMove("createGroup", async () => {
        await f.api.tabs.update(12, { active: true });
        if (result === null) throw new Error("Native mutation failed before confirmation");
        const tab = await f.api.tabs.get(12);
        return { action: "createGroup", mutationApplied: true, selectedTab: { index: tab.index, title: tab.title, url: tab.url }, ...result };
      }), { nativeGroupMove: "createGroup" }), /Native mutation failed|selection changed/);
    await f.adapter.sidePanel.getOptions();
    assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, 12);
    assert.notEqual(f.storage.chatgptSafariSidebarStateV1.openPanels[0].instanceId, owner.instanceId);
    assert.deepEqual(f.selections, [12]);
  }
});

test("a second tab event or a window focus change cancels even a confirmed native group mutation", async () => {
  for (const windowChange of [false, true]) {
    const f = fixture({ companion: { embedded: true, onClosed: event(), async open() {}, async close() {} } });
    f.tabs.set(13, { id: 13, windowId: 3, index: 2, title: "Manual", url: "https://manual.example/", active: false });
    await f.adapter.sidePanel.open({ tabId: 11 });
    const owner = f.messages[0].message;
    await assert.rejects(f.adapter.withAgentSelection(owner.instanceId, await f.api.tabs.get(11), selection =>
      selection.runNativeGroupMove("moveToUngrouped", async () => {
        await f.api.tabs.update(12, { active: true });
        if (windowChange) f.api.windows.onFocusChanged.emit(-1);
        else await f.api.tabs.update(13, { active: true });
        const tab = await f.api.tabs.get(windowChange ? 12 : 13);
        return { action: "moveToUngrouped", mutationApplied: true, selectedTab: { index: tab.index, title: tab.title, url: tab.url } };
      }), { nativeGroupMove: "moveToUngrouped" }), { code: "FOCUS_CHANGED" });
    await f.adapter.sidePanel.getOptions();
    assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].tabId, windowChange ? 12 : 13);
    assert.deepEqual(f.selections, windowChange ? [12] : [12, 13]);
  }
});

test("mounts the original side-chat page in the owning top frame", async () => {
  const f = fixture(), opened = [];
  f.adapter.sidePanel.onOpened.addListener((value) => opened.push(value));
  await f.adapter.sidePanel.open({ tabId: 11 });
  assert.equal(f.scripts[0].func.name, "callSidebarController");
  assert.deepEqual(f.scripts[1], { target: { tabId: 11, frameIds: [0] }, world: "ISOLATED", files: ["safari/sidebar-content.js"] });
  assert.equal(f.messages[0].message.iframeUrl, f.api.runtime.getURL("codex-work-sidepanel.html"));
  assert.deepEqual(f.messages[0].target, { tabId: 11, frameIds: [0] });
  assert.deepEqual(opened, [{ windowId: 3, tabId: 11, path: "codex-work-sidepanel.html" }]);
  assert.equal(extensionOrigin(f.api.runtime), "safari-web-extension://test-extension");
  await f.adapter.sidePanel.open({ tabId: 11 });
  assert.equal(opened.length, 1, "opening an existing sidebar is idempotent");
  assert.equal(f.scripts.filter(script => script.files).length, 1, "only an explicitly missing controller installs the bundle");
});

test("script errors and missing acknowledgements never install or replay a command", async () => {
  for (const options of [{ scriptFailure: true }, { noAcknowledgement: true }]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /Script rejected|did not acknowledge/);
    assert.equal(f.scripts.length, 1);
    assert.deepEqual(f.storage.chatgptSafariSidebarStateV1.openPanels, []);
  }
});

test("the embedded companion opens before mounting and only its owning wrapper can request relay data", async () => {
  const calls = [];
  const f = fixture({ companion: {
    embedded: true, onClosed: event(),
    async open(state) { calls.push(["open", state.instanceId]); },
    async close(state) {
      assert.equal(f.messages.at(-1).message.type, MESSAGE.unmount, "page layout is restored before companion ownership is released");
      calls.push(["close", state.instanceId]);
    },
    async frameRequest(state, payload) { calls.push(["request", state.instanceId, payload]); return { ready: true }; },
  } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const mounted = f.messages[0].message;
  assert.equal(mounted.iframeUrl, f.api.runtime.getURL("embedded-sidechat.html"));
  assert.equal(calls[0][0], "open");
  const sender = { id: f.api.runtime.id, url: mounted.iframeUrl, tab: f.tabs.get(11), frameId: 7 };
  const message = { type: MESSAGE.operation, tabId: 11, windowId: 3, instanceId: mounted.instanceId,
    operation: "companionRequest", payload: { action: "connection" } };
  assert.deepEqual(await f.request(message, sender), { ok: true, value: { ready: true } });
  for (const wrong of [
    { ...sender, url: f.api.runtime.getURL("codex-work-sidepanel.html") },
    { ...sender, url: mounted.iframeUrl + "?owner=forged" },
    { ...sender, tab: { ...sender.tab, windowId: 4 } },
  ]) assert.equal((await f.request(message, wrong)).ok, false);
  assert.equal(calls.filter(([kind]) => kind === "request").length, 1);
  await f.adapter.sidePanel.close({ tabId: 11 });
  assert.deepEqual(calls.map(([kind]) => kind), ["open", "request", "close"]);
});

test("document navigation remounts the inline conversation without reopening its account or agent", async () => {
  let opens = 0;
  const f = fixture({ companion: { embedded: true, onClosed: event(), async open() { opens++; }, async close() {} } });
  await f.adapter.sidePanel.open({ tabId: 11 });
  const instance = f.messages[0].message.instanceId;
  f.tabs.get(11).url = "https://example.com/next";
  f.api.tabs.onUpdated.emit(11, { status: "complete" }, f.tabs.get(11));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 1);
  assert.equal(f.messages.at(-1).message.type, MESSAGE.mount);
  assert.equal(f.messages.at(-1).message.instanceId, instance);
  assert.equal(f.messages.filter(x => x.message.type === MESSAGE.mount).length, 2);
});

test("embedded restoration remounts an authenticated owner without reopening the native UI", async () => {
  const owner = { tabId: 11, windowId: 3, instanceId: "embedded-owner", path: "codex-work-sidepanel.html", width: 480 };
  const f = fixture({ savedState: { version: 1, openPanels: [owner] }, companion: {
    embedded: true, onClosed: event(), async restore() { return owner; },
    async open() { assert.fail("Restore must not reopen the companion"); },
  } });
  await f.adapter.ready;
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message.iframeUrl, f.api.runtime.getURL("embedded-sidechat.html"));
  assert.equal(f.messages[0].message.instanceId, owner.instanceId);
});

test("a rejected embedded mount releases its native context instead of retaining an invisible owner", async () => {
  const calls = [];
  const f = fixture({ mountFails: true, companion: {
    embedded: true, onClosed: event(),
    async open() { calls.push("open"); }, async close() { calls.push("close"); },
  } });
  await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /Mount rejected/);
  assert.deepEqual(calls, ["open", "close"]);
  assert.deepEqual(f.storage.chatgptSafariSidebarStateV1.openPanels, []);
});

test("background restoration rebinds only the actual native owner without opening UI", async () => {
  const owner = { tabId: 11, windowId: 3, instanceId: "native-owner", path: "codex-work-sidepanel.html" };
  const stale = { ...owner, windowId: 4, instanceId: "stale-owner" };
  const calls = [];
  const f = fixture({
    savedState: { version: 1, openPanels: [stale, owner] },
    companion: {
      onClosed: event(),
      async restore(states) { calls.push(states); return states.find(item => item.instanceId === owner.instanceId); },
      async open() { assert.fail("Restoration must not reopen the native UI"); },
    },
  });
  await f.adapter.ready;
  assert.deepEqual(calls, [[stale, owner]]);
  assert.deepEqual(f.storage.chatgptSafariSidebarStateV1.openPanels, [owner]);
  assert.equal(f.messages.length, 0);
});

test("does not replace a restricted Safari page with a launcher", async () => {
  const f = fixture();
  f.tabs.get(11).url = "favorites://";
  await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /HTTP or HTTPS/);
  assert.equal(f.messages.length, 0);
});

test("allows only the upstream extension pages as sidebar paths", async () => {
  const f = fixture();
  for (const value of ["https://evil.example/", "../background.js", "codex-work-sidepanel.html?owner=1"]) {
    await assert.rejects(f.adapter.sidePanel.setOptions({ path: value }), /upstream ChatGPT extension page/);
  }
  await f.adapter.sidePanel.setOptions({ path: "codex-work-sidepanel.html", tabId: 11, enabled: true });
  assert.deepEqual(await f.adapter.sidePanel.getOptions({ tabId: 11 }), {
    enabled: true, path: "codex-work-sidepanel.html", tabId: 11,
  });
});

test("the toolbar enables its owning tab before opening and has one toggle owner", async () => {
  const f = fixture();
  await f.adapter.sidePanel.setOptions({ tabId: 11, enabled: false });
  await f.adapter.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  f.api.action.onClicked.emit(f.tabs.get(11));
  const options = await f.adapter.sidePanel.getOptions({ tabId: 11 });
  assert.equal(options.enabled, true);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels.length, 1);
  f.api.action.onClicked.emit(f.tabs.get(11));
  await f.adapter.sidePanel.getOptions({ tabId: 11 });
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels.length, 0);
});

test("the production Safari toolbar works before upstream panel behavior is initialized", async () => {
  const f = fixture({ browserActionOnly: true, toolbarAlwaysOpens: true });
  await f.adapter.ready;
  assert.equal((await f.adapter.sidePanel.getPanelBehavior()).openPanelOnActionClick, false);
  f.api.browserAction.onClicked.emit(f.tabs.get(11));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.messages.some(value => value.message.type === MESSAGE.mount));
  f.api.browserAction.onClicked.emit(f.tabs.get(11));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.messages.some(value => value.message.type === MESSAGE.unmount));
});

test("the persistent Safari toolbar uses the real browserAction namespace", async () => {
  const f = fixture({ browserActionOnly: true });
  await f.adapter.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  f.api.browserAction.onClicked.emit(f.tabs.get(11));
  await f.adapter.sidePanel.getOptions({ tabId: 11 });
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels.length, 1);
});

test("selection scripts run in the background only for the authorized sidebar owner", async () => {
  const f = fixture();
  await f.adapter.sidePanel.open({ tabId: 11 });
  const instanceId = f.messages[0].message.instanceId;
  const sender = { id: f.api.runtime.id, url: f.api.runtime.getURL("codex-work-sidepanel.html"), tab: f.tabs.get(11), frameId: 7 };
  const func = () => ({ selectedText: null });
  globalThis.ChatGPTSafariSidebarFunctions = { selection: func };
  const request = {
    type: MESSAGE.operation, tabId: 11, windowId: 3, instanceId, operation: "selection",
    payload: { operation: "selection", target: { tabId: 11 }, args: [f.tabs.get(11).url, "observer", "none"] },
  };
  const result = await f.request(request, sender);
  assert.equal(result.ok, true);
  assert.equal(f.scripts.at(-1).func, func);
  assert.deepEqual(f.scripts.at(-1).target, { tabId: 11 });
  const count = f.scripts.length;
  for (const forged of [
    { ...request, instanceId: "wrong" },
    { ...request, payload: { ...request.payload, target: { tabId: 12 } } },
    { ...request, payload: { ...request.payload, operation: "arbitraryFunction" } },
    { ...request, payload: { ...request.payload, world: "MAIN" } },
  ]) assert.equal((await f.request(forged, sender)).ok, false);
  assert.equal((await f.request(request, { ...sender, url: "https://example.com/" })).ok, false);
  assert.equal(f.scripts.length, count);
  delete globalThis.ChatGPTSafariSidebarFunctions;
});

test("disabled options close an open panel and emit the real close event", async () => {
  const f = fixture(), closed = [];
  f.adapter.sidePanel.onClosed.addListener((value) => closed.push(value));
  await f.adapter.sidePanel.open({ tabId: 11 });
  await f.adapter.sidePanel.setOptions({ tabId: 11, enabled: false });
  assert.equal(f.messages.at(-1).message.type, MESSAGE.unmount);
  assert.equal(closed[0].reason, "disabled");
  await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /disabled/);
});

test("a failed mount clears state instead of reporting an opened sidebar", async () => {
  const f = fixture({ mountFails: true }), opened = [];
  f.adapter.sidePanel.onOpened.addListener((value) => opened.push(value));
  await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /Mount rejected/);
  assert.equal(opened.length, 0);
  assert.deepEqual(f.storage.chatgptSafariSidebarStateV1.openPanels, []);
});

test("a failed path update restores every affected open panel and its previous options", async () => {
  const f = fixture({
    mountFails: (tabId, message) => tabId === 21 && message.iframeUrl?.endsWith("waiting-room.html"),
  });
  f.tabs.set(21, { id: 21, windowId: 4, url: "https://example.net/", active: true });
  await f.adapter.sidePanel.open({ tabId: 11 });
  await f.adapter.sidePanel.open({ tabId: 21 });
  await assert.rejects(f.adapter.sidePanel.setOptions({ path: "waiting-room.html" }), /Mount rejected/);
  assert.equal((await f.adapter.sidePanel.getOptions()).path, "codex-work-sidepanel.html");
  assert.deepEqual(f.storage.chatgptSafariSidebarStateV1.openPanels.map((state) => state.path), [
    "codex-work-sidepanel.html", "codex-work-sidepanel.html",
  ]);
  assert.deepEqual(f.messages.slice(-2).map(({ message }) => message.iframeUrl), [
    f.api.runtime.getURL("codex-work-sidepanel.html"), f.api.runtime.getURL("codex-work-sidepanel.html"),
  ]);
});

test("reopening restored state rolls back a rejected new path without losing the active panel", async () => {
  const f = fixture({
    savedState: {
      version: 1,
      defaults: { enabled: true, path: "codex-work-sidepanel.html" },
      openPanels: [{ tabId: 11, windowId: 3, path: "waiting-room.html", instanceId: "existing", width: 420 }],
    },
    mountFails: (tabId, message) => message.iframeUrl?.endsWith("codex-work-sidepanel.html"),
  });
  await assert.rejects(f.adapter.sidePanel.open({ tabId: 11 }), /Mount rejected/);
  assert.equal(f.storage.chatgptSafariSidebarStateV1.openPanels[0].path, "waiting-room.html");
  assert.equal(f.messages.at(-1).message.iframeUrl, f.api.runtime.getURL("waiting-room.html"));
  assert.equal(f.messages.at(-1).message.instanceId, "existing");
});

test("the frame owner handshake validates extension sender, tab, URL and instance", async () => {
  const f = fixture();
  await f.adapter.sidePanel.open({ tabId: 11 });
  const mounted = f.messages[0].message;
  const message = { type: MESSAGE.authorize, tabId: 11, windowId: 3, instanceId: mounted.instanceId };
  const sender = { id: f.api.runtime.id, url: f.api.runtime.getURL("codex-work-sidepanel.html"), tab: f.tabs.get(11), frameId: 7 };
  assert.equal((await f.request(message, sender)).ok, true);
  assert.equal((await f.request({ ...message, instanceId: "forged" }, sender)).ok, false);
  assert.equal((await f.request(message, { ...sender, url: "https://example.com/" })).ok, false);
  assert.equal((await f.request(message, { ...sender, tab: f.tabs.get(12) })).ok, false);
  assert.equal(await f.request(message, { ...sender, id: "other-extension" }), undefined);
});

test("a new top-level document can restore only its own open sidebar", async () => {
  const f = fixture();
  await f.adapter.sidePanel.open({ tabId: 11 });
  const count = f.messages.length;
  await f.request({ type: MESSAGE.ready }, { id: f.api.runtime.id, frameId: 0, tab: f.tabs.get(11) });
  assert.equal(f.messages.length, count + 1);
  await f.request({ type: MESSAGE.ready }, { id: f.api.runtime.id, frameId: 0, tab: f.tabs.get(12) });
  assert.equal(f.messages.length, count + 1);
});

class FakeStyle {
  constructor() { this.values = new Map(); }
  getPropertyValue(key) { return this.values.get(key)?.value || ""; }
  getPropertyPriority(key) { return this.values.get(key)?.priority || ""; }
  setProperty(key, value, priority = "") { this.values.set(key, { value, priority }); }
  removeProperty(key) { this.values.delete(key); }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.style = new FakeStyle(); this.children = []; this.attributes = new Map();
    this.nodeType = 1; this.isConnected = true; this.events = new Map();
    this.computed = { position: "static", right: "auto", left: "auto", transform: "none" };
    this.rect = { left: 0, width: 100 };
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(name, callback) { this.events.set(name, callback); }
  append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; }
  remove() { this.isConnected = false; this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  attachShadow(options) { this.shadowOptions = options; this.shadow = new FakeElement("shadow"); return this.shadow; }
  getBoundingClientRect() {
    const maximum = Number.parseFloat(this.style.getPropertyValue("max-width"));
    const width = Number.isFinite(maximum) ? Math.min(this.rect.width, maximum) : this.rect.width;
    const right = Number.parseFloat(this.style.getPropertyValue("right") || this.computed.right);
    const overrideLeft = Number.parseFloat(this.style.getPropertyValue("left"));
    const left = Number.isFinite(overrideLeft) ? overrideLeft
      : Number.isFinite(right) ? 1280 - right - width : this.rect.left;
    return { left, width, right: left + width };
  }
}
function contentFixture() {
  const document = {
    documentElement: new FakeElement("html"), body: new FakeElement("body"), createElement: (tag) => new FakeElement(tag),
    createTreeWalker(element) {
      const pending = [...element.children];
      return { nextNode() {
        const next = pending.shift();
        if (next) pending.unshift(...next.children);
        return next || null;
      } };
    },
  };
  document.documentElement.append(document.body);
  const listeners = new Map(), observers = [], timers = new Map();
  const page = {
    document, innerWidth: 1280,
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    getComputedStyle(element) {
      return { ...element.computed,
        right: element.style.getPropertyValue("right") || element.computed.right,
        left: element.style.getPropertyValue("left") || element.computed.left,
      };
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const runtime = { id: "test-extension", getURL: (file) => "safari-web-extension://test-extension/" + file.replace(/^\//, ""), onMessage: event(), async sendMessage() {} };
  return { document, page, observers, timers, listeners, content: createSidebarContent({ runtime }, page) };
}

test("content mounts a private original-page frame and restores the page layout on close", () => {
  const f = contentFixture();
  f.document.documentElement.style.setProperty("width", "98%");
  const message = {
    iframeUrl: "safari-web-extension://test-extension/codex-work-sidepanel.html",
    tabId: 11, windowId: 3, instanceId: "test-token", width: 420,
  };
  assert.deepEqual(f.content.mount(message), { ok: true, instanceId: "test-token" });
  const host = f.document.documentElement.children[1];
  assert.deepEqual(host.shadowOptions, { mode: "closed" });
  const frame = host.shadow.children[1].children[1];
  assert.equal(frame.src, message.iframeUrl);
  assert.equal(JSON.parse(frame.name.slice("chatgpt-safari-sidebar:".length)).instanceId, "test-token");
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "calc(100% - 420px)");
  assert.equal(f.content.unmount("wrong-token"), false);
  assert.equal(f.content.unmount("test-token"), true);
  assert.equal(f.document.documentElement.children.length, 1);
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "98%");
});

test("content rejects foreign origins and arbitrary extension resources", () => {
  const f = contentFixture();
  for (const iframeUrl of ["https://evil.example/codex-work-sidepanel.html", "safari-web-extension://other/codex-work-sidepanel.html", "safari-web-extension://test-extension/background.js"]) {
    assert.throws(() => f.content.mount({ iframeUrl, tabId: 11, windowId: 3, instanceId: "token" }), /authorized ChatGPT extension page/);
  }
  assert.equal(f.document.documentElement.children.length, 1);
});

test("closing does not overwrite a width changed by the page while its sidebar was open", () => {
  const f = contentFixture();
  f.content.mount({
    iframeUrl: "safari-web-extension://test-extension/codex-work-sidepanel.html",
    tabId: 11, windowId: 3, instanceId: "token", width: 420,
  });
  f.document.documentElement.style.setProperty("width", "92%", "important");
  f.content.unmount("token");
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "92%");
  assert.equal(f.document.documentElement.style.getPropertyPriority("width"), "important");
});

test("resizing preserves a newly observed page width for later restoration", () => {
  const f = contentFixture();
  f.content.mount({
    iframeUrl: "safari-web-extension://test-extension/codex-work-sidepanel.html",
    tabId: 11, windowId: 3, instanceId: "token", width: 420,
  });
  f.document.documentElement.style.setProperty("width", "92%");
  f.listeners.get("resize")();
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "calc(100% - 420px)");
  f.content.unmount("token");
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "92%");
  assert.equal(f.document.documentElement.style.getPropertyPriority("width"), "");
});

test("embedded content reserves a bounded width, keeps viewport-fixed controls visible and restores authored styles", () => {
  const f = contentFixture();
  const composer = new FakeElement("form");
  composer.computed = { position: "fixed", right: "16px", left: "auto", transform: "none" };
  composer.rect.width = 600;
  composer.style.setProperty("right", "16px");
  const header = new FakeElement("header");
  header.computed = { position: "fixed", right: "0px", left: "0px", transform: "none" };
  header.rect.width = 1280;
  header.style.setProperty("min-width", "1000px");
  f.document.body.append(composer, header);
  f.document.documentElement.style.setProperty("min-width", "900px");
  const message = { iframeUrl: "safari-web-extension://test-extension/embedded-sidechat.html",
    tabId: 11, windowId: 3, instanceId: "inline-owner", width: 420 };
  f.content.mount(message);
  assert.equal(composer.style.getPropertyValue("right"), "436px");
  assert.equal(composer.getBoundingClientRect().right, 844);
  assert.equal(header.style.getPropertyValue("max-width"), "860px");
  assert.equal(header.style.getPropertyValue("min-width"), "0px");
  assert.equal(f.document.documentElement.style.getPropertyValue("min-width"), "0px");
  assert.equal(f.document.documentElement.style.getPropertyValue("margin-right"), "420px");
  f.content.mount({ ...message, width: 700 });
  assert.equal(composer.style.getPropertyValue("right"), "716px", "repeated mount updates layout without replacing the conversation frame");
  composer.style.setProperty("right", "30px", "important");
  f.content.unmount(message.instanceId);
  assert.equal(composer.style.getPropertyValue("right"), "30px", "a newer authored inline value belongs to the page");
  assert.equal(header.style.getPropertyValue("min-width"), "1000px");
  assert.equal(header.style.getPropertyValue("max-width"), "");
  assert.equal(f.document.documentElement.style.getPropertyValue("min-width"), "900px");
  assert.equal(f.document.documentElement.style.getPropertyValue("margin-right"), "");
});

test("fixed controls in transformed containing blocks are not mistaken for viewport controls", () => {
  const f = contentFixture(), container = new FakeElement("section"), fixed = new FakeElement("button");
  container.computed.transform = "translateX(0)";
  fixed.computed = { position: "fixed", right: "12px", left: "auto", transform: "none" };
  container.append(fixed);
  f.document.body.append(container);
  f.content.mount({ iframeUrl: "safari-web-extension://test-extension/embedded-sidechat.html",
    tabId: 11, windowId: 3, instanceId: "owner", width: 420 });
  assert.equal(fixed.style.getPropertyValue("right"), "");
  f.content.unmount("owner");
});

test("new fixed controls are compensated in bounded scans and narrow viewports keep page space", () => {
  const f = contentFixture();
  f.page.innerWidth = 600;
  f.content.mount({ iframeUrl: "safari-web-extension://test-extension/embedded-sidechat.html",
    tabId: 11, windowId: 3, instanceId: "owner", width: 700 });
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "calc(100% - 320px)");
  f.page.innerWidth = 1280;
  f.listeners.get("resize")();
  const added = new FakeElement("button");
  added.computed = { position: "fixed", right: "8px", left: "auto", transform: "none" };
  f.document.body.append(added);
  f.observers[0].callback([{ type: "childList", addedNodes: [added] }]);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  assert.equal(added.style.getPropertyValue("right"), "328px");
  f.content.unmount("owner");
  assert.equal(added.style.getPropertyValue("right"), "");
});

test("sidebar dragging preserves the grab offset and its keyboard resize and close controls restore layout", () => {
  const f = contentFixture();
  f.content.mount({ iframeUrl: "safari-web-extension://test-extension/embedded-sidechat.html",
    tabId: 11, windowId: 3, instanceId: "owner", width: 420 });
  const host = f.document.documentElement.children[1], panel = host.shadow.children[1];
  const handle = panel.children[2], frame = panel.children[1];
  const pointer = { button: 0, clientX: 855, pointerId: 1, preventDefault() {} };
  handle.events.get("pointerdown")(pointer);
  handle.events.get("pointermove")(pointer);
  assert.equal(host.style.getPropertyValue("width"), "420px");
  handle.events.get("pointermove")({ ...pointer, clientX: 785 });
  assert.equal(host.style.getPropertyValue("width"), "490px");
  handle.events.get("pointerup")();
  assert.equal(frame.style.pointerEvents, "");
  handle.events.get("keydown")({ key: "ArrowRight", preventDefault() {} });
  assert.equal(host.style.getPropertyValue("width"), "466px");
  assert.equal(handle.attributes.get("aria-valuemax"), "720");
  panel.children[0].children[1].children[1].events.get("click")();
  assert.equal(f.document.documentElement.children.length, 1);
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "");
  assert.equal(f.listeners.has("resize"), false);
});

test("a failed layout mount removes its host and restores the original page", () => {
  const f = contentFixture();
  f.document.documentElement.style.setProperty("width", "95%");
  f.page.getComputedStyle = () => { throw new Error("Layout unavailable"); };
  assert.deepEqual(f.content.command({ type: MESSAGE.mount,
    iframeUrl: "safari-web-extension://test-extension/embedded-sidechat.html",
    tabId: 11, windowId: 3, instanceId: "owner", width: 420 }), { ok: false, error: "Layout unavailable" });
  assert.equal(f.document.documentElement.children.length, 1);
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "95%");
  assert.equal(f.listeners.has("resize"), false);
});
