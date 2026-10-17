const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createDownloads, downloadPageOperation, assetInventoryPageOperation, chunkBytes } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/downloads-background.js");

function fixture(options = {}) {
  const calls = [], writes = [], content = options.content || Buffer.from("Authenticated Safari download ✓");
  const anchor = { href: options.href || "https://example.com/report.txt", isConnected: true, matches: value => value === "a[href]",
    getBoundingClientRect: () => ({ width: 100, height: 20 }), getAttribute: name => name === "download" ? "link-name.txt" : null };
  const live = { documentId: "document-a", snapshotId: "snapshot-a", url: "https://example.com/start", nodes: new Map([["n1", anchor]]) };
  const location = { href: live.url, origin: "https://example.com" };
  const page = vm.createContext({ URL, AbortController, Uint8Array, TextEncoder, btoa, setTimeout, clearTimeout, location,
    getComputedStyle: () => ({ visibility: "visible", display: "inline", opacity: "1" }), addEventListener() {},
    __chatGPTSafariLiveDocument: live,
    async fetch(url, init) {
      calls.push({ url, init });
      if (options.fetchError) throw new TypeError("redirect rejected");
      let used = false;
      return { ok: true, status: options.status ?? 200, redirected: options.redirected || false, url: options.finalURL || url, type: options.responseType || "basic",
        headers: new Headers({ "content-type": "text/plain", "content-disposition": "attachment; filename*=UTF-8''report%20%E2%9C%93.txt",
          ...(options.contentLength ? { "content-length": options.contentLength } : {}) }),
        body: { getReader() { return { async read() {
          if (used) return { done: true };
          used = true; return { done: false, value: new Uint8Array(content) };
        }, async cancel() {} }; } } };
    } });
  const args = { handle: "live:profile-a:12", expectedUrl: live.url, documentId: live.documentId, snapshotId: live.snapshotId,
    node: "n1", href: anchor.href };
  const operation = async (name, value = args) => {
    page.operation = name; page.args = value;
    const result = await vm.runInContext(`(${(name.startsWith("inventory-") ? assetInventoryPageOperation : downloadPageOperation).toString()})(operation, args)`,
      Object.assign(page, { operation: name.replace(/^inventory-/, "") }));
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.result;
  };
  const unwrap = result => {
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || "Rejected"), result?.error);
    return result.result;
  };
  const api = { scripting: { async executeScript(request) {
    assert.equal(request.target.tabId, 12);
    const [name, value] = request.args;
    try { return [{ result: { ok: true, result: await operation(request.func === assetInventoryPageOperation ? "inventory-" + name : name, value) } }]; }
    catch (error) { return [{ result: { ok: false, error: { code: error.code, message: error.message } } }]; }
  } } };
  let sequence = 0, written = 0;
  const downloads = createDownloads({ api, async target(handle, expectedUrl) {
    assert.equal(handle, args.handle);
    if (expectedUrl !== undefined && location.href !== expectedUrl) throw new Error("The page navigated");
    return { id: 12 };
  }, async send(command) {
    writes.push(command);
    assert.equal(command.id, "operation-a"); assert.equal(command.profileId, "profile-a"); assert.equal(command.sessionId, "session-a");
    const input = command.input;
    if (input.action === "bundleBegin") return { ok: true, result: { bundleId: "bundle-a", directoryPath: "/Downloads/Bundle" } };
    if (input.action === "bundleFinish") return { ok: true, result: { directoryPath: "/Downloads/Bundle", manifestPath: "/Downloads/Bundle/manifest.json" } };
    if (input.action === "begin") return { ok: true, result: { transferId: "native-a" } };
    if (input.action === "append") {
      assert.equal(input.sequence, sequence++);
      written += Buffer.from(input.data, "base64").length;
      if (options.cancelAfterAppend) return { ok: false, error: { code: "AGENT_OWNER_CHANGED", message: "The owner changed" } };
      if (options.mutateAfterAppend) anchor.href = "https://example.com/other.txt";
      return { ok: true, result: { sequence, bytesWritten: written } };
    }
    if (input.action === "finish") { assert.equal(input.expectedBytes, written); return { ok: true, result: { state: "complete", path: "/Downloads/report.txt", bytesWritten: written } }; }
    return { ok: true, result: { aborted: true } };
  }, profileId: "profile-a", sessionId: "session-a", assertTime() {}, unwrap });
  return { args, calls, writes, content, anchor, live, location, operation, page, downloads,
    execute: () => downloads.execute({ id: "operation-a" }, { id: 12 }, args) };
}

