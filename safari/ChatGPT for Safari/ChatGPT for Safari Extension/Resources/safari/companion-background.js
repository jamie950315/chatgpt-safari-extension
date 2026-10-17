/* Owner-bound native relay; Safari remains the authority for browser context. */
(function (root) {
  "use strict";
  function createCompanion(api, environment = root, options = {}) {
    const embedded = options.embedded === true;
    let owner;
    let polling = false;
    let timer;
    let ownerContext;
    let invocation;
    let mentionObservation;
    let documentRecoveryObservation;
    let invocationQueue = Promise.resolve();
    const invocationKey = tabId => `codexWorkSidePanelInvocation:${tabId}`;
    function validInvocation(value) {
      return value && typeof value === "object" && !Array.isArray(value)
        && value.type === "browser_side_chat_prompt_prefill"
        && Number.isSafeInteger(value.createdAtMs) && Date.now() - value.createdAtMs >= 0
        && Date.now() - value.createdAtMs <= 300000
        && (value.prompt !== undefined || value.selectedText !== undefined)
        && (value.prompt === undefined || typeof value.prompt === "string" && value.prompt.trim().length > 0 && value.prompt.length <= 8192)
        && (value.selectedText === undefined || typeof value.selectedText === "string" && value.selectedText.trim().length > 0 && value.selectedText.length <= 80000);
    }
    async function clearInvocation(state) {
      if (invocation?.state === state) invocation = undefined;
      if (!embedded) return;
      await api.storage.session.remove(invocationKey(state.tabId));
    }
    function takeInvocation(state) {
      const result = invocationQueue.then(async () => {
        const tab = await ownedTab(state);
        const current = invocation;
        if (!current || current.state !== state) return { invocation: null };
        if (invocation === current) invocation = undefined;
        await api.storage.session.remove(invocationKey(state.tabId));
        const after = await ownedTab(state);
        if (after.url !== tab.url || current.url !== after.url || current.tabId !== after.id
          || current.windowId !== after.windowId || !validInvocation(current.value)) return { invocation: null };
        // Keep only the original invocation vocabulary. Browser identity stays
        // in the privileged owner binding, not in provider-supplied parameters.
        const value = current.value;
        return { invocation: { type: value.type, createdAtMs: value.createdAtMs,
          ...(value.prompt === undefined ? {} : { prompt: value.prompt }),
          ...(value.selectedText === undefined ? {} : { selectedText: value.selectedText }) } };
      });
      invocationQueue = result.catch(() => {});
      return result;
    }
    const closeListeners = new Set();
    const send = async command => {
      if (embedded && ["status", "poll", "update"].includes(command.action)) {
        command = { ...command, action: "embedded" + command.action[0].toUpperCase() + command.action.slice(1) };
      }
      const result = await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command });
      if (result?.ok !== true) {
        const error = new Error(typeof result?.error === "string" ? result.error : result?.error?.message || "The Safari companion did not respond");
        error.code = result?.error?.code;
        error.data = result?.error?.data;
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
        const url = new URL(tab.url), segments = url.pathname.split("/").filter(Boolean);
        const documentType = segments[0], idIndex = segments.indexOf("d", 1);
        const workspace = url.host === "docs.google.com"
          && ["document", "presentation", "spreadsheets"].includes(documentType)
          && idIndex >= 0 && !!segments[idIndex + 1] && segments.at(-1) !== "pub";
        const mode = !workspace ? "none" : documentType === "spreadsheets" ? "event" : "polling";
        let [capture] = await api.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          func: environment.ChatGPTSafariSidebarFunctions.selection,
          args: [tab.url, state.instanceId, mode],
        });
        if (capture?.result?.needsRecovery && capture.documentId) {
          const target = { tabId: tab.id, documentIds: [capture.documentId] };
          const [recovered] = await api.scripting.executeScript({ target, world: "MAIN",
            func: environment.ChatGPTSafariSidebarFunctions.recoverSelection, args: [url.origin, tab.url, 80000] });
          const current = await ownedTab(state);
          if (current.url !== tab.url || current.status === "loading") throw new Error("The Safari page changed during selection capture");
          const text = recovered?.result?.selectedText;
          [capture] = await api.scripting.executeScript({ target,
            func: environment.ChatGPTSafariSidebarFunctions.selection,
            args: [tab.url, state.instanceId, mode, { captureGeneration: capture.result.captureGeneration,
              selectedText: typeof text === "string" && text.trim().length > 0 ? text : null }] });
        }
        const after = await ownedTab(state);
        if (after.url !== tab.url || after.status === "loading") throw new Error("The Safari page changed during selection capture");
        selectedText = capture?.result?.selectedText || null;
        if (selectedText && capture.documentId) selectionId = `${capture.documentId}:${capture.result.revision}`;
      }
      return { instanceId, tabId: tab.id, windowId: tab.windowId, url: tab.url,
        ...(includeSelection ? { selectedText, selectionId } : {}) };
    }
    const capabilities = { "browserSideChat.openInBrowser": true, "browserSideChat.tabContext.read": true, "browserTabMentions.search": true };
    const sessionChanged = () => {
      documentRecoveryObservation = undefined;
      mentionObservation?.unsubscribe();
      mentionObservation = undefined;
      // Release passive developer capture with the original owner/session.
      Promise.resolve(environment.ChatGPTSafariAgent?.invalidateAll?.()).catch(() => {});
      if (typeof environment.ChatGPTSafariBrowserSessionChanged === "function") {
        Promise.resolve(environment.ChatGPTSafariBrowserSessionChanged()).catch(() => {});
      }
    };
    async function handleRequest(state, request) {
      if (request.ownerToken !== state.instanceId) throw new Error("The native sidebar request belongs to an earlier owner");
      const params = request.params || {};
      switch (request.method) {
      case "context": return { context: await context(state, params.includeSelection === true), capabilities };
      case "openInvocation": return takeInvocation(state);
      case "tabContext": { const tab = await ownedTab(state); return { tabId: tab.id, url: tab.url }; }
      case "tabMentions": {
        await ownedTab(state);
        if (embedded && mentionObservation?.state !== state
          && typeof environment.ChatGPTSafariHooks.subscribeTabMentionsInvalidated === "function") {
          mentionObservation?.unsubscribe();
          const unsubscribe = environment.ChatGPTSafariHooks.subscribeTabMentionsInvalidated(() => {
            if (owner !== state || mentionObservation?.state !== state) return;
            // Only a hint crosses runtime messaging. Candidate content is read
            // again through the exact wrapper's authorized original host call.
            Promise.resolve(api.runtime.sendMessage({ type: "chatgpt-safari:tab-mentions-invalidated",
              instanceId: state.instanceId, tabId: state.tabId, windowId: state.windowId })).catch(() => {});
          });
          mentionObservation = { state, unsubscribe };
        }
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
      case "authStateChanged":
        if (params.state !== "signed_in") await clearInvocation(state);
        return { ok: true };
      default: throw new Error("Unknown native side-chat request");
      }
    }
    async function poll() {
      if (polling || !owner) return;
      polling = true;
      const state = owner;
      try {
        const cloudTunnel = embedded ? environment.ChatGPTSafariGetCloudTunnelState?.() : undefined;
        const response = await send({ action: "poll", ownerToken: state.instanceId, ...(cloudTunnel ? { cloudTunnel } : {}) });
        if (owner !== state) return;
        if (response.closed === true) { didClose(state); return; }
        const sequence = response.documentRecoverySequence;
        if (embedded && Number.isSafeInteger(sequence) && sequence > 0 && sequence <= 1_000_000_000
          && (documentRecoveryObservation?.state !== state || documentRecoveryObservation.sequence !== sequence)) {
          documentRecoveryObservation = { state, sequence };
          // Only a native sequence receipt crosses this owner-bound channel.
          // The wrapper must also observe its authenticated document unloading.
          Promise.resolve(api.runtime.sendMessage({ type: "chatgpt-safari:provider-document-recovery",
            instanceId: state.instanceId, tabId: state.tabId, windowId: state.windowId, sequence })).catch(() => {});
        }
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
      sessionChanged();
      clearInterval(timer);
      timer = undefined;
      for (const listener of closeListeners) listener(state);
    }
    async function update(state, action) {
      const value = await context(state);
      const window = await api.windows.get(state.windowId);
      const profile = embedded ? (await api.storage.local.get("safariLiveProfileId")).safariLiveProfileId : undefined;
      await send({ action: embedded && action === "open" ? "embeddedOpen" : action,
        ...(embedded ? { parentExtensionOrigin: (() => { const u = new URL(api.runtime.getURL("/")); return u.protocol + "//" + u.host.toLowerCase(); })() } : {}),
        ...(profile ? { liveProfileId: profile } : {}),
        ownerToken: state.instanceId, context: value, capabilities,
        bounds: { left: window.left, top: window.top, width: window.width, height: window.height } });
      if (owner === state) ownerContext = value;
    }
    const binding = {
      embedded,
      // These methods belong only to the privileged background's original
      // account tunnel/kernel. They are not exposed by frameRequest.
      async readBrowserSession() {
        if (!embedded || !owner) return null;
        const state = owner;
        await ownedTab(state);
        const response = await send({ action: "embeddedBrowserSession", ownerToken: state.instanceId });
        await ownedTab(state);
        return response.session;
      },
      async agentOwner() {
        if (!embedded || !owner) throw new Error("Open the ChatGPT sidebar before controlling Safari");
        const state = owner;
        await ownedTab(state);
        const profileId = (await api.storage.local.get("safariLiveProfileId")).safariLiveProfileId;
        if (typeof profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error("The Safari browser profile is not ready");
        const response = await send({ action: "embeddedEntry", ownerToken: state.instanceId });
        await ownedTab(state);
        const entry = response.entry;
        if (entry?.phase !== "signedIn" || typeof entry.accountScope !== "string" || !entry.accountScope || entry.accountScope.length > 128) {
          throw new Error("Sign in to ChatGPT before using its Safari agent");
        }
        return { instanceId: state.instanceId, profileId, accountScope: entry.accountScope, tabId: state.tabId, windowId: state.windowId };
      },
      async rebindAgentOwner(state, previousTabId) {
        let step = "REBIND_STATE";
        try {
          if (!embedded || owner !== state || !Number.isSafeInteger(previousTabId) || previousTabId < 0) throw new Error();
          const token = state.instanceId;
          // The sidebar has verified this one native lease and installed its
          // real tab identity on the same state. Never reopen the native owner
          // or refresh its account tunnel for a frame remount.
          step = "REBIND_CONTEXT";
          await update(state, "update");
          step = "REBIND_STATE";
          if (owner !== state || owner.instanceId !== token) throw new Error();
          step = "REBIND_SNAPSHOT";
          await api.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "ISOLATED",
            func: function invalidateReboundSnapshot() {
              const snapshot = globalThis.__chatGPTSafariLiveDocument;
              if (snapshot) { snapshot.nodes.clear(); snapshot.snapshotId = null; }
            } });
          step = "REBIND_CONVERSATION";
          invocation = undefined;
          await api.storage.session.remove(invocationKey(previousTabId));
          const previousKey = `codexWorkSidePanelConversationUrl:${previousTabId}`;
          const conversation = (await api.storage.session.get(previousKey))[previousKey];
          step = "REBIND_STATE";
          if (owner !== state || owner.instanceId !== token) throw new Error();
          step = "REBIND_CONVERSATION";
          if (previousTabId !== state.tabId) {
            if (typeof conversation === "string") {
              await api.storage.session.set({ [`codexWorkSidePanelConversationUrl:${state.tabId}`]: conversation });
            }
            await api.storage.session.remove(previousKey);
          }
          step = "REBIND_STATE";
          if (owner !== state || owner.instanceId !== token) throw new Error();
        } catch {
          // The caller records this fixed phase code, never the underlying
          // native/storage/script error text or private browser identities.
          throw Object.assign(new Error("The native Safari sidebar owner rebind could not be completed."), { code: step });
        }
      },
      async agentKernelURL() {
        if (!embedded || !owner) throw new Error("Open the ChatGPT sidebar before starting its agent kernel");
        const state = owner;
        await ownedTab(state);
        const response = await send({ action: "embeddedKernel", ownerToken: state.instanceId });
        await ownedTab(state);
        return response.url;
      },
      async runAgentCommand(command, expectedOwner) {
        const state = owner;
        if (!state || state.instanceId !== expectedOwner.instanceId) throw new Error("The Safari side-chat owner changed; the command was not executed");
        await ownedTab(state);
        const response = await send({ action: "embeddedLive", ownerToken: state.instanceId,
          profileId: expectedOwner.profileId, command });
        if (owner?.instanceId !== state.instanceId) throw new Error("The Safari side-chat owner changed during execution; read the page before continuing. Do not repeat the input");
        return response.result;
      },
      async frameRequest(state, payload) {
        if (!embedded) throw new Error("The embedded side chat is not enabled");
        await ownedTab(state);
        if (!payload || typeof payload !== "object") throw new Error("Invalid side-chat frame request");
        if (payload.operation === "entry") {
          const response = await send({ action: "embeddedEntry", ownerToken: state.instanceId });
          return response.entry;
        }
        if (payload.operation === "authentication") {
          if (!["open", "resume", "logout"].includes(payload.action)) throw new Error("Unknown app-profile authentication operation");
          await clearInvocation(state);
          const response = await send({ action: "embeddedAuth", ownerToken: state.instanceId, authOperation: payload.action });
          await ownedTab(state);
          if (payload.action === "resume") sessionChanged();
          return response;
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
          const response = await send({ action: "embeddedAuth", ownerToken: state.instanceId, state: params.state });
          sessionChanged();
          return { ...result, authentication: response.authentication };
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
        ownerContext = await context(state);
        if (!timer) timer = setInterval(poll, 500);
        await poll();
        sessionChanged();
        return owner;
      },
      async open(state) {
        const previous = owner;
        const previousContext = ownerContext;
        if (previous !== state) {
          if (previous) await clearInvocation(previous);
          await clearInvocation(state);
          ownerContext = undefined;
        }
        owner = state;
        try { await update(state, "open"); }
        catch (error) { owner = previous; ownerContext = previousContext; throw error; }
        sessionChanged();
        if (!timer) timer = setInterval(poll, 500);
        await poll();
      },
      async close(state) {
        if (owner?.instanceId !== state.instanceId) return;
        await send({ action: embedded ? "embeddedClose" : "close", ownerToken: state.instanceId });
        owner = undefined;
        ownerContext = undefined;
        sessionChanged();
        clearInterval(timer);
        timer = undefined;
        await clearInvocation(state);
        await api.scripting.executeScript({ target: { tabId: state.tabId }, func: environment.ChatGPTSafariSidebarFunctions.removeSelection, args: [state.instanceId] }).catch(() => {});
      },
      poll,
      context,
      handleRequest,
    };
    api.storage.onChanged?.addListener((changes, area) => {
      if (!embedded || area !== "session" || !owner || !ownerContext) return;
      const value = changes[invocationKey(owner.tabId)]?.newValue;
      if (!validInvocation(value)) return;
      invocation = { state: owner, tabId: owner.tabId, windowId: owner.windowId,
        url: ownerContext.url, value };
    });
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
