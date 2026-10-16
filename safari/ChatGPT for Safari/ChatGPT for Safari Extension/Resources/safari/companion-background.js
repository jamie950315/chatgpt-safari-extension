/* Owner-bound native relay; Safari remains the authority for browser context. */
(function (root) {
  "use strict";
  function createCompanion(api, environment = root, options = {}) {
    const embedded = options.embedded === true;
    let owner;
    let polling = false;
    let timer;
    const closeListeners = new Set();
    const send = async command => {
      if (embedded && ["status", "poll", "update"].includes(command.action)) {
        command = { ...command, action: "embedded" + command.action[0].toUpperCase() + command.action.slice(1) };
      }
      const result = await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command });
      if (result?.ok !== true) {
        const error = new Error(typeof result?.error === "string" ? result.error : result?.error?.message || "The Safari companion did not respond");
        error.code = result?.error?.code;
        throw error;
      }
      return result;
    };
    async function ownedTab(state) {
      if (owner?.instanceId !== state.instanceId) throw new Error("The native sidebar owner has changed");
      const tab = await api.tabs.get(state.tabId);
      if (tab.windowId !== state.windowId || tab.incognito || !/^https?:\/\//i.test(tab.url || "")) {
        throw new Error("The native sidebar no longer owns a readable Safari page");
      }
      return tab;
    }
    async function context(state, includeSelection = false) {
      const tab = await ownedTab(state);
      const instanceId = await environment.ChatGPTSafariHooks.getInstanceId();
      let selectedText = null, selectionId = null;
      if (includeSelection && tab.status !== "loading") {
        const [capture] = await api.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          func: environment.ChatGPTSafariSidebarFunctions.selection,
          args: [tab.url, state.instanceId, "none"],
        });
        const after = await ownedTab(state);
        if (after.url !== tab.url || after.status === "loading") throw new Error("The Safari page changed during selection capture");
        selectedText = capture?.result?.selectedText || null;
        if (selectedText && capture.documentId) selectionId = `${capture.documentId}:${capture.result.revision}`;
      }
      return { instanceId, tabId: tab.id, windowId: tab.windowId, url: tab.url,
        ...(includeSelection ? { selectedText, selectionId } : {}) };
    }
    const capabilities = { "browserSideChat.openInBrowser": true, "browserSideChat.tabContext.read": true, "browserTabMentions.search": true };
    async function handleRequest(state, request) {
      if (request.ownerToken !== state.instanceId) throw new Error("The native sidebar request belongs to an earlier owner");
      const params = request.params || {};
      switch (request.method) {
      case "context": return { context: await context(state, params.includeSelection === true), capabilities };
      case "tabContext": { const tab = await ownedTab(state); return { tabId: tab.id, url: tab.url }; }
      case "tabMentions": {
        await ownedTab(state);
        const candidates = await environment.ChatGPTSafariHooks.getTabMentions({ query: params.query || "", limit: params.limit ?? 20, includeFavicons: true });
        await ownedTab(state);
        return { ok: true, candidates };
      }
      case "openInBrowser": {
        await ownedTab(state);
        const url = new URL(params.url);
        if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw new Error("Only ChatGPT conversations can be opened from the native sidebar");
        url.searchParams.delete("surface");
        const tab = await api.tabs.create({ url: url.href, active: true, openerTabId: state.tabId, windowId: state.windowId });
        return { ok: true, tabId: tab.id };
      }
      case "locationChanged": {
        const url = new URL(params.url);
        if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw new Error("Invalid native sidebar conversation URL");
        await api.storage.session.set({ [`codexWorkSidePanelConversationUrl:${state.tabId}`]: url.href });
        return { ok: true };
      }
      case "authStateChanged": return { ok: true };
      default: throw new Error("Unknown native side-chat request");
      }
    }
    async function poll() {
      if (polling || !owner) return;
      polling = true;
      const state = owner;
      try {
        const response = await send({ action: "poll", ownerToken: state.instanceId });
        if (response.closed === true) { didClose(state); return; }
        for (const request of response.requests || []) {
          if (owner?.instanceId !== state.instanceId) return;
          let value;
          try { value = { result: await handleRequest(state, request) }; }
          catch (error) { value = { error: { message: error.message } }; }
          if (owner?.instanceId !== state.instanceId) return;
          await send({ action: "resolve", ownerToken: state.instanceId, id: request.id, ...value });
        }
      } catch (error) {
        if (owner?.instanceId !== state.instanceId) return;
        if (error.code === "COMPANION_NOT_RUNNING") didClose(state);
        clearInterval(timer);
        timer = undefined;
        console.error("Safari native side chat disconnected:", error.message);
      } finally { polling = false; }
    }
    function didClose(state) {
      if (owner?.instanceId !== state.instanceId) return;
      owner = undefined;
      clearInterval(timer);
      timer = undefined;
      for (const listener of closeListeners) listener(state);
    }
    async function update(state, action) {
      const value = await context(state);
      const window = await api.windows.get(state.windowId);
      await send({ action: embedded && action === "open" ? "embeddedOpen" : action,
        ...(embedded ? { parentExtensionOrigin: (() => { const u = new URL(api.runtime.getURL("/")); return u.protocol + "//" + u.host.toLowerCase(); })() } : {}),
        ownerToken: state.instanceId, context: value, capabilities,
        bounds: { left: window.left, top: window.top, width: window.width, height: window.height } });
    }
    const binding = {
      embedded,
      async frameRequest(state, payload) {
        if (!embedded) throw new Error("The embedded side chat is not enabled");
        await ownedTab(state);
        if (!payload || typeof payload !== "object") throw new Error("Invalid side-chat frame request");
        if (payload.operation === "entry") {
          const response = await send({ action: "embeddedEntry", ownerToken: state.instanceId });
          return response.entry;
        }
        if (payload.operation !== "host" || typeof payload.method !== "string") throw new Error("Unknown embedded side-chat operation");
        const params = payload.params || {};
        if (JSON.stringify(params).length > 96000) throw new Error("The side-chat request is too large");
        if (payload.method === "capabilities") {
          return { capabilities, browserContext: { instanceId: await environment.ChatGPTSafariHooks.getInstanceId() } };
        }
        const result = await handleRequest(state, { ownerToken: state.instanceId, method: payload.method, params });
        if (payload.method === "locationChanged") {
          await send({ action: "embeddedLocation", ownerToken: state.instanceId, url: params.url });
        } else if (payload.method === "authStateChanged") {
          if (!["expired", "logout_requested", "signed_in", "signed_out"].includes(params.state)) throw new Error("Invalid ChatGPT authentication state");
          await send({ action: "embeddedAuth", ownerToken: state.instanceId, state: params.state });
        }
        return result;
      },
      onClosed: { addListener(listener) { closeListeners.add(listener); }, removeListener(listener) { closeListeners.delete(listener); } },
      async restore(states) {
        let response;
        try { response = await send({ action: "status" }); }
        catch (error) {
          if (error.code === "COMPANION_NOT_RUNNING") return;
          throw error;
        }
        const state = states.find(item => item.instanceId === response.state?.ownerToken);
        if (!state || response.state.ownerAvailable !== true) return;
        owner = state;
        if (!timer) timer = setInterval(poll, 500);
        await poll();
        return owner;
      },
      async open(state) {
        const previous = owner;
        owner = state;
        try { await update(state, "open"); }
        catch (error) { owner = previous; throw error; }
        if (!timer) timer = setInterval(poll, 500);
        await poll();
      },
      async close(state) {
        if (owner?.instanceId !== state.instanceId) return;
        await send({ action: embedded ? "embeddedClose" : "close", ownerToken: state.instanceId });
        owner = undefined;
        clearInterval(timer);
        timer = undefined;
        await api.scripting.executeScript({ target: { tabId: state.tabId }, func: environment.ChatGPTSafariSidebarFunctions.removeSelection, args: [state.instanceId] }).catch(() => {});
      },
      poll,
      context,
      handleRequest,
    };
    api.tabs.onUpdated.addListener((tabId, change) => {
      if (owner?.tabId === tabId && (change.url || change.status === "complete")) {
        update(owner, "update").catch(error => console.error("Unable to update Safari side-chat context:", error.message));
      }
    });
    return binding;
  }
  if (typeof module === "object" && module.exports) module.exports = { createCompanion };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariSidebarOptions = { companion: createCompanion(api, root, { embedded: true }) };
})(globalThis);
