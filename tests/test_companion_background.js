const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompanion } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/companion-background.js");

function fixture(options = {}) {
  const tab = { id: 11, windowId: 3, url: "https://example.com/", status: "complete" };
  const calls = [], scripts = [], session = {}, sessionChanges = [];
  const storageListeners = [];
  const mentionListeners = new Set(), runtimeMessages = [], invalidations = [];
  let afterCapture;
  let scriptResponse;
  let response = { ok: true, requests: [], entry: { phase: "signedIn", accountScope: "synthetic-native-account-scope" } };
  const api = {
    runtime: { getURL: path => "safari-web-extension://actual-owner" + path, async sendMessage(value) { runtimeMessages.push(value); }, async sendNativeMessage(_, value) { calls.push(value.command); return typeof response === "function" ? response(value.command) : response; } },
    tabs: { async get() { return { ...tab }; }, onUpdated: { addListener() {} } },
    windows: { async get() { return { left: 100, top: 100, width: 1000, height: 800 }; } },
    storage: {
      onChanged: { addListener(value) { storageListeners.push(value); } },
      local: { async get() { return { safariLiveProfileId: "55555555-5555-4555-8555-555555555555" }; } },
      session: { async get(key) { return { [key]: session[key] }; }, async set(value) {
        const changes = Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { oldValue: session[key], newValue }]));
        Object.assign(session, value); storageListeners.forEach(listener => listener(changes, "session"));
      },
        async remove(key) { delete session[key]; } },
    },
    scripting: { async executeScript(value) { scripts.push(value); afterCapture?.(); return scriptResponse ? scriptResponse(value) : [{ documentId: "doc", result: { selectedText: "selected test text", revision: 2 } }]; } },
  };
  const environment = {
    ChatGPTSafariHooks: { async getInstanceId() { return "browser-instance"; }, async getTabMentions() { return [{ id: 11, title: "Test" }]; },
      subscribeTabMentionsInvalidated(listener) { mentionListeners.add(listener); return () => mentionListeners.delete(listener); } },
    ChatGPTSafariSidebarFunctions: { selection() {}, removeSelection() {}, recoverSelection() {} },
    ChatGPTSafariBrowserSessionChanged() { sessionChanges.push(true); },
    ChatGPTSafariAgent: { invalidateAll() { invalidations.push(true); } },
  };
  return { api, tab, calls, scripts, session, sessionChanges, mentionListeners, runtimeMessages, invalidations, binding: createCompanion(api, environment, options), setAfterCapture(value) { afterCapture = value; }, setResponse(value) { response = value; }, setScriptResponse(value) { scriptResponse = value; } };
}
const owner = { tabId: 11, windowId: 3, instanceId: "owner-token" };

test("agent credentials and native commands stay owner-bound and outside the provider host vocabulary", async () => {
  const f = fixture({ embedded: true });
  assert.equal(await f.binding.readBrowserSession(), null);
  await assert.rejects(f.binding.agentKernelURL(), /Open the ChatGPT sidebar/);
  assert.equal(f.calls.length, 0);
  f.setResponse(command => ({ ok: true, requests: [], ...(command.action === "embeddedBrowserSession"
    ? { session: { accessToken: "synthetic-only", account: { id: "synthetic-account" }, user: { id: "synthetic-user" } } }
    : command.action === "embeddedEntry" ? { entry: { phase: "signedIn", accountScope: "native-only-account-scope" } }
    : command.action === "embeddedKernel" ? { url: "http://chatgpt-kernel-fixture.localhost:1234/sandbox?cap=" + "a".repeat(64) }
    : { result: { text: "Real page result" } }) }));
  await f.binding.open(owner);
  try {
    const session = await f.binding.readBrowserSession();
    assert.equal(session.accessToken, "synthetic-only");
    assert.match(await f.binding.agentKernelURL(), /^http:\/\/chatgpt-kernel-fixture\.localhost:/);
    const current = await f.binding.agentOwner();
    assert.equal(current.instanceId, owner.instanceId);
    assert.equal(current.accountScope, "native-only-account-scope");
    assert.equal(f.calls[0].liveProfileId, current.profileId);
    assert.equal((await f.binding.runAgentCommand({ action: "read_page", arguments: {} }, current)).text, "Real page result");
    await assert.rejects(f.binding.runAgentCommand({}, { ...current, instanceId: "old-owner" }), /owner changed/);
    for (const method of ["readBrowserSession", "runAgentCommand", "agentKernelURL"]) {
      await assert.rejects(f.binding.frameRequest(owner, { operation: "host", method, params: {} }), /Unknown native/);
    }
  } finally { await f.binding.close(owner); }
  assert.equal(await f.binding.readBrowserSession(), null);
});

