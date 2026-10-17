/* Measured ordinary-Safari viewport sizing; no CDP/DPR/mobile emulation. */
(function (root) {
  "use strict";
  const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
  const supported = new Set(["browser_viewport_set", "browser_viewport_reset"]);
  const dimensions = value => Number.isSafeInteger(value) && value > 0;
  const scopeKey = scope => JSON.stringify([scope.profileId, scope.ownerId, scope.accountScope,
    scope.sessionId, scope.turnId, scope.tabId]);

  // A fixed read-only helper. Its document nonce never crosses to page code.
  function observeViewport() {
    const key = "__chatGPTSafariViewportDocument";
    if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") });
    return { documentId: globalThis[key], url: location.href, width: innerWidth, height: innerHeight };
  }
  function createViewport(api, companion, environment = root) {
    const entries = new Map(), owners = new Map();
    let busy = false;
    const pause = ms => new Promise(resolve => environment.setTimeout(resolve, ms));
    const unwrap = value => {
      if (value?.ok !== true) throw Object.assign(new Error(value?.error?.message || "The native viewport operation failed"), value?.error);
      return value.result;
    };
    const callNative = async (request, entry, operation, changes = {}) => unwrap(await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", {
      operation: "companion", command: { action: "liveViewport", id: request.id, profileId: entry.scope.profileId, sessionId: request.sessionId,
        input: { operation, scope: entry.scope, expectedUrl: entry.url, windowBounds: entry.bounds,
          ...(entry.leaseId ? { leaseId: entry.leaseId } : {}), ...changes } },
    }));
    async function execute(command, session, metadata, owner, assertCurrent) {
      if (!supported.has(command.type)) throw fail("UNSUPPORTED_VIEWPORT", "Unknown Safari viewport command");
      await assertCurrent();
      if (session.currentTurnId !== metadata.turn_id) throw fail("STALE_TURN", "The original browser turn ended before viewport selection");
      const base = { profileId: owner.profileId, ownerId: owner.instanceId, accountScope: owner.accountScope,
        sessionId: metadata.session_id, turnId: metadata.turn_id };
      if (command.type === "browser_viewport_reset") {
        // A previous teardown may have refused rollback after a manual focus
        // change. A fresh explicit reset may recover that retained lease, but
        // only for the same verified owner/account/profile and native bounds.
        const matches = [...entries.values()].filter(entry => ["profileId", "ownerId", "accountScope"].every(key => entry.scope[key] === base[key]));
        for (const entry of matches) await reset(entry);
        return {};
      }
      if (!dimensions(command.width) || !dimensions(command.height)) throw fail("INVALID_VIEWPORT", "Viewport dimensions must be positive safe integers");
      // Upstream listSessionTabs resolves its logical active session tab, not
      // whichever unrelated user tab currently has native focus.
      const tabs = await session.listSessionTabs(), active = tabs.filter(tab => tab.active === true);
      if (active.length !== 1) throw fail("VIEWPORT_NO_ACTIVE_TAB", "Claim and select one tab in this original browser turn before setting its viewport");
      const tab = active[0], leases = await session.tabLeases.getSessionActiveLeases(session.sessionId);
      const lease = leases.get(tab.id);
      if (!lease || lease.state !== "active" || lease.sessionId !== metadata.session_id || lease.turnId !== metadata.turn_id) {
        throw fail("VIEWPORT_UNCLAIMED_TAB", "The logical active tab must have this exact session and turn's active claim");
      }
      await session.requireOwnedTab(tab.id); await assertCurrent();
      const source = await api.tabs.get(tab.id), returnTab = await api.tabs.get(owner.tabId);
      if (source.windowId !== owner.windowId || returnTab.windowId !== owner.windowId || returnTab.incognito) {
        throw fail("VIEWPORT_OWNER_WINDOW", "Use a claimed tab in the owning sidebar's native Safari window so automatic rollback never has to change the foreground window");
      }
      const scope = { ...base, tabId: String(tab.id) }, key = scopeKey(scope);
      owners.set(key, { ...owner });
      return companion.runAgentCommand({ action: "viewport", arguments: { operation: "set", scope,
        handle: `live:${owner.profileId}:${tab.id}`, expectedUrl: source.url, width: command.width, height: command.height,
        returnTarget: { tabId: owner.tabId, windowId: owner.windowId, url: returnTab.url } } }, owner);
    }
    async function reset(entry) {
      const owner = owners.get(scopeKey(entry.scope));
      if (!owner) throw fail("VIEWPORT_OWNER_ENDED", "The viewport's original sidebar owner is unavailable; native rollback must verify its retained window lease");
      return companion.runAgentCommand({ action: "viewport", arguments: { operation: "reset", scope: entry.scope,
        handle: entry.handle, expectedUrl: entry.url } }, owner);
    }
    async function run(request, selection) {
      if (busy) throw fail("VIEWPORT_BUSY", "Another viewport operation is running; this resize was not queued or repeated");
      busy = true;
      try { return await apply(request, selection); } finally { busy = false; }
    }
    async function apply(request, selection) {
      const args = request.command.arguments, scope = args.scope;
      if (!scope || !["profileId", "ownerId", "accountScope", "sessionId", "turnId", "tabId"].every(key => typeof scope[key] === "string" && scope[key].length > 0)
        || request.agentOwner !== scope.ownerId
        || !["set", "reset"].includes(args.operation)
        || args.handle !== `live:${scope.profileId}:${scope.tabId}`) throw fail("INVALID_VIEWPORT_SCOPE", "Viewport requires the original owner-bound profile, turn and claimed tab");
      const key = scopeKey(scope);
      let entry = entries.get(key), mutation = false;
      const assert = () => {
        selection?.assertCurrent();
        if (Date.now() >= request.deadline) throw fail("VIEWPORT_EXPIRED", "The viewport operation expired; no resize was repeated");
      };
      const target = async (allowInactive = false) => {
        assert();
        const tab = await api.tabs.get(Number(scope.tabId));
        if (tab.incognito || tab.url !== args.expectedUrl || (!allowInactive && !tab.active)) throw fail("VIEWPORT_TARGET_CHANGED", "The claimed viewport tab changed or is no longer selected");
        const window = await api.windows.get(tab.windowId);
        if (window.type !== "normal" || window.state !== "normal" || !window.focused) throw fail("VIEWPORT_WINDOW_STATE", "Viewport sizing requires the selected normal Safari window; fullscreen and minimized windows are unsupported");
        return { tab, window };
      };
      const native = async (operation, changes = {}) => {
        assert();
        // The live executor injects its background session, never the model.
        return callNative(request, entry, operation, changes);
      };
      const measure = async (allowInactive = false) => {
        const { tab } = await target(allowInactive);
        const result = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func: observeViewport });
        assert();
        const value = result?.[0]?.result;
        if (!value || value.url !== args.expectedUrl || !dimensions(value.width) || !dimensions(value.height)
          || typeof value.documentId !== "string" || (entry?.scope.documentId && value.documentId !== entry.scope.documentId)) {
          throw fail("VIEWPORT_DOCUMENT_CHANGED", "The viewport measurement no longer belongs to the exact source document");
        }
        return value;
      };
      const restore = async () => {
        if (!entry?.leaseId) return;
        const result = await native("restore");
        if (result.restored !== true) throw fail("VIEWPORT_RESTORE_UNCONFIRMED", "Safari did not confirm restoration of the original native window bounds");
        entries.delete(key); owners.delete(key);
        // No second mutation if original CSS dimensions changed with browser UI.
        const observed = await measure(true);
        if (observed.width !== entry.originalCSS.width || observed.height !== entry.originalCSS.height) {
          throw fail("VIEWPORT_RESET_CSS_UNCONFIRMED", "The original native bounds were restored, but the original CSS viewport dimensions were not observed", { restoration: "bounds-restored" });
        }
      };
      if (args.operation === "reset") {
        if (!entry) return {};
        await restore(); return {};
      }
      if (!dimensions(args.width) || !dimensions(args.height)) throw fail("INVALID_VIEWPORT", "Viewport dimensions must be positive safe integers");
      try {
        const before = await measure(), { tab, window } = await target();
        if (!entry) {
          entry = { scope: { ...scope, documentId: before.documentId }, url: args.expectedUrl, handle: args.handle,
            windowId: window.id, bounds: { left: window.left, top: window.top, width: window.width, height: window.height },
            originalCSS: { width: before.width, height: before.height } };
          entries.set(key, entry);
        } else if (entry.windowId !== tab.windowId) throw fail("VIEWPORT_WINDOW_CHANGED", "The original viewport tab moved to another native window");
        const begun = await native("begin"); entry.leaseId = begun.leaseId; entry.bounds = begun.windowBounds;
        let observed = before, prior, slope = { width: 1, height: 1 };
        for (let step = 0; step <= 3; step++) {
          await native("check");
          if (observed.width === args.width && observed.height === args.height) {
            const confirmed = await measure(); await native("check");
            if (confirmed.width !== args.width || confirmed.height !== args.height) throw fail("VIEWPORT_LAYOUT_CHANGED", "The measured CSS viewport changed before completion");
            return {};
          }
          if (step === 3) break;
          if (prior) for (const axis of ["width", "height"]) {
            const nativeDelta = entry.bounds[axis] - prior.bounds[axis], cssDelta = observed[axis] - prior.css[axis];
            if (nativeDelta && cssDelta && Math.sign(nativeDelta) === Math.sign(cssDelta)) slope[axis] = cssDelta / nativeDelta;
          }
          const desired = Object.fromEntries(["width", "height"].map(axis => [axis,
            Math.round(entry.bounds[axis] + (args[axis] - observed[axis]) / slope[axis])]));
          if (!dimensions(desired.width) || !dimensions(desired.height)
            || (desired.width === entry.bounds.width && desired.height === entry.bounds.height)) break;
          prior = { css: observed, bounds: { ...entry.bounds } };
          mutation = true;
          const resized = await native("resize", desired); entry.bounds = resized.windowBounds;
          await pause(80); observed = await measure();
          if (entry.bounds.width === prior.bounds.width && entry.bounds.height === prior.bounds.height
            && observed.width === prior.css.width && observed.height === prior.css.height) break;
        }
        throw fail("VIEWPORT_SIZE_UNATTAINABLE", "Safari did not produce the exact requested CSS viewport within three measured native adjustments; minimum size, screen area or browser UI may prevent it");
      } catch (error) {
        if (entry && error.windowBounds) entry.bounds = error.windowBounds;
        if (entry?.leaseId) {
          try { await restore(); error.restoration = "restored"; }
          catch (restoration) { error.restoration = restoration.restoration || "unconfirmed"; error.message += ` Restoration: ${restoration.message}.`; }
        } else { entries.delete(key); owners.delete(key); }
        if (mutation) { error.mutationApplied = true; error.doNotReplay = true; }
        throw error;
      }
    }
    async function release(sessionId, turnId) {
      for (const entry of [...entries.values()]) if (entry.scope.sessionId === sessionId && (turnId == null || entry.scope.turnId === turnId)) await reset(entry);
    }
    async function commitReturnPage(request, ownerTab) {
      const args = request.command.arguments, entry = entries.get(scopeKey(args.scope));
      const expected = args.returnTarget;
      if (!entry || !expected || request.agentOwner !== entry.scope.ownerId || Date.now() >= request.deadline
        || ownerTab.id !== expected.tabId || ownerTab.windowId !== expected.windowId || ownerTab.url !== expected.url
        || entry.windowId !== ownerTab.windowId) {
        throw fail("VIEWPORT_RETURN_PAGE_CHANGED", "The completed viewport selection did not restore its exact original sidebar owner page");
      }
      try {
        const observed = await callNative(request, entry, "commitReturnPage", { returnUrl: ownerTab.url, returnTabId: ownerTab.id });
        if (observed.committed !== true) throw fail("VIEWPORT_RETURN_PAGE_UNCONFIRMED", "Native Safari did not confirm the exact owner page for viewport rollback");
      } catch (error) {
        error.mutationApplied = true; error.doNotReplay = true;
        error.message += ". The measured viewport operation completed, but its rollback owner-page binding is unconfirmed. Do not repeat the resize.";
        throw error;
      }
    }
    return { execute, run, release, commitReturnPage, async invalidateAll() { for (const entry of [...entries.values()]) await reset(entry); } };
  }
  let installed;
  const exports = { observeViewport, supported, createViewport(...args) { return installed = createViewport(...args); },
    commitReturnPage(request, tab) { if (!installed) throw fail("VIEWPORT_UNAVAILABLE", "The original Safari viewport owner is unavailable"); return installed.commitReturnPage(request, tab); },
    run(request, selection) { if (!installed) throw fail("VIEWPORT_UNAVAILABLE", "The original Safari viewport owner is unavailable"); return installed.run(request, selection); } };
  if (typeof module === "object" && module.exports) module.exports = exports;
  else Object.defineProperty(root, "ChatGPTSafariViewport", { value: exports });
})(globalThis);
