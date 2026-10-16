/* Group agent-created tabs using real Safari windows, not synthetic tab groups. */
(function (root) {
  "use strict";
  function createSessionWindows(api) {
    const key = "chatgptSafariSessionWindowsV1";
    const sessions = new Map();
    let queue = Promise.resolve();
    const ready = api.storage.session.get(key).then(value => {
      for (const [id, state] of Object.entries(value[key] || {})) {
        if (Array.isArray(state.tabs)) sessions.set(id, { ...state, tabs: new Set(state.tabs) });
      }
    });
    const save = () => api.storage.session.set({ [key]: Object.fromEntries(
      Array.from(sessions, ([id, state]) => [id, { ...state, tabs: Array.from(state.tabs) }]),
    ) });
    function serial(operation) {
      const pending = queue.then(async () => { await ready; return operation(); });
      queue = pending.catch(() => {});
      return pending;
    }
    async function label(state, tabId) {
      await api.action.setTitle({ tabId, title: state.title ? `ChatGPT — ${state.title}` : "ChatGPT" });
    }
    const manager = {
      createTab(sessionId, preferredWindowId) {
        return serial(async () => {
          let state = sessions.get(sessionId);
          if (!state) { state = { windowId: null, tabs: new Set(), title: "" }; sessions.set(sessionId, state); }
          let tab;
          if (state.windowId != null || preferredWindowId != null) {
            tab = await api.tabs.create({ active: false, url: "about:blank", windowId: state.windowId ?? preferredWindowId });
          } else {
            const window = await api.windows.create({ type: "normal", focused: false, url: "about:blank" });
            if (!Number.isSafeInteger(window?.id)) throw new Error("Safari did not create a session window");
            tab = window.tabs?.find(value => Number.isSafeInteger(value.id));
            if (!tab) tab = await api.tabs.create({ active: false, url: "about:blank", windowId: window.id });
          }
          if (!Number.isSafeInteger(tab?.id)) throw new Error("Safari did not return the created tab identifier");
          try {
            const live = await api.tabs.get(tab.id);
            if (live.incognito) throw new Error("Private Safari tabs cannot join an automation session");
            state.windowId = live.windowId;
            state.tabs.add(live.id);
            await label(state, live.id);
            await save();
            return live;
          } catch (error) {
            state.tabs.delete(tab.id);
            if (state.tabs.size === 0) sessions.delete(sessionId);
            try { await api.tabs.remove(tab.id); } catch (cleanupError) {
              throw new Error(`${error.message}; unable to close unleased tab ${tab.id}: ${cleanupError.message}`);
            }
            throw error;
          }
        });
      },
      ensureAgentTabGroup(sessionId, tabId, previousTabIds) {
        return serial(async () => {
          const tabs = await Promise.all([tabId, ...previousTabIds].map(id => api.tabs.get(id)));
          if (tabs.some(tab => tab.incognito)) throw new Error("Private Safari tabs cannot join an automation session");
          let state = sessions.get(sessionId);
          if (!state) { state = { windowId: null, tabs: new Set(), title: "" }; sessions.set(sessionId, state); }
          // Keep popup windows and their stable Safari tab identifiers intact.
          state.windowId ??= tabs[0].windowId;
          for (const tab of tabs) state.tabs.add(tab.id);
          await label(state, tabId);
          await save();
        });
      },
      setSessionGroupTitle(sessionId, title) {
        return serial(async () => {
          let state = sessions.get(sessionId);
          if (!state) { state = { windowId: null, tabs: new Set(), title: "" }; sessions.set(sessionId, state); }
          state.title = typeof title === "string" ? title.trim() : "";
          await Promise.all(Array.from(state.tabs, id => label(state, id)));
          await save();
        });
      },
      releaseTabsFromManagedGroups(tabIds) {
        return serial(async () => {
          const released = new Set(tabIds);
          for (const state of sessions.values()) {
            let changed = false;
            for (const id of released) if (state.tabs.delete(id)) {
              changed = true;
              await api.action.setTitle({ tabId: id, title: "ChatGPT" });
            }
            // Deliverables keep their window; later agent tabs get a new one.
            if (changed) state.windowId = null;
          }
          await save();
        });
      },
      refreshManagedGroupsFromChrome() {
        return serial(async () => {
          const live = new Map((await api.tabs.query({})).map(tab => [tab.id, tab]));
          for (const [id, state] of sessions) {
            for (const tabId of state.tabs) if (!live.has(tabId)) state.tabs.delete(tabId);
            if (state.tabs.size === 0) sessions.delete(id);
            else if (!Array.from(state.tabs).some(tabId => live.get(tabId).windowId === state.windowId)) state.windowId = null;
          }
          await save();
        });
      },
    };
    api.tabs.onRemoved.addListener(() => {
      manager.refreshManagedGroupsFromChrome().catch(() => console.error("Unable to refresh Safari session windows"));
    });
    return manager;
  }
  if (typeof module === "object" && module.exports) module.exports = { createSessionWindows };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariSessionWindows = createSessionWindows(api);
})(globalThis);