test("agent ownership uses only the fresh native signed-in relay account scope", async () => {
  const f = fixture({ embedded: true });
  await f.binding.open(owner);
  try {
    assert.equal((await f.binding.agentOwner()).accountScope, "synthetic-native-account-scope");
    f.setResponse({ ok: true, entry: { phase: "signedIn", accountScope: "replacement-native-scope" } });
    assert.equal((await f.binding.agentOwner()).accountScope, "replacement-native-scope");
    for (const entry of [{ phase: "guest", accountScope: "old-scope" }, { phase: "signedIn" }, { authentication: { state: "expired" } }]) {
      f.setResponse({ ok: true, entry });
      await assert.rejects(f.binding.agentOwner(), /Sign in to ChatGPT/);
    }
  } finally { f.setResponse({ ok: true }); await f.binding.close(owner); }
});

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

test("embedded frames use the relay lifecycle and retain owner-bound browser authority", async () => {
  const f = fixture({ embedded: true });
  f.setResponse(command => ({ ok: true, requests: [], ...(command.action === "embeddedEntry"
    ? { entry: { providerURL: "test-entry", bridgeToken: "test-token" } } : {}) }));
  await f.binding.open(owner);
  try {
    assert.equal(f.binding.embedded, true);
    assert.equal(f.calls[0].action, "embeddedOpen");
    assert.equal(f.calls[0].parentExtensionOrigin, "safari-web-extension://actual-owner");
    assert.equal(f.calls.some(call => call.action === "open"), false);
    assert.deepEqual(await f.binding.frameRequest(owner, { operation: "entry" }), { providerURL: "test-entry", bridgeToken: "test-token" });
    const context = await f.binding.frameRequest(owner, { operation: "host", method: "context", params: { includeSelection: true } });
    assert.equal(context.context.selectedText, "selected test text");
    await assert.rejects(f.binding.frameRequest({ ...owner, instanceId: "old" }, { operation: "entry" }), /owner has changed/);
    await assert.rejects(f.binding.frameRequest(owner, { operation: "host", method: "execute", params: {} }), /Unknown native/);
  } finally { await f.binding.close(owner); }
  assert.equal(f.calls.at(-1).action, "embeddedClose");
});

test("a verified collection rebind updates the same native owner without reopening or refreshing its tunnel", async () => {
  const f = fixture({ embedded: true }), state = { ...owner };
  await f.binding.open(state);
  const expectedOwner = await f.binding.agentOwner(), callCount = f.calls.length, changes = f.sessionChanges.length;
  f.session["codexWorkSidePanelConversationUrl:11"] = "https://chatgpt.com/c/existing-conversation";
  state.tabId = f.tab.id = 21;
  try {
    await assert.rejects(f.binding.rebindAgentOwner({ ...state }, 11), { code: "REBIND_STATE" },
      "equal tokens do not authorize an unrelated state object");
    await f.binding.rebindAgentOwner(state, 11);
    assert.deepEqual(f.calls.slice(callCount).map(call => call.action), ["embeddedUpdate"]);
    assert.equal(f.calls.at(-1).ownerToken, owner.instanceId);
    assert.equal(f.calls.at(-1).context.tabId, 21);
    assert.equal(f.sessionChanges.length, changes);
    assert.equal(f.session["codexWorkSidePanelConversationUrl:21"], "https://chatgpt.com/c/existing-conversation");
    assert.equal(f.session["codexWorkSidePanelConversationUrl:11"], undefined);
    assert.equal((await f.binding.agentOwner()).tabId, 21);
    assert.equal((await f.binding.agentOwner()).instanceId, expectedOwner.instanceId);
    f.setResponse({ ok: true, result: { text: "Original in-flight command completed" } });
    assert.equal((await f.binding.runAgentCommand({}, expectedOwner)).text, "Original in-flight command completed");
    await assert.rejects(f.binding.frameRequest(state, { operation: "host", method: "rebindAgentOwner", params: {} }), /Unknown native/);
    const script = f.scripts.find(value => value.func.name === "invalidateReboundSnapshot");
    assert.deepEqual(script.target, { tabId: 21, frameIds: [0] });
    assert.equal(script.world, "ISOLATED");
    const snapshot = { nodes: new Map([["old-node", {}]]), snapshotId: "old-snapshot", documentId: "real-document" };
    globalThis.__chatGPTSafariLiveDocument = snapshot;
    try { script.func(); } finally { delete globalThis.__chatGPTSafariLiveDocument; }
    assert.equal(snapshot.nodes.size, 0);
    assert.equal(snapshot.snapshotId, null);
    assert.equal(snapshot.documentId, "real-document", "the document identity itself is not fabricated");
    const beforeSameID = f.calls.length;
    await f.binding.rebindAgentOwner(state, 21);
    assert.deepEqual(f.calls.slice(beforeSameID).map(call => call.action), ["embeddedUpdate"]);
    assert.equal(f.session["codexWorkSidePanelConversationUrl:21"], "https://chatgpt.com/c/existing-conversation",
      "same-ID source restoration retains the original conversation key");
    assert.equal(f.sessionChanges.length, changes);
  } finally { await f.binding.close(state); }
});

