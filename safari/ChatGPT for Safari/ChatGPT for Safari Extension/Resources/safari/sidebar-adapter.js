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
  const NATIVE_GROUP_MOVES = new Set(["createGroup", "moveToGroup", "moveToUngrouped"]);
  const SELECTION_FAILURE_CODES = new Set([
    "FOCUS_CHANGED", "LIVE_TIMEOUT", "COMPANION_NOT_RUNNING", "STALE_TARGET", "AGENT_OWNER_CHANGED",
    "REBIND_STATE", "REBIND_CONTEXT", "REBIND_SNAPSHOT", "REBIND_CONVERSATION",
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
    let agentSelection;
    let selectionTrace = { phase: "idle", events: [], before: [], after: [] };
    const inventoryIds = tabs => tabs.slice(0, 256).map(tab => ({ tabId: tab.id, windowId: tab.windowId, active: tab.active === true }));
    function traceSelection(type, fields = {}) {
      if (!agentSelection?.groupMove) return;
      const event = { type };
      for (const key of ["tabId", "windowId", "oldWindowId", "newWindowId"]) {
        if (Number.isSafeInteger(fields[key])) event[key] = fields[key];
      }
      selectionTrace.events.push(event);
      selectionTrace.events = selectionTrace.events.slice(-64);
    }
    function nativeOwnerSuspended(state) {
      const selection = agentSelection;
      return selection?.owner === state && selection.groupMove?.create
        && selection.groupMove.create.ownerRestored !== true;
    }

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

    async function contentCommand(state, message, installIfMissing, allowAbsent = false) {
      const target = { tabId: state.tabId, frameIds: [0] };
      const execute = () => api.scripting.executeScript({
        target, world: "ISOLATED", func: callSidebarController, args: [message],
      });
      let entries = await execute();
      let result = entries?.find(entry => entry.frameId === 0)?.result;
      if (allowAbsent && result?.code === "SIDEBAR_CONTROLLER_MISSING") return result;
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

    async function unmountContent(state, allowAbsent = false) {
      return contentCommand(state, { type: MESSAGE.unmount, instanceId: state.instanceId }, false, allowAbsent);
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
      if (agentSelection?.owner === state) {
        agentSelection.cancelled = true;
        clearTimeout(agentSelection.dialogTimer);
        if (!agentSelection.inUse) agentSelection = undefined;
      }
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

    // An original-agent native batch may select another claimed tab without
    // moving its provider frame. Only our exact select/restore events belong
    // to this transaction; a user selection still follows normal ownership.
    async function withAgentSelection(ownerToken, targetTab, operation, scope = {}) {
      const selection = await serialize(async () => {
        const owner = Array.from(openByWindow.values()).find(state => state.instanceId === ownerToken);
        if (!embedded || !owner) throw new Error("The Safari agent no longer owns its inline sidebar");
        if (agentSelection?.dialogHeld && !agentSelection.inUse) {
          const pending = agentSelection;
          if (pending.cancelled || Date.now() >= pending.dialogDeadline) {
            clearTimeout(pending.dialogTimer);
            agentSelection = undefined;
            throw Object.assign(new Error("The dialog selection expired or changed. Inspect the current page; no input was repeated."), { code: "FOCUS_CHANGED" });
          }
          if (scope.action !== pending.dialogKind || pending.owner !== owner || pending.targetTab.id !== targetTab.id
            || pending.targetTab.windowId !== targetTab.windowId || pending.targetTab.url !== targetTab.url) {
            throw new Error("Respond to the current JavaScript dialog before selecting another agent target");
          }
          pending.assertCurrent();
          pending.inUse = true;
          return pending;
        }
        if (agentSelection) throw new Error("Another Safari agent selection is in progress");
        const nativeGroupMove = NATIVE_GROUP_MOVES.has(scope.nativeGroupMove) ? scope.nativeGroupMove : undefined;
        if (owner.tabId === targetTab.id && !nativeGroupMove) return null;
        const current = await api.tabs.get(owner.tabId);
        if (current.windowId !== owner.windowId || current.incognito || !/^https?:\/\//iu.test(current.url || "")) {
          throw new Error("The Safari agent sidebar owner is no longer available");
        }
        const value = { owner, ownerTab: current, targetTab, expected: [], cancelled: false, expectedWindow: targetTab.windowId, inUse: true };
        value.assertCurrent = () => {
          if (value.cancelled || agentSelection !== value || openByWindow.get(owner.windowId) !== owner) {
            const error = new Error("Safari selection changed during the agent command. Read the current page before continuing; do not repeat input.");
            error.code = "FOCUS_CHANGED";
            throw error;
          }
        };
        value.select = async tab => {
          value.assertCurrent();
          value.expectedWindow = tab.windowId;
          if (!tab.active) {
            value.expected.push({ tabId: tab.id, windowId: tab.windowId });
            await api.tabs.update(tab.id, { active: true });
            value.assertCurrent();
          }
          await api.windows.update(tab.windowId, { focused: true });
          value.assertCurrent();
        };
        value.holdDialog = (kind = "dialog") => {
          value.assertCurrent();
          if (!["dialog", "filechooser"].includes(kind)) throw new Error("Unsupported native modal selection");
          if (value.dialogHeld) return;
          value.dialogHeld = true;
          value.dialogKind = kind;
          value.dialogDeadline = Date.now() + 5 * 60 * 1000;
          value.dialogTimer = setTimeout(() => {
            // Expiry never answers a modal or steals focus back to its owner.
            value.cancelled = true;
            if (!value.inUse && agentSelection === value) agentSelection = undefined;
          }, 5 * 60 * 1000);
          value.dialogTimer?.unref?.();
        };
        value.releaseDialog = () => {
          value.assertCurrent();
          value.dialogHeld = false;
          clearTimeout(value.dialogTimer);
        };
        value.runNativeGroupMove = async (action, perform) => {
          value.assertCurrent();
          if (action !== nativeGroupMove || value.groupMove) throw new Error("This Safari selection has no matching native group mutation");
          const before = new Map((await api.tabs.query({ windowId: targetTab.windowId })).map(tab => [tab.id, { ...tab }]));
          value.assertCurrent();
          const transition = { action, before, ...(action === "createGroup" ? { create: {
            removed: new Set(), observed: false, ownerParked: false,
          } } : {}) };
          value.groupMove = transition;
          selectionTrace = { phase: "native", action, events: [], before: inventoryIds([...before.values()]), after: [] };
          let accepted = false;
          let nativeResult;
          let failureStage = "native";
          try {
            const result = nativeResult = await perform();
            value.assertCurrent();
            let freshOwner;
            if (transition.targetRemoval || transition.create) {
              failureStage = "source_proof";
              const source = result?.sourceCollection, destination = result?.destinationCollection;
              const nativeWindow = result?.windowIdentifier;
              const collection = proof => proof && proof.nativeWindowIdentifier === nativeWindow
                && (proof.title === null ? proof.identity === null : typeof proof.title === "string" && proof.title.length > 0
                  && proof.identity?.kind === "safari-native-title" && proof.identity.title === proof.title
                  && proof.identity.windowIdentifier === nativeWindow);
              const sourceTabs = await api.tabs.query({ windowId: targetTab.windowId });
              value.assertCurrent();
              if (result.action !== action || result.mutationApplied !== true
                || (!transition.create && !transition.activation)
                || typeof nativeWindow !== "string" || !nativeWindow
                || (scope.nativeWindowIdentifier !== undefined && nativeWindow !== scope.nativeWindowIdentifier)
                || !collection(source) || !collection(destination) || source.restored !== true
                || source.selectedUrlBefore !== targetTab.url || result.currentGroupTitle !== source.title
                || destination.title !== scope.destinationTitle || result.destinationGroupTitle !== destination.title) {
                value.cancelled = true;
                value.assertCurrent();
              }
              let priorOwner;
              try { priorOwner = await api.tabs.get(owner.tabId); } catch { /* Safari may rekey a restored source collection. */ }
              value.assertCurrent();
              if (priorOwner?.windowId === owner.windowId) freshOwner = priorOwner;
              else if (transition.create && before.has(owner.tabId)
                && (!priorOwner || priorOwner.windowId === -1)) {
                transition.create.observed = true;
                const original = [...before.values()].filter(tab => tab.url === value.ownerTab.url && tab.title === value.ownerTab.title);
                const restored = sourceTabs.filter(tab => !tab.incognito && tab.url === value.ownerTab.url && tab.title === value.ownerTab.title);
                if (original.length === 1 && restored.length === 1) freshOwner = restored[0];
              }
              if (!freshOwner || freshOwner.windowId !== owner.windowId || freshOwner.incognito
                || freshOwner.url !== value.ownerTab.url || freshOwner.title !== value.ownerTab.title) {
                value.cancelled = true;
                value.assertCurrent();
              }
            }
            if (transition.activation || transition.create) {
              failureStage = "selected_proof";
              const selected = result?.selectedTab;
              const active = transition.create
                ? await api.tabs.query({ active: true, windowId: targetTab.windowId }) : null;
              const current = active ? (active.length === 1 ? active[0] : {}) : await api.tabs.get(transition.activation.tabId);
              const prior = before.get(current.id) || (transition.create
                ? (() => { const samePage = [...before.values()].filter(tab => tab.url === current.url && tab.title === current.title);
                  return samePage.length === 1 ? samePage[0] : undefined; })() : undefined);
              const window = await api.windows.get(targetTab.windowId);
              value.assertCurrent();
              // The native helper identifies its terminal AX-selected tab only
              // after the confirmed mutation and all native UI cleanup. Match
              // that exact single transition; never accept arbitrary tab changes.
              if (result.action !== action || result.mutationApplied !== true || !selected
                || !Number.isSafeInteger(selected.index) || selected.index < 0
                || !window.focused || current.windowId !== targetTab.windowId || !current.active || current.incognito
                || !prior || prior.url !== current.url || prior.title !== current.title
                || selected.index !== current.index || selected.title !== current.title || selected.url !== current.url) {
                value.cancelled = true;
                value.assertCurrent();
              }
              value.verifiedNativeSelection = { tabId: current.id, windowId: current.windowId,
                index: current.index, title: current.title, url: current.url };
            }
            if (freshOwner && (freshOwner.id !== owner.tabId || transition.create?.ownerParked)) {
              failureStage = "owner_rebind";
              await serialize(async () => {
                value.assertCurrent();
                const current = await api.tabs.get(freshOwner.id);
                const terminal = await api.tabs.get(value.verifiedNativeSelection.tabId);
                const window = await api.windows.get(owner.windowId);
                const verified = value.verifiedNativeSelection;
                value.assertCurrent();
                if (current.windowId !== owner.windowId || current.incognito
                  || current.url !== value.ownerTab.url || current.title !== value.ownerTab.title
                  || !window.focused || !terminal.active || terminal.windowId !== verified.windowId
                  || terminal.index !== verified.index || terminal.url !== verified.url || terminal.title !== verified.title) {
                  value.cancelled = true;
                  value.assertCurrent();
                }
                // Restored inactive source tabs reject script injection in
                // Safari. Restore this already-proved owner once, before any
                // snapshot or frame script, not after the operation returns.
                transition.create.restoringOwner = true;
                await value.select(current);
                const selectedOwner = await api.tabs.get(current.id);
                const ownerWindow = await api.windows.get(current.windowId);
                value.assertCurrent();
                if (!selectedOwner.active || !ownerWindow.focused || selectedOwner.incognito
                  || selectedOwner.windowId !== current.windowId || selectedOwner.index !== current.index
                  || selectedOwner.url !== current.url || selectedOwner.title !== current.title) {
                  value.cancelled = true;
                  value.assertCurrent();
                }
                value.verifiedNativeSelection = { tabId: selectedOwner.id, windowId: selectedOwner.windowId,
                  index: selectedOwner.index, title: selectedOwner.title, url: selectedOwner.url };
                const previousTabId = owner.tabId, previousOptions = optionsByTab.get(previousTabId);
                owner.tabId = current.id;
                owner.windowId = current.windowId;
                optionsByTab.delete(previousTabId);
                if (previousOptions) optionsByTab.set(current.id, previousOptions);
                // Keep the native owner/conversation, but replace obsolete tab
                // bootstrap or a same-ID frame whose parked handshake failed.
                await options.companion.rebindAgentOwner(owner, previousTabId);
                value.assertCurrent();
                // A restored document may have either retained the old frame
                // or no controller. Only the latter needs no unmount command.
                failureStage = "owner_unmount";
                await unmountContent(owner, true);
                failureStage = "owner_mount";
                await mountContent(owner);
                value.assertCurrent();
                failureStage = "owner_commit";
                await save();
                transition.create.ownerRestored = true;
              });
              result.sidebarOwner = { tabId: owner.tabId, windowId: owner.windowId, rebound: true };
            }
            accepted = true;
            return result;
          } catch (error) {
            // Record only bounded public enums before cleanup can cancel the
            // original broker request and obscure the failing local phase.
            selectionTrace.failure = { stage: failureStage,
              code: SELECTION_FAILURE_CODES.has(error?.code) ? error.code : "UNCLASSIFIED" };
            if (nativeResult?.mutationApplied === true) {
              error.mutationApplied = true;
              error.doNotReplay = true;
              if (Number.isSafeInteger(nativeResult.actionsPerformed)) error.actionsPerformed = nativeResult.actionsPerformed;
              error.data = { ...error.data, nativeResult };
            }
            throw error;
          } finally {
            selectionTrace.phase = accepted ? "verified" : "rejected";
            try { selectionTrace.after = inventoryIds(await api.tabs.query({})); }
            catch { selectionTrace.phase = "inventory_unavailable"; }
            if (value.groupMove === transition) value.groupMove = undefined;
            if (transition.create) {
              await serialize(async () => {
                for (const id of transition.create.removed) {
                  optionsByTab.delete(id);
                  for (const created of mediaTabs.values()) created.delete(id);
                }
                await save();
              });
            }
            if (transition.targetRemoval) {
              if (!accepted) value.cancelled = true;
              await serialize(() => removeTab(transition.targetRemoval.tabId));
            }
            if (!accepted && transition.create?.observed) {
              value.cancelled = true;
              // A failed source proof cannot revive a parked/rekeyed owner.
              await serialize(async () => {
                if (openByWindow.get(owner.windowId) === owner) await closeState(owner, "group_unconfirmed", true);
              });
            } else if (!accepted && transition.activation && !transition.handled) {
              value.cancelled = true;
              await serialize(() => activateTab(transition.activation));
            }
          }
        };
        agentSelection = value;
        return value;
      });
      if (!selection) return operation(null);
      try {
        const result = await operation(selection);
        // A moved target can leave Safari on a verified source sibling. Restore
        // a source owner only while that exact terminal selection is unchanged.
        // Do not attempt to switch native groups for an owner that was moved.
        const movedOwner = selection.verifiedNativeSelection && selection.owner.tabId === targetTab.id;
        const restoredOwner = selection.verifiedNativeSelection?.tabId === selection.owner.tabId;
        if (!selection.dialogHeld && !selection.cancelled && !movedOwner && !restoredOwner && openByWindow.get(selection.owner.windowId) === selection.owner) {
          const verified = selection.owner.tabId !== targetTab.id ? selection.verifiedNativeSelection : undefined;
          try {
            const current = await api.tabs.get(verified?.tabId ?? targetTab.id);
            const window = await api.windows.get(verified?.windowId ?? targetTab.windowId);
            const unchanged = !verified || (current.windowId === verified.windowId && current.index === verified.index
              && current.title === verified.title && current.url === verified.url);
            if (current.active && window.focused && unchanged) {
              const owner = await api.tabs.get(selection.owner.tabId);
              if (owner.windowId === selection.owner.windowId) {
                await selection.select(owner);
                selection.assertCurrent();
                if (typeof scope.afterOwnerRestored === "function") {
                  await scope.afterOwnerRestored(owner);
                  selection.assertCurrent();
                }
              }
            }
          } catch (error) {
            if (verified) {
              error.message += " The native group move completed; owner restoration was not confirmed. Do not repeat the group move.";
              error.data = { ...error.data, mutationApplied: true, doNotReplay: true, nativeResult: result };
            }
            throw error;
          }
        }
        return result;
      } finally {
        selection.inUse = false;
        if (!selection.dialogHeld || selection.cancelled) {
          clearTimeout(selection.dialogTimer);
          if (agentSelection === selection) agentSelection = undefined;
        }
      }
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
        if (message.type === MESSAGE.ready) {
          // A parked native source has no usable frame authority yet. Its
          // successful native result performs the one verified remount.
          if (nativeOwnerSuspended(state)) return { ok: true, open: true, suspended: true };
          // A new owning document needs its frame, not a new native account
          // owner or tunnel. Initial opening/restoration already bound it.
          if (embedded) await mountContent(state);
          else await mount(state);
        }
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
    async function removeTab(tabId) {
      optionsByTab.delete(tabId);
      for (const state of Array.from(openByWindow.values())) {
        if (state.tabId === tabId) await closeState(state, "tab_removed", true);
      }
      await save();
    }
    api.tabs.onRemoved.addListener((tabId, details) => {
      traceSelection("tabRemoved", { tabId, windowId: details?.windowId });
      const transition = agentSelection?.groupMove;
      if (transition?.create && !agentSelection.cancelled && transition.before.has(tabId) && details?.windowId === -1) {
        // Switching native collections may unload every source API identity,
        // including the owner. Only this native lease may reconcile them.
        transition.create.observed = true;
        transition.create.removed.add(tabId);
        if (tabId === agentSelection.owner.tabId) transition.create.ownerParked = true;
        return;
      }
      if (transition && !agentSelection.cancelled && !transition.targetRemoval && tabId === agentSelection.targetTab.id
        && tabId !== agentSelection.owner.tabId && details?.windowId === -1) {
        // Safari emits this exact removal when a moved tab leaves the visible
        // source collection. Native source/destination proof must confirm it.
        transition.targetRemoval = { tabId };
        return;
      }
      if (agentSelection && [agentSelection.owner.tabId, agentSelection.targetTab.id].includes(tabId)) agentSelection.cancelled = true;
      serialize(() => removeTab(tabId)).catch(reportError);
    });
    async function activateTab({ tabId, windowId }, alreadyUnmounted = false) {
      const previous = openByWindow.get(windowId);
      if (!previous || previous.tabId === tabId) return;
      await closeState(previous, "tab_changed", alreadyUnmounted);
      if (getOptionsUnlocked(tabId).enabled) await openUnlocked({ tabId, windowId });
    }
    function createTransfer(tabId, windowId) {
      const selection = agentSelection, transition = selection?.groupMove, flow = transition?.create;
      if (!flow || selection.cancelled || !transition.before.has(tabId)) return;
      // Safari's virtual -1 lifecycle differs between collection switches.
      // Do not infer physical movement or require an optional event sequence.
      if (windowId === -1 || windowId === selection.targetTab.windowId) {
        flow.observed = true;
        if (tabId === selection.owner.tabId && windowId === -1) flow.ownerParked = true;
      }
      else selection.cancelled = true;
    }
    api.tabs.onActivated.addListener(({ tabId, windowId }) => {
      traceSelection("tabActivated", { tabId, windowId });
      let parkedOwner = false;
      if (agentSelection) {
        const expected = agentSelection.cancelled ? -1
          : agentSelection.expected.findIndex(item => item.tabId === tabId && item.windowId === windowId);
        if (expected >= 0) { agentSelection.expected.splice(expected, 1); return; }
        const transition = agentSelection.groupMove;
        const flow = transition?.create;
        if (!agentSelection.cancelled && flow && !flow.restoringOwner && windowId === agentSelection.targetTab.windowId) {
          // The native phase guards own real menu/tab/user changes during this
          // call. API collection churn is staged until restored-source proof;
          // the final active tab must match native URL/title/index exactly.
          transition.activation = { tabId, windowId };
          return;
        }
        if (!flow && !agentSelection.cancelled && transition && !transition.activation && windowId === agentSelection.targetTab.windowId) {
          // Defer one native-move side effect, not an interval of user events.
          // A failed/mismatched native result replays normal owner invalidation.
          transition.activation = { tabId, windowId };
          return;
        }
        if (transition) transition.handled = true;
        parkedOwner = flow?.observed === true;
        agentSelection.cancelled = true;
      }
      serialize(() => activateTab({ tabId, windowId }, parkedOwner)).catch(reportError);
    });
    api.windows?.onFocusChanged?.addListener(windowId => {
      traceSelection("windowFocusChanged", { windowId });
      if (agentSelection && windowId !== agentSelection.expectedWindow) agentSelection.cancelled = true;
    });
    api.tabs.onCreated?.addListener(tab => traceSelection("tabCreated", { tabId: tab.id, windowId: tab.windowId }));
    api.tabs.onDetached?.addListener((tabId, details) => {
      traceSelection("tabDetached", { tabId, oldWindowId: details.oldWindowId });
      createTransfer(tabId, details.oldWindowId);
    });
    api.tabs.onAttached?.addListener((tabId, details) => {
      traceSelection("tabAttached", { tabId, newWindowId: details.newWindowId });
      createTransfer(tabId, details.newWindowId);
    });
    api.windows?.onCreated?.addListener(window => traceSelection("windowCreated", { windowId: window.id }));
    api.windows?.onRemoved?.addListener(windowId => traceSelection("windowRemoved", { windowId }));
    api.tabs.onUpdated?.addListener((tabId, change) => {
      if (!embedded || change.status !== "complete") return;
      serialize(async () => {
        const state = Array.from(openByWindow.values()).find(item => item.tabId === tabId);
        if (!state) return;
        if (nativeOwnerSuspended(state)) return;
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
        if (!panelBehavior.openPanelOnActionClick && !options.toolbarAlwaysOpens) return;
        const state = openByWindow.get(tab.windowId);
        if (state?.tabId === tab.id) await closeState(state, "toolbar");
        else {
          optionsByTab.set(tab.id, { enabled: true, path: "codex-work-sidepanel.html" });
          await openUnlocked({ tabId: tab.id, windowId: tab.windowId });
        }
      }).catch(reportError);
    });

    return { sidePanel, ready, mountContent, unmountContent, withAgentSelection,
      selectionDiagnostics: () => structuredClone(selectionTrace), messages: MESSAGE, origin: extensionOrigin(api.runtime) };
  }

  const exported = { createSidebarAdapter, extensionOrigin, MESSAGE };
  if (typeof module === "object" && module.exports) module.exports = exported;
  const api = root.browser || root.chrome;
  if (api?.runtime?.id && !api.sidePanel?.open) {
    // Safari owns this toolbar even while upstream desktop discovery changes
    // its Chrome panel mode. A cold/reloaded background must not leave the
    // visible button inert because the upstream panel behavior is still false.
    const adapter = createSidebarAdapter(api, { ...root.ChatGPTSafariSidebarOptions, toolbarAlwaysOpens: true });
    api.sidePanel = adapter.sidePanel;
    if (root.chrome && root.chrome !== api) root.chrome.sidePanel = adapter.sidePanel;
    root.ChatGPTSafariSidebar = adapter;
  }
})(globalThis);
