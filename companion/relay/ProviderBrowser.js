/* Runs only in the unprivileged relayed provider origin, never in extension UI. */
((bootstrap) => {
  "use strict";
  const localOrigin = location.origin;
  const officialOrigin = "https://chatgpt.com";
  const allowed = new Set(["chatgpt.com", "cdn.oaistatic.com", "persistent.oaistatic.com"]);
  const key = bootstrap.key;
  const originalFetch = window.fetch.bind(window);
  if (bootstrap.providerOrigin !== localOrigin || !/^[a-f0-9]{64}$/.test(key)
    || !/^safari-web-extension:\/\/[A-Za-z0-9-]{1,128}$/.test(bootstrap.parentExtensionOrigin)
    || !/^[a-f0-9]{64}$/.test(bootstrap.bridgeToken)
    || !/^https:\/\/chatgpt\.com\/cdn\/assets\/633146\.[a-f0-9]{10}\.js$/.test(bootstrap.runtimeURL)) {
    throw new Error("The ChatGPT provider relay bootstrap is invalid");
  }
  const clean = new URL(location.href);
  clean.searchParams.delete("__chatgpt_key");
  history.replaceState(history.state, "", clean);

  function route(input, capability = true) {
    const target = new URL(input, location.href);
    if (!["http:", "https:"].includes(target.protocol)) return target;
    let result = target;
    if (target.origin !== localOrigin) {
      if (target.protocol !== "https:" || target.port || target.username || target.password || !allowed.has(target.hostname)) return target;
      const path = target.hostname === "chatgpt.com" ? target.pathname : `/__chatgpt/upstream/${target.hostname}${target.pathname}`;
      result = new URL(path + target.search + target.hash, localOrigin);
    }
    if (capability) result.searchParams.set("__chatgpt_key", key);
    return result;
  }

  function importURL(input) {
    const original = new URL(input, officialOrigin);
    if (original.username || original.password || original.protocol !== "https:" || original.port || !allowed.has(original.hostname)) {
      throw new Error("The provider module URL is not allowlisted");
    }
    // Public hashed modules are already validated and cookie-free at the relay.
    // Keep their exact canonical URL so adapter imports share the site's ESM runtime.
    const publicModule = original.origin === officialOrigin && !original.search
      && /^\/cdn\/assets\/(?:async\/)?[A-Za-z0-9_-]+[.-][A-Za-z0-9._-]+\.js$/.test(original.pathname);
    return route(original.href, !publicModule).href;
  }

  function upstreamURL(input) {
    const target = new URL(input, location.href);
    if (target.origin === officialOrigin && !target.username && !target.password && !target.port) return target.href;
    if (target.origin !== localOrigin || target.username || target.password) throw new Error("The provider URL has another origin");
    target.searchParams.delete("__chatgpt_key");
    target.searchParams.delete("__chatgpt_inline");
    let host = "chatgpt.com", path = target.pathname;
    const prefix = "/__chatgpt/upstream/";
    if (path.startsWith(prefix)) {
      const split = path.slice(prefix.length).indexOf("/");
      if (split < 0) throw new Error("The provider URL is invalid");
      host = path.slice(prefix.length, prefix.length + split);
      path = path.slice(prefix.length + split);
      if (!allowed.has(host)) throw new Error("The provider URL is not allowlisted");
    } else if (path.startsWith("/__chatgpt/")) throw new Error("Internal relay URLs have no public destination");
    return new URL(path + target.search + target.hash, `https://${host}`).href;
  }

  let reportQueue = Promise.resolve();
  async function report(value) {
    const body = JSON.stringify(value);
    if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > 8192) {
      throw new RangeError("The provider diagnostic report exceeds 8 KiB");
    }
    const next = reportQueue.then(async () => {
      const response = await originalFetch(localOrigin + "/__chatgpt/diagnostics", {
        method: "POST", headers: { "Content-Type": "application/json", "X-ChatGPT-Relay": key },
        body, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("The provider diagnostic report was rejected");
    });
    // A later observation is independent; failed reports are never replayed.
    reportQueue = next.catch(() => {});
    return next;
  }

  Object.defineProperty(globalThis, "ChatGPTSafariProviderRelay", { value: Object.freeze({
    providerOrigin: localOrigin,
    parentExtensionOrigin: bootstrap.parentExtensionOrigin,
    bridgeToken: bootstrap.bridgeToken,
    runtimeURL: bootstrap.runtimeURL,
    importURL, upstreamURL, report,
  }) });
  // Host messaging belongs solely to SideChatBridge. This shim exposes no account/native operations.

  async function bufferedBody(request, signal) {
    if (signal?.aborted) throw signal.reason;
    if (!request.body) return new ArrayBuffer(0);
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal?.aborted) throw signal.reason;
        if (done) break;
        size += value.byteLength;
        if (size > 32 * 1024 * 1024) {
          reader.cancel("upload limit").catch(() => {});
          throw new RangeError("The provider upload exceeds 32 MiB");
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return body.buffer;
    } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  }
  window.fetch = async function providerFetch(input, init) {
    const original = input instanceof Request ? input : null;
    const target = route(original ? original.url : String(input), false);
    if (target.origin !== localOrigin || !["http:", "https:"].includes(target.protocol)) return originalFetch(input, init);
    const options = { ...(original ? {
      method: original.method, headers: original.headers, signal: original.signal,
      credentials: original.credentials, redirect: original.redirect, cache: original.cache,
    } : {}), ...init };
    if (original && original.method !== "GET" && original.method !== "HEAD" && init?.body === undefined) {
      options.body = await bufferedBody(original, options.signal);
    }
    const headers = new Headers(options.headers);
    headers.set("X-ChatGPT-Relay", key);
    return originalFetch(target.href, { ...options, headers, referrerPolicy: "no-referrer" });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const localXHR = new WeakSet();
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const target = route(String(url), false);
    if (target.origin === localOrigin && ["http:", "https:"].includes(target.protocol)) localXHR.add(this);
    else localXHR.delete(this);
    return originalOpen.call(this, method, target.href, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (localXHR.has(this)) this.setRequestHeader("X-ChatGPT-Relay", key);
    return originalSend.call(this, body);
  };

  const originalAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (["src", "href", "action", "poster"].includes(String(name).toLowerCase()) && typeof value === "string" && !/^(?:data:|blob:|#)/i.test(value)) {
      try { value = route(value).href; } catch { /* The browser reports an invalid resource normally. */ }
    }
    return originalAttribute.call(this, name, value);
  };
  for (const [prototype, property] of [[HTMLImageElement.prototype, "src"], [HTMLScriptElement.prototype, "src"], [HTMLLinkElement.prototype, "href"], [HTMLIFrameElement.prototype, "src"]]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set || !descriptor.configurable) continue;
    Object.defineProperty(prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, route(String(value)).href); } });
  }
  document.addEventListener("click", event => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.getAttribute("href").startsWith("#")) return;
    const mapped = route(anchor.href);
    if (mapped.origin === localOrigin) originalAttribute.call(anchor, "href", mapped.href);
  }, true);
  document.addEventListener("submit", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) originalAttribute.call(form, "action", route(form.action).href);
  }, true);
  void report({ state: "loading" }).catch(() => {});
})(/*__CHATGPT_RELAY_BOOTSTRAP__*/);
