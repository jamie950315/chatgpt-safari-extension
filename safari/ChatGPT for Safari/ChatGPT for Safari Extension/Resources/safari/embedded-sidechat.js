/* The privileged wrapper never executes provider code. */
const api = globalThis.browser || globalThis.chrome;
const prefix = "chatgpt-safari-sidebar:";
const surface = document.querySelector("#surface");
const status = document.querySelector("#status");
let channel, interval;
let disposed = false;
const hostMethods = new Set(["context", "capabilities", "tabContext", "tabMentions", "openInBrowser", "locationChanged", "authStateChanged"]);

function fail(error) {
  if (disposed) return;
  clearInterval(interval);
  channel?.close();
  status.textContent = error instanceof Error ? error.message : "ChatGPT could not connect. Close and reopen the sidebar.";
  status.setAttribute("role", "alert");
  surface.replaceChildren(status);
}

try {
  if (!window.name.startsWith(prefix)) throw new Error("The ChatGPT sidebar has no Safari owner");
  const owner = JSON.parse(window.name.slice(prefix.length));
  window.name = "";
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.tabId) || !Number.isSafeInteger(owner.windowId)
    || typeof owner.instanceId !== "string") throw new Error("The sidebar owner is invalid");
  const authorization = await api.runtime.sendMessage({ ...owner, type: prefix + "authorize-frame" });
  if (authorization?.ok !== true) throw new Error(authorization?.error || "The sidebar is no longer active");
  const invoke = async payload => {
    const response = await api.runtime.sendMessage({ ...owner, type: prefix + "operation", operation: "companionRequest", payload });
    if (response?.ok !== true) throw new Error(response?.error || "The Safari sidebar disconnected");
    return response.value;
  };
  const host = (method, params = {}) => invoke({ operation: "host", method, params });
  const entry = await invoke({ operation: "entry" });
  const url = new URL(entry.providerURL);
  if (url.protocol !== "http:" || !/^chatgpt-provider-[a-z0-9-]+\.localhost$/u.test(url.hostname)
    || url.origin !== entry.providerOrigin || typeof entry.bridgeToken !== "string" || entry.bridgeToken.length < 32) {
    throw new Error("The native relay returned an invalid provider address");
  }
  const frame = document.createElement("iframe");
  frame.title = "ChatGPT side chat";
  frame.referrerPolicy = "no-referrer";
  // Provider scripts run only in this unprivileged, isolated origin.
  frame.sandbox = "allow-scripts allow-forms allow-same-origin allow-downloads allow-modals allow-popups";
  let previousContext;
  async function observeContext() {
    if (disposed || !channel) return;
    const value = await host("context", { includeSelection: true });
    const next = JSON.stringify(value.context);
    if (previousContext != null && previousContext !== next) {
      channel.postMessage({ type: "event", payload: { type: "browser_side_chat_context_invalidated", protocolVersion: 2 } });
    }
    previousContext = next;
  }
  let providerDocument;
  window.addEventListener("message", event => {
    if (disposed || !event.isTrusted || event.source !== frame.contentWindow || event.origin !== entry.providerOrigin
      || event.data?.type !== "chatgpt-safari-provider:ready" || event.data.token !== entry.bridgeToken
      || typeof event.data.documentId !== "string" || !/^[0-9a-f-]{36}$/iu.test(event.data.documentId)
      || event.data.documentId === providerDocument) return;
    providerDocument = event.data.documentId;
    clearInterval(interval);
    channel?.close();
    const pair = new MessageChannel();
    channel = pair.port1;
    let inFlight = 0;
    channel.onmessage = async ({ data }) => {
      if (data?.type === "ready") {
        clearInterval(interval);
        interval = setInterval(() => { void observeContext().catch(fail); }, 1000);
        void observeContext().catch(fail);
        return;
      }
      if (data?.type === "failure") { fail(new Error(String(data.error).slice(0, 512))); return; }
      if (disposed || data?.type !== "request" || typeof data.id !== "string" || data.id.length > 128
        || !hostMethods.has(data.method) || !data.params || typeof data.params !== "object" || Array.isArray(data.params)
        || JSON.stringify(data.params).length > 96000 || inFlight >= 32) return;
      const currentChannel = channel;
      inFlight++;
      try {
        const result = await host(data.method, data.params);
        if (!disposed && channel === currentChannel) currentChannel.postMessage({ type: "reply", id: data.id, result });
      } catch (error) {
        if (!disposed && channel === currentChannel) currentChannel.postMessage({ type: "reply", id: data.id, error: error.message });
      } finally { inFlight--; }
    };
    frame.contentWindow.postMessage({ type: "chatgpt-safari-provider:connect", token: entry.bridgeToken }, entry.providerOrigin, [pair.port2]);
  });
  window.addEventListener("pagehide", () => { disposed = true; clearInterval(interval); channel?.close(); }, { once: true });
  frame.src = entry.providerURL;
  surface.replaceChildren(frame);
} catch (error) { fail(error); }
