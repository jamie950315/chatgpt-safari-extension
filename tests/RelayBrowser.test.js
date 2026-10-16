const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../companion/relay/ProviderBrowser.js"), "utf8");
function setup() {
  const origin = "http://chatgpt-provider-fixture.localhost:34567", key = "a".repeat(64);
  const fetches = [], reports = [], listeners = [];
  class Element { setAttribute(name, value) { this[name] = value; } }
  function elementClass(property) {
    class Node extends Element {}
    Object.defineProperty(Node.prototype, property, { configurable: true, get() { return this._value; }, set(value) { this._value = value; } });
    return Node;
  }
  class XHR {
    open(...args) { this.args = args; }
    send(value) { this.body = value; }
    setRequestHeader(key, value) { (this.headers ||= {})[key] = value; }
  }
  const location = { origin, href: origin + "/c/fixture?surface=browser_side_chat&__chatgpt_key=" + key };
  const context = { URL, Request, Headers, Uint8Array, ArrayBuffer, Promise, TextEncoder, location,
    history: { state: null, replaceState(_state, _unused, url) { location.href = String(url); } },
    document: { addEventListener(name, callback) { listeners.push([name, callback]); } },
    Element, HTMLImageElement: elementClass("src"), HTMLScriptElement: elementClass("src"),
    HTMLLinkElement: elementClass("href"), HTMLIFrameElement: elementClass("src"), HTMLFormElement: class extends Element {},
    XMLHttpRequest: XHR,
    fetch: async (...args) => { (String(args[0]).endsWith("/__chatgpt/diagnostics") ? reports : fetches).push(args); return { ok: true }; },
  };
  context.window = context;
  vm.createContext(context);
  const bootstrap = { providerOrigin: origin, parentExtensionOrigin: "safari-web-extension://fixture-extension",
    bridgeToken: "b".repeat(64), key, runtimeURL: "https://chatgpt.com/cdn/assets/633146.c3403bd103.js" };
  vm.runInContext(source.replace("/*__CHATGPT_RELAY_BOOTSTRAP__*/", JSON.stringify(bootstrap)), context);
  return { context, config: context.ChatGPTSafariProviderRelay, fetches, reports, listeners, key, origin };
}

test("provider URL mapping keeps real origins and removes local capabilities from public links", () => {
  const { config, context, key, origin, listeners } = setup();
  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.providerOrigin, origin);
  assert.equal(config.parentExtensionOrigin, "safari-web-extension://fixture-extension");
  assert.equal(config.runtimeURL, "https://chatgpt.com/cdn/assets/633146.c3403bd103.js");
  assert.equal(context.location.href.includes("__chatgpt_key"), false);
  const mapped = config.importURL(config.runtimeURL);
  assert.equal(new URL(mapped).origin, origin);
  assert.equal(new URL(mapped).searchParams.get("__chatgpt_key"), null);
  assert.equal(config.upstreamURL(mapped), config.runtimeURL);
  const cdn = config.importURL("https://cdn.oaistatic.com/assets/fixture.js");
  assert.equal(config.upstreamURL(cdn), "https://cdn.oaistatic.com/assets/fixture.js");
  assert.throws(() => config.importURL("https://attacker.invalid/module.js"));
  assert.throws(() => config.importURL("https://secret@chatgpt.com/module.js"));
  assert.throws(() => config.upstreamURL(origin + "/__chatgpt/sidechat-host.js"));
  assert.throws(() => config.upstreamURL("https://attacker.invalid/"));
  assert.equal(listeners.some(([name]) => name === "message"), false, "Only SideChatBridge owns provider host messaging");
  assert.equal(config.key, undefined, "The HTTP capability remains inside the routing closure");
});

test("adapter imports share the original site's canonical public-module runtime identity", () => {
  const { config, key, origin } = setup();
  const entryURL = config.importURL("https://chatgpt.com/cdn/assets/entry.fixture123.js");
  const siteRuntimeURL = new URL("./633146.c3403bd103.js", entryURL).href;
  assert.equal(config.importURL(config.runtimeURL), siteRuntimeURL);
  assert.equal(siteRuntimeURL, origin + "/cdn/assets/633146.c3403bd103.js");
  const originalAsyncURL = new URL("../assets/async/637745.14f70978dc.js", siteRuntimeURL).href;
  assert.equal(config.importURL("https://chatgpt.com/cdn/assets/async/637745.14f70978dc.js"), originalAsyncURL);
  assert.equal(new URL(originalAsyncURL).search, "");
  const queried = config.importURL(config.runtimeURL + "?cohort=upstream-fixture");
  assert.equal(new URL(queried).searchParams.get("cohort"), "upstream-fixture");
  assert.equal(new URL(queried).searchParams.get("__chatgpt_key"), key);
  assert.equal(config.upstreamURL(queried), config.runtimeURL + "?cohort=upstream-fixture");
  const privateRoute = config.importURL("https://chatgpt.com/?surface=browser_side_chat");
  assert.equal(new URL(privateRoute).searchParams.get("__chatgpt_key"), key);
});

test("provider fetch rewrites only allowlisted origins and preserves real request bodies", async () => {
  const { context, fetches, key, origin } = setup();
  await context.fetch(new Request("https://chatgpt.com/backend-api/fixture", { method: "POST", body: "synthetic-prompt", headers: { "Content-Type": "text/plain" } }));
  const [url, options] = fetches[0];
  assert.equal(url, origin + "/backend-api/fixture");
  assert.equal(options.headers.get("X-ChatGPT-Relay"), key);
  assert.equal(Buffer.from(options.body).toString(), "synthetic-prompt");
  assert.equal(options.referrerPolicy, "no-referrer");
  await context.fetch("https://attacker.invalid/public-resource", { headers: { "X-Public-Fixture": "yes" } });
  assert.equal(fetches[1][0], "https://attacker.invalid/public-resource");
  assert.equal(fetches[1][1].headers["X-ChatGPT-Relay"], undefined);
});

test("provider boot reports directly through captured fetch without the functional host channel", async () => {
  const { config, reports, fetches, origin, key } = setup();
  await config.report({ state: "installed", usedOrigin: 1, channelConnected: true });
  assert.equal(fetches.length, 0);
  assert.equal(reports.length, 2);
  assert.deepEqual(JSON.parse(reports[0][1].body), { state: "loading" });
  assert.equal(reports[1][0], origin + "/__chatgpt/diagnostics");
  assert.equal(reports[1][1].headers["X-ChatGPT-Relay"], key);
  assert.equal(reports[1][1].credentials, "omit");
  assert.equal(reports[1][1].redirect, "error");
  assert.deepEqual(JSON.parse(reports[1][1].body), { state: "installed", usedOrigin: 1, channelConnected: true });
  await assert.rejects(config.report({ state: "failed", errors: [{ kind: "Error", frames: ["x".repeat(9000)] }] }), /8 KiB/);
});
