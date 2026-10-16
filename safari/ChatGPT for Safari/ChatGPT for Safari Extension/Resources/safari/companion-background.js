/* Native side-chat window; Safari remains the authority for browser context. */
(function (root) {
  "use strict";
  function createCompanion(api, environment = root) {
    let owner;
    let polling = false;
    let timer;
    const closeListeners = new Set();
    const send = async command => {
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
      await send({ action, ownerToken: state.instanceId, context: value, capabilities,
        bounds: { left: window.left, top: window.top, width: window.width, height: window.height } });
    }
    const binding = {
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
        await send({ action: "close", ownerToken: state.instanceId });
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
  if (api?.runtime?.id) root.ChatGPTSafariSidebarOptions = { companion: createCompanion(api) };
})(globalThis);
