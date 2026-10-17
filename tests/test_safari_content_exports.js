const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { contentExportPageOperation, youtubeTranscriptPageOperation, formatYouTubeTranscript, createExports } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/downloads-background.js");

function fixture(url = "https://docs.google.com/document/d/document-id/edit?tab=t.1#heading") {
  const requests = [], events = [];
  const location = { href: url };
  let response = { bytes: Buffer.from("%PDF-1.7\nReal document bytes\n"), mime: "application/pdf", url: "https://docs.google.com/document/d/document-id/export?format=pdf", status: 200 };
  const context = vm.createContext({ location, document: { title: "Example - Google Docs" }, crypto: require("node:crypto").webcrypto,
    TextEncoder, TextDecoder, Uint8Array, URL, AbortController, setTimeout, clearTimeout, btoa, addEventListener(type, callback) { events.push({ type, callback }); },
    async fetch(href, options) {
      requests.push({ href, options });
      const value = new Response(response.bytes, { status: response.status, headers: { "content-type": response.mime } });
      Object.defineProperty(value, "url", { value: response.url }); return value;
    } });
  const operation = vm.runInContext(`(${contentExportPageOperation.toString()})`, context);
  const inspect = (kind = "gsuite", format = "pdf") => operation("inspect", { scope: "real-account-owner-session-turn", kind, format });
  return { operation, inspect, location, requests, events, setResponse(value) { response = { ...response, ...value }; } };
}

test("Google exports derive official current-document URLs and require the exact document/account scope", async () => {
  const f = fixture(), result = await f.inspect(); assert.equal(result.ok, true);
  assert.equal(result.result.href, "https://docs.google.com/document/d/document-id/export?format=pdf&tab=t.1#heading");
  assert.equal(f.requests.length, 0, "Inspecting an export for original consent must not fetch or write it");
  const args = { scope: "real-account-owner-session-turn", exportId: result.result.exportId };
  assert.equal((await f.operation("check", { ...args, scope: "different-account" })).ok, false);
  f.location.href = "https://docs.google.com/document/d/replaced-id/edit";
  assert.equal((await f.operation("start", args)).ok, false); assert.equal(f.requests.length, 0);
  for (const url of ["https://untrusted.test/document/d/id/edit", "http://docs.google.com/document/d/id/edit", "https://docs.google.com/document/d/id/pub", "https://docs.google.com/spreadsheets/d/id/edit"]) {
    assert.equal((await fixture(url).inspect("gsuite", "docx")).ok, false);
  }
});

test("Google exports return actual bounded bytes and reject login HTML or a mismatched file format", async () => {
  for (const bad of [false, "html", "format"]) {
    const f = fixture();
    if (bad === "html") f.setResponse({ bytes: Buffer.from("<!doctype html><html>Sign in</html>"), mime: "text/html" });
    if (bad === "format") f.setResponse({ bytes: Buffer.from("not a PDF"), mime: "application/pdf" });
    const selected = (await f.inspect()).result, args = { scope: "real-account-owner-session-turn", exportId: selected.exportId };
    const started = await f.operation("start", args);
    if (bad) assert.equal(started.ok, false);
    else {
      assert.equal(started.ok, true); const chunk = await f.operation("read", args);
      assert.equal(Buffer.from(chunk.result.data, "base64").toString(), "%PDF-1.7\nReal document bytes\n");
      assert.equal((await f.operation("read", args)).result.done, true);
    }
    assert.equal(f.requests[0].options.credentials, "same-origin");
    assert.equal(Object.hasOwn(f.requests[0].options, "headers"), false, "No account identity or cookies are manually attached");
    await f.operation("cancel", args);
  }
  const markdown = fixture(); markdown.setResponse({ bytes: Buffer.from("# Heading\n\n[image]: <data:image/png;base64,private-inline>\n\nActual text\n"), mime: "text/plain" });
  const selected = (await markdown.inspect("gsuite", "md")).result, args = { scope: "real-account-owner-session-turn", exportId: selected.exportId };
  assert.equal((await markdown.operation("start", args)).ok, true);
  const chunk = await markdown.operation("read", args); assert.equal(Buffer.from(chunk.result.data, "base64").toString(), "# Heading\nActual text");
  await markdown.operation("cancel", args);
});

