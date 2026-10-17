const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const bridge = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/download-realm-background.js");

function fixture(options = {}) {
  const calls = [], listeners = new Map(), timers = new Map(), counters = { readers: 0, reads: 0, cancels: 0, releases: 0 };
  let now = 100, timerId = 0, sent = false;
  const bytes = options.bytes || Buffer.from("Ordinary destination session ✓ 繁體中文\n");
  const live = { documentId: "destination-document", snapshotId: "destination-snapshot", url: "https://destination.test/existing" };
  const location = { href: live.url, origin: "https://destination.test" };
  const args = { intentId: "original-operation", scope: "original-owner-account-profile-session-turn",
    documentId: live.documentId, snapshotId: live.snapshotId, expectedUrl: live.url, href: "https://destination.test/private.bin",
    nonce: "11111111-1111-4111-8111-111111111111", remainingMs: 30000 };
  const reader = options.reader || { async read() { counters.reads++; if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(bytes) }; }, async cancel() { counters.cancels++; }, releaseLock() { counters.releases++; } };
  const response = { ok: true, redirected: false, type: "basic", status: 200, url: args.href,
    headers: new Headers({ "content-type": "application/octet-stream; charset=utf-8", "content-disposition": "attachment; filename*=UTF-8''owned-%E4%B8%AD%E6%96%87.bin", ...options.headers }),
    body: { getReader() { counters.readers++; if (counters.readers > 1) throw new Error("Body reused"); return reader; }, async cancel() { counters.cancels++; } }, ...options.response };
  const sandbox = vm.createContext({ __chatGPTSafariLiveDocument: live, location, URL, Headers, Uint8Array, AbortController, btoa,
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    async fetch(href, input) { calls.push({ href, input }); return options.fetch ? options.fetch(href, input, response) : response; } });
  const invoke = async (operation, overrides = {}) => {
    sandbox.operation = operation; sandbox.args = { ...args, ...overrides };
    return vm.runInContext(`(${bridge.realmPageOperation.toString()})(operation,args)`, sandbox);
  };
  const run = async (operation, overrides) => {
    const value = await invoke(operation, overrides);
    if (!value.ok) throw Object.assign(new Error(value.error.message), value.error);
    return value.result;
  };
  return { args, live, location, sandbox, response, reader, counters, bytes, calls, timers, run, invoke,
    pagehide() { listeners.get("pagehide")(); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    now() { return now; } };
}

test("the serialized destination operation owns one exact Response and never refetches its body", async () => {
  const f = fixture({ bytes: Buffer.alloc(110000, 0xab) });
  assert.equal(Object.isFrozen(bridge), true); assert.equal(bridge.chunkBytes, 49152); assert.equal(bridge.maximumBytes, 33554432);
  await f.run("arm"); assert.equal(f.calls.length, 0);
  assert.equal((await f.run("check")).phase, "armed");
  const result = await f.run("fetch"); assert.equal(result.kind, "response"); assert.equal(result.status, 200); assert.equal(result.url, f.args.href);
  assert.equal(f.counters.readers, 0); assert.equal(f.counters.reads, 0, "Native receipt verification happens before any body read");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.credentials, "same-origin"); assert.equal(f.calls[0].input.mode, "same-origin"); assert.equal(f.calls[0].input.redirect, "manual");
  assert.deepEqual(Object.keys(f.calls[0].input.headers), ["X-ChatGPT-Safari-Transfer"]);
  assert.equal(f.calls[0].input.headers["X-ChatGPT-Safari-Transfer"], f.args.nonce);
  const metadata = await f.run("metadata"); assert.equal(metadata.filename, "owned-中文.bin"); assert.equal(metadata.mime, "application/octet-stream");
  assert.equal(f.counters.readers, 1); assert.equal(f.counters.reads, 0);
  await assert.rejects(f.run("metadata"), /one retained response/);
  const chunks = [];
  for (;;) {
    const next = await f.run("read");
    if (next.done) { assert.equal(next.bytes, f.bytes.length); break; }
    const bytes = Buffer.from(next.data, "base64"); assert.equal(bytes.length, next.bytes); assert.ok(bytes.length <= 49152); chunks.push(bytes);
  }
  assert.deepEqual(chunks.map(bytes => bytes.length), [49152, 49152, 11696]);
  assert.deepEqual(Buffer.concat(chunks), f.bytes); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 1);
  assert.equal((await f.run("check")).phase, "done");
  await assert.rejects(f.run("read"), /already reached EOF/);
  await f.run("cancel"); assert.equal(f.timers.size, 0);
});

