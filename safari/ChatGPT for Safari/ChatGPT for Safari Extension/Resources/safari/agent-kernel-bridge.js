/* The original agent's high-level Safari boundary, inside its security gate. */
(function (root) {
  "use strict";
  const nativeCommands = new Set([
    "dom_cua_get_visible_dom", "dom_cua_click", "dom_cua_type",
    "dom_cua_keypress", "dom_cua_scroll", "navigate_tab_url",
    "navigate_tab_back", "navigate_tab_forward", "navigate_tab_reload", "close_tab",
  ]);
  const originalCommands = new Set([
    "browser_user_open_tabs", "browser_user_claim_tab", "browser_user_get_tab_context",
    "get_tab", "list_tabs", "create_tab", "selected_tab", "mark_tab", "name_session",
  ]);
  let hostDocument;
  const status = { phase: "idle", requests: 0, replies: 0, failures: 0, connections: 0 };
  let browserConnection;
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

  async function dispatch(context, command, original) {
    if (context.clientInfo.family !== "safari") return original();
    if (!record(command) || typeof command.type !== "string") throw new Error("A Safari agent command is required.");
    if (originalCommands.has(command.type)) {
      // Original inventory/claim handlers do not call the live executor. Bind
      // these reads and leases to the same real sidebar owner as native input.
      await context.api.executeUnhandledCommand({ type: "browser_safari_context" });
      return original();
    }
    if (!nativeCommands.has(command.type)) throw new Error(`Safari does not support agent command "${command.type}".`);
    if (typeof command.browser_id !== "string" || !/^[1-9]\d*$/u.test(command.tab_id || "")
      || !Number.isSafeInteger(Number(command.tab_id))) throw new Error("A Safari agent command requires its browser and claimed tab IDs.");
    return context.api.executeUnhandledCommand({ type: "browser_safari_command", command });
  }

  function ensureHostDocument(api = root.chrome, document = root.document) {
    if (hostDocument) return hostDocument.ready;
    if (!document?.body || root.window?.parent !== root.window) {
      return Promise.reject(new Error("Safari requires its persistent background document to start the agent kernel."));
    }
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    const state = { frame };
    state.ready = (async () => {
      status.phase = "preparing";
      const url = await root.ChatGPTSafariSidebarOptions.companion.agentKernelURL();
      validateSandboxURL(url);
      return new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          root.clearTimeout(timer);
          frame.removeEventListener("load", loaded);
          frame.removeEventListener("error", failed);
          if (error) {
            frame.remove();
            if (hostDocument === state) hostDocument = undefined;
            reject(error);
          } else resolve();
        };
        const loaded = () => { status.phase = "host_loaded"; finish(); };
        const failed = () => finish(new Error("The Safari agent host document could not load."));
        frame.addEventListener("load", loaded, { once: true });
        frame.addEventListener("error", failed, { once: true });
        timer = root.setTimeout(() => finish(new Error("The Safari agent host document did not load within 10 seconds.")), 10000);
        frame.src = api.runtime.getURL("js-kernel-offscreen.html") + "?kernel=" + encodeURIComponent(url);
        document.body.append(frame);
      });
    })().catch(error => { status.phase = "failed"; status.failures++; frame.remove(); if (hostDocument === state) hostDocument = undefined; throw error; });
    hostDocument = state;
    return state.ready;
  }

  function validateSandboxURL(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !/^chatgpt-kernel-[a-f0-9-]+\.localhost$/u.test(url.hostname)
      || !url.port || url.username || url.password || url.hash || url.pathname !== "/sandbox"
      || [...url.searchParams].length !== 1 || !/^[a-f0-9]{64}$/u.test(url.searchParams.get("cap") || "")) {
      throw new Error("Invalid isolated Safari agent kernel URL.");
    }
    return url.href;
  }

  function sandboxURL() { return validateSandboxURL(new URLSearchParams(root.location.search).get("kernel")); }

  function portTransport(port) {
    const listeners = new Set();
    let closed = false, callback;
    const finish = () => {
      if (closed) return;
      closed = true; port.close();
      for (const listener of listeners) Promise.resolve(listener()).catch(() => {});
      listeners.clear();
    };
    port.onmessage = event => {
      if (closed) return;
      if (event.data?.type === "close") finish();
      else if (event.data?.type === "message") callback?.(event.data.value);
    };
    port.onmessageerror = finish;
    port.start();
    return {
      sendMessage(value) { if (closed) throw new Error("The Safari kernel browser connection is closed."); port.postMessage({ type: "message", value }); },
      setMessageCallback(value) { callback = value; },
      addCloseListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      close() { if (!closed) { port.postMessage({ type: "close" }); finish(); } },
    };
  }

  function connectBrowser(scopeId) {
    if (root.window.parent === root.window || root.window.parent.parent === root.window.parent) {
      throw new Error("The Safari kernel browser connection requires its background host.");
    }
    const channel = new root.MessageChannel();
    const transport = portTransport(channel.port1);
    root.window.parent.parent.postMessage({ type: "chatgpt-safari:kernel-browser", scopeId }, "*", [channel.port2]);
    return transport;
  }

  function onBrowserConnection(listener) {
    if (browserConnection) throw new Error("The Safari kernel browser listener is already registered.");
    browserConnection = listener;
    root.window.addEventListener("message", event => {
      if (!event.isTrusted || event.data?.type !== "chatgpt-safari:kernel-browser" || event.ports.length !== 1) return;
      const port = event.ports[0];
      let frame;
      try {
        const expected = new URL(root.chrome.runtime.getURL("js-kernel-host.html"));
        const origin = new URL(event.origin);
        if (origin.protocol !== expected.protocol || origin.host.toLowerCase() !== expected.host.toLowerCase()) throw new Error();
        frame = [...(hostDocument?.frame.contentDocument?.querySelectorAll("iframe") || [])].find(item => item.contentWindow === event.source);
        const url = new URL(frame?.src);
        if (url.protocol !== expected.protocol || url.host.toLowerCase() !== expected.host.toLowerCase()
          || url.pathname !== expected.pathname || !event.data.scopeId || url.searchParams.get("scopeId") !== event.data.scopeId) throw new Error();
      } catch { port.postMessage({ type: "close" }); port.close(); return; }
      status.connections++;
      listener(event.data.scopeId, portTransport(port));
    });
  }

  async function sendRequest(request) {
    status.requests++;
    await ensureHostDocument();
    const target = hostDocument.frame.contentWindow;
    if (!target) throw new Error("The Safari agent host document is unavailable.");
    // Safari treats an iframe in its persistent background as the same message
    // context: runtime.sendMessage does not deliver to this replacement for
    // Chrome's offscreen document. Use the original protocol over a real port.
    const channel = new root.MessageChannel();
    return new Promise((resolve, reject) => {
      const close = () => { channel.port1.close(); channel.port2.close(); };
      channel.port1.onmessage = event => {
        if (event.data?.type === "chatgpt-safari:kernel-progress" && event.data.phase === "received") {
          status.phase = "executing"; return;
        }
        status.replies++; status.phase = event.data?.ok === true ? "ready" : "failed";
        if (event.data?.ok !== true) status.failures++;
        close(); resolve(event.data);
      };
      channel.port1.onmessageerror = () => { status.phase = "failed"; status.failures++; close(); reject(new Error("The Safari agent host returned unreadable data.")); };
      try { status.phase = "sent"; target.postMessage(request, "*", [channel.port2]); }
      catch (error) { close(); reject(error); }
    });
  }

  const bridge = Object.freeze({ dispatch, ensureHostDocument, sendRequest, sandboxURL, connectBrowser, onBrowserConnection,
    status: () => ({ ...status }) });
  if (typeof module !== "undefined" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariAgentKernel", { value: bridge });
})(globalThis);
