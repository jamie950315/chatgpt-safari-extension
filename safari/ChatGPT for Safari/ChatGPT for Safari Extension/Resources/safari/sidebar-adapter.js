/* Safari content-sidebar implementation for the upstream sidePanel contract. */
(function (root) {
  "use strict";

  const MESSAGE = Object.freeze({
    ready: "chatgpt-safari-sidebar:ready",
    mount: "chatgpt-safari-sidebar:mount",
    unmount: "chatgpt-safari-sidebar:unmount",
    closed: "chatgpt-safari-sidebar:closed",
    resized: "chatgpt-safari-sidebar:resized",
    authorize: "chatgpt-safari-sidebar:authorize-frame",
    operation: "chatgpt-safari-sidebar:operation",
  });
  const STORAGE_KEY = "chatgptSafariSidebarStateV1";
  const PATHS = new Set([
    "codex-work-sidepanel.html",
    "waiting-room.html",
    "side-panel-loading.html",
    "embedded-sidechat.html",
  ]);

  // This function is serialized by Safari into the owning isolated world.
  function callSidebarController(message) {
    const controller = globalThis.__chatgptSafariSidebarContent;
    if (!controller) return { ok: false, code: "SIDEBAR_CONTROLLER_MISSING" };
    return controller.command(message);
  }

  function integer(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a nonnegative integer`);
    }
    return value;
  }

  function extensionOrigin(runtime) {
    const url = new URL(runtime.getURL("/"));
    return `${url.protocol}//${url.host}`;
  }

  function createEvent(reportError) {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      emit(details) {
        for (const listener of listeners) {
          try { listener(details); } catch (error) { reportError(error); }
        }
      },
    };
  }

  function createSidebarAdapter(api, options = {}) {
    const action = api.browserAction || api.action;
    const reportError = options.reportError || ((error) => console.error(error));
    const onOpened = createEvent(reportError);
    const onClosed = createEvent(reportError);
    const openByWindow = new Map();
    const optionsByTab = new Map();
    const mediaTabs = new Map();
    const embedded = options.companion?.embedded === true;
    const usesContent = !options.companion || embedded;
    let defaults = { enabled: true, path: "codex-work-sidepanel.html" };
    let panelBehavior = { openPanelOnActionClick: false };
    let queue = Promise.resolve();

    const ready = (async () => {
      const saved = (await api.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
      if (saved?.version !== 1) return;
      if (saved.defaults && PATHS.has(saved.defaults.path)) {
        defaults = { enabled: saved.defaults.enabled === true, path: saved.defaults.path };
      }
      panelBehavior = { openPanelOnActionClick: saved.openPanelOnActionClick === true };
      for (const item of saved.tabOptions || []) {
        if (Number.isSafeInteger(item.tabId) && PATHS.has(item.path)) {
          optionsByTab.set(item.tabId, { enabled: item.enabled === true, path: item.path });
        }
      }
      for (const item of saved.openPanels || []) {
        if (Number.isSafeInteger(item.tabId) && Number.isSafeInteger(item.windowId)
          && PATHS.has(item.path) && typeof item.instanceId === "string") {
          openByWindow.set(item.windowId, item);
        }
      }
      if (options.companion && openByWindow.size) {
        let restored;
        try { restored = await options.companion.restore(Array.from(openByWindow.values())); }
        catch (error) { reportError(error); }
        // The companion retains one authenticated context owner.
        for (const [windowId, state] of openByWindow) {
          if (state.instanceId !== restored?.instanceId) openByWindow.delete(windowId);
          else if (embedded) {
            try { await mountContent(state); }
            catch (error) { openByWindow.delete(windowId); reportError(error); }
          }
        }
        await save();
      }
    })();

    function serialize(operation) {
      const pending = queue.then(async () => { await ready; return operation(); });
      queue = pending.catch(() => {});
      return pending;
    }

    function save() {
      return api.storage.session.set({
        [STORAGE_KEY]: {
          version: 1,
          defaults,
          tabOptions: Array.from(optionsByTab, ([tabId, value]) => ({ tabId, ...value })),
          openPanels: Array.from(openByWindow.values()),
          ...panelBehavior,
        },
      });
    }

    function getOptionsUnlocked(tabId) {
      return {
        ...defaults,
        ...(tabId == null ? {} : optionsByTab.get(tabId)),
        ...(tabId == null ? {} : { tabId }),
      };
    }

    async function resolveTab(scope = {}) {
      if (scope.tabId != null) {
        const tab = await api.tabs.get(integer(scope.tabId, "tabId"));
        if (scope.windowId != null && tab.windowId !== integer(scope.windowId, "windowId")) {
          throw new Error("The sidebar tab does not belong to the requested window");
        }
        return tab;
      }
      const query = { active: true };
      if (scope.windowId == null) query.currentWindow = true;
      else query.windowId = integer(scope.windowId, "windowId");
      const [tab] = await api.tabs.query(query);
      if (tab?.id == null) throw new Error("No active Safari tab is available for the sidebar");
      return tab;
    }

    async function contentCommand(state, message, installIfMissing) {
      const target = { tabId: state.tabId, frameIds: [0] };
      const execute = () => api.scripting.executeScript({
        target, world: "ISOLATED", func: callSidebarController, args: [message],
      });
      let entries = await execute();
      let result = entries?.find(entry => entry.frameId === 0)?.result;
      if (result?.code === "SIDEBAR_CONTROLLER_MISSING" && installIfMissing) {
        await api.scripting.executeScript({ target, world: "ISOLATED", files: ["safari/sidebar-content.js"] });
        entries = await execute();
        result = entries?.find(entry => entry.frameId === 0)?.result;
      }
      if (result?.ok !== true || result.instanceId !== state.instanceId) {
        throw new Error(result?.error || "Safari did not acknowledge the owning sidebar command");
      }
      return result;
    }

    async function mountContent(state) {
      return contentCommand(state, {
        type: MESSAGE.mount,
        iframeUrl: api.runtime.getURL(embedded ? "embedded-sidechat.html" : state.path),
        tabId: state.tabId,
        windowId: state.windowId,
        instanceId: state.instanceId,
        width: state.width,
      }, true);
    }

    async function unmountContent(state) {
      return contentCommand(state, { type: MESSAGE.unmount, instanceId: state.instanceId }, false);
    }

    async function mount(state) {
      if (options.companion) await options.companion.open(state);
      if (!usesContent) return;
      try { await mountContent(state); }
      catch (error) {
        if (embedded) {
          try { await options.companion.close(state); }
          catch (closeError) { throw new AggregateError([error, closeError], "The embedded sidebar could not release its failed owner"); }
        }
        throw error;
      }
    }

    async function closeState(state, reason, alreadyUnmounted = false) {
      if (usesContent && !alreadyUnmounted) await unmountContent(state);
      if (options.companion) await options.companion.close(state);
      const created = mediaTabs.get(state.instanceId);
      if (created) {
        mediaTabs.delete(state.instanceId);
        await Promise.all(Array.from(created, id => api.tabs.remove(id).catch(reportError)));
      }
      if (openByWindow.get(state.windowId) === state) openByWindow.delete(state.windowId);
      await save();
      onClosed.emit({ windowId: state.windowId, tabId: state.tabId, path: state.path, reason });
    }

    async function openUnlocked(scope) {
      const tab = await resolveTab(scope);
      const tabId = integer(tab.id, "tabId");
      const windowId = integer(tab.windowId, "windowId");
      if (!/^https?:\/\//i.test(tab.url || "")) {
        throw new Error("The ChatGPT sidebar can only be attached to an HTTP or HTTPS page");
      }
      const selected = getOptionsUnlocked(tabId);
      if (!selected.enabled) throw new Error("The ChatGPT sidebar is disabled for this tab");
      const previous = openByWindow.get(windowId);
      if (previous && previous.tabId !== tabId) await closeState(previous, "tab_changed");
      const existing = openByWindow.get(windowId);
      const state = existing || {
        tabId, windowId, instanceId: root.crypto.randomUUID(), width: 420,
      };
      const previousPath = state.path;
      state.path = selected.path;
      openByWindow.set(windowId, state);
      try {
        await save();
        await mount(state);
      } catch (error) {
        if (!existing) {
          openByWindow.delete(windowId);
          await save();
        } else if (previousPath !== state.path) {
          state.path = previousPath;
          await save();
          try { await mount(state); }
          catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "The sidebar update and its rollback both failed");
          }
        }
        throw error;
      }
      if (!existing) onOpened.emit({ windowId, tabId, path: state.path });
    }

    const sidePanel = {
      onOpened,
      onClosed,
      getOptions(scope = {}) {
        return serialize(() => getOptionsUnlocked(scope.tabId == null ? undefined : integer(scope.tabId, "tabId")));
      },
      setOptions(value) {
        return serialize(async () => {
          if (value.path != null && !PATHS.has(value.path)) {
            throw new Error("The sidebar path must be an upstream ChatGPT extension page");
          }
          if (value.enabled != null && typeof value.enabled !== "boolean") {
            throw new TypeError("enabled must be a boolean");
          }
          const tabId = value.tabId == null ? undefined : integer(value.tabId, "tabId");
          const updated = {
            ...getOptionsUnlocked(tabId),
            ...(value.path == null ? {} : { path: value.path }),
            ...(value.enabled == null ? {} : { enabled: value.enabled }),
          };
          delete updated.tabId;
          const previousDefaults = defaults;
          const previousTabOptions = optionsByTab.get(tabId);
          const changedPaths = [];
          try {
            for (const state of Array.from(openByWindow.values())) {
              if (tabId != null && state.tabId !== tabId) continue;
              const selected = tabId == null ? { ...updated, ...optionsByTab.get(state.tabId) } : updated;
              if (!selected.enabled) await closeState(state, "disabled");
              else if (selected.path !== state.path) {
                changedPaths.push({ state, path: state.path });
                state.path = selected.path;
                await save();
                await mount(state);
              }
            }
            if (tabId == null) defaults = updated;
            else optionsByTab.set(tabId, updated);
            await save();
          } catch (error) {
            defaults = previousDefaults;
            if (tabId != null) {
              if (previousTabOptions) optionsByTab.set(tabId, previousTabOptions);
              else optionsByTab.delete(tabId);
            }
            const rollbackErrors = [];
            for (const { state, path } of changedPaths.reverse()) {
              if (openByWindow.get(state.windowId) !== state) continue;
              state.path = path;
              try { await mount(state); }
              catch (rollbackError) { rollbackErrors.push(rollbackError); }
            }
            await save();
            if (rollbackErrors.length) {
              throw new AggregateError([error, ...rollbackErrors], "The sidebar options update could not be fully rolled back");
            }
            throw error;
          }
        });
      },
      open(scope = {}) { return serialize(() => openUnlocked(scope)); },
      close(scope = {}) {
        return serialize(async () => {
          const state = scope.tabId == null
            ? openByWindow.get((await resolveTab(scope)).windowId)
            : Array.from(openByWindow.values()).find((item) => item.tabId === scope.tabId);
          if (state) await closeState(state, "api");
        });
      },
      setPanelBehavior(value) {
        return serialize(async () => {
          if (typeof value.openPanelOnActionClick !== "boolean") {
            throw new TypeError("openPanelOnActionClick must be a boolean");
          }
          panelBehavior = { openPanelOnActionClick: value.openPanelOnActionClick };
          await save();
        });
      },
      getPanelBehavior() { return serialize(() => ({ ...panelBehavior })); },
    };

    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== api.runtime.id || !message || typeof message.type !== "string") return false;
      if (message.type === MESSAGE.authorize || message.type === MESSAGE.operation) {
        (async () => {
          await ready;
          const expectedUrl = api.runtime.getURL(embedded ? "embedded-sidechat.html" : "codex-work-sidepanel.html");
          const state = openByWindow.get(message.windowId);
          if (sender.url !== expectedUrl || sender.tab?.id !== message.tabId || sender.tab?.windowId !== message.windowId
            || state?.tabId !== message.tabId || state.instanceId !== message.instanceId) {
            throw new Error("This frame does not own an active Safari sidebar");
          }
          const tab = await api.tabs.get(state.tabId);
          if (tab.windowId !== state.windowId) throw new Error("The sidebar tab moved to another window");
          if (message.type === MESSAGE.operation) {
            const value = await performFrameOperation(state, tab, message.operation, message.payload);
            return { ok: true, value };
          }
          return { ok: true, tab };
        })().then(respond, (error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (sender.frameId !== 0 || sender.tab?.id == null) return false;
      if (![MESSAGE.ready, MESSAGE.closed, MESSAGE.resized].includes(message.type)) return false;
      serialize(async () => {
        const state = openByWindow.get(sender.tab.windowId);
        if (!state || state.tabId !== sender.tab.id) return { ok: true, open: false };
        if (message.type === MESSAGE.ready) await mount(state);
        else {
          if (state.instanceId !== message.instanceId) throw new Error("The sidebar instance is no longer active");
          if (message.type === MESSAGE.closed) await closeState(state, "button", true);
          else if (Number.isFinite(message.width) && message.width >= 280 && message.width <= 1200) {
            state.width = message.width;
            await save();
          }
        }
        return { ok: true, open: openByWindow.has(sender.tab.windowId) };
      }).then(respond, (error) => respond({ ok: false, error: error.message }));
      return true;
    });

    async function performFrameOperation(state, tab, operation, payload = {}) {
      switch (operation) {
      case "companionRequest":
        if (!embedded || typeof options.companion.frameRequest !== "function") {
          throw new Error("The embedded ChatGPT companion is unavailable");
        }
        return options.companion.frameRequest(state, payload);
      case "getOwner":
        if (payload.tabId !== state.tabId) throw new Error("The sidebar can only read its owning tab");
        return tab;
      case "getUserSettings": return action.getUserSettings();
      case "getCommands": return api.commands.getAll();
      case "focusOwner":
        if (payload.tabId !== state.tabId || payload.options?.active !== true
          || Object.keys(payload.options).length !== 1) throw new Error("The sidebar can only focus its owning tab");
        return api.tabs.update(state.tabId, { active: true });
      case "createTab": {
        const url = new URL(payload.url);
        const media = new URL(api.runtime.getURL("microphone-permission.html"));
        if (url.protocol === media.protocol && url.host === media.host && url.pathname === media.pathname
          && !url.hash && Array.from(url.searchParams).every(([key, value]) =>
            (key === "camera" && value === "1") || (key === "microphone" && value === "0"))) {
          const created = await api.tabs.create({ url: url.href, windowId: state.windowId });
          if (!mediaTabs.has(state.instanceId)) mediaTabs.set(state.instanceId, new Set());
          mediaTabs.get(state.instanceId).add(created.id);
          return created;
        }
        if (url.origin !== "https://chatgpt.com" || url.username || url.password) {
          throw new Error("The sidebar can only open its ChatGPT conversation");
        }
        return api.tabs.create({ url: url.href, active: true, openerTabId: state.tabId, windowId: state.windowId });
      }
      case "closeMedia": {
        const created = mediaTabs.get(state.instanceId);
        if (!created?.delete(payload.tabId)) throw new Error("The sidebar did not create this media-permission tab");
        await api.tabs.remove(payload.tabId);
        return;
      }
      case "selection": {
        const { target, args, operation: name, world } = payload;
        if (target?.tabId !== state.tabId || !Array.isArray(args)) throw new Error("Invalid sidebar selection target");
        if (Object.keys(target).some(key => !["tabId", "documentIds"].includes(key))) throw new Error("Invalid sidebar selection scope");
        if (target.documentIds != null && (!Array.isArray(target.documentIds) || target.documentIds.length !== 1
          || typeof target.documentIds[0] !== "string")) throw new Error("Invalid sidebar document identity");
        if (name === "selection") {
          if (args[0] !== tab.url || typeof args[1] !== "string" || args[1].length > 128
            || !["none", "event", "polling"].includes(args[2]) || ![3, 4].includes(args.length)
            || (world != null && world !== "ISOLATED")) throw new Error("Invalid sidebar selection request");
          const recovery = args[3];
          if (recovery != null && (!Number.isSafeInteger(recovery.captureGeneration)
            || (recovery.selectedText != null && (typeof recovery.selectedText !== "string" || recovery.selectedText.length > 80000)))) {
            throw new Error("Invalid sidebar selection recovery");
          }
        } else if (name === "recoverSelection") {
          if (args.length !== 3 || args[0] !== new URL(tab.url).origin || args[1] !== tab.url
            || args[2] !== 80000 || world !== "MAIN") throw new Error("Invalid sidebar workspace selection");
        } else if (name === "removeSelection") {
          if (args.length !== 1 || typeof args[0] !== "string" || args[0].length > 128 || world != null) {
            throw new Error("Invalid sidebar selection cleanup");
          }
        } else throw new Error("Unknown sidebar selection operation");
        const func = root.ChatGPTSafariSidebarFunctions?.[name];
        if (typeof func !== "function") throw new Error("The upstream sidebar selection function is unavailable");
        return api.scripting.executeScript({ target, args, func, ...(world ? { world } : {}) });
      }
      default: throw new Error("Unknown Safari sidebar operation");
      }
    }

    options.companion?.onClosed.addListener(state => {
      serialize(async () => {
        const current = openByWindow.get(state.windowId);
        if (current?.instanceId === state.instanceId) await closeState(current, "native_window", !embedded);
      }).catch(reportError);
    });
    api.tabs.onRemoved.addListener((tabId) => {
      serialize(async () => {
        optionsByTab.delete(tabId);
        for (const state of Array.from(openByWindow.values())) {
          if (state.tabId === tabId) await closeState(state, "tab_removed", true);
        }
        await save();
      }).catch(reportError);
    });
    api.tabs.onActivated.addListener(({ tabId, windowId }) => {
      serialize(async () => {
        const previous = openByWindow.get(windowId);
        if (!previous || previous.tabId === tabId) return;
        await closeState(previous, "tab_changed");
        if (getOptionsUnlocked(tabId).enabled) await openUnlocked({ tabId, windowId });
      }).catch(reportError);
    });
    api.tabs.onUpdated?.addListener((tabId, change) => {
      if (!embedded || change.status !== "complete") return;
      serialize(async () => {
        const state = Array.from(openByWindow.values()).find(item => item.tabId === tabId);
        if (!state) return;
        const tab = await api.tabs.get(tabId);
        if (!/^https?:\/\//i.test(tab.url || "") || tab.incognito || tab.windowId !== state.windowId) {
          await closeState(state, "navigation", true); return;
        }
        // A document navigation destroys the old inline frame. Retain the
        // conversation and account owner; do not reopen or restart the agent.
        await mountContent(state);
      }).catch(reportError);
    });
    action.onClicked.addListener((tab) => {
      serialize(async () => {
        if (!panelBehavior.openPanelOnActionClick) return;
        const state = openByWindow.get(tab.windowId);
        if (state?.tabId === tab.id) await closeState(state, "toolbar");
        else {
          optionsByTab.set(tab.id, { enabled: true, path: "codex-work-sidepanel.html" });
          await openUnlocked({ tabId: tab.id, windowId: tab.windowId });
        }
      }).catch(reportError);
    });

    return { sidePanel, ready, mountContent, unmountContent, messages: MESSAGE, origin: extensionOrigin(api.runtime) };
  }

  const exported = { createSidebarAdapter, extensionOrigin, MESSAGE };
  if (typeof module === "object" && module.exports) module.exports = exported;
  const api = root.browser || root.chrome;
  if (api?.runtime?.id && !api.sidePanel?.open) {
    const adapter = createSidebarAdapter(api, root.ChatGPTSafariSidebarOptions || {});
    api.sidePanel = adapter.sidePanel;
    if (root.chrome && root.chrome !== api) root.chrome.sidePanel = adapter.sidePanel;
    root.ChatGPTSafariSidebar = adapter;
  }
})(globalThis);
