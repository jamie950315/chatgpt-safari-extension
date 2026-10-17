/* The privileged wrapper never executes provider code. */
const api = globalThis.browser || globalThis.chrome;
const prefix = "chatgpt-safari-sidebar:";
const surface = document.querySelector("#surface");
const status = document.querySelector("#status");
let channel, interval;
let disposed = false;
const hostMethods = new Set(["context", "capabilities", "tabContext", "tabMentions", "openInBrowser", "locationChanged", "authStateChanged", "openInvocation"]);

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
  const invocationKey = `codexWorkSidePanelInvocation:${owner.tabId}`;
  const invocationAvailable = () => {
    if (!disposed && channel) channel.postMessage({ type: "event", payload: { type: "browser_side_chat_invocation_available" } });
  };
  const storageChanged = (changes, area) => {
    if (area === "session" && changes[invocationKey]?.newValue != null) invocationAvailable();
  };
  api.storage?.onChanged?.addListener(storageChanged);
  const tabEvents = ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached", "onReplaced"];
  let tabChangesPending = false;
  const tabsChanged = () => {
    if (disposed || tabChangesPending) return;
    tabChangesPending = true;
    queueMicrotask(() => {
      tabChangesPending = false;
      if (!disposed && channel) channel.postMessage({ type: "event", payload: { type: "browser_tab_mentions_invalidated" } });
    });
  };
  for (const name of tabEvents) api.tabs?.[name]?.addListener(tabsChanged);
  const mentionInvalidated = (message, sender) => {
    if (sender.id === api.runtime.id && sender.tab == null && message?.type === "chatgpt-safari:tab-mentions-invalidated"
      && message.instanceId === owner.instanceId && message.tabId === owner.tabId && message.windowId === owner.windowId) tabsChanged();
  };
  api.runtime.onMessage?.addListener(mentionInvalidated);
  let entry, frame, authScreen, previousContext, providerDocument;
  let recoveryPending = false, recoveryAttempted = false;
  async function loadProvider(expectedAccountScope) {
    const next = await invoke({ operation: "entry" });
    if (disposed) return;
    if (next?.authentication) { showAuthentication(next.authentication.state); return; }
    if (expectedAccountScope !== undefined && next.accountScope !== expectedAccountScope) {
      throw new Error("The ChatGPT account changed. Close and reopen the sidebar before continuing.");
    }
    if (expectedAccountScope !== undefined && next.providerOrigin !== entry.providerOrigin) {
      throw new Error("The ChatGPT provider changed. Close and reopen the sidebar before continuing.");
    }
    const url = new URL(next.providerURL);
    if (url.protocol !== "http:" || !/^chatgpt-provider-[a-z0-9-]+\.localhost$/u.test(url.hostname)
      || url.origin !== next.providerOrigin || typeof next.bridgeToken !== "string" || next.bridgeToken.length < 32) {
      throw new Error("The native relay returned an invalid provider address");
    }
    clearInterval(interval); channel?.close(); channel = undefined;
    providerDocument = undefined; previousContext = undefined; entry = next; authScreen = undefined;
    frame = document.createElement("iframe");
    frame.title = "ChatGPT side chat";
    frame.referrerPolicy = "no-referrer";
    // Provider scripts run only in this unprivileged, isolated origin.
    frame.sandbox = "allow-scripts allow-forms allow-same-origin allow-downloads allow-modals allow-popups";
    frame.setAttribute("allow", `autoplay ${entry.providerOrigin}; camera ${entry.providerOrigin}; clipboard-write ${entry.providerOrigin}; microphone ${entry.providerOrigin}`);
    frame.src = entry.providerURL;
    surface.replaceChildren(frame);
  }
  function showAuthentication(state) {
    if (!["expired", "signed_out", "logout_requested"].includes(state)) return;
    clearInterval(interval);
    if (frame) frame.style.display = "none";
    authScreen?.remove();
    const screen = document.createElement("section");
    screen.className = "authentication";
    screen.setAttribute("role", "status");
    const heading = document.createElement("h1");
    heading.textContent = state === "logout_requested" ? "Log out of ChatGPT?" : state === "expired" ? "Your session has expired" : "Sign in to ChatGPT";
    const explanation = document.createElement("p");
    explanation.textContent = state === "logout_requested"
      ? "Complete logout in the app window. Your Safari logins are unchanged."
      : "Sign in in the app window, then choose Continue to restore this sidebar.";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = state === "logout_requested" ? "Log out in app window" : "Sign in in app window";
    const resume = document.createElement("button");
    resume.type = "button"; resume.textContent = "Continue";
    const feedback = document.createElement("p"); feedback.setAttribute("role", "status");
    const perform = async (button, action) => {
      button.disabled = true; feedback.textContent = "";
      try {
        await invoke({ operation: "authentication", action });
        if (disposed || authScreen !== screen) return;
        if (action === "resume") await loadProvider();
        else feedback.textContent = "Finish in the app window, then choose Continue.";
      } catch (error) {
        if (!disposed && authScreen === screen) feedback.textContent = error.message;
      } finally { button.disabled = false; }
    };
    open.addEventListener("click", () => { void perform(open, state === "logout_requested" ? "logout" : "open"); });
    resume.addEventListener("click", () => { void perform(resume, "resume"); });
    screen.append(heading, explanation, open, resume, feedback);
    authScreen = screen;
    if (frame) surface.append(screen);
    else surface.replaceChildren(screen);
  }
  async function observeContext() {
    if (disposed || !channel) return;
    const value = await host("context", { includeSelection: true });
    const next = JSON.stringify(value.context);
    if (previousContext != null && previousContext !== next) {
      channel.postMessage({ type: "event", payload: { type: "browser_side_chat_context_invalidated", protocolVersion: 2 } });
    }
    previousContext = next;
  }
  window.addEventListener("message", event => {
    if (disposed || !frame || !event.isTrusted || event.source !== frame.contentWindow || event.origin !== entry.providerOrigin) return;
    if (event.data?.type === "chatgpt-safari-provider:document-capability-missing") {
      if (recoveryPending) return;
      if (recoveryAttempted || typeof entry.accountScope !== "string" || !entry.accountScope) {
        fail(new Error("ChatGPT could not reconnect. Close and reopen the sidebar to continue.")); return;
      }
      recoveryPending = true; recoveryAttempted = true;
      clearInterval(interval); channel?.close(); channel = undefined;
      void loadProvider(entry.accountScope).catch(fail).finally(() => { recoveryPending = false; });
      return;
    }
    if (event.data?.type !== "chatgpt-safari-provider:ready" || event.data.token !== entry.bridgeToken
      || typeof event.data.documentId !== "string" || !/^[0-9a-f-]{36}$/iu.test(event.data.documentId)
      || event.data.documentId === providerDocument) return;
    providerDocument = event.data.documentId;
    recoveryAttempted = false;
    clearInterval(interval);
    channel?.close();
    const pair = new MessageChannel();
    channel = pair.port1;
    const ownedChannel = channel;
    let inFlight = 0;
    channel.onmessage = async ({ data }) => {
      if (disposed || channel !== ownedChannel) return;
      if (data?.type === "ready") {
        clearInterval(interval);
        interval = setInterval(() => { void observeContext().catch(fail); }, 1000);
        void observeContext().catch(fail);
        invocationAvailable();
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
        if (!disposed && channel === currentChannel && data.method === "authStateChanged" && result?.authentication) {
          showAuthentication(result.authentication.state);
        }
      } catch (error) {
        if (!disposed && channel === currentChannel) currentChannel.postMessage({ type: "reply", id: data.id, error: error.message });
      } finally { inFlight--; }
    };
    frame.contentWindow.postMessage({ type: "chatgpt-safari-provider:connect", token: entry.bridgeToken }, entry.providerOrigin, [pair.port2]);
  });
  window.addEventListener("pagehide", () => {
    disposed = true; clearInterval(interval); channel?.close(); api.storage?.onChanged?.removeListener(storageChanged);
    for (const name of tabEvents) api.tabs?.[name]?.removeListener(tabsChanged);
    api.runtime.onMessage?.removeListener(mentionInvalidated);
  }, { once: true });
  await loadProvider();
} catch (error) { fail(error); }