test("EOF releases the body but preserves the unchanged document deadline for writer finish check and final cancel", async () => {
  for (const finish of ["cancel", "deadline"]) {
    const f = fixture(); await f.run("arm"); await f.run("fetch", { remainingMs: 40 }); await f.run("metadata");
    const first = await f.run("read"); assert.equal(first.done, false);
    f.advance(25); const eof = await f.run("read"); assert.equal(eof.done, true); assert.equal(eof.bytes, f.bytes.length);
    assert.equal(f.counters.releases, 1); assert.equal(f.counters.cancels, 0);
    const lease = f.sandbox.__chatGPTSafariDownloadRealms.leases.get(f.args.intentId);
    assert.equal(lease.phase, "done"); assert.equal(lease.reader, null); assert.equal(lease.response, null); assert.equal(lease.pending, null);
    assert.equal(lease.deadline, 140, "EOF cannot reset the fetch-plus-body budget");
    assert.equal((await f.run("check")).alive, true);
    await assert.rejects(f.run("read"), /already reached EOF/);
    if (finish === "deadline") { f.advance(15); await assert.rejects(f.run("check"), /document, snapshot, scope/); }
    else { await f.run("cancel"); await assert.rejects(f.run("check"), /document, snapshot, scope/); }
    assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  }
});

test("1024 nonce tombstones stay bounded without eviction and block new arms and already-armed fetches", async () => {
  const f = fixture({ response: { ok: false, status: 0, type: "opaqueredirect", url: "", body: null } });
  const nonce = index => index.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
  for (let index = 1; index < 1024; index++) {
    await f.run("arm"); await f.run("fetch", { nonce: nonce(index) }); await f.run("cancel");
  }
  await f.run("arm"); await f.run("arm", { intentId: "prearmed-second-operation" });
  await f.run("fetch", { nonce: nonce(1024) }); await f.run("cancel");
  assert.equal((await f.invoke("arm")).error.code, "DOWNLOAD_REALM_CAPACITY");
  assert.equal((await f.invoke("fetch", { intentId: "prearmed-second-operation", nonce: nonce(1025) })).error.code, "DOWNLOAD_REALM_CAPACITY");
  assert.equal((await f.invoke("fetch", { intentId: "prearmed-second-operation", nonce: nonce(1) })).error.code, "DOWNLOAD_REALM_USED");
  assert.equal(f.sandbox.__chatGPTSafariDownloadRealms.usedNonces.size, 1024);
  assert.equal(f.sandbox.__chatGPTSafariDownloadRealms.usedNonces.has(nonce(1)), true);
  assert.equal(f.calls.length, 1024);
  await f.run("cancel", { intentId: "prearmed-second-operation" }); assert.equal(f.timers.size, 0);
});

