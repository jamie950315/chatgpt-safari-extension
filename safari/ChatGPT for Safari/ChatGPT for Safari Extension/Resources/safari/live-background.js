/* Existing-profile control. WebExtension APIs read/target pages; native input
 * produces trusted events. No cookies, synthetic input, or CDP emulation. */
(function (root) {
  "use strict";
  const fail = (code, message) => Object.assign(new Error(message), { code });
  function pageOperation(operation, args) {
    const reject = (code, message) => ({ ok: false, error: { code, message } });
    const key = "__chatGPTSafariLiveDocument";
    let state = globalThis[key];
    if (!state) {
      state = { documentId: crypto.randomUUID(), nodes: new Map(), snapshotId: null, url: location.href };
      Object.defineProperty(globalThis, key, { value: state });
    }
    const visible = element => {
      const r = element.getBoundingClientRect(), s = getComputedStyle(element);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
    };
    const label = element => {
      const references = (element.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
      return (element.getAttribute("aria-label") || references.trim() ||
        [...(element.labels || [])].map(x => x.textContent).join(" ") ||
        element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") ||
        element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240);
    };
    if (operation === "read") {
      state.nodes.clear();
      state.snapshotId = crypto.randomUUID(); state.url = location.href;
      const nodes = [];
      const selectors = "a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true],[tabindex]";
      for (const element of document.querySelectorAll(selectors)) {
        if (nodes.length >= 500 || !visible(element)) continue;
        const id = "n" + (nodes.length + 1); state.nodes.set(id, element);
        const item = { node: id, tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: label(element),
          type: element.getAttribute("type"), disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true" };
        if (element.matches("a[href]")) item.href = element.href;
        if (element.matches("input:not([type=password]),textarea,select")) item.value = element.value.slice(0, 1000);
        nodes.push(item);
      }
      const text = document.body?.innerText || "";
      return { ok: true, result: { url: location.href, title: document.title, documentId: state.documentId,
        snapshotId: state.snapshotId, text: text.slice(0, args.maxLength), truncated: text.length > args.maxLength, nodes,
        focusedNode: [...state.nodes].find(([, element]) => element === document.activeElement)?.[0] || null,
        frames: [...document.querySelectorAll("iframe")].map(x => ({ title: x.title, src: x.src })), scroll: { x: scrollX, y: scrollY },
        scope: "top-frame", viewport: { width: innerWidth, height: innerHeight } } };
    }
    if (state.documentId !== args.documentId || state.snapshotId !== args.snapshotId || state.url !== location.href) {
      return reject("STALE_TARGET", "The page or snapshot changed. Read the page again before interacting.");
    }
    if (operation === "check") return { ok: true, result: { url: location.href } };
    const element = args.node ? state.nodes.get(args.node) : document.documentElement;
    if (!element?.isConnected) return reject("STALE_TARGET", "This node is no longer in the page. Read the page again.");
    if (operation === "focused") {
      // Native event posting is asynchronous. Observe delivery without posting
      // another click or changing focus ourselves.
      return (async () => {
        const deadline = Date.now() + 600;
        do {
          if (!element.isConnected || state.url !== location.href) return reject("STALE_TARGET", "The page changed while waiting for native focus.");
          if (document.activeElement === element || element.contains(document.activeElement)) return { ok: true, result: { focused: true } };
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        return reject("FOCUS_CHANGED", "The intended page element did not receive focus. No text was entered.");
      })();
    }
    if (operation === "pointCheck") {
      const hit = document.elementFromPoint(args.point.x, args.point.y);
      return visible(element) && hit && (hit === element || element.contains(hit))
        ? { ok: true, result: { actionable: true } } : reject("TARGET_MOVED", "The page target moved or became covered before native input.");
    }
    if (operation !== "prepare") return reject("INVALID_COMMAND", "Unknown live page operation.");
    return (async () => {
      if (args.node) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!element.isConnected || state.url !== location.href) return reject("STALE_TARGET", "The page changed while targeting the node.");
      if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
        return reject("NOT_ACTIONABLE", "The target is hidden or disabled.");
      }
      const textInput = element.tagName === "INPUT" && ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type);
      if (args.type === "type" && (!(textInput || element.matches("textarea") || element.isContentEditable) ||
          element.readOnly || element.getAttribute("aria-readonly") === "true")) {
        return reject("NOT_EDITABLE", "The selected node is not an editable page element.");
      }
      const rect = element.getBoundingClientRect();
      const x = args.node ? Math.max(0, Math.min(innerWidth, (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2)) : innerWidth / 2;
      const y = args.node ? Math.max(0, Math.min(innerHeight, (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2)) : innerHeight / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === element || element.contains(hit))) return reject("OBSCURED_TARGET", "Another page element covers the target.");
      return { ok: true, result: { expectedUrl: location.href, viewport: { width: innerWidth, height: innerHeight }, point: { x, y } } };
    })();
  }

  function createLive(api, environment = root) {
    let profileId, timer, stopped = false, polling = false;
    const sessionId = environment.crypto.randomUUID();
    const delay = ms => new Promise(resolve => environment.setTimeout(resolve, ms));
    const send = command => api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command });
    const unwrap = response => {
      if (response?.ok !== true) throw Object.assign(new Error(response?.error?.message || "Live Safari command failed."), response?.error || { code: "LIVE_FAILED" });
      return response.result;
    };
    const url = value => {
      let parsed; try { parsed = new URL(value); } catch { throw fail("INVALID_URL", "A valid HTTP/HTTPS URL is required."); }
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw fail("INVALID_URL", "Only HTTP/HTTPS pages without URL credentials can be controlled.");
      return parsed.href;
    };
    const describe = tab => ({ handle: `live:${profileId}:${tab.id}`, profileId, tabId: tab.id, windowId: tab.windowId,
      title: tab.title || "", url: tab.url || "", active: !!tab.active, status: tab.status });
    async function target(handle, expectedUrl) {
      const parts = String(handle).split(":");
      if (parts.length !== 3 || parts[0] !== "live" || parts[1] !== profileId || !/^\d+$/.test(parts[2])) throw fail("INVALID_HANDLE", "Use a handle from this profile's live_list_tabs result.");
      const tab = await api.tabs.get(Number(parts[2]));
      if (tab.incognito) throw fail("PRIVATE_TAB", "Private Safari tabs are not controlled by this backend.");
      url(tab.url);
      if (expectedUrl !== undefined && tab.url !== expectedUrl) throw fail("STALE_TARGET", "The tab navigated. Read its current page before acting.");
      return tab;
    }
    async function page(tab, operation, args) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: pageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    async function read(tab, maxLength = 20000) {
      if (!Number.isInteger(maxLength) || maxLength < 1000 || maxLength > 60000) throw fail("INVALID_ARGUMENT", "maxLength must be between 1000 and 60000.");
      const value = await page(tab, "read", { maxLength });
      await target(describe(tab).handle, value.url);
      return { ...describe(tab), ...value };
    }
    async function ready(tabId) {
      let tab;
      for (let i = 0; i < 60; i++) {
        tab = await api.tabs.get(tabId);
        if (tab.status === "complete") return tab;
        await delay(100);
      }
      // Keep the observed identity when loading outlives this bounded wait.
      // Never turn a delivered navigation into an apparently failed mutation.
      return tab;
    }
    async function focus(tab) {
      await api.tabs.update(tab.id, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      const fresh = await target(describe(tab).handle, tab.url);
      const window = await api.windows.get(tab.windowId);
      if (!fresh.active) throw fail("FOCUS_CHANGED", "Safari did not select the requested tab.");
      return { left: window.left, top: window.top, width: window.width, height: window.height };
    }
    async function execute(request) {
      const action = request.command.action, args = request.command.arguments || {};
      const assertTime = () => { if (Date.now() > request.deadline) throw fail("LIVE_TIMEOUT", "The live command expired. It was not replayed."); };
      assertTime();
      if (action === "list_tabs") {
        const tabs = await api.tabs.query({});
        return { tabs: tabs.filter(x => !x.incognito && /^https?:\/\//i.test(x.url || "")).map(describe) };
      }
      if (action === "create_tab") {
        if (args.profileId !== profileId) throw fail("INVALID_PROFILE", "Use a profileId returned by live_list_tabs.");
        const created = await api.tabs.create({ url: url(args.url), active: true, ...(args.windowId === undefined ? {} : { windowId: args.windowId }) });
        return describe(await ready(created.id));
      }
      const tab = await target(args.handle, ["navigate", "history", "select_tab", "close_tab"].includes(action) ? args.expectedUrl : undefined);
      if (action === "read_page") return read(tab, args.maxLength);
      if (["navigate", "history", "select_tab", "close_tab"].includes(action) && typeof args.expectedUrl !== "string") throw fail("INVALID_ARGUMENT", "expectedUrl is required for this action.");
      if (action === "navigate") { await api.tabs.update(tab.id, { url: url(args.url) }); return describe(await ready(tab.id)); }
      if (action === "history") {
        const method = { back: "goBack", forward: "goForward", reload: "reload" }[args.direction];
        if (!method || typeof api.tabs[method] !== "function") throw fail("UNSUPPORTED_NAVIGATION", "This native Safari navigation method is unavailable.");
        await api.tabs[method](tab.id);
        return describe(await ready(tab.id));
      }
      if (action === "select_tab") { await focus(tab); return describe(await target(args.handle, tab.url)); }
      if (action === "close_tab") { await api.tabs.remove(tab.id); return { closed: true, handle: args.handle }; }
      if (action !== "interact") throw fail("UNKNOWN_ACTION", "Unknown live Safari action.");
      if (typeof args.documentId !== "string" || typeof args.snapshotId !== "string" ||
          !Array.isArray(args.interactions) || args.interactions.length < 1 || args.interactions.length > 20) throw fail("INVALID_ARGUMENT", "A fresh page snapshot and 1–20 interactions are required.");
      const completed = [];
      const nativeSteps = [];
      try {
        await page(tab, "check", args);
        // Safari's windows.update selects its window but does not activate a
        // background/fullscreen app. One explicit native activation precedes
        // the batch; later user focus changes abort instead of being undone.
        const selectedBounds = await focus(tab);
        assertTime();
        const activated = unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
          input: { action: "focus", expectedUrl: tab.url, windowBounds: selectedBounds } }));
        nativeSteps.push({ action: "focus", ...activated });
        for (const interaction of args.interactions) {
          assertTime();
          if (!["click", "type", "key", "scroll"].includes(interaction.type) ||
              (interaction.type !== "scroll" && typeof interaction.node !== "string")) throw fail("INVALID_ARGUMENT", "Each interaction requires a supported type and page node.");
          if (interaction.type === "type" && (typeof interaction.value !== "string" || interaction.value.length > 12000)) throw fail("INVALID_ARGUMENT", "Type requires text of at most 12000 UTF-16 code units.");
          if (interaction.type === "key" && !["Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(interaction.key)) throw fail("UNSUPPORTED_KEY", "Use a supported page editing/navigation key, not an application shortcut.");
          const current = await target(args.handle, tab.url);
          const window = await api.windows.get(tab.windowId);
          if (!current.active || !window.focused) throw fail("FOCUS_CHANGED", "The selected Safari tab/window lost focus. No input was replayed.");
          const windowBounds = { left: window.left, top: window.top, width: window.width, height: window.height };
          const geometry = await page(tab, "prepare", { ...args, ...interaction });
          const native = async (kind, extra = {}) => {
            assertTime(); await target(args.handle, tab.url); await page(tab, "check", args);
            await page(tab, "pointCheck", { ...args, node: interaction.node, point: geometry.point });
            const result = unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
              input: { action: kind, ...geometry, windowBounds, ...extra } }));
            nativeSteps.push({ action: kind, node: interaction.node, ...result });
            return result;
          };
          if (interaction.type === "type" && interaction.requireFocused !== true) {
            await native("click");
            await page(tab, "focused", { ...args, node: interaction.node });
          }
          // A key must not implicitly click/activate a button or move a caret.
          if (interaction.type === "key" || (interaction.type === "type" && interaction.requireFocused === true)) await page(tab, "focused", { ...args, node: interaction.node });
          const result = await native(interaction.type, { text: interaction.value, replaceAll: interaction.replaceAll === true,
            key: interaction.key, deltaX: interaction.deltaX, deltaY: interaction.deltaY });
          completed.push({ type: interaction.type, node: interaction.node, result });
          await delay(80);
        }
        const after = await ready(tab.id);
        if (after.status !== "complete") return { completed, tab: describe(after), pagePending: true,
          nextAction: "Read this handle with live_read_page to inspect the loading document. Do not repeat the interaction." };
        return { completed, page: await read(after) };
      } catch (error) {
        const details = error.data;
        error.data = { completed, nativeSteps, eventsPosted: error.eventsPosted, mayHavePostedInput: error.mayHavePostedInput,
          ...(details ? { details } : {}),
          outcome: nativeSteps.some(step => step.eventsPosted > 0) || error.mayHavePostedInput ? "partial or uncertain; read current page before continuing" : "no native input confirmed" };
        throw error;
      }
    }
    async function poll() {
      if (stopped || polling || !profileId) return;
      polling = true;
      try {
        const response = await send({ action: "livePoll", profileId, sessionId });
        if (response?.ok !== true) return; // A poll never launches a user-quit app.
        for (const request of response.requests || []) {
          let response;
          try { response = { ok: true, result: await execute(request) }; }
          catch (error) { response = { ok: false, error: { code: error.code || "SAFARI_API_ERROR", message: error.message,
            ...(error.data ? { data: error.data } : {}) } }; }
          await send({ action: "liveResolve", id: request.id, profileId, sessionId, response });
        }
      } catch { /* Service discovery resumes on the next poll; mutations are not retried. */ }
      finally { polling = false; }
    }
    async function start() {
      const stored = await api.storage.local.get("safariLiveProfileId");
      profileId = stored.safariLiveProfileId;
      if (typeof profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(profileId)) {
        profileId = environment.crypto.randomUUID();
        await api.storage.local.set({ safariLiveProfileId: profileId });
      }
      timer = environment.setInterval(poll, 750);
      await poll();
    }
    return { start, poll, execute, stop() { stopped = true; environment.clearInterval(timer); } };
  }
  if (typeof module === "object" && module.exports) module.exports = { createLive, pageOperation };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) {
    root.ChatGPTSafariLive = createLive(api);
    root.ChatGPTSafariLive.start().catch(() => {});
  }
})(globalThis);
