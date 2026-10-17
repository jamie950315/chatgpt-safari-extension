/* User-requested organization of real Safari tabs. Native groups are named
 * collections, not Chrome's colored inline groups. No browser API is replaced. */
(function (root) {
  "use strict";
  const record = value => value != null && typeof value === "object" && !Array.isArray(value);
  const id = value => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Use an explicit Safari tab or window ID from a current query");
    return value;
  };
  function options(value, keys, empty = false) {
    if (!record(value) || (!empty && Object.keys(value).length === 0) || Object.keys(value).some(key => !keys.includes(key))) {
      throw new Error("This Safari organization option is unsupported; read the management capability documentation");
    }
    return value;
  }
  const tabIds = value => {
    const result = [...new Set((Array.isArray(value) ? value : [value]).map(id))];
    if (!result.length || result.length > 50) throw new Error("Organize between 1 and 50 explicitly selected tabs");
    return result;
  };
  const auditKey = "safariManagementAuditTrail", auditLimit = 50, auditLifetime = 72 * 60 * 60 * 1000;
  let auditQueue = Promise.resolve();
  function auditScope(owner) {
    if (typeof owner.accountScope !== "string" || !/^[a-z0-9_-]{1,128}$/iu.test(owner.accountScope)) {
      throw new Error("The verified ChatGPT account scope is unavailable for Safari's management audit");
    }
    return { profileId: owner.profileId, accountScope: owner.accountScope };
  }
  const sameAuditScope = (left, right) => left.profileId === right.profileId && left.accountScope === right.accountScope;
  function serializedAudit(operation) {
    const result = auditQueue.then(operation);
    auditQueue = result.catch(() => {});
    return result;
  }
  async function readAuditEntries(api) {
    if (typeof api.storage?.session?.get !== "function" || typeof api.storage.session.set !== "function") {
      throw new Error("Safari's browser-session management audit storage is unavailable");
    }
    const stored = (await api.storage.session.get(auditKey))[auditKey];
    const cutoff = Date.now() - auditLifetime;
    return (Array.isArray(stored) ? stored : []).filter(entry => record(entry) && record(entry.change)
      && typeof entry.profileId === "string" && typeof entry.accountScope === "string"
      && Array.isArray(entry.change.args) && record(entry.change.before)
      && typeof entry.change.namespace === "string" && typeof entry.change.method === "string"
      && Number.isFinite(entry.change.createdAt) && entry.change.createdAt >= cutoff).slice(-auditLimit);
  }
  const windowState = value => ({ id: value.id, focused: value.focused, left: value.left,
    top: value.top, width: value.width, height: value.height, state: value.state });
  function windowCreationOptions(args) {
    if (args.length > 1) throw new Error("windows.create accepts at most one argument");
    const value = options(args.length ? args[0] : {}, ["focused", "height", "left", "state", "tabId", "top", "type", "width"], true);
    if (value.type !== undefined && value.type !== "normal") throw new Error("windows.create supports only normal, non-private Safari windows");
    if (value.focused !== undefined && typeof value.focused !== "boolean") throw new Error("focused must be a boolean");
    if (value.state !== undefined && !["normal", "minimized", "maximized", "fullscreen"].includes(value.state)) throw new Error("Unsupported Safari window state");
    for (const key of ["left", "top", "width", "height"]) {
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (["width", "height"].includes(key) && value[key] <= 0))) {
        throw new Error("Safari window bounds require integer coordinates and positive dimensions");
      }
    }
    if (value.state !== undefined && value.state !== "normal" && ["left", "top", "width", "height"].some(key => value[key] !== undefined)) {
      throw new Error("Use state normal when setting Safari window bounds");
    }
    if (Object.hasOwn(value, "tabId")) id(value.tabId);
    return { ...value, type: "normal" };
  }
  function uncertainWindowCreation(error) {
    error.message += ". Safari window creation was delivered once and was not retried. Inspect current windows before continuing; do not repeat a possibly completed creation or tab move.";
    error.doNotReplay = true;
    error.data = { ...(record(error.data) ? error.data : {}), doNotReplay: true };
    return error;
  }
  function readableNativeFailure(error) {
    // The upstream kernel serializes only Error.message. Carry the bounded
    // native outcome through that boundary without copying private error data.
    const data = record(error.data) ? error.data : {}, safe = {};
    const codes = new Set(["GROUP_UI_UNAVAILABLE", "GROUP_RESULT_UNCONFIRMED", "GROUP_READ_CHANGED_SELECTION",
      "FOCUS_CHANGED", "PAGE_CHANGED", "NATIVE_TARGET_OBSCURED", "STALE_OPERATION", "LIVE_TIMEOUT"]);
    if (codes.has(error.code)) safe.code = error.code;
    if (["menu_completion", "sidebar_preflight", "sidebar_layout_confirmation"].includes(data.stage)) safe.stage = data.stage;
    for (const key of ["requestedVisible", "sidebarHit", "pickerHit", "newTabGroupButtonPresent",
      "visibleContextMenu", "visibleGroupPickerMenu", "visibleViewMenu", "visibleOtherNativeMenu",
      "nativeMenuFocused", "mutationApplied", "doNotReplay"]) {
      if (typeof data[key] === "boolean") safe[key] = data[key];
    }
    if (Number.isSafeInteger(data.sidebarToggleHitCount) && data.sidebarToggleHitCount >= 0 && data.sidebarToggleHitCount <= 8) {
      safe.sidebarToggleHitCount = data.sidebarToggleHitCount;
    }
    for (const key of ["tabBarRestoration", "nativeSidebarRestoration"]) {
      if (["restored", "unconfirmed"].includes(data[key])) safe[key] = data[key];
    }
    if (Object.keys(safe).length) error.message += ` Native result: ${JSON.stringify(safe)}.`;
    return error;
  }
  function createManagement(api, companion, personalData = root.ChatGPTSafariPersonalData) {
    const sessions = new Map();
    let nextGroup = 1;
    let busy = false;
    async function execute(command, session, metadata, owner, assertCurrent) {
      owner = { ...owner };
      const authorize = assertCurrent;
      assertCurrent = async () => {
        const current = await authorize();
        if (owner.accountScope !== undefined && (!current || !sameAuditScope(current, owner))) {
          throw new Error("The ChatGPT account changed during this Safari management command");
        }
        return current;
      };
      await assertCurrent();
      let state = sessions.get(metadata.session_id);
      if (!state || state.owner !== owner.instanceId || state.profile !== owner.profileId || state.accountScope !== owner.accountScope) {
        state = { owner: owner.instanceId, profile: owner.profileId, accountScope: owner.accountScope, groups: new Map() };
        sessions.set(metadata.session_id, state);
      }
      if (command.type === "browser_management_get_audit_trail") {
        const scope = auditScope(owner);
        return serializedAudit(async () => {
          const entries = await readAuditEntries(api);
          await assertCurrent();
          return { changes: entries.filter(entry => sameAuditScope(entry, scope)).map(entry => entry.change).reverse() };
        });
      }
      const { namespace, method, args } = command;
      if (!Array.isArray(args) || args.length > 2) throw new Error("Safari management requires explicit method arguments");
      const tab = async tabId => {
        await assertCurrent();
        const value = await api.tabs.get(id(tabId));
        if (value.incognito || !/^https?:\/\//iu.test(value.url || "")) throw new Error("Only ordinary HTTP/HTTPS Safari tabs can be organized");
        return value;
      };
      const owned = async tabId => { const value = await tab(tabId); await session.requireOwnedTab(value.id); return value; };
      const window = async windowId => {
        await assertCurrent();
        const value = await api.windows.get(id(windowId));
        if (value.incognito || value.type !== "normal") throw new Error("Use an ordinary Safari window");
        return value;
      };
      const audit = async (before, operation) => {
        await assertCurrent();
        const value = await operation();
        const result = typeof value === "number" ? value
          : namespace === "windows" && method === "create" && Number.isSafeInteger(value?.id) ? value.id
          : namespace === "bookmarks" && typeof value?.id === "string" ? { id: value.id } : undefined;
        // Like upstream, an unavailable audit store does not turn a completed
        // mutation into a failure. Queries explicitly report unavailability.
        try {
          const scope = auditScope(owner);
          await serializedAudit(async () => {
            const entries = await readAuditEntries(api);
            await assertCurrent();
            entries.push({ ...scope, change: { namespace, method, args, before, createdAt: Date.now(),
              ...(result === undefined ? {} : { result }) } });
            await api.storage.session.set({ [auditKey]: entries.slice(-auditLimit) });
          });
        } catch { /* Never replay a completed mutation because audit storage failed. */ }
        return value;
      };
      // The upstream audit's tabLayout schema requires Chrome-only group/color
      // and autoDiscardable values. Omit that snapshot rather than invent them.
      const layout = () => ({});
      const organize = async (target, action, extra = {}) => {
        await assertCurrent();
        try {
          return await companion.runAgentCommand({ action: "organize", arguments: {
            handle: `live:${owner.profileId}:${target.id}`, expectedUrl: target.url, operation: action, ...extra,
          } }, owner);
        } catch (error) { throw readableNativeFailure(error); }
      };
      const describeGroup = group => ({ id: group.id, title: group.title, windowId: group.windowId,
        nativeIdentity: { kind: "safari-native-title", title: group.title, windowIdentifier: group.windowIdentifier } });
      const observeGroups = async windowId => {
        const target = await tab(owner.tabId);
        if (windowId !== undefined && target.windowId !== id(windowId)) throw new Error("Inspect native groups in the sidebar's current Safari window");
        const observed = await organize(target, "inspect");
        const titles = observed.groupTitles;
        if (!Array.isArray(titles) || typeof observed.windowIdentifier !== "string") throw new Error("Safari did not return a native tab-group inventory");
        if (new Set(titles).size !== titles.length) throw new Error("Native Safari groups have duplicate names; rename them uniquely before organizing them");
        for (const group of state.groups.values()) {
          if (group.windowId === target.windowId && (group.windowIdentifier !== observed.windowIdentifier || !titles.includes(group.title))) state.groups.delete(group.id);
        }
        return titles.map(title => {
          let group = [...state.groups.values()].find(item => item.title === title && item.windowIdentifier === observed.windowIdentifier);
          if (!group) { group = { id: nextGroup++, title, windowId: target.windowId, windowIdentifier: observed.windowIdentifier, tabs: new Set() }; state.groups.set(group.id, group); }
          if (observed.currentGroupTitle === title) group.tabs.add(target.id);
          return describeGroup(group);
        });
      };
      const findGroup = async groupId => {
        await observeGroups();
        const group = state.groups.get(id(groupId));
        if (!group) throw new Error("The native Safari group changed. Query tabGroups again before acting");
        return group;
      };
      const groupTarget = async group => {
        // A successful creation grants this session authority over that exact
        // native group even while Safari hides its destination collection.
        if (group.createdBySession) {
          const source = await tab(owner.tabId);
          if (source.windowId !== group.windowId) throw new Error("The sidebar left the native group's Safari window");
          return source;
        }
        for (const tabId of group.tabs) {
          try { const value = await owned(tabId); if (value.windowId === group.windowId) return value; } catch { /* A user may have closed a formerly observed member. */ }
        }
        throw new Error("Claim a currently visible tab in this native group before renaming it");
      };

      let value;
      if (namespace === "bookmarks") {
        if (typeof personalData?.bookmarks !== "function") throw new Error("Safari's native bookmark capability is unavailable");
        const bookmark = async (operation, arguments_) => {
          await assertCurrent();
          return personalData.bookmarks(operation, arguments_, owner);
        };
        const handle = value => {
          if (typeof value !== "string" || !value || value.length > 256) throw new Error("Use a current native Safari bookmark handle");
          return value;
        };
        if (method === "getTree" && args.length === 0) value = await bookmark(method, []);
        else if (method === "search" && args.length === 1) {
          const query = typeof args[0] === "string" ? args[0] : options(args[0], ["query", "title", "url"], true);
          if (record(query) && Object.values(query).some(item => typeof item !== "string")) throw new Error("Bookmark search fields must be strings");
          value = await bookmark(method, [query]);
        } else if (method === "get" && args.length === 1) {
          const handles = Array.isArray(args[0]) ? args[0].map(handle) : handle(args[0]);
          if (Array.isArray(handles) && (!handles.length || handles.length > 100)) throw new Error("Read between 1 and 100 explicit bookmark handles");
          value = await bookmark(method, [handles]);
        } else if (["getChildren", "getSubTree"].includes(method) && args.length === 1) value = await bookmark(method, [handle(args[0])]);
        else if (method === "update" && args.length === 2) {
          const identifier = handle(args[0]), changes = options(args[1], ["title", "url"]);
          if (Object.values(changes).some(item => typeof item !== "string")) throw new Error("Bookmark changes must be strings");
          const previous = await bookmark("get", [identifier]);
          if (!Array.isArray(previous) || previous.length !== 1 || previous[0].id !== identifier) throw new Error("The current bookmark identity could not be read before updating it");
          const before = Object.fromEntries(["id", "index", "parentId", "title", "url"].filter(key => previous[0][key] !== undefined).map(key => [key, previous[0][key]]));
          value = await audit({ bookmarks: [before] }, () => bookmark("update", [identifier, changes]));
        } else if (method === "create" && args.length === 1) {
          const properties = options(args[0], ["title", "url", "parentId"]);
          if (properties.title !== undefined && typeof properties.title !== "string") throw new Error("A bookmark title must be a string");
          if (properties.parentId !== undefined) handle(properties.parentId);
          if (Object.hasOwn(properties, "url")) {
            let parsed;
            try { parsed = new URL(properties.url); } catch { /* Report invalid input before opening Safari UI. */ }
            if (typeof properties.url !== "string" || !parsed || !["http:", "https:"].includes(parsed.protocol)
              || parsed.username || parsed.password) throw new Error("Bookmark URLs require HTTP or HTTPS without credentials");
            value = await audit({}, () => bookmark("create", [properties]));
          } else {
            if (typeof properties.title !== "string" || !properties.title.trim()) throw new Error("A native bookmark folder needs a nonempty title");
            value = await audit({}, () => bookmark("createFolder", [properties]));
          }
        } else if (method === "move" && args.length === 2) {
          const identifier = handle(args[0]), properties = options(args[1], ["parentId"]);
          handle(properties.parentId);
          const previous = await bookmark("get", [identifier]);
          if (!Array.isArray(previous) || previous.length !== 1 || previous[0].id !== identifier) throw new Error("The current bookmark identity could not be read before moving it");
          const before = Object.fromEntries(["id", "index", "parentId", "title", "url"].filter(key => previous[0][key] !== undefined).map(key => [key, previous[0][key]]));
          value = await audit({ bookmarks: [before] }, () => bookmark("move", [identifier, properties]));
        } else if (["remove", "removeTree"].includes(method) && args.length === 1) {
          const identifier = handle(args[0]), previous = await bookmark("get", [identifier]);
          if (!Array.isArray(previous) || previous.length !== 1 || previous[0].id !== identifier) throw new Error("The current bookmark identity could not be read before deleting it");
          const before = Object.fromEntries(["id", "index", "parentId", "title", "url"].filter(key => previous[0][key] !== undefined).map(key => [key, previous[0][key]]));
          value = await audit({ bookmarks: [before] }, () => bookmark(method, [identifier]));
        } else throw new Error(`Safari does not support management.bookmarks.${method} with these arguments. Native bookmark movement requires an explicit destination folder; insertion indices and root drops are unavailable`);
      } else if (namespace === "tabs" && method === "query") {
        const query = options(args[0] ?? {}, ["windowId", "active", "pinned", "title", "url", "currentWindow", "lastFocusedWindow"], true);
        value = (await api.tabs.query(query)).filter(item => !item.incognito && /^https?:\/\//iu.test(item.url || ""));
      } else if (namespace === "tabs" && method === "get") value = await tab(args[0]);
      else if (namespace === "tabs" && method === "update") {
        const target = await owned(args[0]), changes = options(args[1], ["pinned"]);
        if (typeof changes.pinned !== "boolean") throw new Error("pinned must be a boolean");
        value = await audit(layout([target]), () => api.tabs.update(target.id, changes));
      } else if (namespace === "tabs" && method === "remove") {
        const targets = await Promise.all(tabIds(args[0]).map(owned));
        value = await audit(layout(targets), () => api.tabs.remove(targets.map(item => item.id)));
      } else if (namespace === "tabs" && method === "move") {
        const targets = await Promise.all(tabIds(args[0]).map(owned)), move = options(args[1], ["windowId", "index"]);
        if (!Number.isSafeInteger(move.index) || move.index < -1) throw new Error("tabs.move requires index >= -1");
        if (move.windowId !== undefined) await window(move.windowId);
        value = await audit(layout(targets), () => api.tabs.move(targets.map(item => item.id), move));
      } else if (namespace === "tabs" && method === "group") {
        const request = options(args[0], ["tabIds", "groupId", "createProperties"]);
        const targets = await Promise.all(tabIds(request.tabIds).map(owned));
        if (targets.some(item => item.id === owner.tabId)) throw new Error("Keep the active sidebar tab outside this native group operation. Open the sidebar in another existing tab before grouping its current page");
        if (targets.some(item => item.pinned || item.windowId !== targets[0].windowId)) throw new Error("Group unpinned tabs in the same Safari window; move them only when the user requests a transfer");
        const properties = options(request.createProperties ?? {}, ["windowId"], true);
        if (properties.windowId !== undefined && properties.windowId !== targets[0].windowId) throw new Error("createProperties.windowId must match the selected tabs");
        if (request.groupId !== undefined && request.createProperties !== undefined) throw new Error("Use either groupId or createProperties, not both");
        let group = request.groupId === undefined ? undefined : await findGroup(request.groupId);
        if (group && group.windowId !== targets[0].windowId) throw new Error("Select a native group in the same Safari window");
        const title = group?.title || `ChatGPT ${new Date().toISOString().replace(/[:.]/gu, "-")}`;
        const completed = [];
        const originalTabs = await api.tabs.query({ windowId: targets[0].windowId });
        let creationProof, latestProof;
        const pendingTarget = async original => {
          await assertCurrent();
          let current;
          try { current = await api.tabs.get(original.id); } catch { /* Safari rekeys hidden source tabs after group creation. */ }
          if (current?.id === original.id) {
            if (current.url !== original.url || current.title !== original.title || current.windowId !== original.windowId) {
              throw new Error("A pending claimed tab changed after the previous native operation");
            }
            return owned(original.id);
          }
          const source = latestProof?.sourceCollection;
          if (!creationProof || latestProof?.mutationApplied !== true || source?.restored !== true
            || source.nativeWindowIdentifier !== creationProof.windowIdentifier
            || source.title !== creationProof.sourceCollection?.title
            || originalTabs.filter(item => item.url === original.url && item.title === original.title).length !== 1) {
            throw new Error("Safari changed a pending tab's ID without an unambiguous restored source collection");
          }
          const matches = (await api.tabs.query({ windowId: original.windowId })).filter(item =>
            item.windowId === original.windowId && !item.incognito && item.id !== owner.tabId
            && item.url === original.url && item.title === original.title);
          await assertCurrent();
          if (matches.length !== 1) throw new Error("The originally claimed pending tab no longer has a unique source identity");
          // This one batch already claimed the original tab before any mutation.
          // Use its observed replacement ID, never publish a persistent alias or
          // transfer this authority to a later command/session.
          return matches[0];
        };
        try {
          value = await audit(layout(targets), async () => {
            for (const target of targets) {
              const current = await pendingTarget(target);
              const result = await organize(current, group ? "moveToGroup" : "createGroup", {
                groupTitle: title, ...(group ? { windowIdentifier: group.windowIdentifier } : { newTitle: title }),
              });
              latestProof = result;
              if (!group) {
                creationProof = result;
                group = { id: nextGroup++, title, windowId: target.windowId, windowIdentifier: result.windowIdentifier,
                  createdBySession: true, tabs: new Set() };
                state.groups.set(group.id, group);
              }
              group.tabs.add(current.id); completed.push(current.id);
            }
            return group.id;
          });
        } catch (error) {
          error.message = `${error.message}. Grouped tab IDs: ${completed.join(", ") || "none confirmed"}. Native operations were not retried. Query current tabs before continuing.`;
          throw error;
        }
      } else if (namespace === "tabs" && method === "ungroup") {
        const targets = await Promise.all(tabIds(args[0]).map(owned));
        if (targets.some(item => item.id === owner.tabId)) throw new Error("Keep the active sidebar tab outside this native group operation. Open the sidebar in another existing tab before ungrouping its current page");
        value = await audit(layout(targets), async () => {
          for (const target of targets) {
            await organize(await owned(target.id), "moveToUngrouped");
            for (const group of state.groups.values()) group.tabs.delete(target.id);
          }
        });
      } else if (namespace === "tabGroups" && method === "query") {
        const query = options(args[0] ?? {}, ["windowId", "title"], true);
        value = (await observeGroups(query.windowId)).filter(item => query.title === undefined || item.title === query.title);
      } else if (namespace === "tabGroups" && method === "get") value = describeGroup(await findGroup(args[0]));
      else if (namespace === "tabGroups" && method === "update") {
        const group = await findGroup(args[0]), changes = options(args[1], ["title"]);
        if (typeof changes.title !== "string" || !changes.title.trim() || changes.title.length > 120) throw new Error("A native group needs a nonempty title of at most 120 characters");
        const target = await groupTarget(group);
        value = await audit({}, async () => {
          const result = await organize(target, "renameGroup", { groupTitle: group.title, newTitle: changes.title, windowIdentifier: group.windowIdentifier });
          const renamed = result.renamedGroup;
          if (renamed?.kind !== "safari-native-title" || renamed.title !== changes.title
            || renamed.windowIdentifier !== group.windowIdentifier) {
            const error = new Error("Safari did not confirm the exact renamed native group. Inspect current groups; do not repeat the name change");
            error.mutationApplied = result.mutationApplied === true;
            error.doNotReplay = true;
            error.data = { nativeResult: result };
            throw error;
          }
          group.title = changes.title; return describeGroup(group);
        });
      } else if (namespace === "windows" && ["get", "getAll", "getCurrent", "getLastFocused"].includes(method)) {
        if (method === "get") value = await window(args[0]);
        else if (method === "getAll") {
          options(args[0] ?? {}, ["populate", "windowTypes"], true);
          value = (await api.windows.getAll(args[0] ?? {})).filter(item => !item.incognito && item.type === "normal");
        } else value = await window((await tab(owner.tabId)).windowId);
      } else if (namespace === "windows" && method === "create") {
        const create = windowCreationOptions(args);
        if (typeof api.windows.create !== "function") throw new Error("This Safari version does not expose native windows.create; no window or tab was changed");
        // Even blank creation belongs to the current ordinary-profile owner.
        await window((await tab(owner.tabId)).windowId);
        let target, sourceTabs;
        if (Object.hasOwn(create, "tabId")) {
          target = await owned(create.tabId);
          if (target.id === owner.tabId) throw new Error("Keep the active sidebar tab outside this window creation. Move only another explicitly claimed tab");
          if (target.pinned) throw new Error("windows.create cannot move a pinned tab without changing its pinning");
          await window(target.windowId);
          const observed = await organize(target, "inspectWindowSource");
          const source = observed.sourceCollection;
          if (observed.currentGroupTitle !== null || observed.currentGroupSharingState !== "unshared"
            || source?.kind !== "ungrouped" || source.sharingState !== "unshared"
            || typeof observed.windowIdentifier !== "string" || !observed.windowIdentifier
            || source.nativeWindowIdentifier !== observed.windowIdentifier) {
            throw new Error("Safari did not verify that the source tab collection is unshared. No window was created and no tab was moved");
          }
          sourceTabs = await api.tabs.query({ windowId: target.windowId });
          const fresh = await owned(target.id);
          if (fresh.windowId !== target.windowId || fresh.url !== target.url || fresh.title !== target.title || fresh.pinned) {
            throw new Error("The claimed Safari tab changed before its requested window transfer");
          }
        }
        const before = (await api.windows.getAll({ windowTypes: ["normal"] })).filter(item => !item.incognito && item.type === "normal");
        value = await audit({ windows: before.map(windowState) }, async () => {
          let delivered = false;
          try {
            await assertCurrent();
            delivered = true;
            const created = await api.windows.create(create);
            await assertCurrent();
            if (!Number.isSafeInteger(created?.id) || created.id <= 0 || before.some(item => item.id === created.id)) {
              throw new Error("Safari did not return a unique newly created window ID");
            }
            const confirmed = await window(created.id);
            if (target) {
              const moved = await tab(target.id);
              if (moved.windowId !== confirmed.id || moved.url !== target.url || moved.title !== target.title || moved.pinned) {
                throw new Error("Safari did not confirm the exact claimed tab in its new window");
              }
              const expected = sourceTabs.filter(item => item.id !== target.id).sort((a, b) => a.index - b.index).map(item => item.id);
              const sourceExists = (await api.windows.getAll({ windowTypes: ["normal"] })).some(item => item.id === target.windowId);
              const remaining = sourceExists ? await api.tabs.query({ windowId: target.windowId }) : [];
              if (!sourceExists && expected.length) throw new Error("Safari closed a source window that still had unrelated original tabs");
              if (JSON.stringify(remaining.sort((a, b) => a.index - b.index).map(item => item.id)) !== JSON.stringify(expected)) {
                throw new Error("Safari's source window no longer contains exactly its unrelated original tabs in their original order");
              }
            }
            return confirmed;
          } catch (error) { throw delivered ? uncertainWindowCreation(error) : error; }
        });
      } else if (namespace === "windows" && method === "update") {
        const target = await window(args[0]), changes = options(args[1], ["focused", "left", "top", "width", "height", "state"]);
        if (changes.state !== undefined && !["normal", "minimized", "maximized", "fullscreen"].includes(changes.state)) throw new Error("Unsupported Safari window state");
        await Promise.all((await api.tabs.query({ windowId: target.id })).map(item => owned(item.id)));
        value = await audit({ windows: [{ id: target.id, focused: target.focused, left: target.left, top: target.top,
          width: target.width, height: target.height, state: target.state }] }, () => api.windows.update(target.id, changes));
      } else throw new Error(`Safari does not support management.${namespace}.${method}. Read this capability's Safari documentation`);
      await assertCurrent();
      return { value: value === undefined ? null : value };
    }
    return { async execute(...args) {
      if (busy) throw new Error("Another Safari organization command is running. This command was not queued or executed");
      busy = true;
      try { return await execute(...args); } finally { busy = false; }
    }, release(sessionId) { sessions.delete(sessionId); } };
  }
  if (typeof module === "object" && module.exports) module.exports = { createManagement };
  else Object.defineProperty(root, "ChatGPTSafariManagement", { value: { createManagement } });
})(globalThis);