test("the fixed YouTube helper uses the current player, fetches only observed captions, and restores subtitle state", async () => {
  for (const initiallyEnabled of [false, true]) {
    const videoId = "abcDEF123_-", url = "https://www.youtube.com/watch?v=" + videoId;
    let enabled = initiallyEnabled, observer, disconnected = false, fetches = 0;
    const player = { getVideoData() { return { video_id: videoId }; }, isSubtitlesOn() { return enabled; },
      toggleSubtitles() { enabled = !enabled; }, toggleSubtitlesOn() { enabled = true; observer([{ name: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=zh-TW&kind=asr", startTime: 100 }]); } };
    const operation = vm.runInNewContext(`(${youtubeTranscriptPageOperation.toString()})`, {
      location: { href: url }, document: { querySelector(selector) { return selector === "ytd-player" ? { getPlayer() { return player; } } : player; } },
      Reflect, URL, Uint8Array, TextDecoder, AbortController, setTimeout, clearTimeout, performance: { now: () => 100 },
      PerformanceObserver: class { constructor(callback) { observer = entries => callback({ getEntries: () => entries }); } observe() {} disconnect() { disconnected = true; } },
      async fetch(href, options) { fetches++; assert.equal(new URL(href).pathname, "/api/timedtext"); assert.equal(new URL(href).searchParams.get("fmt"), "json3");
        assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
        return new Response(JSON.stringify({ events: [{ tStartMs: 65000, segs: [{ utf8: "Actual captions 繁體中文" }] }] }), { headers: { "content-type": "application/json" } }); }
    });
    const result = await operation(videoId, url), text = formatYouTubeTranscript(videoId, result, url);
    assert.match(text, /Language: zh-TW/); assert.match(text, /\[1:05\] Actual captions 繁體中文/);
    assert.equal(enabled, initiallyEnabled); assert.equal(disconnected, true); assert.equal(fetches, 1);
    assert.throws(() => formatYouTubeTranscript(videoId, { ...result, pageUrl: url + "&changed=1" }, url), /invalid transcript/);
  }
});

test("content exports return a real native path only after exact writer completion and abort on owner change", async () => {
  for (const cancelOwner of [false, true]) {
    const f = fixture(), selected = (await f.inspect()).result, calls = [], written = [];
    let allowed = true, sequence = 0, bytes = 0;
    const api = { scripting: { async executeScript(script) {
      assert.equal(script.world, "ISOLATED"); assert.equal(script.func, contentExportPageOperation);
      return [{ result: await f.operation(...script.args) }];
    } } };
    const unwrap = value => { if (!value?.ok) throw new Error(value?.error?.message || "Rejected"); return value.result; };
    const exports = createExports({ api, profileId: "profile", sessionId: "background-session", assertTime() {}, unwrap,
      async target(handle, url) { assert.equal(url, f.location.href); if (!allowed) throw Object.assign(new Error("The original owner changed"), { code: "AGENT_OWNER_CHANGED" }); },
      async send(command) {
        calls.push(command.input.action);
        assert.equal(command.action, "liveDownload"); assert.equal(command.id, "real-operation");
        if (command.input.action === "begin") return { ok: true, result: { transferId: "native-transfer" } };
        if (command.input.action === "append") {
          assert.equal(command.input.sequence, sequence); const chunk = Buffer.from(command.input.data, "base64"); written.push(chunk); bytes += chunk.length; sequence++;
          if (cancelOwner) allowed = false;
          return { ok: true, result: { bytesWritten: bytes, sequence } };
        }
        if (command.input.action === "finish") { assert.equal(command.input.expectedBytes, bytes); return { ok: true, result: { path: "/Downloads/native-completed.pdf" } }; }
        return { ok: true, result: { cancelled: true } };
      } });
    const result = exports.execute({ id: "real-operation" }, { id: 12, url: f.location.href }, { handle: "real-handle", kind: "gsuite", format: "pdf", exportId: selected.exportId, scope: "real-account-owner-session-turn" });
    if (cancelOwner) { await assert.rejects(result, /owner changed/); assert.deepEqual(calls, ["begin", "append", "abort"]); }
    else { assert.deepEqual(await result, { path: "/Downloads/native-completed.pdf" }); assert.deepEqual(calls, ["begin", "append", "finish"]); }
    assert.equal(Buffer.concat(written).toString(), "%PDF-1.7\nReal document bytes\n");
    assert.equal((await f.operation("check", { scope: "real-account-owner-session-turn", exportId: selected.exportId })).ok, false, "Completed or cancelled source bytes must be released");
  }
});
