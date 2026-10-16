/* Native top-level transport for the upstream browser-side-chat protocol. */
(() => {
  "use strict";
  if (window !== window.top || location.origin !== "https://chatgpt.com") return;
  const isSideChat = new URL(location.href).searchParams.get("surface") === "browser_side_chat";
  if (!isSideChat) return;
  Object.defineProperty(window, "__CODEX_BROWSER_SIDE_CHAT__", { value: true });
  const handler = window.webkit?.messageHandlers?.chatgptSidechat;
  if (!handler || typeof handler.postMessage !== "function") return;
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
    try { return await handler.postMessage({ method, params }); }
    catch (error) { diagnostics.failures++; throw error; }
  }
  class ContextInvalidated extends Error {}
  class NativeBrowserSideChatConnection {
    constructor({ pageWindow, getAuthScope }) {
      if (pageWindow !== window || location.origin !== "https://chatgpt.com") {
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
      if (this.disposed || location.origin !== "https://chatgpt.com") {
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
      if (url.origin === location.origin) void request("locationChanged", { url: url.href }).catch(() => {});
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
    // Exact deployment binding: these factories were inspected in the served 2026-10-16 build.
    // The original site hard-codes Chrome iframe ancestry; replace its host boundary,
    // not browser globals, origins, CSP, the composer, or request construction.
    const { __webpack_require__: runtime } = await import("https://chatgpt.com/cdn/assets/633146.1f9c264032.js");
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
      const origin = candidate => candidate === window && !window.closed && location.origin === "https://chatgpt.com"
        ? location.origin : upstream.a(candidate);
      require.d(exports, { a: () => origin });
    });
    install("Kxt", () => (module, exports, require) => {
      require.d(exports, { BrowserSideChatConnection: () => NativeBrowserSideChatConnection });
    });
    siteAdapter.state = "installed";
  }
  void installSiteAdapter().catch(error => {
    siteAdapter.state = "failed";
    siteAdapter.error = String(error?.message || error).slice(0, 512);
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
      if (url.origin !== "https://chatgpt.com" || url.username || url.password) return;
      await request(method, { url: url.href });
    } else if (method === "authStateChanged") {
      if (!["expired", "logout_requested", "signed_in", "signed_out"].includes(payload.state)) return;
      await request(method, { state: payload.state });
    }
  }
  // At top level window.parent is this window. Route only the known host messages;
  // all unrelated postMessage calls keep their ordinary browser behavior.
  window.postMessage = function(message, targetOrigin, transfer) {
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
        publicScripts: [...urls].sort().slice(0, 500) };
    },
  });
  Object.defineProperty(window, "__CHATGPT_SAFARI_SIDECAR__", { value: api });
  if (document.documentElement) publishStatus();
  else document.addEventListener("DOMContentLoaded", publishStatus, { once: true });
})();
