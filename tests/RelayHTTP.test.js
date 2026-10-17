const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createServer, request } = require("node:http");
const { connect } = require("node:net");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

test("provider relay uses real bounded HTTP, isolated capabilities, module gates, and SSE", { skip: process.platform !== "darwin", timeout: 90_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatgpt-provider-relay-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "relay");
  const compiled = spawnSync("xcrun", ["swiftc", "-swift-version", "5", "-D", "CHATGPT_RELAY_TESTING",
    "companion/relay/ProviderRelayPolicy.swift", "companion/relay/ProviderRelayCore.swift", "tests/RelayHTTP.swift", "-o", binary],
    { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const received = [];
  let sessionValid = true;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === "/api/auth/session") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessionValid ? { user: { id: "synthetic-user", email: "not-forwarded@example.invalid" },
        account: { id: "synthetic-account", structure: "personal", privateField: "not-forwarded" },
        accessToken: "synthetic-only", expires: new Date(Date.now() + 3600_000).toISOString() } : {}));
    } else if (req.url.startsWith("/backend-api/settings/user")) {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"fixture\":true}");
    } else if (req.url.startsWith("/__codex-api/settings/user")) {
      res.writeHead(404, { "Content-Type": "application/json" }); res.end("{\"fixture\":false}");
    } else if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n"); setTimeout(() => res.end("data: last\n\n"), 250);
    } else if (req.url === "/challenge") {
      res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" }); res.end("<h1>Never execute challenge content</h1>");
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/next?fixture=1" }); res.end();
    } else if (req.url === "/foreign") {
      res.writeHead(302, { Location: "https://attacker.invalid/" }); res.end();
    } else if (req.url === "/cookie") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "synthetic_provider=fixture; HttpOnly; Path=/" }); res.end("{}");
    } else if (req.url === "/cdn/assets/bad-html-123.js") {
      res.writeHead(200, { "Content-Type": "text/html" }); res.end("<script>unexpected</script>");
    } else if (req.url.startsWith("/cdn/assets/")) {
      res.writeHead(200, { "Content-Type": "application/javascript" }); res.end("export const fixture = true;");
    } else if (req.url === "/echo") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.concat(chunks));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-fixture'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests", "X-Frame-Options": "DENY" });
      res.end('<html><head><link rel="modulepreload" href="/cdn/assets/633146.c3403bd103.js"><script type="module" src="/cdn/assets/entry-123.js"></script><script type="module">import "./unchanged-relative.js"; globalThis.originalInline = true;</script></head><body>Actual fixture provider</body></html>');
    }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const child = spawn(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "companion/relay/ProviderBrowser.js")], { stdio: ["pipe", "ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  let pending = ""; const messages = [], waiters = [];
  child.stdio[3].on("data", chunk => {
    pending += chunk;
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), value = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (waiters.length) waiters.shift()(value); else messages.push(value);
    }
  });
  function next() {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Private fixture reply timed out")), 10_000);
      waiters.push(value => { clearTimeout(timeout); resolve(value); });
    });
  }
  let entry = await next();
  assert.match(new URL(entry.origin).hostname, /^chatgpt-provider-[a-z0-9-]+\.localhost$/);
  function call(target = "/", options = {}) {
    const url = new URL(entry.origin);
    const headers = { Host: url.host, ...(options.authorized === false ? {} : { "X-ChatGPT-Relay": entry.key }), ...options.headers };
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: url.port, path: target, method: options.method || "GET", headers }, res => {
        const chunks = []; let first = null, ended = false;
        res.on("data", chunk => { if (first === null) first = Date.now(); chunks.push(chunk); options.onData?.(chunk, ended); });
        res.on("end", () => { ended = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), first, endedAt: Date.now() }); });
        res.on("error", reject);
      });
      req.on("error", reject); req.end(options.body);
    });
  }
  const before = received.length;
  assert.equal((await call("/", { authorized: false })).status, 401);
  assert.equal((await call("/", { headers: { Host: "attacker.invalid" } })).status, 403);
  assert.equal((await call("/", { headers: { Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await call("/api/auth/signout")).status, 403);
  assert.equal(received.length, before, "Rejected routes must not reach upstream");
  const page = await call("/?surface=browser_side_chat");
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Actual fixture provider/);
  assert.match(page.headers["content-security-policy"], /object-src 'none'/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors http: https: safari-web-extension:\/\/fixture-extension/);
  assert.equal(page.headers["x-frame-options"], undefined);
  assert.equal(page.headers["set-cookie"], undefined);
  const html = page.body.toString();
  assert.equal((html.match(/await import\(/g) || []).length, 4);
  assert.ok(html.indexOf("/__chatgpt/browser.js") < html.indexOf("await import("));
  const inlineURL = html.match(/await import\("([^"]*__chatgpt_inline[^"]*)"\)/)?.[1];
  assert.ok(inlineURL);
  const inline = await call(new URL(inlineURL).pathname + new URL(inlineURL).search);
  assert.equal(inline.body.toString(), 'import "./unchanged-relative.js"; globalThis.originalInline = true;');
  assert.equal(new URL(inlineURL).pathname, "/", "Inline module relative imports keep the document's base directory");
  const browser = await call(`/__chatgpt/browser.js?__chatgpt_key=${entry.key}&__chatgpt_runtime=633146.c3403bd103.js`);
  assert.equal(browser.status, 200); assert.match(browser.body.toString(), /ChatGPTSafariProviderRelay/); assert.ok(browser.body.includes(Buffer.from(entry.bridgeToken)));
  const host = await call("/__chatgpt/sidechat-host.js");
  assert.match(host.body.toString(), /await globalThis\.__CHATGPT_SAFARI_ADAPTER_READY__/);
  await call("/cdn/assets/633146.c3403bd103.js", { authorized: false });
  const diagnostic = { state: "installed", usedOrigin: 2, usedConnection: 1, connections: 1, contexts: 1, failures: 0,
    scriptErrors: 1, unhandledRejections: 0, channelConnected: true, readyPosted: true,
    connectMessages: 1, parentSourceMatched: true, parentTokenMatched: true, parentOriginKind: "expected",
    errors: [{ kind: "TypeError", frames: ["/cdn/assets/async/637745.14f70978dc.js:12:34"] }] };
  const diagnosticPost = value => {
    const body = Buffer.from(JSON.stringify(value));
    return call("/__chatgpt/diagnostics", { method: "POST", body,
      headers: { Origin: entry.origin, "Content-Type": "application/json", "Content-Length": body.length } });
  };
  assert.equal((await diagnosticPost(diagnostic)).status, 200);
  assert.equal((await diagnosticPost({ ...diagnostic, message: "private error text" })).status, 400);
  assert.equal((await diagnosticPost({ ...diagnostic, errors: [{ kind: "Error", frames: ["/cdn/assets/fixture-123.js?private=secret"] }] })).status, 400);
  assert.equal((await diagnosticPost({ ...diagnostic, untrusted: "x".repeat(9000) })).status, 413);
  child.stdin.write("status\n"); const diagnosticStatus = await next();
  assert.deepEqual(diagnosticStatus.providerReport, diagnostic, "Rejected diagnostic payloads must not replace the last safe report");
  assert.equal(diagnosticStatus.requestRoutes.browserScript, 1);
  assert.equal(diagnosticStatus.requestRoutes.hostModule, 1);
  assert.equal(diagnosticStatus.requestRoutes.runtimeModule, 1);
  assert.ok(diagnosticStatus.requestRoutes.rejections >= 3);
  assert.equal((await call("/cdn/assets/fixture-123.js", { authorized: false })).status, 200);
  assert.equal((await call("/cdn/assets/async/637745.14f70978dc.js", { authorized: false })).status, 200);
  assert.equal(received.at(-1).headers.cookie, undefined);
  assert.equal((await call("/cdn/assets/async/../fixture-123.js", { authorized: false })).status, 401);
  assert.equal((await call("/cdn/assets/bad-html-123.js", { authorized: false })).status, 502);
  const redirected = await call("/redirect");
  assert.equal(redirected.status, 302); assert.equal(new URL(redirected.headers.location).origin, entry.origin);
  assert.equal((await call("/foreign")).status, 502);
  const challenged = await call("/challenge");
  assert.equal(challenged.status, 502); assert.ok(!challenged.body.includes(Buffer.from("Never execute challenge content")));
  await call("/cookie");
  await call("/next?__chatgpt_key=" + entry.key, { headers: { Cookie: "unrelated_browser_secret=forbidden", Referer: entry.origin + "/?__chatgpt_key=" + entry.key, "User-Agent": "Actual-Safari-Fixture/1.0" } });
  const last = received.at(-1);
  assert.equal(last.headers.cookie, "synthetic_provider=fixture");
  assert.equal(last.headers.referer, undefined); assert.equal(last.headers["x-chatgpt-relay"], undefined);
  assert.equal(last.headers["user-agent"], "Actual-Safari-Fixture/1.0", "The upstream sees the actual browser identity, not URLSession's default agent or an invented Chrome identity");
  assert.ok(!JSON.stringify(last.headers).includes(entry.key));
  await call("/cdn/assets/fixture-123.js");
  assert.equal(received.at(-1).headers.cookie, undefined, "Static provider resources remain cookie-free");
  const binaryBody = Buffer.from([0, 1, 2, 255, 128, 10]);
  assert.deepEqual((await call("/echo", { method: "POST", body: binaryBody, headers: { "Content-Length": binaryBody.length } })).body, binaryBody);
  const stream = await call("/stream");
  assert.equal(stream.body.toString(), "data: first\n\ndata: last\n\n");
  assert.ok(stream.endedAt - stream.first >= 150, "SSE must arrive before upstream completion");
  const rawStatus = await new Promise((resolve, reject) => {
    const url = new URL(entry.origin), socket = connect(Number(url.port), "127.0.0.1");
    let bytes = "";
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nX-ChatGPT-Relay: ${entry.key}\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n`));
    socket.on("data", chunk => { bytes += chunk; }); socket.on("end", () => resolve(Number(bytes.match(/^HTTP\/1.1 (\d+)/)?.[1]))); socket.on("error", reject);
  });
  assert.equal(rawStatus, 400);
  const protectedHeaders = { Authorization: "Bearer synthetic-provider-token", "ChatGPT-Account-ID": "synthetic-account-scope",
    "X-OpenAI-Expected-Account-Id": "synthetic-account-scope", Originator: "synthetic-browser-client", "OAI-Client-Version": "synthetic-client-version" };
  await call("/backend-api/settings/user?private=fixture-only", { headers: protectedHeaders });
  assert.equal(received.at(-1).headers["chatgpt-account-id"], "synthetic-account-scope");
  assert.equal(received.at(-1).headers["x-openai-expected-account-id"], "synthetic-account-scope");
  assert.equal(received.at(-1).headers.originator, "synthetic-browser-client");
  assert.equal(received.at(-1).headers.authorization, "Bearer synthetic-provider-token");
  await call("/cdn/assets/async/637745.14f70978dc.js", { headers: protectedHeaders });
  for (const name of ["authorization", "chatgpt-account-id", "x-openai-expected-account-id", "originator", "oai-client-version", "cookie"]) {
    assert.equal(received.at(-1).headers[name], undefined, `Static module must not receive protected ${name}`);
  }
  await call("/cdn/assets/fixture-123.js?cohort=synthetic", { headers: protectedHeaders });
  for (const name of ["authorization", "chatgpt-account-id", "x-openai-expected-account-id", "originator", "oai-client-version", "cookie"]) {
    assert.equal(received.at(-1).headers[name], undefined, `Authenticated static resource must not receive protected ${name}`);
  }
  await call("/__codex-api/settings/user");
  child.stdin.write("status\n"); const settingsStatus = await next();
  assert.deepEqual(settingsStatus.settingsRequests, [
    { path: "/backend-api/settings/user", method: "GET", status: 200, stage: "complete" },
    { path: "/__codex-api/settings/user", method: "GET", status: 404, stage: "complete" },
  ]);
  assert.ok(!JSON.stringify(settingsStatus.settingsRequests).includes("fixture-only"));
  assert.ok(!JSON.stringify(settingsStatus.settingsRequests).includes("synthetic-account-scope"));
  const old = entry;
  child.stdin.write("browser-session\n"); const guestSession = await next();
  assert.equal(guestSession.browserSessionAvailable, false);
  child.stdin.write("verify\n"); entry = await next();
  assert.equal(entry.verified, true); assert.notEqual(entry.key, old.key); assert.notEqual(entry.accountScope, old.accountScope);
  child.stdin.write("browser-session\n"); const browserSession = await next();
  assert.deepEqual(browserSession.browserSession, { accessToken: "synthetic-only", account: { id: "synthetic-account", structure: "personal" }, user: { id: "synthetic-user" } });
  child.stdin.write("status\n"); const safeStatus = await next();
  assert.ok(!JSON.stringify(safeStatus).includes("synthetic-only"));
  assert.equal((await call("/", { headers: { "X-ChatGPT-Relay": old.key } })).status, 401);
  sessionValid = false;
  child.stdin.write("verify\n"); entry = await next();
  assert.equal(entry.verified, false); assert.equal((await call("/")).status, 503);
  child.stdin.write("clear\n"); const cleared = await next();
  assert.notEqual(cleared.key, entry.key); assert.notEqual(cleared.bridgeToken, entry.bridgeToken);
  child.stdin.write("stop\n");
});
