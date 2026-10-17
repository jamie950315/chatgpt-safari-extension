const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-background.js");
function fixture() {
  const calls = [], metadata = { session_id: "thread-a", turn_id: "turn-a" };
  const page = { documentId: "document-a", snapshotId: "snapshot-a", url: "https://example.com/", title: "Existing signed-in page",
    text: "Page-only verification text", focusedNode: null, nodes: [{ node: "n1", tag: "input", label: "Project note" }, { node: "n2", tag: "button", label: "Apply" }] };
  let owner = { instanceId: "sidebar-a", profileId: "55555555-5555-4555-8555-555555555555" }, error;
  const session = { currentTurnId: metadata.turn_id, async requireOwnedTab(id) { if (id !== 12) throw new Error("Tab is not claimed by this session"); } };
  const companion = { async agentOwner() { return owner; }, async runAgentCommand(command, expected) {
    calls.push({ command, expected });
    if (error) throw error;
    if (command.action === "read_page") return { ...page };
    if (command.action === "interact") { page.snapshotId += "-next"; page.focusedNode = "n1"; return { page: { ...page }, completed: [{ type: command.arguments.interactions[0].type }] }; }
    return { status: "complete" };
  } };
  const agent = createAgent({ tabs: { async get() { return { url: page.url }; } } }, companion);
  const execute = (type, params = {}) => agent.execute({ type, browser_id: "0", tab_id: "12", ...params }, session, metadata);
  return { agent, calls, metadata, session, execute, setOwner(next) { owner = next; }, setError(next) { error = next; } };
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
  assert.equal(f.calls.length, 1);
});