test("a real link is fetched in its own cookie context, streamed in bounded chunks, and only completed after native confirmation", async () => {
  const f = fixture({ content: Buffer.alloc(chunkBytes * 2 + 137, 0x42) });
  const inspected = await f.downloads.inspect({ id: 12 }, f.args);
  assert.equal(inspected.href, f.args.href);
  assert.equal(f.calls.length, 0, "Inspection must not start a download before the original policy approves it");
  const result = await f.execute();
  assert.equal(result.state, "complete"); assert.equal(result.bytesWritten, f.content.length);
  assert.equal(f.calls.length, 1, "A delivered fetch must not be retried");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.mode, "same-origin"); assert.equal(f.calls[0].init.redirect, "manual");
  assert.equal(f.writes[0].input.filename, "report ✓.txt");
  const chunks = f.writes.filter(x => x.input.action === "append").map(x => Buffer.from(x.input.data, "base64"));
  assert.deepEqual(chunks.map(x => x.length), [chunkBytes, chunkBytes, 137]);
  assert.deepEqual(Buffer.concat(chunks), f.content);
  assert.equal(f.writes.at(-1).input.action, "finish");
});

test("stale snapshots, changed approved links, and JavaScript controls cannot start network transfer", async () => {
  const stale = fixture(); stale.live.snapshotId = "next-snapshot";
  await assert.rejects(stale.execute(), /current visible DOM/); assert.equal(stale.calls.length, 0);
  const cross = fixture(); cross.anchor.href = "https://other.example/report.txt";
  await assert.rejects(cross.execute(), /current visible DOM/); assert.equal(cross.calls.length, 0);
  const button = fixture(); button.anchor.matches = () => false;
  await assert.rejects(button.execute(), /JavaScript buttons/); assert.equal(button.calls.length, 0);
});

test("redirects and oversized response headers fail without producing a file", async () => {
  for (const options of [{ fetchError: true }, { redirected: true }, { responseType: "opaqueredirect", status: 0 }, { finalURL: "https://other.example/report.txt" }, { contentLength: String(33 * 1024 * 1024) }]) {
    const f = fixture(options);
    await assert.rejects(f.execute(), /download request failed|redirect without a policy-approved/);
    assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0);
  }
});
test("an approved cross-origin HTTP link uses ordinary-page credentialed CORS and exact native bytes", async () => {
  const f = fixture({ href: "https://approved-cdn.example/report.txt" });
  const selected = await f.downloads.inspect({ id: 12 }, f.args);
  assert.equal(selected.href, f.anchor.href); assert.equal(f.calls.length, 0);
  const result = await f.execute(); assert.equal(result.state, "complete");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.credentials, "include");
  assert.equal(f.calls[0].init.mode, "cors"); assert.equal(f.calls[0].init.redirect, "manual");
  assert.deepEqual(Buffer.concat(f.writes.filter(x => x.input.action === "append").map(x => Buffer.from(x.input.data, "base64"))), f.content);
  const denied = fixture({ href: "https://approved-cdn.example/report.txt", fetchError: true });
  await assert.rejects(denied.execute(), /Safari denied credentialed CORS/); assert.equal(denied.calls.length, 1); assert.equal(denied.writes.length, 0);
});

test("owner cancellation or link changes discard a partial transfer, never finish or retry it", async () => {
  for (const options of [{ cancelAfterAppend: true }, { mutateAfterAppend: true }]) {
    const f = fixture(options);
    await assert.rejects(f.execute(), /owner changed|current visible DOM/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes.filter(x => x.input.action === "finish").length, 0);
    assert.equal(f.writes.at(-1).input.action, "abort");
    assert.equal(f.page.__chatGPTSafariDownloadState.size, 0);
  }
});
test("observed inline assets produce exact bundle bytes and a manifest referencing confirmed native files", async () => {
  const f = fixture();
  const markup = '<svg xmlns="http://www.w3.org/2000/svg"><text>Observed asset ✓</text></svg>';
  f.live.assetInventories = new Map([["inventory-a", { scope: "session-owner-turn", documentId: f.live.documentId, pageUrl: f.location.href,
    items: new Map([["svg-1", { id: "svg-1", kind: "image", name: "Observed", inline: true, url: "inline-svg:svg-1", markup }]]) }]]);
  const args = { handle: f.args.handle, scope: "session-owner-turn", inventoryId: "inventory-a", assetIds: ["svg-1"] };
  const inspected = await f.downloads.inspectAssets({ id: 12 }, args);
  assert.equal(inspected.assets[0].inline, true); assert.equal(f.writes.length, 0);
  const result = await f.downloads.bundle({ id: "operation-a" }, { id: 12 }, args);
  assert.equal(result.summary.downloadedCount, 1); assert.equal(result.summary.failedCount, 0);
  assert.equal(result.manifestPath, "/Downloads/Bundle/manifest.json");
  const bytes = Buffer.concat(f.writes.filter(x => x.input.action === "append").map(x => Buffer.from(x.input.data, "base64")));
  assert.equal(bytes.toString("utf8"), markup);
  assert.equal(f.writes[0].input.action, "bundleBegin");
  const final = f.writes.find(x => x.input.action === "bundleFinish");
  assert.equal(final.input.manifest.assets[0].path, result.assets[0].path);
  assert.equal(f.calls.length, 0, "Inline SVG bytes must not trigger an unapproved network fetch");
  await assert.rejects(f.downloads.bundle({ id: "operation-a" }, { id: 12 }, { ...args, scope: "other-owner" }), /current claimed document/);
});
