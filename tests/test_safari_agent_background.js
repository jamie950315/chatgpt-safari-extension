const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-background.js");
function fixture() {
  const calls = [], metadata = { session_id: "thread-a", turn_id: "turn-a" };
  const page = { documentId: "document-a", snapshotId: "snapshot-a", url: "https://example.com/", title: "Existing signed-in page",
    text: "Page-only verification text", focusedNode: null, nodes: [{ node: "n1", tag: "input", label: "Project note" }, { node: "n2", tag: "button", label: "Apply" },
      { node: "n3", tag: "a", label: "Download report", href: "https://example.com/report.txt" }] };
  let owner = { instanceId: "sidebar-a", profileId: "55555555-5555-4555-8555-555555555555", accountScope: "account-a" }, error, interactionResult;
  const session = { currentTurnId: metadata.turn_id, async requireOwnedTab(id) { if (id !== 12) throw new Error("Tab is not claimed by this session"); } };
  const companion = { async agentOwner() { return owner; }, async runAgentCommand(command, expected) {
    calls.push({ command, expected });
    if (error) throw error;
    if (command.action === "read_page") return { ...page };
    if (command.action === "dom_query") return command.arguments.command.type === "safari_selection_read" ? { text: "Current selected text" }
      : { node: "n1", documentId: page.documentId, snapshotId: page.snapshotId, url: page.url };
    if (command.action === "download_link_inspect") return { href: page.nodes[2].href, url: page.url };
    if (command.action === "download_link") return { state: "complete", path: "/Downloads/report.txt", bytesWritten: 42 };
    if (command.action === "interact") { page.snapshotId += "-next"; page.focusedNode = "n1"; return interactionResult
      ?? { page: { ...page }, completed: command.arguments.interactions.map(item => ({ type: item.type })) }; }
    return { status: "complete" };
  } };
  const agent = createAgent({ tabs: { async get() { return { url: page.url }; } } }, companion);
  const execute = (type, params = {}) => agent.execute({ type, browser_id: "0", tab_id: "12", ...params }, session, metadata);
  return { agent, calls, metadata, session, execute, setOwner(next) { owner = { ...owner, ...next }; }, setError(next) { error = next; },
    setInteractionResult(next) { interactionResult = next; } };
}
test("the original agent reads a claimed ordinary Safari tab and uses native focused input", async () => {
  const f = fixture();
  const dom = await f.execute("dom_cua_get_visible_dom");
  assert.match(dom, /Page-only verification text/);
  assert.match(dom, /\[d1_n1\] input "Project note"/);
  await f.execute("dom_cua_click", { node_id: "d1_n1" });
  await f.execute("dom_cua_type", { text: "verified" });
  const last = f.calls.at(-1).command;
  assert.equal(last.action, "interact");
  assert.deepEqual(last.arguments.interactions, [{ type: "type", node: "n1", value: "verified", requireFocused: true }]);
  assert.equal(last.arguments.handle, "live:55555555-5555-4555-8555-555555555555:12");
  await assert.rejects(f.execute("dom_cua_click", { node_id: "d1_n2" }), /earlier snapshot/);
});
test("unclaimed tabs, ended turns, old owners and released snapshots cannot post input", async () => {
  const f = fixture();
  await assert.rejects(f.execute("dom_cua_get_visible_dom", { tab_id: "99" }), /not claimed/);
  await f.execute("dom_cua_get_visible_dom");
  f.agent.release(f.metadata.session_id, f.metadata.turn_id);
  await assert.rejects(f.execute("dom_cua_click", { node_id: "d1_n1" }), /Read the current visible DOM/);
  await f.execute("dom_cua_get_visible_dom");
  f.setOwner({ instanceId: "sidebar-b", profileId: "55555555-5555-4555-8555-555555555555" });
  await assert.rejects(f.execute("dom_cua_click", { node_id: "d2_n1" }), /sidebar owner changed/);
  await assert.rejects(f.execute("dom_cua_get_visible_dom"), /sidebar owner changed/);
  await assert.rejects(f.agent.authorize(f.session, f.metadata), /sidebar owner changed/);
  f.session.currentTurnId = "turn-ended";
  await assert.rejects(f.execute("dom_cua_get_visible_dom"), /no longer active/);
  assert.equal(f.calls.length, 2);
});
test("a native delivery error preserves the no-replay instruction through message-only RPC", async () => {
  const f = fixture(); await f.execute("dom_cua_get_visible_dom");
  f.setError(Object.assign(new Error("Input outcome is uncertain"), { data: { completed: [{ type: "click" }] } }));
  await assert.rejects(f.execute("dom_cua_click", { node_id: "d1_n1" }), /Completed steps: 1.*not retried.*do not repeat/);
  assert.equal(f.calls.length, 2);
});
test("navigation keeps the ordinary profile and checks the current target URL", async () => {
  const f = fixture();
  assert.deepEqual(await f.execute("navigate_tab_url", { url: "https://example.com/next" }), {});
  assert.equal(f.calls[0].command.action, "navigate");
  assert.equal(f.calls[0].command.arguments.expectedUrl, "https://example.com/");
  await assert.rejects(f.execute("playwright_evaluate", { script: "document.cookie" }), /not implemented/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].command.arguments.command.type, "safari_logs_start");
});
test("download preflight and transfer retain the exact claimed document, snapshot, node, profile and owner", async () => {
  const f = fixture();
  await assert.rejects(f.execute("safari_download_inspect", { node_id: "d1_n3" }), /Read the current visible DOM/);
  assert.equal(f.calls.length, 0);
  await f.execute("dom_cua_get_visible_dom");
  const inspected = await f.execute("safari_download_inspect", { node_id: "d1_n3", href: "https://other.example/override" });
  assert.deepEqual(inspected, { href: "https://example.com/report.txt", url: "https://example.com/" });
  assert.deepEqual(f.calls[1].command, { action: "download_link_inspect", arguments: {
    handle: "live:55555555-5555-4555-8555-555555555555:12", expectedUrl: "https://example.com/",
    documentId: "document-a", snapshotId: "snapshot-a", node: "n3",
  } });
  assert.deepEqual(await f.execute("dom_cua_download_media", { node_id: "d1_n3", href: inspected.href }), {});
  assert.deepEqual(f.calls[2].command, { action: "download_link", arguments: { ...f.calls[1].command.arguments, href: inspected.href } });
  assert.equal(f.calls[2].expected.instanceId, "sidebar-a");
  assert.equal(f.calls[2].expected.profileId, "55555555-5555-4555-8555-555555555555");
  await assert.rejects(f.execute("safari_download_inspect", { node_id: "d1_n999" }), /current visible DOM/);
  assert.equal(f.calls.length, 3);
});
test("a download cannot reuse a preflight after the original turn, claim or sidebar owner changes", async () => {
  for (const change of ["turn", "claim", "owner", "release"]) {
    const f = fixture();
    await f.execute("dom_cua_get_visible_dom");
    const link = await f.execute("safari_download_inspect", { node_id: "d1_n3" });
    if (change === "turn") f.session.currentTurnId = "next-turn";
    if (change === "claim") f.session.requireOwnedTab = async () => { throw new Error("Tab is no longer claimed"); };
    if (change === "owner") f.setOwner({ instanceId: "next-owner", profileId: "55555555-5555-4555-8555-555555555555" });
    if (change === "release") f.agent.release(f.metadata.session_id, f.metadata.turn_id);
    await assert.rejects(f.execute("dom_cua_download_media", { node_id: "d1_n3", href: link.href }),
      /no longer active|no longer claimed|sidebar owner changed|current visible DOM/);
    assert.equal(f.calls.length, 2, "Invalidated preflight must not reach the transfer backend");
  }
});
test("double-click and modified page keys retain the original claimed native boundary", async () => {
  const f = fixture();
  await f.execute("dom_cua_get_visible_dom");
  await f.execute("dom_cua_double_click", { node_id: "d1_n1" });
  assert.equal(f.calls.at(-1).command.arguments.interactions[0].clickCount, 2);
  await f.execute("dom_cua_keypress", { keys: ["META", "a"] });
  assert.equal(f.calls.at(-1).command.arguments.interactions[0].key, "Meta+a");
  await assert.rejects(f.execute("dom_cua_keypress", { keys: ["META", "a", "b"] }), /one page key/);
});
test("the original browser clipboard is a real session and owner scoped virtual clipboard", async () => {
  const f = fixture();
  await f.execute("tab_clipboard_write_text", { text: "session-only clipboard" });
  assert.deepEqual(await f.execute("tab_clipboard_read_text"), { text: "session-only clipboard" });
  assert.equal(f.calls.length, 0, "virtual clipboard APIs must not read or overwrite the system clipboard");
  const image = [{ entries: [{ mime_type: "image/png", base64: "aW1hZ2U=" }] }];
  await f.execute("tab_clipboard_write", { items: image });
  assert.deepEqual(await f.execute("tab_clipboard_read"), { items: image });
  const first = await f.execute("tab_clipboard_read"); first.items[0].entries[0].base64 = "mutated";
  assert.deepEqual(await f.execute("tab_clipboard_read"), { items: image });
  f.agent.release(f.metadata.session_id);
  assert.deepEqual(await f.execute("tab_clipboard_read"), { items: [] });
});
test("original Playwright locators resolve a native target rather than dispatching synthetic input", async () => {
  const f = fixture();
  const original = f.agent;
  const requests = [];
  const companion = { async agentOwner() { return { instanceId: "sidebar", profileId: "profile", accountScope: "account" }; },
    async runAgentCommand(command) { requests.push(command); return command.action === "dom_query"
      ? { node: "real-query-node", documentId: "document", snapshotId: "snapshot", url: "https://example.com/" } : {}; } };
  const agent = createAgent({}, companion);
  await agent.execute({ type: "playwright_locator_fill", browser_id: "0", tab_id: "12", selector: 'internal:label="Project note"i', value: "Native replacement" }, f.session, f.metadata);
  assert.equal(requests[0].action, "dom_query");
  assert.equal(requests[0].arguments.command.selector, 'internal:label="Project note"i');
  assert.deepEqual(requests[1].arguments.interactions, [{ type: "type", node: "real-query-node", value: "Native replacement", replaceAll: true }]);
  assert.equal(original.supported.has("playwright_locator_fill"), true);
});
test("all original keyboard routes use the virtual clipboard and never send OS paste shortcuts", async () => {
  for (const route of ["dom_cua_keypress", "cua_keypress", "playwright_locator_press"]) {
    const f = fixture(); await f.execute("dom_cua_get_visible_dom"); await f.execute("dom_cua_click", { node_id: "d1_n1" });
    await f.execute("tab_clipboard_write_text", { text: "Virtual session payload" });
    const invoke = keys => f.execute(route, route === "playwright_locator_press" ? { selector: "input", value: keys.join("+") } : { keys });
    await invoke(["Control", "v"]);
    assert.deepEqual(f.calls.at(-1).command.arguments.interactions, [{ type: "type", node: "n1", value: "Virtual session payload", requireFocused: true }]);
    assert.equal(f.calls.some(call => call.command.arguments.interactions?.some(item => item.type === "key" && /[vV]$/.test(item.key))), false);
    if (route === "playwright_locator_press") {
      assert.ok(f.calls.some(call => call.command.arguments.command?.type === "safari_locator_focus"));
      assert.equal(f.calls.at(-1).command.arguments.interactions.some(item => item.type === "click"), false, "press must focus, not activate its target");
    }
    await invoke(["Meta", "Shift", "v"]);
    await invoke(["Shift", "Insert"]);
    await assert.rejects(invoke(["Meta", "Alt", "v"]), /Native clipboard shortcuts are disabled/);
    await f.execute("tab_clipboard_write", { items: [{ entries: [{ mime_type: "text/plain", text: "Plain" }, { mime_type: "text/html", text: "<b>Rich</b>" }] }] });
    await assert.rejects(invoke(["Meta", "v"]), /rich-text or binary/);
    await invoke(["Meta", "Shift", "v"]);
    assert.equal(f.calls.at(-1).command.arguments.interactions[0].value, "Plain");
  }
});
test("sequential typing sends Unicode characters once in bounded fresh native batches", async () => {
  const f = fixture(), value = "1234567890123456789😀ab";
  assert.deepEqual(await f.execute("playwright_locator_press_sequentially", { selector: "input", value }), {});
  const batches = f.calls.filter(call => call.command.action === "interact").map(call => call.command.arguments.interactions);
  assert.deepEqual(batches.map(batch => batch.length), [20, 2]);
  assert.equal(batches[0].at(-1).value, "😀");
  assert.equal(batches.flat().map(item => item.value).join(""), value);
  assert.ok(batches.flat().every(item => item.type === "type" && item.requireFocused === true && !item.replaceAll));
  assert.equal(f.calls.filter(call => call.command.arguments.command?.type === "safari_locator_focus").length, 2);
});
test("sequential typing never replays an incomplete or unverifiable native batch", async () => {
  for (const result of [{ completed: [{ type: "type" }] }, {}, { completed: [{ type: "click" }] }]) {
    const f = fixture(); f.setInteractionResult(result);
    await assert.rejects(f.execute("playwright_locator_press_sequentially", { selector: "input", value: "ab" }), /[Dd]o not repeat/);
    assert.equal(f.calls.filter(call => call.command.action === "interact").length, 1);
    assert.equal(f.calls.filter(call => call.command.arguments.command?.type === "safari_locator_focus").length, 1);
  }
});
test("sequential typing stops at a native dialog or delivered navigation", async () => {
  for (const state of ["dialogOpen", "pagePending"]) {
    const f = fixture(); f.setInteractionResult({ completed: [{ type: "type" }], [state]: true });
    const typing = f.execute("playwright_locator_press_sequentially", { selector: "input", value: "ab" });
    if (state === "dialogOpen") assert.deepEqual(await typing, {});
    else await assert.rejects(typing, /delivered 1 characters.*Do not repeat/);
    assert.equal(f.calls.filter(call => call.command.action === "interact").length, 1);
    assert.equal(f.calls.filter(call => call.command.arguments.command?.type === "safari_locator_focus").length, 1);
  }
});
test("file chooser waiters register before a concurrent click without holding the live broker", async () => {
  const f = fixture();
  const waiting = f.execute("playwright_wait_for_file_chooser", { timeout_ms: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0, "a local event waiter cannot occupy the serialized live broker");
  f.setInteractionResult({ completed: [{ type: "click" }], fileChooserOpen: true, fileChooser: { id: "native-chooser-a", isMultiple: false } });
  await f.execute("playwright_locator_click", { selector: "input[type=file]" });
  assert.deepEqual(await waiting, { file_chooser_id: "native-chooser-a", is_multiple: false });
  await assert.rejects(f.execute("safari_file_chooser_inspect", { file_chooser_id: "native-chooser-a", files: ["/tmp/first", "/tmp/second"] }), /does not accept multiple/);
  await f.execute("safari_file_chooser_inspect", { file_chooser_id: "native-chooser-a", files: ["/tmp/first"] });
  await f.execute("playwright_file_chooser_set_files", { file_chooser_id: "native-chooser-a", files: ["/tmp/first"] });
  assert.equal(f.calls.at(-1).command.action, "filechooser");
  assert.deepEqual(f.calls.at(-1).command.arguments.agentScope, { ownerId: "sidebar-a", sessionId: "thread-a", turnId: "turn-a" });
  await assert.rejects(f.execute("playwright_file_chooser_set_files", { file_chooser_id: "native-chooser-a", files: ["/tmp/first"] }), /stale Safari file chooser/);
});
test("file chooser waits end on turn release, timeout, or unverified native source", async () => {
  const released = fixture(), waiting = released.execute("playwright_wait_for_file_chooser", { timeout_ms: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  released.agent.release(released.metadata.session_id, released.metadata.turn_id);
  await assert.rejects(waiting, /ended with its original sidebar/);
  const expired = fixture(); await assert.rejects(expired.execute("playwright_wait_for_file_chooser", { timeout_ms: 1 }), /Timed out/);
  const unverified = fixture(), pending = unverified.execute("playwright_wait_for_file_chooser", { timeout_ms: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  unverified.setInteractionResult({ completed: [{ type: "click" }], fileChooserOpen: true, fileChooserError: "Unverified source; cancel this chooser" });
  await unverified.execute("playwright_locator_click", { selector: "button" });
  await assert.rejects(pending, /Unverified source/);
});
test("changing the ChatGPT account in the same sidebar cancels waiters and permanently invalidates the old turn", async () => {
  const f = fixture();
  await f.execute("tab_clipboard_write_text", { text: "Account-only virtual clipboard" });
  const pending = f.execute("playwright_wait_for_file_chooser", { timeout_ms: 1000 }); pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  f.setOwner({ accountScope: "different-account" });
  await assert.rejects(f.execute("dom_cua_get_visible_dom"), /sidebar owner changed.*ChatGPT account/);
  await assert.rejects(pending, /ended with its original sidebar/);
  await assert.rejects(f.agent.authorize(f.session, f.metadata), /sidebar owner changed/);
  assert.equal(f.calls.length, 0);
  f.metadata.turn_id = "new-turn"; f.session.currentTurnId = "new-turn";
  assert.deepEqual(await f.execute("tab_clipboard_read"), { items: [] });
});
test("content export preflight and delivery bind the actual account, owner, profile, and turn", async () => {
  const f = fixture();
  await f.execute("safari_content_export_inspect", { exportType: "tab_content_export_gsuite", format: "pdf" });
  const inspected = f.calls.at(-1).command;
  assert.equal(inspected.action, "dom_query"); assert.equal(inspected.arguments.command.kind, "gsuite");
  assert.deepEqual(JSON.parse(inspected.arguments.command.scope), ["thread-a", "turn-a", "sidebar-a", "55555555-5555-4555-8555-555555555555", "account-a"]);
  await f.execute("tab_content_export_gsuite", { format: "pdf", exportId: "a".repeat(32), href: "https://model-override.test/" });
  const delivered = f.calls.at(-1).command;
  assert.equal(delivered.action, "content_export"); assert.equal(delivered.arguments.exportId, "a".repeat(32));
  assert.equal(delivered.arguments.href, undefined); assert.equal(delivered.arguments.scope, inspected.arguments.command.scope);
  await assert.rejects(f.execute("tab_content_export_gsuite", { format: "pdf" }), /Inspect and approve/);
});
test("browser viewport commands delegate before tab-id parsing and release their exact session scope", async () => {
  const previous = globalThis.ChatGPTSafariViewport, calls = [];
  globalThis.ChatGPTSafariViewport = { createViewport() { return {
    async execute(command, session, metadata, owner, assertCurrent) { await assertCurrent(); calls.push({ command, metadata: { ...metadata }, owner }); return {}; },
    async release(sessionId, turnId) { calls.push({ sessionId, turnId }); },
  }; } };
  try {
    const f = fixture();
    await f.agent.execute({ type: "browser_viewport_set", browser_id: "0", width: 1000, height: 700 }, f.session, f.metadata);
    assert.equal(calls[0].command.tab_id, undefined); assert.equal(calls[0].owner.accountScope, "account-a");
    await f.agent.release("thread-a", "turn-a"); assert.deepEqual(calls.at(-1), { sessionId: "thread-a", turnId: "turn-a" });
  } finally { if (previous === undefined) delete globalThis.ChatGPTSafariViewport; else globalThis.ChatGPTSafariViewport = previous; }
});