test("owner rebind failures identify their actual step without exposing raw native, script, or storage errors", async () => {
  for (const code of ["REBIND_CONTEXT", "REBIND_SNAPSHOT", "REBIND_CONVERSATION"]) {
    const f = fixture({ embedded: true }), state = { ...owner };
    await f.binding.open(state);
    state.tabId = f.tab.id = 21;
    const privateError = () => Object.assign(new Error("Synthetic private URL https://private.example/ token=never-record"), { code: "PRIVATE_ERROR" });
    if (code === "REBIND_CONTEXT") f.setResponse(command => {
      if (command.action === "embeddedUpdate") throw privateError();
      return { ok: true };
    });
    if (code === "REBIND_SNAPSHOT") {
      const execute = f.api.scripting.executeScript;
      f.api.scripting.executeScript = async command => {
        if (command.func.name === "invalidateReboundSnapshot") throw privateError();
        return execute(command);
      };
    }
    const remove = f.api.storage.session.remove;
    if (code === "REBIND_CONVERSATION") f.api.storage.session.remove = async () => { throw privateError(); };
    try {
      await assert.rejects(f.binding.rebindAgentOwner(state, 11), error => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private|https:|token|PRIVATE_ERROR/u);
        assert.equal(error.cause, undefined);
        assert.equal(error.data, undefined);
        return true;
      });
    } finally { f.api.storage.session.remove = remove; f.setResponse({ ok: true }); await f.binding.close(state); }
  }
});

test("original context-menu and website invocations are consumed once by only their live owner", async () => {
  const f = fixture({ embedded: true });
  const key = "codexWorkSidePanelInvocation:11";
  const value = { type: "browser_side_chat_prompt_prefill", createdAtMs: Date.now(), prompt: "Ask about this page", selectedText: "Original selection" };
  f.session[key] = { ...value, prompt: "Old stored invocation" };
  await f.binding.open(owner);
  try {
    assert.equal(f.session[key], undefined, "a previous owner cannot replay a stored invocation");
    const consume = () => f.binding.frameRequest(owner, { operation: "host", method: "openInvocation", params: {} });
    await f.api.storage.session.set({ [key]: { ...value, ignored: "not provider vocabulary" } });
    const replies = await Promise.all([consume(), consume()]);
    assert.deepEqual(replies.map(reply => reply.invocation), [value, null]);
    assert.equal(f.session[key], undefined);
    await f.api.storage.session.set({ "codexWorkSidePanelInvocation:22": value });
    assert.equal((await consume()).invocation, null);
    await f.api.storage.session.set({ [key]: { ...value, createdAtMs: Date.now() - 300001 } });
    assert.equal((await consume()).invocation, null);
    await assert.rejects(f.binding.frameRequest({ ...owner, instanceId: "old-owner" }, { operation: "host", method: "openInvocation", params: {} }), /owner has changed/);
  } finally { await f.binding.close(owner); }
});

test("navigation, sign-out and owner replacement discard pending prefill instead of crossing page or account scope", async () => {
  const f = fixture({ embedded: true }), key = "codexWorkSidePanelInvocation:11";
  const value = { type: "browser_side_chat_prompt_prefill", createdAtMs: Date.now(), prompt: "Original page only" };
  let current = owner;
  await f.binding.open(current);
  const consume = () => f.binding.frameRequest(current, { operation: "host", method: "openInvocation", params: {} });
  try {
    await f.api.storage.session.set({ [key]: value });
    f.tab.url = "https://example.com/new-document";
    assert.equal((await consume()).invocation, null);
    await f.api.storage.session.set({ [key]: value });
    await f.binding.frameRequest(current, { operation: "host", method: "authStateChanged", params: { state: "signed_out" } });
    assert.equal((await consume()).invocation, null);
    await f.api.storage.session.set({ [key]: value });
    current = { ...owner, instanceId: "replacement-owner" };
    await f.binding.open(current);
    assert.equal((await consume()).invocation, null);
  } finally { await f.binding.close(current); }
});

