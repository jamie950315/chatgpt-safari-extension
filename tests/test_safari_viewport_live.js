const test = require("node:test");
const assert = require("node:assert/strict");
const { createLive } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/live-background.js");

test("viewport set commits a genuinely restored owner; reset bypasses selection and uses the real background session", async () => {
  const profile = "55555555-5555-4555-8555-555555555555", background = "background-session";
  const tab = { id: 12, windowId: 20, url: "https://fixture.test/source", active: true };
  const ownerTab = { id: 24, windowId: 20, url: "https://fixture.test/owner", active: true };
  const selected = [], committed = [], executions = [];
  const api = { runtime: { async sendNativeMessage() { return { ok: true, requests: [] }; } },
    storage: { local: { async get() { return { safariLiveProfileId: profile }; } } },
    tabs: { async get() { return { ...tab }; } } };
  const environment = { crypto: { randomUUID: () => background }, setInterval() {}, clearInterval() {},
    ChatGPTSafariSidebar: { async withAgentSelection(owner, target, operation, scope) {
      selected.push([owner, target.id]); const value = await operation({ assertCurrent() {} });
      await scope.afterOwnerRestored(ownerTab); return value;
    } }, ChatGPTSafariViewport: {
      async run(request, selection) { executions.push({ request, selection }); return {}; },
      async commitReturnPage(request, returned) { committed.push({ request, returned }); },
    } };
  const live = createLive(api, environment); await live.start();
  const request = operation => ({ id: "native-operation", agentOwner: "owner", sessionId: "untrusted-override", deadline: Date.now() + 10000,
    command: { action: "viewport", arguments: { operation, handle: `live:${profile}:12`, expectedUrl: tab.url } } });
  await live.execute(request("set"));
  assert.deepEqual(selected, [["owner", 12]]); assert.equal(committed.length, 1);
  assert.equal(committed[0].request.sessionId, background); assert.equal(committed[0].returned, ownerTab);
  delete environment.ChatGPTSafariSidebar;
  await live.execute(request("reset"));
  assert.equal(selected.length, 1); assert.equal(committed.length, 1);
  assert.equal(executions[1].selection, undefined); assert.equal(executions[1].request.sessionId, background);
});
