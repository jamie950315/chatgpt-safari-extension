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
  const messages = [], scripts = [], rules = [], storage = {};
  if (options.savedState) storage.chatgptSafariSidebarStateV1 = structuredClone(options.savedState);
  const tabs = new Map([
    [11, { id: 11, windowId: 3, url: "https://example.com/", active: true }],
    [12, { id: 12, windowId: 3, url: "https://example.org/", active: false }],
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
      async sendMessage(tabId, message, target) {
        messages.push({ tabId, message, target });
        const mountFails = typeof options.mountFails === "function"
          ? options.mountFails(tabId, message) : options.mountFails;
        if (mountFails && message.type === MESSAGE.mount) return { ok: false, error: "Mount rejected" };
        return { ok: true, instanceId: message.instanceId };
      },
      onRemoved: event(),
      onActivated: event(),
    },
    scripting: { async executeScript(args) { scripts.push(args); return []; } },
    declarativeNetRequest: { async updateSessionRules(args) { rules.push(args); } },
    action: { onClicked: event() },
  };
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
  return { api, adapter, messages, scripts, rules, tabs, storage, request };
}

test("mounts the original side-chat page in the owning top frame", async () => {
  const f = fixture(), opened = [];
  f.adapter.sidePanel.onOpened.addListener((value) => opened.push(value));
  await f.adapter.sidePanel.open({ tabId: 11 });
  assert.deepEqual(f.scripts[0], { target: { tabId: 11, frameIds: [0] }, files: ["safari/sidebar-content.js"] });
  assert.equal(f.messages[0].message.iframeUrl, f.api.runtime.getURL("codex-work-sidepanel.html"));
  assert.deepEqual(f.messages[0].target, { frameId: 0 });
  assert.deepEqual(opened, [{ windowId: 3, tabId: 11, path: "codex-work-sidepanel.html" }]);
  assert.equal(extensionOrigin(f.api.runtime), "safari-web-extension://test-extension");
  await f.adapter.sidePanel.open({ tabId: 11 });
  assert.equal(opened.length, 1, "opening an existing sidebar is idempotent");
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
  constructor(tag) { this.tagName = tag; this.style = new FakeStyle(); this.children = []; this.attributes = new Map(); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener() {}
  append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  attachShadow(options) { this.shadowOptions = options; this.shadow = new FakeElement("shadow"); return this.shadow; }
}
function contentFixture() {
  const document = { documentElement: new FakeElement("html"), createElement: (tag) => new FakeElement(tag) };
  const listeners = new Map();
  const page = {
    document, innerWidth: 1280,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const runtime = { id: "test-extension", getURL: (file) => "safari-web-extension://test-extension/" + file.replace(/^\//, ""), onMessage: event(), async sendMessage() {} };
  return { document, listeners, content: createSidebarContent({ runtime }, page) };
}

test("content mounts a private original-page frame and restores the page layout on close", () => {
  const f = contentFixture();
  f.document.documentElement.style.setProperty("width", "98%");
  const message = {
    iframeUrl: "safari-web-extension://test-extension/codex-work-sidepanel.html",
    tabId: 11, windowId: 3, instanceId: "test-token", width: 420,
  };
  assert.deepEqual(f.content.mount(message), { ok: true, instanceId: "test-token" });
  const host = f.document.documentElement.children[0];
  assert.deepEqual(host.shadowOptions, { mode: "closed" });
  const frame = host.shadow.children[1].children[1];
  assert.equal(frame.src, message.iframeUrl);
  assert.equal(JSON.parse(frame.name.slice("chatgpt-safari-sidebar:".length)).instanceId, "test-token");
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "calc(100% - 420px)");
  assert.equal(f.content.unmount("wrong-token"), false);
  assert.equal(f.content.unmount("test-token"), true);
  assert.equal(f.document.documentElement.children.length, 0);
  assert.equal(f.document.documentElement.style.getPropertyValue("width"), "98%");
});

test("content rejects foreign origins and arbitrary extension resources", () => {
  const f = contentFixture();
  for (const iframeUrl of ["https://evil.example/codex-work-sidepanel.html", "safari-web-extension://other/codex-work-sidepanel.html", "safari-web-extension://test-extension/background.js"]) {
    assert.throws(() => f.content.mount({ iframeUrl, tabId: 11, windowId: 3, instanceId: "token" }), /authorized ChatGPT extension page/);
  }
  assert.equal(f.document.documentElement.children.length, 0);
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