test("arm rejects another origin, credentials, fragments and stale destination identity without requesting", async () => {
  for (const overrides of [{ href: "https://source.test/private.bin" }, { href: "https://user:password@destination.test/private.bin" },
    { href: "blob:https://destination.test/id" }, { href: "https://destination.test/private.bin#fragment" },
    { documentId: "original-source-document" }, { snapshotId: "stale" }, { expectedUrl: "https://destination.test/new" }]) {
    const f = fixture(); assert.equal((await f.invoke("arm", overrides)).ok, false); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.run("arm"); await assert.rejects(f.run("arm"), /unused exact/); assert.equal(f.calls.length, 0);
});

test("manual redirects have no readable response or automatic next hop and the old nonce cannot be reused", async () => {
  const f = fixture({ response: { ok: false, status: 0, type: "opaqueredirect", url: "", body: null } });
  await f.run("arm"); assert.equal((await f.run("fetch")).kind, "redirect"); assert.equal(f.calls.length, 1); assert.equal(f.counters.readers, 0);
  await assert.rejects(f.run("fetch"), /one fresh nonce/);
  await assert.rejects(f.run("metadata"), /one retained response/);
  await f.run("cancel"); await f.run("arm");
  await assert.rejects(f.run("fetch"), /one fresh nonce/); assert.equal(f.calls.length, 1);
  const nextNonce = "22222222-2222-4222-8222-222222222222";
  assert.equal((await f.run("fetch", { nonce: nextNonce })).kind, "redirect"); assert.equal(f.calls.length, 2);
  await f.run("cancel"); assert.equal(f.timers.size, 0);
});

test("fetch requires the armed exact URL, fresh nonce and bounded active time", async () => {
  for (const overrides of [{ href: "https://destination.test/other" }, { nonce: "invalid" }, { remainingMs: 0 }, { remainingMs: 30001 }, { remainingMs: 1.5 }]) {
    const f = fixture(); await f.run("arm"); assert.equal((await f.invoke("fetch", overrides)).ok, false); assert.equal(f.calls.length, 0); await f.run("cancel");
  }
});

test("non-success, opaque, followed or mismatched responses fail without a reader or retry", async () => {
  for (const response of [{ ok: false, status: 401 }, { type: "opaque" }, { redirected: true }, { url: "https://destination.test/unapproved" }, { body: null }]) {
    const f = fixture({ response }); await f.run("arm"); assert.equal((await f.invoke("fetch")).ok, false);
    assert.equal(f.counters.readers, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.signal.aborted, true); assert.equal(f.timers.size, 0);
    await assert.rejects(f.run("fetch"), /document, snapshot, scope/); assert.equal(f.calls.length, 1);
  }
});

test("destination changes, pagehide and deadline abort retained bodies and return no stale bytes", async () => {
  for (const change of ["document", "snapshot", "url", "scope", "pagehide", "deadline"]) {
    const f = fixture(); await f.run("arm"); await f.run("fetch"); await f.run("metadata");
    if (change === "document") f.live.documentId = "new-document";
    if (change === "snapshot") f.live.snapshotId = "new-snapshot";
    if (change === "url") f.location.href = "https://destination.test/new";
    if (change === "pagehide") f.pagehide();
    if (change === "deadline") f.advance(30000);
    const value = await f.invoke("read", change === "scope" ? { scope: "foreign-owner" } : {});
    assert.equal(value.ok, false); assert.equal(value.result, undefined); assert.equal(f.counters.reads, 0);
    if (change !== "scope") assert.equal(f.calls[0].input.signal.aborted, true);
    await f.run("cancel"); assert.equal(f.timers.size, 0);
  }
  const f = fixture(); await f.run("arm"); f.advance(90000); await assert.rejects(f.run("check"), /document, snapshot, scope/); assert.equal(f.calls.length, 0);
});

test("fetch and body use one unchanged deadline rather than resetting the budget at metadata", async () => {
  let f;
  f = fixture({ fetch(_url, _input, response) { f.advance(20); return response; } });
  await f.run("arm"); const result = await f.run("fetch", { remainingMs: 30 }); assert.equal(result.elapsedMs, 20);
  await f.run("metadata"); f.advance(10);
  await assert.rejects(f.run("read"), /document, snapshot, scope/); assert.equal(f.counters.reads, 0);
});

test("cancellation while a read is pending cannot publish its later bytes or overwrite a rearmed lease", async () => {
  let release;
  const f = fixture({ reader: { read() { return new Promise(resolve => { release = resolve; }); }, async cancel() {} } });
  await f.run("arm"); await f.run("fetch"); await f.run("metadata");
  const pending = f.invoke("read"); await Promise.resolve();
  await f.run("cancel"); await f.run("arm");
  release({ done: false, value: new Uint8Array([1, 2, 3]) });
  assert.equal((await pending).ok, false); assert.equal((await f.run("check")).phase, "armed"); await f.run("cancel");
});

test("a cancelled pending fetch cannot adopt a late Response into a newly armed lease", async () => {
  let release;
  const f = fixture({ fetch(_href, _input, response) { return new Promise(resolve => { release = () => resolve(response); }); } });
  await f.run("arm"); const pending = f.invoke("fetch"); await Promise.resolve();
  await f.run("cancel"); await f.run("arm"); release();
  const value = await pending; assert.equal(value.error.code, "DOWNLOAD_REALM_FETCH_FAILED");
  assert.equal(f.counters.readers, 0); assert.equal((await f.run("check")).phase, "armed"); assert.equal(f.calls.length, 1);
  await f.run("cancel");
});

test("overlapping reads fail closed and cancel the first pending read", async () => {
  let release;
  const f = fixture({ reader: { read() { return new Promise(resolve => { release = resolve; }); }, async cancel() {} } });
  await f.run("arm"); await f.run("fetch"); await f.run("metadata");
  const pending = f.invoke("read"); await Promise.resolve();
  const overlap = await f.invoke("read"); assert.equal(overlap.error.code, "DOWNLOAD_REALM_SEQUENCE");
  release({ done: false, value: new Uint8Array([1]) }); assert.equal((await pending).ok, false); assert.equal(f.calls.length, 1);
});

test("declared and streamed size limits cancel without returning an oversized chunk", async () => {
  for (const length of ["33554433", "invalid"]) {
    const f = fixture({ headers: { "content-length": length } }); await f.run("arm"); await f.run("fetch");
    const result = await f.invoke("metadata"); assert.equal(result.error.code, "DOWNLOAD_SIZE"); assert.equal(f.counters.readers, 0); assert.equal(f.calls[0].input.signal.aborted, true);
  }
  const f = fixture({ bytes: Buffer.alloc(33554433) }); await f.run("arm"); await f.run("fetch"); await f.run("metadata");
  let delivered = 0;
  for (;;) {
    const value = await f.invoke("read");
    if (!value.ok) { assert.equal(value.error.code, "DOWNLOAD_SIZE"); break; }
    delivered += value.result.bytes;
  }
  assert.ok(delivered <= 33554432); assert.equal(f.calls[0].input.signal.aborted, true); assert.equal(f.calls.length, 1);
});

test("browser export is frozen and page serialization needs no module closure", () => {
  const sandbox = { globalThis: {} };
  const path = require.resolve("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/download-realm-background.js");
  vm.runInNewContext(fs.readFileSync(path, "utf8"), sandbox);
  assert.equal(Object.isFrozen(sandbox.globalThis.ChatGPTSafariDownloadRealm), true);
  assert.equal(typeof sandbox.globalThis.ChatGPTSafariDownloadRealm.realmPageOperation, "function");
});
