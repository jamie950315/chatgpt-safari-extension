/* Original side-chat host boundary for the native profile and isolated provider frame. */
globalThis.__CHATGPT_SAFARI_ADAPTER_READY__ = (async () => {
  "use strict";
  const relay = window.ChatGPTSafariProviderRelay;
  const relayMode = relay != null;
  const actualOrigin = location.origin;
  // Safari serializes extension UUID hosts in canonical lowercase, while
  // runtime.getURL can preserve uppercase. Compare the same exact principal.
  const parentOriginMatches = value => typeof value === "string"
    && value.toLowerCase() === relay?.parentExtensionOrigin?.toLowerCase();
  if (relayMode) {
    const provider = new URL(relay.providerOrigin);
    if (window === window.top || provider.origin !== actualOrigin || provider.protocol !== "http:"
      || !/^chatgpt-provider-[a-z0-9-]+\.localhost$/u.test(provider.hostname)
      || !/^safari-web-extension:\/\/[^/]+$/u.test(relay.parentExtensionOrigin)
      || typeof relay.bridgeToken !== "string" || relay.bridgeToken.length < 32) throw new Error("Invalid isolated ChatGPT host boundary");
  } else if (window !== window.top || actualOrigin !== "https://chatgpt.com") return;
  const officialURL = value => relayMode ? relay.upstreamURL(value) : new URL(value, location.href).href;
  const documentAvailable = () => location.origin === actualOrigin;

  const isSideChat = new URL(location.href).searchParams.get("surface") === "browser_side_chat";
  if (!isSideChat) return;
  Object.defineProperty(window, "__CODEX_BROWSER_SIDE_CHAT__", { value: true });
  const nativeHandler = window.webkit?.messageHandlers?.chatgptSidechat;
  if (!relayMode && (!nativeHandler || typeof nativeHandler.postMessage !== "function")) return;
  let relayPort, connectResolve, connectReject;
  const relayPending = new Map();
  const handshake = { readyPosted: false, connectMessages: 0, parentSourceMatched: false,
    parentTokenMatched: false, parentOriginKind: "none" };
  const relayReady = relayMode ? new Promise((resolve, reject) => { connectResolve = resolve; connectReject = reject; }) : null;
  if (relayMode) {
    const connectTimer = setTimeout(() => connectReject(new Error("The Safari sidebar did not connect")), 10000);
    window.addEventListener("message", event => {
      if (event.data?.type === "chatgpt-safari-provider:connect") {
        handshake.connectMessages++;
        handshake.parentSourceMatched = event.source === window.parent;
        handshake.parentTokenMatched = event.data.token === relay.bridgeToken;
        handshake.parentOriginKind = parentOriginMatches(event.origin) ? "expected" : event.origin === "null" ? "opaque" : "other";
      }
      if (relayPort || event.source !== window.parent || !parentOriginMatches(event.origin)
        || event.data?.type !== "chatgpt-safari-provider:connect" || event.data.token !== relay.bridgeToken
        || event.ports?.length !== 1) return;
      relayPort = event.ports[0];
      clearTimeout(connectTimer);
      relayPort.onmessage = ({ data }) => {
        if (data?.type === "event") { api.receive(data.payload); return; }
        if (data?.type !== "reply" || typeof data.id !== "string") return;
        const pending = relayPending.get(data.id);
        if (!pending) return;
        relayPending.delete(data.id); clearTimeout(pending.timer);
        data.error ? pending.reject(new Error(String(data.error).slice(0, 1024))) : pending.resolve(data.result);
      };
      relayPort.onmessageerror = () => disconnectRelay();
      relayPort.postMessage({ type: "ready" });
      handshake.readyPosted = true;
      connectResolve();
    });
    window.addEventListener("pagehide", () => disconnectRelay(), { once: true });
    // The extension parent initiates after frame load, as in Margina. Reply
    // through its transferred port, not a message targeted at a custom scheme.
  }
  function disconnectRelay() {
    relayPort?.close();
    for (const pending of relayPending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The Safari sidebar disconnected")); }
    relayPending.clear();
  }
  async function sendRequest(method, params) {
    if (!relayMode) return nativeHandler.postMessage({ method, params });
    await relayReady;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { relayPending.delete(id); reject(new Error("The Safari sidebar request timed out")); }, 15000);
      relayPending.set(id, { resolve, reject, timer });
      relayPort.postMessage({ type: "request", id, method, params });
    });
  }
  const originalPostMessage = window.postMessage.bind(window);
  const requestTypes = new Map([
    ["browser_side_chat_context_requested", "context"],
    ["browser_side_chat_capabilities_requested", "capabilities"],
    ["browser_side_chat_tab_context_requested", "tabContext"],
    ["browser_side_chat_open_in_browser", "openInBrowser"],
    ["browser_side_chat_location_changed", "locationChanged"],
    ["browser_side_chat_auth_state_changed", "authStateChanged"],
  ]);
  let capabilities = {}, browserContext = { instanceId: null }, lastGestureAt = 0;
  let activeSearch = 0;
  const diagnostics = { outbound: {}, received: {}, failures: 0, scriptErrors: 0, unhandledRejections: 0 };
  window.addEventListener("error", () => { diagnostics.scriptErrors++; });
  window.addEventListener("unhandledrejection", () => { diagnostics.unhandledRejections++; });
  const siteAdapter = { state: "loading", modules: [], usedFactories: {}, connections: 0 };
  const caughtErrors = [];
  function captureError(error) {
    if (!error || typeof error.name !== "string" || caughtErrors.length >= 4) return;
    const frames = [];
    for (const line of String(error.stack || "").split("\n")) {
      const match = line.match(/(?:https?:\/\/[^/]+)?(\/cdn\/assets\/[a-zA-Z0-9._/-]+\.js):([0-9]+):([0-9]+)/u);
      if (match) frames.push(match[1] + ":" + match[2] + ":" + match[3]);
      if (frames.length >= 6) break;
    }
    const known = ["The side-chat extension is unavailable", "The Safari owner tab is no longer available", "The Safari side-chat context request timed out", "The ChatGPT account changed", "Load failed"];
    caughtErrors.push({ kind: ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "SecurityError", "DOMException"].includes(error.name) ? error.name : "UnknownError", frames,
      ...(known.includes(error.message) ? { reason: error.message } : {}) });
  }
  if (relayMode) {
    const originalError = console.error;
    console.error = function(...args) { for (const value of args) captureError(value); return originalError.apply(this, args); };
    window.addEventListener("error", event => captureError(event.error));
    window.addEventListener("unhandledrejection", event => captureError(event.reason));
    const report = setInterval(() => {
      void relay.report({ state: siteAdapter.state,
        usedOrigin: siteAdapter.usedFactories.aH || 0, usedConnection: siteAdapter.usedFactories.Kxt || 0,
        connections: siteAdapter.connections, contexts: diagnostics.outbound.context || 0,
        failures: diagnostics.failures, scriptErrors: diagnostics.scriptErrors,
        unhandledRejections: diagnostics.unhandledRejections, channelConnected: relayPort != null, ...handshake,
        errors: caughtErrors.map(error => ({ kind: error.kind, frames: error.frames.slice(0, 4) })) }).catch(() => {});
    }, 2000);
    window.addEventListener("pagehide", () => clearInterval(report), { once: true });
  }
  function validRecord(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
  function validRequestId(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
  function publish(payload) {
    if (!validRecord(payload) || typeof payload.type !== "string") return;
    diagnostics.received[payload.type] = (diagnostics.received[payload.type] || 0) + 1;
    // Native responses use the real top-level origin and a browser-generated MessageEvent.
    originalPostMessage(payload, location.origin);
  }
  function publishStatus() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-chatgpt-extension-status", JSON.stringify({ capabilities }));
    window.dispatchEvent(new Event("chatgpt-extension-status"));
  }
  async function request(method, params) {
    diagnostics.outbound[method] = (diagnostics.outbound[method] || 0) + 1;
    try { return await sendRequest(method, params); }
    catch (error) { diagnostics.failures++; throw error; }
  }
  class ContextInvalidated extends Error {}
  class NativeBrowserSideChatConnection {
    constructor({ pageWindow, getAuthScope }) {
      if (pageWindow !== window || !documentAvailable()) {
        throw new Error("The native side-chat document is not available");
      }
      siteAdapter.connections++;
      this.authScope = getAuthScope;
      this.listeners = new Set(); this.pending = new Set(); this.generation = 0;
      this.disposed = false; this.waiters = 0; this.currentContext = undefined;
      this.openAllowed = false; this.invocation = undefined; this.invocationListener = undefined;
      this.message = event => {
        if (event.source !== window || event.origin !== location.origin || !event.isTrusted) return;
        const payload = event.data;
        if (payload?.type === "browser_side_chat_context_invalidated" && payload.protocolVersion === 2) {
          this.invalidate(new ContextInvalidated("The side-chat context changed"));
          if (this.waiters === 0) void this.getContext().catch(() => {});
        } else if (payload?.type === "browser_side_chat_prompt_prefill") {
          this.invocation = payload; this.deliverInvocation();
        } else if (payload?.type === "update" && validRecord(payload.status)) {
          this.status = payload.status; this.notify();
        } else if (payload?.type === "browser_side_chat_capabilities") {
          this.notify();
        }
      };
      this.pageHide = () => { this.disposed = true; this.invalidate(); };
      this.pageShow = event => { if (event.persisted) { this.disposed = false; this.invalidate(); void this.getContext().catch(() => {}); } };
      window.addEventListener("message", this.message);
      window.addEventListener("pagehide", this.pageHide);
      window.addEventListener("pageshow", this.pageShow);
    }
    get confirmed() { return this.currentContext != null; }
    get context() { return this.currentContext; }
    get canOpenInBrowser() { return !this.disposed && this.openAllowed; }
    get extensionStatus() {
      return { ...this.status, toolbar: { pin: "unsupported" }, capabilities };
    }
    subscribe(listener) { this.listeners.add(listener); listener(); return () => this.listeners.delete(listener); }
    subscribeOpenInvocation(listener) {
      this.invocationListener = listener; this.deliverInvocation();
      return () => { if (this.invocationListener === listener) this.invocationListener = undefined; };
    }
    notify() { for (const listener of this.listeners) listener(); }
    invalidate(error = new Error("The side-chat context is no longer available")) {
      this.generation++; this.currentContext = undefined; this.openAllowed = false;
      for (const reject of this.pending) reject(error);
      this.pending.clear(); this.notify();
    }
    getContext(timeout = 5000) {
      if (this.disposed || !documentAvailable()) {
        return Promise.reject(new Error("The native side-chat document is not available"));
      }
      const generation = this.generation;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); this.pending.delete(cancel);
          error ? reject(error) : resolve(value);
        };
        const cancel = error => finish(error);
        const timer = setTimeout(() => finish(new Error("The Safari side-chat context request timed out")), Math.max(0, timeout));
        this.pending.add(cancel);
        void request("context", { requestId: crypto.randomUUID(), includeSelection: true }).then(result => {
          if (settled) return;
          if (generation !== this.generation || this.disposed) { finish(new ContextInvalidated("The side-chat context changed")); return; }
          const value = result?.context;
          if (!validRecord(value) || typeof value.instanceId !== "string"
            || !Number.isSafeInteger(value.tabId) || value.tabId < 0
            || !Number.isSafeInteger(value.windowId) || value.windowId < 0
            || (value.url !== null && typeof value.url !== "string")) {
            finish(new Error("The Safari owner tab is no longer available")); return;
          }
          this.currentContext = value;
          this.openAllowed = result?.capabilities?.["browserSideChat.openInBrowser"] === true;
          this.notify(); finish(null, value);
        }, error => finish(error));
      });
    }
    async waitForContext(timeout = 5000) {
      const deadline = Date.now() + timeout, scope = this.authScope();
      this.waiters++;
      try {
        for (;;) {
          try {
            const context = await this.getContext(Math.max(0, deadline - Date.now()));
            if (scope !== this.authScope()) throw new Error("The ChatGPT account changed");
            return context;
          } catch (error) {
            if (!(error instanceof ContextInvalidated) || Date.now() >= deadline
              || this.disposed || scope !== this.authScope()) throw error;
          }
        }
      } finally { this.waiters--; }
    }
    async prepareSubmit(message) {
      const generation = this.generation, scope = this.authScope();
      try {
        const context = await this.getContext();
        const assertCurrent = () => {
          if (generation !== this.generation || this.disposed || !this.confirmed || scope !== this.authScope()
            || context.selectedText !== this.currentContext?.selectedText
            || context.selectionId !== this.currentContext?.selectionId) throw new Error(message);
        };
        assertCurrent(); return { context, assertCurrent };
      } catch { throw new Error(message); }
    }
    setLocation(value) {
      if (this.disposed) return;
      let url; try { url = new URL(value, location.href); } catch { return; }
      if (url.origin === location.origin) void request("locationChanged", { url: officialURL(url.href) }).catch(() => {});
    }
    setAuthState(state) {
      if (this.disposed || !["expired", "logout_requested", "signed_in", "signed_out"].includes(state)) return;
      if (state !== "signed_in") { this.invocation = undefined; this.invalidate(); }
      void request("authStateChanged", { state }).catch(() => {});
    }
    deliverInvocation() {
      if (this.disposed || !this.invocationListener || !this.invocation) return;
      const invocation = this.invocation; this.invocation = undefined;
      const age = Date.now() - invocation.createdAtMs;
      if (age >= 0 && age <= 300000) this.invocationListener(invocation);
    }
    dispose() {
      this.disposed = true; this.invalidate(); this.listeners.clear(); this.invocation = undefined;
      this.invocationListener = undefined;
      window.removeEventListener("message", this.message);
      window.removeEventListener("pagehide", this.pageHide);
      window.removeEventListener("pageshow", this.pageShow);
    }
  }
  async function installSiteAdapter() {
    // The actual HTML selects the runtime; the host factories were checked against the served build.
    // The original site hard-codes Chrome iframe ancestry; replace its host boundary,
    // not browser globals, origins, the composer, or request construction.
    const runtimeURL = relayMode ? relay.runtimeURL : "https://chatgpt.com/cdn/assets/633146.c3403bd103.js";
    if (!/^https:\/\/chatgpt\.com\/cdn\/assets\/633146\.[a-f0-9]{10}\.js$/u.test(runtimeURL)) throw new Error("The ChatGPT deployment has no supported module runtime");
    siteAdapter.runtimeURL = runtimeURL;
    const { __webpack_require__: runtime } = await import(relayMode ? relay.importURL(runtimeURL) : runtimeURL);
    if (!runtime?.m || !runtime?.c || typeof runtime.d !== "function") throw new Error("Unsupported ChatGPT module runtime");
    const install = (id, create) => {
      if (runtime.c[id]) throw new Error("The ChatGPT native host adapter was installed too late: " + id);
      let factory = runtime.m[id];
      Object.defineProperty(runtime.m, id, {
        configurable: true, enumerable: true,
        get() {
          if (factory == null) return factory;
          const adapted = create(factory);
          return (...args) => {
            siteAdapter.usedFactories[id] = (siteAdapter.usedFactories[id] || 0) + 1;
            return adapted(...args);
          };
        },
        set(value) { factory = value; },
      });
      siteAdapter.modules.push(id);
    };
    install("aH", original => (module, exports, require) => {
      const upstream = {};
      original(module, upstream, require);
      const origin = candidate => !window.closed && documentAvailable()
        && candidate === window
        ? (relayMode ? relay.parentExtensionOrigin : actualOrigin) : upstream.a(candidate);
      require.d(exports, { a: () => origin });
    });
    install("Kxt", () => (module, exports, require) => {
      require.d(exports, { BrowserSideChatConnection: () => NativeBrowserSideChatConnection });
    });
    siteAdapter.state = "installed";
  }
  const adapterReady = installSiteAdapter().catch(error => {
    siteAdapter.state = "failed";
    siteAdapter.error = String(error?.message || error).slice(0, 512);
    if (relayMode) {
      void relayReady.then(() => relayPort.postMessage({ type: "failure", error: siteAdapter.error })).catch(() => {});
      throw error;
    }
  });
  async function handle(payload) {
    const method = requestTypes.get(payload.type);
    if (method === "capabilities") {
      const result = await request(method, {});
      capabilities = validRecord(result?.capabilities) ? result.capabilities : {};
      browserContext = validRecord(result?.browserContext) ? result.browserContext : { instanceId: null };
      publish({ type: "browser_side_chat_capabilities", browserContext, capabilities });
      publishStatus();
    } else if (method === "context") {
      if (payload.protocolVersion !== 2 || !validRequestId(payload.requestId)
        || (payload.includeSelection != null && typeof payload.includeSelection !== "boolean")) return;
      const result = await request(method, {
        requestId: payload.requestId, includeSelection: payload.includeSelection === true,
      });
      publish({ type: "browser_side_chat_context", protocolVersion: 2, requestId: payload.requestId,
        context: result?.context ?? null, capabilities: result?.capabilities ?? {} });
    } else if (method === "tabContext") {
      if (!validRequestId(payload.requestId)) return;
      const result = await request(method, { requestId: payload.requestId });
      publish({ type: "browser_side_chat_tab_context_changed", requestId: payload.requestId,
        tabId: result?.tabId ?? null, url: result?.url ?? null });
    } else if (method === "openInBrowser" || method === "locationChanged") {
      if (typeof payload.url !== "string" || payload.url.length > 16384) return;
      let url; try { url = new URL(payload.url); } catch { return; }
      if (url.origin !== actualOrigin || url.username || url.password) return;
      await request(method, { url: officialURL(url.href) });
    } else if (method === "authStateChanged") {
      if (!["expired", "logout_requested", "signed_in", "signed_out"].includes(payload.state)) return;
      await request(method, { state: payload.state });
    }
  }
  // At top level window.parent is this window. Route only the known host messages;
  // all unrelated postMessage calls keep their ordinary browser behavior.
  if (!relayMode) window.postMessage = function(message, targetOrigin, transfer) {
    if (validRecord(message) && requestTypes.has(message.type)) {
      void handle(message).catch(() => {});
      return;
    }
    return originalPostMessage(message, targetOrigin, transfer);
  };
  window.addEventListener("message", event => {
    if (event.isTrusted && event.source === window && event.origin === location.origin
      && validRecord(event.data) && requestTypes.has(event.data.type)) {
      void handle(event.data).catch(() => {});
    }
  });
  for (const type of ["click", "beforeinput", "paste", "pointerdown", "keydown"]) {
    document.addEventListener(type, event => { if (event.isTrusted) lastGestureAt = Date.now(); }, true);
  }
  window.addEventListener("chatgpt-extension-request-status", () => {
    void request("capabilities", {}).then(result => {
      capabilities = validRecord(result?.capabilities) ? result.capabilities : {};
      browserContext = validRecord(result?.browserContext) ? result.browserContext : { instanceId: null };
      publishStatus();
    }).catch(() => {});
  });
  window.addEventListener("chatgpt-extension-stop-browser-tabs", () => { activeSearch++; });
  window.addEventListener("pagehide", () => { activeSearch++; });
  window.addEventListener("chatgpt-extension-request-browser-tab-mentions", event => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!validRecord(detail) || Object.keys(detail).some(key => !["query", "limit"].includes(key))
      || typeof detail.query !== "string" || detail.query.length > 500
      || !Number.isSafeInteger(detail.limit) || detail.limit < 0 || detail.limit > 100
      || Date.now() - lastGestureAt >= 5000 || lastGestureAt === 0
      || capabilities["browserTabMentions.search"] !== true) return;
    const search = ++activeSearch;
    void request("tabMentions", { query: detail.query, limit: detail.limit }).then(result => {
      if (search !== activeSearch) return;
      const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute("data-chatgpt-extension-browser-tabs", JSON.stringify(candidates));
      try { window.dispatchEvent(new Event("chatgpt-extension-browser-tabs")); }
      finally { root.removeAttribute("data-chatgpt-extension-browser-tabs"); }
    }).catch(() => {});
  });
  const api = Object.freeze({
    receive(payload) {
      if (payload?.type === "browser_side_chat_capabilities") {
        capabilities = validRecord(payload.capabilities) ? payload.capabilities : {};
        browserContext = validRecord(payload.browserContext) ? payload.browserContext : { instanceId: null };
        publishStatus();
      }
      publish(payload);
    },
    diagnostics() {
      const urls = new Set();
      const resources = typeof globalThis.performance?.getEntriesByType === "function"
        ? globalThis.performance.getEntriesByType("resource").map(entry => entry.name) : [];
      for (const value of [...Array.from(document.scripts || [], script => script.src), ...resources]) {
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" || !["cdn.oaistatic.com", "chatgpt.com"].includes(url.hostname)
            || !/\.[cm]?js$/u.test(url.pathname)) continue;
          url.search = ""; url.hash = "";
          urls.add(url.href);
        } catch {}
      }
      return { ...JSON.parse(JSON.stringify(diagnostics)),
        siteAdapter: JSON.parse(JSON.stringify(siteAdapter)),
        sideChatPreloadFlag: window.__CODEX_BROWSER_SIDE_CHAT__ === true,
        parentIsSelf: window.parent === window,
        transport: relayMode ? "isolated-provider" : "native-profile",
        publicScripts: [...urls].sort().slice(0, 500) };
    },
  });
  Object.defineProperty(window, "__CHATGPT_SAFARI_SIDECAR__", { value: api });
  if (document.documentElement) publishStatus();
  else document.addEventListener("DOMContentLoaded", publishStatus, { once: true });
  await adapterReady;
})();
