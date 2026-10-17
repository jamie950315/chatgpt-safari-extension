/* Original consent/security remains in the cloud-command dispatcher. */
(function (root) {
  "use strict";
  const sameOwner = (left, right) => left.instanceId === right.instanceId
    && left.profileId === right.profileId && left.accountScope === right.accountScope;
  function nativeFailure(response, fallback, bookmarkOperation = false) {
    const error = new Error(response?.error?.message || fallback);
    error.code = response?.error?.code;
    error.data = response?.error?.data;
    for (const key of ["mutationApplied", "doNotReplay"]) {
      if (typeof error.data?.[key] === "boolean") error[key] = error.data[key];
    }
    if (bookmarkOperation) {
      // The original kernel retains Error.message, not arbitrary error data.
      // Carry only fixed native stages, timings, and equality outcomes across
      // that boundary. Never copy bookmark titles, URLs, handles or inventories.
      const data = error.data || {}, safe = {};
      if (["BOOKMARK_OPERATION_UNCONFIRMED", "FOCUS_CHANGED", "BOOKMARK_DEADLINE_EXPIRED", "STALE_OPERATION"].includes(error.code)) safe.code = error.code;
      if (["expansion", "restoration", "inventory", "confirmation", "source_reveal", "destination_reveal", "url_focus", "url_commit", "title_focus", "title_commit",
        "folder_focus", "folder_commit", "delete_menu", "delete_completion"].includes(data.stage)) safe.stage = data.stage;
      if (["none", "owner", "deadline", "owner_and_deadline", "frontmost_process", "focused_application", "focused_window",
        "window_identity", "window_bounds", "input", "editor_surface", "editor_identity", "utility_identity"].includes(data.guardStage)) safe.guardStage = data.guardStage;
      for (const key of ["waitMS", "queueWaitMS", "elapsedMS", "expansionMS", "inventoryMS", "attachedSheetCount",
        "initialExpansionMS", "initialInventoryMS", "utilityMS", "reentryExpansionMS", "reentryInventoryMS", "updateMS", "finalInventoryMS"]) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 1_000_000_000) safe[key] = data[key];
      }
      for (const key of ["focusedElementMatches", "fieldFocused", "valueMatches", "mutationApplied", "doNotReplay", "sheetPhase",
        "focusedIsSheet", "focusedIsBookmarkSheet", "focusedMatchesAttachedSheet", "focusedParentMatchesWindow", "focusedAXWindowMatchesWindow", "sheetInWindowSurface"]) {
        if (typeof data[key] === "boolean") safe[key] = data[key];
      }
      if (Object.keys(safe).length) error.message += ` Native bookmark result: ${JSON.stringify(safe)}.`;
    }
    return error;
  }
  function createPersonalData(api, companion, sidebar = root.ChatGPTSafariSidebar) {
    let bookmarksBusy = false;
    const activeCreations = new Map();
    const currentOwner = async owner => {
      if (!sameOwner(await companion.agentOwner(), owner)) throw new Error("The original side-chat owner changed; personal data was not returned");
    };
    const send = (owner, command) => api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command: {
      action: "personalData", ownerToken: owner.instanceId, profileId: owner.profileId,
      command: { ...command, profileId: owner.profileId },
    } });
    const cancelCreation = transaction => {
      transaction.revoked = true;
      if (transaction.delivered && !transaction.complete && !transaction.cancelSent && transaction.cancelCommand) {
        transaction.cancelSent = true;
        void send(transaction.owner, transaction.cancelCommand).catch(() => {});
      }
    };
    async function readyTab(tabId, windowId, url, owner, navigation) {
      const check = async () => {
        await currentOwner(owner);
        if (!navigation.untouched) throw new Error("The temporary Safari bookmark navigation changed");
        const tab = await api.tabs.get(tabId);
        const tabs = await api.tabs.query({ windowId });
        if (tab.windowId !== windowId || tab.incognito || tabs.length !== 1 || tabs[0].id !== tabId
          || tab.pendingUrl != null && tab.pendingUrl !== "" && tab.pendingUrl !== url) {
          navigation.untouched = false;
          throw new Error("The temporary Safari bookmark page or its pending navigation changed");
        }
        if (tab.url === url) {
          navigation.committed = true;
          return tab.status !== "loading" ? tab : undefined;
        }
        // Safari can acknowledge windows.create while its one initial tab is
        // still blank. Observe that already-delivered navigation, without
        // selecting the tab or invoking any native bookmark operation yet.
        if (!navigation.committed && [undefined, "", "about:blank"].includes(tab.url)) return undefined;
        navigation.untouched = false;
        throw new Error("The temporary Safari bookmark page changed");
      };
      // Observe the one delivered navigation; never reload it after a timeout.
      let listener, timeout, resolveChanged, rejectChanged;
      const changed = new Promise((resolve, reject) => { resolveChanged = resolve; rejectChanged = reject; });
      // An update can arrive while the initial native owner read is pending.
      // Retain that rejection without an unhandled-rejection side effect.
      changed.catch(() => {});
      listener = (id, change = {}) => {
        if (id !== tabId) return;
        if (change.url != null && change.url !== url || change.pendingUrl != null && change.pendingUrl !== "" && change.pendingUrl !== url) {
          navigation.untouched = false;
          rejectChanged(new Error("The temporary Safari bookmark navigation changed; no bookmark command was started"));
          return;
        }
        check().then(tab => { if (tab) resolveChanged(tab); }, rejectChanged);
      };
      api.tabs.onUpdated?.addListener(listener);
      try {
        const initial = await check();
        if (initial) return initial;
        return await Promise.race([changed, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Safari's temporary bookmark page did not finish loading")), 5000);
        })]);
      } finally { clearTimeout(timeout); api.tabs.onUpdated?.removeListener(listener); }
    }
    async function bookmarks(method, args = [], expectedOwner, originalScope) {
      if (bookmarksBusy) throw new Error("Another native Safari bookmark operation is running; this request was not queued");
      if (!["getTree", "search", "get", "getChildren", "getSubTree", "update", "createFolder", "create", "remove", "removeTree", "move"].includes(method)
        || !Array.isArray(args) || args.length > 2) throw new Error("This native Safari bookmark method is unsupported");
      // The sidebar adapter initializes after this background module.
      const activeSidebar = sidebar || root.ChatGPTSafariSidebar;
      if (typeof activeSidebar?.withAgentSelection !== "function") throw new Error("Safari's owner-bound bookmark selection is unavailable");
      if (method === "create" && (!originalScope || typeof originalScope.sessionId !== "string" || !originalScope.sessionId
        || typeof originalScope.turnId !== "string" || !originalScope.turnId || typeof originalScope.assertCurrent !== "function")) {
        throw new Error("URL bookmark creation requires the exact original agent session and turn");
      }
      bookmarksBusy = true;
      let owner, windowId, tabId, url, nativeDelivered = false, navigationWatcher;
      let creation;
      const navigation = { untouched: true, committed: false };
      const mutation = ["update", "createFolder", "create", "remove", "removeTree", "move"].includes(method);
      try {
        owner = await companion.agentOwner();
        if (expectedOwner && !sameOwner(owner, expectedOwner)) throw new Error("The original side-chat owner changed before reading bookmarks");
        const entry = await send(owner, { action: "utilityEntry" });
        await currentOwner(owner);
        if (entry?.ok !== true) throw nativeFailure(entry, "Safari's temporary bookmark page is unavailable");
        const parsed = new URL(entry.result?.url);
        if (parsed.protocol !== "http:" || !/^chatgpt-utility-[a-f0-9-]{36}\.localhost$/iu.test(parsed.hostname)
          || !parsed.port || !/^\/bookmarks\/[a-f0-9-]{36}$/iu.test(parsed.pathname)
          || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("The native bookmark utility address is invalid");
        url = parsed.href;
        const before = await api.windows.getAll({ windowTypes: ["normal"] });
        await currentOwner(owner);
        const created = await api.windows.create({ url, focused: false, type: "normal" });
        // A mismatched response never grants cleanup authority over another window.
        if (!Number.isSafeInteger(created?.id) || created.id <= 0 || before.some(item => item.id === created.id)) {
          const error = new Error("Safari did not identify the newly created bookmark window. Inspect current windows before repeating the request");
          error.doNotReplay = true; throw error;
        }
        windowId = created.id;
        const tabs = await api.tabs.query({ windowId });
        if (tabs.length !== 1 || tabs[0].incognito || tabs[0].windowId !== windowId
          || !Number.isSafeInteger(tabs[0].id) || tabs[0].id <= 0) {
          throw new Error("Safari did not return the sole temporary bookmark tab");
        }
        tabId = tabs[0].id;
        navigationWatcher = (id, change = {}) => {
          if (id !== tabId) return;
          const allowed = nativeDelivered ? [url, "bookmarks://"] : [url];
          if (change.url != null && !allowed.includes(change.url)
            || change.pendingUrl != null && change.pendingUrl !== "" && !allowed.includes(change.pendingUrl)) navigation.untouched = false;
        };
        api.tabs.onUpdated?.addListener(navigationWatcher);
        const tab = await readyTab(tabId, windowId, url, owner, navigation);
        const outcome = await activeSidebar.withAgentSelection(owner.instanceId, tab, async selection => {
          // Returning failures lets the selection owner restore the original
          // window. Throwing here would skip that normal restoration path.
          try {
            if (!selection) throw new Error("The Safari sidebar no longer owns this bookmark operation");
            await selection.select(tab);
            await currentOwner(owner);
            const current = await api.tabs.get(tabId), siblings = await api.tabs.query({ windowId });
            if (current.windowId !== windowId || current.url !== url || current.status === "loading"
              || current.pendingUrl != null && current.pendingUrl !== "" && current.pendingUrl !== url
              || siblings.length !== 1 || siblings[0].id !== tabId) {
              navigation.untouched = false;
              throw new Error("The temporary Safari bookmark tab changed before native execution");
            }
            const window = await api.windows.get(windowId);
            if (window.type !== "normal" || window.incognito || !window.focused) throw new Error("The temporary bookmark window is not focused");
            const windowBounds = Object.fromEntries(["left", "top", "width", "height"].map(key => [key, window[key]]));
            if (Object.values(windowBounds).some(value => !Number.isFinite(value)) || windowBounds.width <= 0 || windowBounds.height <= 0) {
              throw new Error("Safari did not return actual bookmark-window bounds");
            }
            selection.assertCurrent();
            let scope = {};
            if (method === "create") {
              await originalScope.assertCurrent();
              const operationId = root.crypto.randomUUID().toUpperCase();
              scope = { operationId, sessionId: originalScope.sessionId, turnId: originalScope.turnId, issuedAtMs: Date.now() };
              creation = { owner, ...scope, revoked: false, delivered: false, complete: false,
                pendingTitle: `ChatGPT Safari Pending ${operationId}`,
                cancelCommand: { action: "bookmarksCancel", expectedUrl: url, windowBounds, ...scope } };
              activeCreations.set(operationId, creation);
              creation.timer = setTimeout(() => cancelCreation(creation), 45000);
            }
            nativeDelivered = true;
            if (creation) creation.delivered = true;
            let response = await send(owner, { action: "bookmarks", expectedUrl: url, windowBounds, method, arguments: args, ...scope });
            if (creation && response?.ok === true) {
              const pending = response.result;
              if (pending?.kind !== "bookmark-create-staged" || pending.operationId !== creation.operationId
                || pending.pendingTitle !== creation.pendingTitle || typeof pending.receipt !== "string"
                || !/^[a-f0-9-]{36}$/iu.test(pending.receipt)) throw new Error("The one-shot native bookmark receipt is invalid; Add was not repeated");
              await currentOwner(owner);
              await originalScope.assertCurrent();
              selection.assertCurrent();
              if (creation.revoked || !navigation.untouched) throw new Error("The original bookmark transaction was cancelled or its document changed; Add was not repeated");
              // Native bookmarks:// temporarily has no ordinary API tab.
              // The consumed receipt owns that exact original native editor;
              // do not invent or reacquire a tab identity between stages.
              const currentWindow = await api.windows.get(windowId);
              if (currentWindow.incognito || !currentWindow.focused
                || ["left", "top", "width", "height"].some(key => currentWindow[key] !== windowBounds[key])) {
                throw new Error("The exact original bookmark utility window or native document changed before finalization; Add was not repeated");
              }
              // Continue the same original selection; never select/focus again
              // to hide a manual foreground change between the two stages.
              response = await send(owner, { action: "bookmarksContinue", expectedUrl: url, windowBounds, receipt: pending.receipt, ...scope });
              await originalScope.assertCurrent();
              if (creation.revoked) throw new Error("The original bookmark transaction was cancelled before its final result");
              if (response?.ok === true) {
                const complete = response.result;
                if (complete?.kind !== "bookmark-create-complete" || complete.utilityRestored !== true || !complete.record
                  || typeof selection.confirmBookmarkUtility !== "function") throw new Error("The native bookmark result did not prove utility restoration; Add was not repeated");
                const siblings = await api.tabs.query({ windowId }), restoredWindow = await api.windows.get(windowId);
                if (siblings.length !== 1 || restoredWindow.incognito || !restoredWindow.focused
                  || ["left", "top", "width", "height"].some(key => restoredWindow[key] !== windowBounds[key])) {
                  throw new Error("The restored bookmark utility is no longer the sole tab in its original window; Add was not repeated");
                }
                const restored = await api.tabs.get(siblings[0].id);
                if (restored.windowId !== windowId || restored.url !== url || restored.incognito || !restored.active
                  || restored.status === "loading" || restored.pendingUrl != null && restored.pendingUrl !== "" && restored.pendingUrl !== url) {
                  throw new Error("Safari did not restore the exact capability-bound bookmark utility page; Add was not repeated");
                }
                selection.confirmBookmarkUtility(restored);
                tabId = restored.id;
                creation.complete = true;
                response = { ok: true, result: complete.record };
              }
            }
            return response?.ok === true ? { value: response.result } : { error: nativeFailure(response, "Safari's native bookmark operation failed", true) };
          } catch (error) { return { error }; }
        }, method === "create" ? { nativeBookmarkCreate: url } : {});
        await currentOwner(owner);
        if (outcome.error) throw outcome.error;
        return outcome.value;
      } catch (error) {
        if (nativeDelivered && mutation) {
          error.doNotReplay = true;
          error.message += ". The native bookmark command was delivered once. Inspect current bookmarks before continuing; do not replay it.";
          if (creation && !creation.complete) error.message += ` Existing pending entry, if Add was applied: ${creation.pendingTitle}. Do not repeat Add.`;
        }
        throw error;
      } finally {
        if (creation) {
          clearTimeout(creation.timer);
          activeCreations.delete(creation.operationId);
          if (!creation.complete) cancelCreation(creation);
        }
        // Close only our untouched, sole-tab utility window, after the owner
        // was restored. A focus change, user tab, navigation or account change
        // leaves it in place instead of closing or refocusing the user's work.
        if (owner && windowId && tabId) {
          try {
            await currentOwner(owner);
            const ownerWindow = await api.windows.get(owner.windowId);
            const window = await api.windows.get(windowId);
            const tabs = await api.tabs.query({ windowId });
            const pendingInitial = !navigation.committed && !nativeDelivered && [undefined, "", "about:blank"].includes(tabs[0]?.url)
              && tabs[0]?.pendingUrl === url;
            if (navigation.untouched && ownerWindow.focused && !window.focused && tabs.length === 1 && tabs[0].id === tabId
              && ([url, "bookmarks://"].includes(tabs[0].url) || pendingInitial)
              && (tabs[0].pendingUrl == null || tabs[0].pendingUrl === "" || [url, "bookmarks://"].includes(tabs[0].pendingUrl))) await api.windows.remove(windowId);
          } catch { /* No cleanup authority remains after a changed owner/window. */ }
        }
        if (navigationWatcher) api.tabs.onUpdated?.removeListener(navigationWatcher);
        bookmarksBusy = false;
      }
    }
    return Object.freeze({
      bookmarks,
      cancelBookmarks(sessionId) {
        for (const transaction of activeCreations.values()) if (transaction.sessionId === sessionId) cancelCreation(transaction);
      },
      getBookmarks: () => bookmarks("getTree"),
      async history(request) {
        const owner = await companion.agentOwner();
        const args = {};
        if (request.queries != null) {
          if (!Array.isArray(request.queries) || request.queries.length === 0 || request.queries.some(value => typeof value !== "string")) {
            throw new TypeError("History queries must be a nonempty array of strings");
          }
          args.queries = request.queries;
        }
        if (request.limit != null) {
          if (!Number.isSafeInteger(request.limit) || request.limit <= 0) throw new TypeError("History limit must be a positive integer");
          args.limit = request.limit;
        }
        for (const key of ["from", "to"]) if (request[key] != null) {
          if (typeof request[key] !== "string" || !Number.isFinite(Date.parse(request[key]))) throw new TypeError(`History ${key} must be a valid date`);
          args[key] = new Date(request[key]).toISOString();
        }
        const response = await send(owner, { action: "history", arguments: args });
        await currentOwner(owner);
        if (response?.ok !== true) {
          throw nativeFailure(response, "Safari history could not be read");
        }
        if (!Array.isArray(response.result) || response.result.some(item => !item || typeof item.url !== "string"
          || typeof item.dateVisited !== "string" || !Number.isFinite(Date.parse(item.dateVisited))
          || (item.title !== undefined && typeof item.title !== "string"))) throw new Error("The native Safari history result is invalid");
        return response.result;
      },
    });
  }
  if (typeof module === "object" && module.exports) module.exports = { createPersonalData };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariPersonalData = createPersonalData(api, root.ChatGPTSafariSidebarOptions.companion);
})(globalThis);
