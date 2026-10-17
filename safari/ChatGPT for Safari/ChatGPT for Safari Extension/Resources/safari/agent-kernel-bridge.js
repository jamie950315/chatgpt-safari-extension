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
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

  async function dispatch(context, command, original) {
    if (context.clientInfo.family !== "safari") return original();
    if (!record(command) || typeof command.type !== "string") throw new Error("A Safari agent command is required.");
    if (originalCommands.has(command.type)) return original();
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
        const loaded = () => finish();
        const failed = () => finish(new Error("The Safari agent host document could not load."));
        frame.addEventListener("load", loaded, { once: true });
        frame.addEventListener("error", failed, { once: true });
        timer = root.setTimeout(() => finish(new Error("The Safari agent host document did not load within 10 seconds.")), 10000);
        frame.src = api.runtime.getURL("js-kernel-offscreen.html") + "?kernel=" + encodeURIComponent(url);
        document.body.append(frame);
      });
    })().catch(error => { frame.remove(); if (hostDocument === state) hostDocument = undefined; throw error; });
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

  async function sendRequest(request) {
    await ensureHostDocument();
    const target = hostDocument.frame.contentWindow;
    if (!target) throw new Error("The Safari agent host document is unavailable.");
    // Safari treats an iframe in its persistent background as the same message
    // context: runtime.sendMessage does not deliver to this replacement for
    // Chrome's offscreen document. Use the original protocol over a real port.
    const channel = new root.MessageChannel();
    return new Promise((resolve, reject) => {
      const close = () => { channel.port1.close(); channel.port2.close(); };
      channel.port1.onmessage = event => { close(); resolve(event.data); };
      channel.port1.onmessageerror = () => { close(); reject(new Error("The Safari agent host returned unreadable data.")); };
      try { target.postMessage(request, "*", [channel.port2]); }
      catch (error) { close(); reject(error); }
    });
  }

  const bridge = Object.freeze({ dispatch, ensureHostDocument, sendRequest, sandboxURL });
  if (typeof module !== "undefined" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariAgentKernel", { value: bridge });
})(globalThis);