test("Google Workspace selection uses the original recovery function and document-bound generation", async () => {
  for (const [type, mode] of [["document", "polling"], ["presentation", "polling"], ["spreadsheets", "event"]]) {
    const f = fixture({ embedded: true });
    f.tab.url = `https://docs.google.com/${type}/d/synthetic-document/edit`;
    f.setScriptResponse(command => command.world === "MAIN"
      ? [{ documentId: "workspace-document", result: { selectedText: "Recovered canvas selection" } }]
      : command.args[3] ? [{ documentId: "workspace-document", result: { selectedText: command.args[3].selectedText, revision: 4 } }]
      : [{ documentId: "workspace-document", result: { selectedText: null, revision: 3, captureGeneration: 7, needsRecovery: true } }]);
    await f.binding.open(owner);
    try {
      const value = await f.binding.context(owner, true);
      assert.equal(value.selectedText, "Recovered canvas selection");
      assert.equal(value.selectionId, "workspace-document:4");
      assert.deepEqual(f.scripts[0].args, [f.tab.url, owner.instanceId, mode]);
      assert.equal(f.scripts[1].func.name, "recoverSelection");
      assert.equal(f.scripts[1].world, "MAIN");
      assert.deepEqual(f.scripts[1].target, { tabId: 11, documentIds: ["workspace-document"] });
      assert.deepEqual(f.scripts[1].args, ["https://docs.google.com", f.tab.url, 80000]);
      assert.deepEqual(f.scripts[2].args[3], { captureGeneration: 7, selectedText: "Recovered canvas selection" });
    } finally { await f.binding.close(owner); }
  }
});

test("app-profile authentication stays outside provider host methods and refreshes the tunnel only after resume", async () => {
  const f = fixture({ embedded: true });
  f.setResponse(command => ({ ok: true, requests: [], ...(command.action === "embeddedAuth"
    ? { authentication: command.state === "expired" ? { state: "expired" } : null } : {}) }));
  await f.binding.open(owner);
  try {
    const changed = f.sessionChanges.length;
    const response = await f.binding.frameRequest(owner, { operation: "host", method: "authStateChanged", params: { state: "expired" } });
    assert.deepEqual(response.authentication, { state: "expired" });
    await f.binding.frameRequest(owner, { operation: "authentication", action: "open" });
    assert.equal(f.calls.at(-1).authOperation, "open");
    assert.equal(f.calls.at(-1).ownerToken, owner.instanceId);
    assert.equal(f.sessionChanges.length, changed + 1);
    await f.binding.frameRequest(owner, { operation: "authentication", action: "resume" });
    assert.equal(f.sessionChanges.length, changed + 2);
    await assert.rejects(f.binding.frameRequest(owner, { operation: "host", method: "authentication", params: { action: "open" } }), /Unknown native/);
    await assert.rejects(f.binding.frameRequest(owner, { operation: "authentication", action: "importCookies" }), /Unknown app-profile/);
  } finally { await f.binding.close(owner); }
});

test("original favicon warmup invalidation is owner-bound and released with account or owner teardown", async () => {
  const f = fixture({ embedded: true });
  await f.binding.open(owner);
  const request = () => f.binding.handleRequest(owner, { ownerToken: owner.instanceId, method: "tabMentions", params: {} });
  try {
    await request(); await request();
    assert.equal(f.mentionListeners.size, 1);
    const stale = [...f.mentionListeners][0]; stale();
    assert.deepEqual(f.runtimeMessages, [{ type: "chatgpt-safari:tab-mentions-invalidated", instanceId: owner.instanceId, tabId: owner.tabId, windowId: owner.windowId }]);
    const count = f.invalidations.length;
    await f.binding.frameRequest(owner, { operation: "host", method: "authStateChanged", params: { state: "signed_out" } });
    assert.equal(f.invalidations.length, count + 1); assert.equal(f.mentionListeners.size, 0);
    stale(); assert.equal(f.runtimeMessages.length, 1);
    await request(); assert.equal(f.mentionListeners.size, 1);
  } finally { await f.binding.close(owner); }
  assert.equal(f.mentionListeners.size, 0);
  assert.equal(f.invalidations.length, 3, "open, auth change and close clear original agent developer capture");
});
