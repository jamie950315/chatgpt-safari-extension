/* Existing-profile control. WebExtension APIs read/target pages; native input
 * produces trusted events. No cookies, synthetic input, or CDP emulation. */
(function (root) {
  "use strict";
  const fail = (code, message) => Object.assign(new Error(message), { code });
  function consoleCapture(operation, token) {
    const key = "__chatGPTSafariConsoleCapture";
    const previous = globalThis[key];
    if (operation === "stop") { if (previous?.token === token) previous.stop(); return; }
    if (previous?.token === token) return;
    previous?.stop();
    const originals = new Map(), wrappers = new Map();
    let stopped = false, timer;
    const format = value => {
      if (value === null) return "null";
      if (["string", "number", "boolean", "undefined", "bigint"].includes(typeof value)) return String(value).slice(0, 4000);
      if (typeof value === "function") return "[function]";
      const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
      return typeof message === "string" ? message.slice(0, 4000) : Array.isArray(value) ? "[array]" : "[object]";
    };
    const report = (level, values) => {
      if (!stopped) window.postMessage({ type: "chatgpt-safari:console-entry", token, level,
        message: values.slice(0, 32).map(format).join(" ").slice(0, 4000) }, location.origin);
    };
    for (const level of ["debug", "info", "log", "warn", "error"]) {
      const original = console[level]; originals.set(level, original);
      const wrapper = function (...args) { Reflect.apply(original, this, args); report(level, args); };
      wrappers.set(level, wrapper); console[level] = wrapper;
    }
    const onError = event => report("error", [event.message || "Uncaught page error"]);
    const onRejection = event => report("error", ["Unhandled rejection:", event.reason]);
    window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onRejection);
    const state = { token, stop() {
      if (stopped) return; stopped = true; clearTimeout(timer);
      for (const [level, wrapper] of wrappers) if (console[level] === wrapper) console[level] = originals.get(level);
      window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection);
      if (globalThis[key] === state) delete globalThis[key];
    } };
    Object.defineProperty(globalThis, key, { value: state, configurable: true });
    timer = setTimeout(state.stop, 5 * 60 * 1000);
  }
  function pageOperation(operation, args) {
    const reject = (code, message) => ({ ok: false, error: { code, message } });
    if (args._nativeObservationDeadline !== undefined && (!Number.isFinite(args._nativeObservationDeadline) || Date.now() >= args._nativeObservationDeadline)) {
      return reject("POST_INPUT_READBACK_TIMEOUT", "This page observation expired before Safari could execute it. No late page action was performed.");
    }
    const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = "__chatGPTSafariLiveDocument";
    let state = globalThis[key];
    if (!state) {
      state = { documentId: newId(), nodes: new Map(), snapshotId: null, url: location.href };
      Object.defineProperty(globalThis, key, { value: state });
    }
    if (args.expectedDocumentId && state.documentId !== args.expectedDocumentId) return reject("STALE_TARGET", "The selected iframe document changed after native frame resolution.");
    if (["logs_bind", "logs_read", "logs_release"].includes(operation)) {
      if (operation === "logs_release") {
        if (state.logs?.scope !== args.scope) return { ok: true, result: { token: null } };
        const token = state.logs.token; state.logs.release(); return { ok: true, result: { token } };
      }
      if (operation === "logs_bind" && state.logs?.scope !== args.scope) {
        state.logs?.release();
        const logs = { scope: args.scope, token: newId(), startedAt: new Date().toISOString(), entries: [], expired: false };
        const listen = event => {
          if (!event.isTrusted || event.source !== window || event.origin !== location.origin || event.data?.type !== "chatgpt-safari:console-entry"
            || event.data.token !== logs.token || !["debug", "info", "log", "warn", "error"].includes(event.data.level)
            || typeof event.data.message !== "string" || event.data.message.length > 4000) return;
          logs.entries.push({ level: event.data.level, message: event.data.message, timestamp: new Date().toISOString(), url: location.href });
          if (logs.entries.length > 500) logs.entries.shift();
        };
        let timer;
        logs.release = () => { window.removeEventListener("message", listen); clearTimeout(timer); logs.entries.length = 0; if (state.logs === logs) state.logs = null; };
        timer = setTimeout(() => { window.removeEventListener("message", listen); logs.expired = true; }, 5 * 60 * 1000);
        state.logs = logs; window.addEventListener("message", listen);
      }
      const logs = state.logs;
      if (!logs || logs.scope !== args.scope) return reject("LOG_CAPTURE_INACTIVE", "Console capture is not active for this sidebar turn.");
      if (operation === "logs_bind") return { ok: true, result: { token: logs.token, startedAt: logs.startedAt, documentId: state.documentId } };
      if (logs.expired) return reject("LOG_CAPTURE_EXPIRED", "The five-minute console capture window ended; claim the tab in a new turn to start another window.");
      return { ok: true, result: { logs: logs.entries.filter(entry => (!args.levels || args.levels.includes(entry.level))
        && (!args.filter || entry.message.includes(args.filter))).slice(-Math.min(args.limit || 100, 500)), startedAt: logs.startedAt } };
    }
    const roots = () => {
      const found = [], visit = root => {
        found.push(root);
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) visit(element.shadowRoot);
          if (element.tagName === "IFRAME") {
            try { if (element.contentDocument) visit(element.contentDocument); } catch { /* Cross-origin frames use explicit frame-scoped queries. */ }
          }
        }
      };
      visit(document); return found;
    };
    const all = selector => roots().flatMap(root => [...root.querySelectorAll(selector)]);
    const active = () => {
      let element = document.activeElement;
      while (element) {
        let next = element.shadowRoot?.activeElement;
        try { next ||= element.contentDocument?.activeElement; } catch { /* A cross-origin frame is its own focus boundary. */ }
        if (!next || next === element) return element;
        element = next;
      }
      return null;
    };
    const rectangle = element => {
      const local = element.getBoundingClientRect();
      let left = local.left, top = local.top, view = element.ownerDocument?.defaultView;
      while (view && view !== window) {
        const frame = view.frameElement;
        if (!frame) throw new Error("The frame is no longer attached to this page.");
        const r = frame.getBoundingClientRect();
        left += r.left + frame.clientLeft; top += r.top + frame.clientTop; view = frame.ownerDocument.defaultView;
      }
      return { left, top, right: left + local.width, bottom: top + local.height, width: local.width, height: local.height };
    };
    const hitAt = (x, y) => {
      let context = document, hit;
      for (let depth = 0; depth < 40; depth++) {
        const next = context.elementFromPoint(x, y);
        if (!next || next === hit) break;
        hit = next;
        if (hit.shadowRoot) { context = hit.shadowRoot; continue; }
        try {
          if (hit.contentDocument) {
            const r = hit.getBoundingClientRect(); x -= r.left + hit.clientLeft; y -= r.top + hit.clientTop;
            context = hit.contentDocument; continue;
          }
        } catch { /* Native coordinate input can still target the frame itself. */ }
        break;
      }
      return hit;
    };
    const contains = (element, hit) => {
      for (let current = hit; current;) {
        if (current === element || element.contains(current)) return true;
        const root = current.getRootNode?.();
        current = root?.host || current.ownerDocument?.defaultView?.frameElement;
      }
      return false;
    };
    const visible = element => {
      const r = element.getBoundingClientRect(), s = (element.ownerDocument?.defaultView || globalThis).getComputedStyle(element);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
    };
    const label = element => {
      const references = (element.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent || "").join(" ");
      return (element.getAttribute("aria-label") || references.trim() ||
        [...(element.labels || [])].map(x => x.textContent).join(" ") ||
        element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") ||
        element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240);
    };
    if (operation === "capture_state" || operation === "capture_scroll") {
      if (operation === "capture_scroll") {
        if (state.documentId !== args.documentId || location.href !== args.url) return reject("STALE_TARGET", "The screenshot document changed; its scroll was not modified.");
        return (async () => {
          scrollTo({ left: args.x, top: args.y, behavior: "instant" });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { ok: true, result: { x: scrollX, y: scrollY } };
        })();
      }
      const sidebar = document.querySelector("[data-chatgpt-safari-sidebar]");
      const sidebarRect = sidebar?.getBoundingClientRect();
      const contentWidth = sidebarRect && sidebarRect.left > 0 && sidebarRect.right >= innerWidth - 1
        ? Math.min(sidebarRect.left, document.documentElement.getBoundingClientRect().width) : innerWidth;
      return { ok: true, result: { documentId: state.documentId, url: location.href, x: scrollX, y: scrollY,
        viewport: { width: innerWidth, height: innerHeight }, contentWidth,
        width: Math.max(contentWidth, document.body?.scrollWidth || 0),
        height: Math.max(innerHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0) } };
    }
    if (operation === "frame_resolve") {
      const injected = globalThis.__chatGPTSafariPlaywright;
      if (!injected) return reject("QUERY_HELPER_MISSING", "The original selector engine is unavailable.");
      const frames = injected.querySelectorAll(injected.parseSelector(args.selector), document);
      if (frames.length !== 1 || frames[0].tagName !== "IFRAME") return reject("STRICT_FRAME", "The frame selector must identify exactly one iframe.");
      if (!state.snapshotId || state.url !== location.href) { state.nodes.clear(); state.snapshotId = newId(); state.url = location.href; }
      const node = "f" + newId(); state.nodes.set(node, frames[0]);
      frames[0].contentWindow.postMessage({ type: "chatgpt-safari:resolve-frame", nonce: args.nonce }, "*");
      return { ok: true, result: { node, documentId: state.documentId, snapshotId: state.snapshotId, url: location.href } };
    }
    if (operation === "query") {
      const command = args.command;
      if (command.type === "safari_webmcp_probe") {
        const provider = Reflect.get(document, "modelContext");
        return { ok: true, result: { getTools: typeof provider?.getTools, executeTool: typeof provider?.executeTool, originOpaque: location.origin === "null" } };
      }
      let context = document, injected = globalThis.__chatGPTSafariPlaywright;
      if (!injected) return reject("QUERY_HELPER_MISSING", "The original Playwright selector engine is unavailable.");
      const select = (selector, root = context) => injected.querySelectorAll(injected.parseSelector(selector), root);
      if (command.type === "playwright_dom_snapshot") {
        const snapshot = injected.incrementalAriaSnapshot(document.body || document.documentElement, { mode: "ai" });
        return { ok: true, result: { dom_snapshot: snapshot.full, frameRefs: snapshot.iframeRefs.filter(ref => ref in snapshot.iframeDepths) } };
      }
      if (command.type === "safari_selection_read") {
        const element = active();
        if (element?.tagName === "IFRAME") return reject("CROSS_ORIGIN_FOCUS", "Use a frame-scoped locator before reading this iframe's selection.");
        if (element && injected.isProtectedCredentialField(element)) return reject("PROTECTED_FIELD", "Credential field selections are not exposed to the session clipboard.");
        const selection = element && typeof element.selectionStart === "number"
          ? element.value.slice(element.selectionStart, element.selectionEnd) : String(element?.ownerDocument?.getSelection() || document.getSelection() || "");
        return { ok: true, result: { text: selection } };
      }
      if (command.type === "safari_point_prepare") {
        const element = hitAt(command.x, command.y)?.closest("a[href]");
        if (!element) return reject("NOT_A_LINK", "The visible point does not identify a current file link.");
        if (!state.snapshotId || state.url !== location.href) {
          state.nodes.clear(); state.snapshotId = newId(); state.url = location.href;
        }
        const node = "q" + newId(); state.nodes.set(node, element);
        return { ok: true, result: { node, documentId: state.documentId, snapshotId: state.snapshotId, url: location.href } };
      }
      const parts = String(command.selector || "").split(" >> internal:control=enter-frame >> ");
      for (const part of parts.slice(0, -1)) {
        const frames = select(part);
        if (frames.length !== 1 || frames[0].tagName !== "IFRAME") return reject("AMBIGUOUS_FRAME", "A frame locator must resolve to exactly one iframe.");
        try {
          context = frames[0].contentDocument;
          if (!context) throw new Error();
          injected = context.defaultView.__chatGPTSafariPlaywright;
          if (!injected) throw new Error();
        } catch { return reject("CROSS_ORIGIN_FRAME", "This frame requires a frame-scoped Safari query; its document was not read from the parent origin."); }
      }
      const elements = select(parts.at(-1));
      const visible = element => injected.elementState(element, "visible").matches;
      const protectedField = element => injected.isProtectedCredentialField(element);
      const kind = command.type;
      if (kind === "playwright_locator_count") return { ok: true, result: { count: elements.length } };
      if (kind === "playwright_locator_all_text_contents") return { ok: true, result: { values: elements.map(x => x.textContent || "") } };
      if (kind === "playwright_locator_read_all") {
        const serialize = element => ({ attributes: Object.fromEntries([...element.attributes].filter(x => x.name.toLowerCase() !== "value" || !protectedField(element)).map(x => [x.name, x.value])),
          inner_text: element.innerText || "", text_content: element.textContent });
        return { ok: true, result: { values: elements.map(element => command.relative_selector ? (select(command.relative_selector, element)[0] ? serialize(select(command.relative_selector, element)[0]) : null) : serialize(element)) } };
      }
      if (kind === "playwright_locator_wait_for") {
        const first = elements[0], wanted = command.state || "visible";
        const matched = wanted === "attached" ? !!first : wanted === "detached" ? !first : wanted === "visible" ? !!first && visible(first) : wanted === "hidden" ? !first || !visible(first) : false;
        return { ok: true, result: { matched } };
      }
      let matches = elements;
      if (matches.length > 1) {
        const shown = matches.filter(visible);
        if (shown.length === 1) matches = shown;
      }
      if (matches.length !== 1) return reject("STRICT_LOCATOR", `The locator resolved to ${matches.length} elements; use an unambiguous locator.`);
      let element = matches[0];
      if (kind === "safari_locator_focus") {
        const target = injected.retarget(element, "follow-label");
        if (!target || typeof target.focus !== "function") return reject("NOT_FOCUSABLE", "The locator does not identify a focusable element.");
        target.focus({ preventScroll: true });
        element = target;
      }
      if (kind === "safari_select_read") {
        if (element.tagName !== "SELECT") return reject("NOT_A_SELECT", "The locator does not identify a native select element.");
        return { ok: true, result: { multiple: element.multiple, options: [...element.options].map((option, index) => ({
          index, value: option.value, label: option.label, nativeLabel: option.label.trim().replace(/\s+/g, " "),
          disabled: option.disabled || option.parentElement?.disabled === true, selected: option.selected,
        })) } };
      }
      const read = kind === "playwright_locator_get_attribute" ? { value: String(command.name).toLowerCase() === "value" && protectedField(element) ? null : element.getAttribute(command.name) }
        : kind === "playwright_locator_inner_text" ? { value: element.innerText || "" }
        : kind === "playwright_locator_text_content" ? { value: element.textContent }
        : kind === "playwright_locator_is_enabled" ? { value: injected.elementState(element, "enabled").matches }
        : kind === "playwright_locator_is_visible" ? { value: visible(element) }
        : kind === "safari_checked_read" ? { checked: element.matches("input[type=checkbox],input[type=radio]") ? element.checked : element.getAttribute("aria-checked") === "true", isRadio: element.matches("input[type=radio],[role=radio]") }
        : null;
      if (read) return { ok: true, result: read };
      if (!state.snapshotId || state.url !== location.href) {
        state.nodes.clear(); state.snapshotId = newId(); state.url = location.href;
      }
      const node = "q" + newId(); state.nodes.set(node, element);
      return { ok: true, result: { node, documentId: state.documentId, snapshotId: state.snapshotId, url: location.href,
        viewport: { width: innerWidth, height: innerHeight } } };
    }
    if (operation === "read") {
      state.nodes.clear();
      state.snapshotId = newId(); state.url = location.href;
      const nodes = [];
      const selectors = "a[href],button,input,textarea,select,iframe,[role=button],[role=link],[role=textbox],[contenteditable=true],[tabindex]";
      for (const element of all(selectors)) {
        if (nodes.length >= 500 || !visible(element)) continue;
        const id = "n" + (nodes.length + 1); state.nodes.set(id, element);
        const item = { node: id, tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: label(element),
          type: element.getAttribute("type"), disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true" };
        if (element.matches("a[href]")) item.href = element.href;
        if (element.matches("input:not([type=password]),textarea,select")) item.value = element.value.slice(0, 1000);
        nodes.push(item);
      }
      const text = roots().map(root => root.body?.innerText ?? root.innerText ?? root.textContent ?? "").join("\n");
      return { ok: true, result: { url: location.href, title: document.title, documentId: state.documentId,
        snapshotId: state.snapshotId, text: text.slice(0, args.maxLength), truncated: text.length > args.maxLength, nodes,
        focusedNode: [...state.nodes].find(([, element]) => element === active())?.[0] || null,
        frames: [...document.querySelectorAll("iframe")].map(x => ({ title: x.title, src: x.src })), scroll: { x: scrollX, y: scrollY },
        scope: "top-frame", viewport: { width: innerWidth, height: innerHeight } } };
    }
    if (state.documentId !== args.documentId || state.snapshotId !== args.snapshotId || state.url !== location.href) {
      return reject("STALE_TARGET", "The page or snapshot changed. Read the page again before interacting.");
    }
    if (operation === "check") return { ok: true, result: { url: location.href } };
    if (operation === "filechooser_arm") {
      state.fileChooserObserver?.stop();
      const token = args.token, runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
      if (typeof token !== "string" || !runtime?.sendMessage) return reject("FILE_CHOOSER_OBSERVER_UNAVAILABLE", "Safari cannot observe the source file input for this native action.");
      let timer, trustedGesture = false;
      const documents = roots().filter(root => root.nodeType === 9);
      const gesture = event => {
        const source = args.sourceNode ? state.nodes.get(args.sourceNode) : null;
        if (event.isTrusted && (source ? event.composedPath().some(node => node?.nodeType && contains(source, node)) : Math.abs(event.clientX - args.point?.x) <= 2 && Math.abs(event.clientY - args.point?.y) <= 2)) trustedGesture = true;
      };
      const observer = { stop() { for (const root of documents) { root.removeEventListener("click", clicked, true); root.removeEventListener("click", gesture, true); root.removeEventListener("keydown", gesture, true); } clearTimeout(timer); if (state.fileChooserObserver === observer) state.fileChooserObserver = null; } };
      const clicked = event => {
        const input = event.composedPath().find(node => node?.tagName === "INPUT" && node.type === "file");
        // A trusted label click and a page's input.click() within that actual
        // user gesture both dispatch a file-input click. Observe them; never
        // invoke a hidden input or manufacture a user activation ourselves.
        if (!input || !trustedGesture || (!event.isTrusted && !navigator.userActivation?.isActive) || !input.isConnected || input.disabled
          || state.documentId !== args.documentId || state.url !== location.href) return;
        observer.stop();
        const node = "u" + newId(); state.nodes.set(node, input);
        runtime.sendMessage({ type: "chatgpt-safari:file-input", token, node, isMultiple: input.multiple === true,
          documentId: state.documentId, snapshotId: state.snapshotId, url: location.href }).catch(() => {});
      };
      state.fileChooserObserver = observer; for (const root of documents) { root.addEventListener("click", gesture, true); root.addEventListener("keydown", gesture, true); root.addEventListener("click", clicked, true); }
      timer = setTimeout(observer.stop, 3000);
      return { ok: true, result: { armed: true } };
    }
    const element = args.node ? state.nodes.get(args.node) : document.documentElement;
    if (!element?.isConnected) return reject("STALE_TARGET", "This node is no longer in the page. Read the page again.");
    if (operation === "focused") {
      // Native event posting is asynchronous. Observe delivery without posting
      // another click or changing focus ourselves.
      return (async () => {
        const deadline = Date.now() + 600;
        do {
          if (!element.isConnected || state.url !== location.href) return reject("STALE_TARGET", "The page changed while waiting for native focus.");
          if (active() === element || element.contains(active())) return { ok: true, result: { focused: true } };
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        return reject("FOCUS_CHANGED", "The intended page element did not receive focus. No text was entered.");
      })();
    }
    if (operation === "pointCheck") {
      if (args.frameRect) {
        const current = rectangle(element);
        if (["left", "top", "width", "height"].some(name => Math.abs(current[name] - args.frameRect[name]) > 0.5)) return reject("FRAME_LAYOUT_CHANGED", "The frame moved after its target was mapped. No input was replayed.");
      }
      const hit = hitAt(args.point.x, args.point.y);
      return visible(element) && hit && contains(element, hit)
        ? { ok: true, result: { actionable: true } } : reject("TARGET_MOVED", "The page target moved or became covered before native input.");
    }
    if (operation !== "prepare") return reject("INVALID_COMMAND", "Unknown live page operation.");
    return (async () => {
      if (args.node && args.noScroll !== true) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        let view = element.ownerDocument?.defaultView;
        while (view && view !== window && view.frameElement) {
          view.frameElement.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          view = view.frameElement.ownerDocument.defaultView;
        }
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!element.isConnected || state.url !== location.href) return reject("STALE_TARGET", "The page changed while targeting the node.");
      if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
        return reject("NOT_ACTIONABLE", "The target is hidden or disabled.");
      }
      const textInput = element.tagName === "INPUT" && ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type);
      const focusedFrame = element.tagName === "IFRAME" && args.requireFocused === true && active() === element;
      if (args.type === "type" && (!(textInput || element.matches("textarea") || element.isContentEditable || focusedFrame) ||
          element.readOnly || element.getAttribute("aria-readonly") === "true")) {
        return reject("NOT_EDITABLE", "The selected node is not an editable page element.");
      }
      const rect = rectangle(element);
      const x = args.point?.x ?? (args.node ? Math.max(0, Math.min(innerWidth, (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2)) : innerWidth / 2);
      const y = args.point?.y ?? (args.node ? Math.max(0, Math.min(innerHeight, (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2)) : innerHeight / 2);
      const hit = hitAt(x, y);
      if (!hit || !contains(element, hit)) return reject("OBSCURED_TARGET", "Another page element covers the target.");
      let axisAligned = true;
      if (args.frameBounds) for (let ancestor = element; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode?.().host) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform && transform !== "none") {
          const matrix = new DOMMatrixReadOnly(transform);
          if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) axisAligned = false;
        }
      }
      const frame = args.frameBounds ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        clientLeft: element.clientLeft, clientTop: element.clientTop, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
        offsetWidth: element.offsetWidth, offsetHeight: element.offsetHeight, axisAligned } : undefined;
      return { ok: true, result: { expectedUrl: location.href, viewport: { width: innerWidth, height: innerHeight }, point: { x, y }, ...(frame ? { frame } : {}) } };
    })();
  }

  function createLive(api, environment = root) {
    let profileId, timer, stopped = false, polling = false;
    const sessionId = environment.crypto.randomUUID();
    const frameResolutions = new Map(), fileInputObservations = new Map(), fileChoosers = new Map();
    const delay = ms => new Promise(resolve => environment.setTimeout(resolve, ms));
    const send = async command => {
      const nativeInput = ["liveInput", "liveModal", "liveDialog"].includes(command.action);
      let callbackTimer, response;
      try {
        if (nativeInput) callbackTimer = environment.setTimeout(() => {
          // Only diagnose whether Safari can service a timer and another native
          // message while this callback is pending. Never retry native input.
          Promise.resolve().then(() => api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command: {
            action: "liveInputCallbackTimeout", id: command.id, profileId: command.profileId, sessionId: command.sessionId,
          } })).catch(() => {});
        }, 2000);
        response = await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command });
      } finally { if (callbackTimer !== undefined) (environment.clearTimeout || clearTimeout)(callbackTimer); }
      const receipt = response?.inputReceiptSequence;
      if (nativeInput && Number.isSafeInteger(receipt) && receipt > 0) {
        // Record receipt before unwrapping a native success OR failure and
        // before any page/selection API. This diagnostic has no input payload
        // and cannot replay or change the delivered native operation.
        try {
          await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command: {
            action: "liveInputAck", id: command.id, profileId: command.profileId, sessionId: command.sessionId, receiptSequence: receipt,
          } });
        } catch { /* Receipt telemetry must not hide the actual native outcome. */ }
      }
      return response;
    };
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
    async function target(handle, expectedUrl, allowBlank = false) {
      const parts = String(handle).split(":");
      if (parts.length !== 3 || parts[0] !== "live" || parts[1] !== profileId || !/^\d+$/.test(parts[2])) throw fail("INVALID_HANDLE", "Use a handle from this profile's live_list_tabs result.");
      const tab = await api.tabs.get(Number(parts[2]));
      if (tab.incognito) throw fail("PRIVATE_TAB", "Private Safari tabs are not controlled by this backend.");
      if (!(allowBlank && tab.url === "about:blank" && expectedUrl === "about:blank")) url(tab.url);
      if (expectedUrl !== undefined && tab.url !== expectedUrl) throw fail("STALE_TARGET", "The tab navigated. Read its current page before acting.");
      return tab;
    }
    async function page(tab, operation, args, frameId = 0) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, func: pageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    api.runtime.onMessage?.addListener((message, sender) => {
      if (message?.type === "chatgpt-safari:file-input") {
        const pending = fileInputObservations.get(message.token);
        if (!pending || sender.tab?.id !== pending.tabId || sender.frameId !== pending.frameId || sender.url !== pending.url
          || message.url !== pending.url || message.documentId !== pending.documentId || message.snapshotId !== pending.snapshotId
          || typeof message.node !== "string" || !/^u[a-f0-9]{32}$/.test(message.node) || typeof message.isMultiple !== "boolean") return;
        if (pending.value) { pending.ambiguous = true; return; }
        pending.value = { documentId: message.documentId, snapshotId: message.snapshotId, node: message.node, isMultiple: message.isMultiple };
        return { ok: true };
      }
      if (message?.type !== "chatgpt-safari:frame-identity") return;
      const pending = frameResolutions.get(message.nonce);
      if (!pending || sender.tab?.id !== pending.tabId || !Number.isSafeInteger(sender.frameId) || sender.frameId <= 0
        || !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(message.documentId || "")) return;
      return (async () => {
        const frames = await api.webNavigation.getAllFrames({ tabId: pending.tabId });
        const frame = frames.find(frame => frame.frameId === sender.frameId && frame.parentFrameId === pending.parentFrameId && frame.url === sender.url);
        if (!frame || frameResolutions.get(message.nonce) !== pending) return;
        frameResolutions.delete(message.nonce); environment.clearTimeout?.(pending.timer);
        pending.resolve({ frameId: frame.frameId, url: frame.url, documentId: message.documentId }); return { ok: true };
      })();
    });
    async function resolveFrame(tab, parentFrameId, selector, expectedDocumentId) {
      if (typeof api.webNavigation?.getAllFrames !== "function") throw fail("FRAME_API_UNAVAILABLE", "Safari does not expose native frame identities.");
      const nonce = environment.crypto.randomUUID();
      let pending;
      const identity = new Promise((resolve, reject) => {
        pending = { tabId: tab.id, parentFrameId, resolve,
          timer: environment.setTimeout(() => { frameResolutions.delete(nonce); reject(fail("FRAME_DISCONNECTED", "The selected frame did not return its actual Safari frame identity.")); }, 2000) };
        frameResolutions.set(nonce, pending);
      });
      identity.catch(() => {});
      try {
        const binding = await page(tab, "frame_resolve", { selector, nonce, expectedDocumentId }, parentFrameId);
        const child = await identity; return { ...binding, frameId: parentFrameId, childFrameId: child.frameId, childUrl: child.url, childDocumentId: child.documentId };
      } catch (error) { frameResolutions.delete(nonce); environment.clearTimeout?.(pending.timer); throw error; }
    }
    async function read(tab, maxLength = 20000, observe = operation => operation()) {
      if (!Number.isInteger(maxLength) || maxLength < 1000 || maxLength > 60000) throw fail("INVALID_ARGUMENT", "maxLength must be between 1000 and 60000.");
      const value = await observe(() => page(tab, "read", { maxLength }));
      await observe(() => target(describe(tab).handle, value.url));
      return { ...describe(tab), ...value };
    }
    async function ready(tabId, observe = operation => operation()) {
      let tab;
      for (let i = 0; i < 60; i++) {
        tab = await observe(() => api.tabs.get(tabId));
        if (tab.status === "complete") return tab;
        await delay(100);
      }
      // Keep the observed identity when loading outlives this bounded wait.
      // Never turn a delivered navigation into an apparently failed mutation.
      return tab;
    }
    async function focus(tab, selection) {
      if (selection) await selection.select(tab);
      else {
        await api.tabs.update(tab.id, { active: true });
        await api.windows.update(tab.windowId, { focused: true });
      }
      const fresh = await target(describe(tab).handle, tab.url);
      const window = await api.windows.get(tab.windowId);
      if (!fresh.active) throw fail("FOCUS_CHANGED", "Safari did not select the requested tab.");
      return { left: window.left, top: window.top, width: window.width, height: window.height };
    }
    async function capture(tab, args, request, bounds, selection, assertTime) {
      const before = await page(tab, "capture_state", {});
      const region = args.clip || (args.fullPage ? { x: 0, y: 0, width: before.width, height: before.height }
        : { x: before.x, y: before.y, width: before.contentWidth, height: before.viewport.height });
      if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0
        || region.width <= 0 || region.height <= 0 || region.width * region.height > 40000000
        || region.x + region.width > before.width + 1 || region.y + region.height > before.height + 1) {
        throw fail("INVALID_CAPTURE_REGION", "The screenshot region must fit the current document and contain at most 40 million pixels.");
      }
      const canvas = environment.document?.createElement("canvas");
      if (!canvas) throw fail("CAPTURE_RENDERER_UNAVAILABLE", "Safari's background image compositor is unavailable.");
      canvas.width = Math.ceil(region.width); canvas.height = Math.ceil(region.height);
      const context = canvas.getContext("2d");
      if (!context) throw fail("CAPTURE_RENDERER_UNAVAILABLE", "Safari could not create the screenshot compositor.");
      const raw = async () => {
        selection?.assertCurrent(); assertTime(); await target(describe(tab).handle, before.url);
        const selected = await api.tabs.get(tab.id), window = await api.windows.get(tab.windowId);
        if (!selected.active || !window.focused) throw fail("FOCUS_CHANGED", "The screenshot tab/window lost focus. Capture was stopped.");
        let dataUrl;
        if (typeof api.tabs.captureVisibleTab === "function") dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        else dataUrl = unwrap(await send({ action: "liveCapture", id: request.id, profileId, sessionId,
          input: { expectedUrl: before.url, windowBounds: bounds, viewport: before.viewport, fullPage: false } })).dataUrl;
        if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) throw fail("CAPTURE_FAILED", "Safari returned no valid screenshot bytes.");
        await target(describe(tab).handle, before.url);
        const image = new environment.Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(fail("CAPTURE_DECODE_FAILED", "Safari's captured image could not be decoded.")); image.src = dataUrl; });
        return image;
      };
      let tiles = 0, changed = false, pendingError;
      try {
        for (let y = 0; y < region.height; y += before.viewport.height) {
          for (let x = 0; x < region.width; x += before.contentWidth) {
            if (++tiles > 256) throw fail("CAPTURE_LIMIT", "This full-page screenshot exceeds the 256-tile limit.");
            const desired = { x: region.x + x, y: region.y + y };
            const position = await page(tab, "capture_scroll", { ...before, ...desired }); changed = true;
            const sourceX = desired.x - position.x, sourceY = desired.y - position.y;
            const width = Math.min(before.contentWidth - sourceX, region.width - x);
            const height = Math.min(before.viewport.height - sourceY, region.height - y);
            if (width <= 0 || height <= 0) throw fail("CAPTURE_LAYOUT_CHANGED", "The document layout changed while capturing its tiles.");
            const image = await raw();
            const scaleX = image.naturalWidth / before.viewport.width, scaleY = image.naturalHeight / before.viewport.height;
            if (!(scaleX > 0 && scaleY > 0)) throw fail("CAPTURE_FAILED", "Safari returned invalid image dimensions.");
            context.drawImage(image, sourceX * scaleX, sourceY * scaleY, width * scaleX, height * scaleY, x, y, width, height);
          }
        }
        return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
      } catch (error) { pendingError = error; throw error; }
      finally {
        canvas.width = 0; canvas.height = 0;
        if (changed) {
          try {
            const restored = await page(tab, "capture_scroll", before);
            if (Math.abs(restored.x - before.x) > 1 || Math.abs(restored.y - before.y) > 1) throw fail("CAPTURE_SCROLL_RESTORE_FAILED", "Safari did not restore the original screenshot scroll position.");
          } catch (error) {
            if (!pendingError) throw error;
            pendingError.message += ` Scroll restoration failed: ${error.message}`;
          }
        }
      }
    }
    async function execute(request) {
      const action = request.command.action;
      if (request.agentOwner !== undefined && ["interact", "organize", "select_tab", "screenshot", "dialog", "filechooser", "viewport"].includes(action)
        && !(action === "viewport" && request.command.arguments?.operation === "reset")) {
        if (typeof request.agentOwner !== "string" || !request.agentOwner
          || typeof environment.ChatGPTSafariSidebar?.withAgentSelection !== "function") {
          throw fail("INVALID_OWNER", "The original Safari agent selection owner is unavailable.");
        }
        const tab = await target(request.command.arguments?.handle, request.command.arguments?.expectedUrl);
        const nativeGroupMove = action === "organize" && ["createGroup", "moveToGroup", "moveToUngrouped"].includes(request.command.arguments?.operation)
          ? request.command.arguments.operation : undefined;
        const groupArgs = request.command.arguments || {};
        return environment.ChatGPTSafariSidebar.withAgentSelection(request.agentOwner, tab,
          selection => executeCommand(request, selection), { action, nativeGroupMove,
            destinationTitle: nativeGroupMove === "moveToUngrouped" ? null
              : nativeGroupMove === "createGroup" ? groupArgs.newTitle : groupArgs.groupTitle,
            nativeWindowIdentifier: groupArgs.windowIdentifier,
            afterOwnerRestored: action === "viewport"
              ? ownerTab => environment.ChatGPTSafariViewport.commitReturnPage({ ...request, sessionId }, ownerTab) : undefined });
      }
      return executeCommand(request);
    }
    async function executeCommand(request, selection) {
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
      const tab = await target(args.handle, ["navigate", "history", "select_tab", "close_tab"].includes(action) ? args.expectedUrl : undefined, action === "navigate");
      if (action === "viewport") return environment.ChatGPTSafariViewport.run({ ...request, sessionId }, selection);
      if (action === "read_page") return read(tab, args.maxLength);
      if (action === "dom_query") {
        if (args.command?.type === "safari_downloads_probe") return { download: typeof api.downloads?.download,
          search: typeof api.downloads?.search, onCreated: typeof api.downloads?.onCreated?.addListener, onChanged: typeof api.downloads?.onChanged?.addListener };
        if (args.command?.type === "safari_webmcp_probe") return page(tab, "query", args);
        if (args.command?.type === "safari_content_export_inspect") {
          return environment.ChatGPTSafariDownloads.createExports({ api, target, send, profileId, sessionId, assertTime, unwrap }).inspect(tab, args.command);
        }
        if (["safari_assets_list", "safari_assets_inspect"].includes(args.command?.type)) {
          const downloads = environment.ChatGPTSafariDownloads.createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap });
          return args.command.type === "safari_assets_list" ? downloads.listAssets(tab, { ...args.command, handle: args.handle })
            : downloads.inspectAssets(tab, { ...args.command, handle: args.handle });
        }
        if (args.command?.type === "safari_logs_start") {
          const value = await page(tab, "logs_bind", { scope: args.command.scope });
          await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: consoleCapture, args: ["start", value.token] });
          return value;
        }
        if (args.command?.type === "safari_logs_read") return page(tab, "logs_read", args.command);
        await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["safari/playwright-injected.js"], world: "ISOLATED" });
        assertTime();
        if (args.command?.type === "playwright_dom_snapshot") {
          const snapshot = async (frameId, depth = 0, expectedDocumentId) => {
            assertTime();
            const value = await page(tab, "query", { ...args, expectedDocumentId }, frameId);
            let text = value.dom_snapshot;
            if (depth < 8) for (const ref of value.frameRefs || []) {
              try {
                const child = await resolveFrame(tab, frameId, "aria-ref=" + ref, expectedDocumentId);
                const body = await snapshot(child.childFrameId, depth + 1, child.childDocumentId);
                text = text.split("\n").flatMap(line => line.includes(`[ref=${ref}]`) && /^\s*- iframe\b/.test(line)
                  ? [line + (line.endsWith(":") ? "" : ":"), ...body.split("\n").map(inner => (line.match(/^\s*/)?.[0] || "") + "  " + inner)] : [line]).join("\n");
              } catch (error) {
                if (!["FRAME_DISCONNECTED", "FRAME_API_UNAVAILABLE", "STRICT_FRAME"].includes(error.code)) throw error;
                text += `\n- iframe content unavailable: ${error.code}`;
              }
            }
            return text.slice(0, 60000);
          };
          return { dom_snapshot: await snapshot(0) };
        }
        let frameId = 0, expectedDocumentId; const framePath = [];
        const parts = typeof args.command?.selector === "string" ? args.command.selector.split(" >> internal:control=enter-frame >> ") : [];
        if (parts.length > 9) throw fail("FRAME_DEPTH", "A Safari frame locator is limited to eight nested frames.");
        for (const part of parts.slice(0, -1)) {
          assertTime(); const binding = await resolveFrame(tab, frameId, part, expectedDocumentId); framePath.push(binding); frameId = binding.childFrameId; expectedDocumentId = binding.childDocumentId;
        }
        const result = await page(tab, "query", { ...args, expectedDocumentId, command: { ...args.command, ...(parts.length ? { selector: parts.at(-1) } : {}) } }, frameId);
        return { ...result, ...(frameId ? { frameId, framePath } : {}) };
      }
      if (action === "asset_bundle") {
        const downloads = environment.ChatGPTSafariDownloads.createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap });
        return downloads.bundle(request, tab, args);
      }
      if (action === "content_export") {
        return environment.ChatGPTSafariDownloads.createExports({ api, target, send, profileId, sessionId, assertTime, unwrap }).execute(request, tab, args);
      }
      if (action === "filechooser") {
        const chooser = fileChoosers.get(args.chooserId);
        if (!chooser || chooser.tabId !== tab.id || chooser.ownerId !== request.agentOwner
          || chooser.sessionId !== args.agentScope?.sessionId || chooser.turnId !== args.agentScope?.turnId
          || args.agentScope?.ownerId !== request.agentOwner || !args.scope || Object.keys(args.scope).length !== 7
          || Object.entries(chooser.scope).some(([name, value]) => args.scope[name] !== value)
          || chooser.url !== tab.url || args.operation !== "setFiles") throw fail("STALE_FILE_CHOOSER", "This file chooser no longer belongs to the exact source tab, owner, session, and turn.");
        const selectedBounds = await focus(tab, selection);
        const sameBounds = ["left", "top", "width", "height"].every(name => Math.abs(selectedBounds[name] - chooser.windowBounds[name]) <= 1);
        if (!sameBounds) throw fail("WINDOW_CHANGED", "The file chooser's source Safari window moved or resized.");
        selection?.assertCurrent(); assertTime();
        fileChoosers.delete(args.chooserId);
        const result = unwrap(await send({ action: "liveFileChooser", id: request.id, profileId, sessionId,
          input: { action: "fileChooser", operation: "setFiles", expectedUrl: chooser.url, windowBounds: selectedBounds,
            scope: chooser.scope, isMultiple: chooser.isMultiple, chooserId: args.chooserId, files: args.files } }));
        selection?.releaseDialog?.();
        return result;
      }
      if (action === "screenshot" || action === "dialog") {
        const selectedBounds = await focus(tab, selection);
        assertTime();
        const fresh = await target(args.handle, tab.url);
        const input = { expectedUrl: fresh.url, windowBounds: selectedBounds };
        if (action === "dialog") {
          unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
            input: { ...input, action: "focus", allowJavaScriptDialog: true } }));
          const result = unwrap(await send({ action: "liveDialog", id: request.id, profileId, sessionId,
            input: { ...input, action: args.operation, dialogId: args.dialogId, promptText: args.promptText } }));
          if (args.operation === "inspect" && result.dialog) selection?.holdDialog?.();
          else selection?.releaseDialog?.();
          return args.operation === "inspect" ? { dialog: result.dialog } : {};
        }
        return capture(tab, args, request, selectedBounds, selection, assertTime);
      }
      if (action === "download_link_inspect" || action === "download_link") {
        const downloads = environment.ChatGPTSafariDownloads.createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap });
        return action === "download_link_inspect" ? downloads.inspect(tab, args) : downloads.execute(request, tab, args);
      }
      if (action === "organize") {
        if (typeof args.expectedUrl !== "string" || !["inspect", "createGroup", "moveToGroup", "moveToUngrouped", "renameGroup"].includes(args.operation)) throw fail("INVALID_ARGUMENT", "A native Safari organization operation and expectedUrl are required.");
        const selectedBounds = await focus(tab, selection);
        assertTime();
        unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
          input: { action: "focus", expectedUrl: tab.url, windowBounds: selectedBounds } }));
        const fresh = await target(args.handle, args.expectedUrl);
        assertTime();
        const organize = async () => unwrap(await send({ action: "liveOrganize", id: request.id, profileId, sessionId,
          input: { action: args.operation, expectedUrl: fresh.url, windowBounds: selectedBounds,
            tab: { index: fresh.index, title: fresh.title }, groupTitle: args.groupTitle, newTitle: args.newTitle,
            windowIdentifier: args.windowIdentifier } }));
        return selection && ["createGroup", "moveToGroup", "moveToUngrouped"].includes(args.operation)
          ? selection.runNativeGroupMove(args.operation, organize) : organize();
      }
      if (["navigate", "history", "select_tab", "close_tab"].includes(action) && typeof args.expectedUrl !== "string") throw fail("INVALID_ARGUMENT", "expectedUrl is required for this action.");
      if (action === "navigate") { await api.tabs.update(tab.id, { url: url(args.url) }); return describe(await ready(tab.id)); }
      if (action === "history") {
        const method = { back: "goBack", forward: "goForward", reload: "reload" }[args.direction];
        if (!method || typeof api.tabs[method] !== "function") throw fail("UNSUPPORTED_NAVIGATION", "This native Safari navigation method is unavailable.");
        await api.tabs[method](tab.id);
        return describe(await ready(tab.id));
      }
      if (action === "select_tab") { await focus(tab, selection); return describe(await target(args.handle, tab.url)); }
      if (action === "close_tab") { await api.tabs.remove(tab.id); return { closed: true, handle: args.handle }; }
      if (action !== "interact") throw fail("UNKNOWN_ACTION", "Unknown live Safari action.");
      if (typeof args.documentId !== "string" || typeof args.snapshotId !== "string" ||
          !Array.isArray(args.interactions) || args.interactions.length < 1 || args.interactions.length > 20) throw fail("INVALID_ARGUMENT", "A fresh page snapshot and 1–20 interactions are required.");
      const frameId = args.frameId || 0;
      const framePath = args.framePath || [];
      if (!Number.isSafeInteger(frameId) || frameId < 0 || !Array.isArray(framePath) || framePath.length > 8
        || (frameId > 0 && (!framePath.length || framePath.at(-1).childFrameId !== frameId))) throw fail("INVALID_FRAME", "A native frame-scoped input requires its observed parent frame chain.");
      const completed = [];
      const nativeSteps = [];
      let inputDelivered = false, readbackExpired = false, lastDelivered, lastWindowBounds, lastCurrent = tab, activeFileChooserOpened;
      const fileInputTokens = new Set();
      const observe = async operation => {
        assertTime();
        if (readbackExpired) throw fail("POST_INPUT_READBACK_TIMEOUT", "The delivered input's page readback expired. No input was repeated.");
        if (!inputDelivered) { const result = await operation(); assertTime(); return result; }
        let timer;
        try {
          const result = await Promise.race([operation(), new Promise((_, reject) => {
            timer = environment.setTimeout(() => {
              readbackExpired = true;
              reject(Object.assign(fail("POST_INPUT_READBACK_TIMEOUT", "Safari did not finish a page observation within two seconds after delivered native input. Do not repeat that input."),
                { mayHavePostedInput: true, doNotReplay: true }));
            }, 2000);
          })]);
          assertTime(); return result;
        } finally { if (timer !== undefined) (environment.clearTimeout || clearTimeout)(timer); }
      };
      const observedPage = (operation, options, selectedFrame = frameId) => observe(() => page(tab, operation,
        { ...options, ...(inputDelivered ? { _nativeObservationDeadline: Date.now() + 2000 } : {}) }, selectedFrame));
      const scopedPage = (operation, options) => observedPage(operation, options);
      try {
        await scopedPage("check", args);
        // Safari's windows.update selects its window but does not activate a
        // background/fullscreen app. One explicit native activation precedes
        // the batch; later user focus changes abort instead of being undone.
        const selectedBounds = await focus(tab, selection);
        assertTime();
        const activated = unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
          input: { action: "focus", expectedUrl: tab.url, windowBounds: selectedBounds } }));
        nativeSteps.push({ action: "focus", ...activated });
        for (const interaction of args.interactions) {
          selection?.assertCurrent();
          assertTime();
          if (!["click", "type", "key", "scroll", "move", "drag", "select"].includes(interaction.type) ||
              (!["scroll", "move", "drag", "click"].includes(interaction.type) && typeof interaction.node !== "string") ||
              (interaction.type === "click" && typeof interaction.node !== "string" && !interaction.point)) throw fail("INVALID_ARGUMENT", "Each interaction requires a supported type and page node or viewport point.");
          if (interaction.type === "type" && (typeof interaction.value !== "string" || interaction.value.length > 12000)) throw fail("INVALID_ARGUMENT", "Type requires text of at most 12000 UTF-16 code units.");
          if (interaction.type === "key" && (typeof interaction.key !== "string" || interaction.key.length > 80)) throw fail("UNSUPPORTED_KEY", "Use a page key with optional Meta, Control, Alt, and Shift modifiers.");
          const current = await observe(() => target(args.handle, tab.url));
          const window = await observe(() => api.windows.get(tab.windowId));
          if (!current.active || !window.focused) throw fail("FOCUS_CHANGED", "The selected Safari tab/window lost focus. No input was replayed.");
          const windowBounds = { left: window.left, top: window.top, width: window.width, height: window.height };
          lastCurrent = current; lastWindowBounds = windowBounds;
          const frameGeometry = [];
          for (const frame of framePath) {
            await observedPage("check", frame, frame.frameId);
            frameGeometry.push(await observedPage("prepare", { ...frame, type: "click", frameBounds: true }, frame.frameId));
          }
          const localGeometry = await scopedPage("prepare", { ...args, ...interaction });
          for (const [index, frame] of framePath.entries()) frameGeometry[index] = await observedPage("prepare", { ...frame, type: "click", frameBounds: true, noScroll: true }, frame.frameId);
          let point = { ...localGeometry.point };
          const parentPoints = [];
          for (const geometry of [...frameGeometry].reverse()) {
            const { frame } = geometry;
            const scaleX = frame.width / frame.offsetWidth, scaleY = frame.height / frame.offsetHeight;
            if (!frame.axisAligned || ![scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) throw fail("FRAME_LAYOUT_CHANGED", "Safari could not map a rotated, detached, or invalid frame viewport.");
            point = { x: frame.left + (frame.clientLeft + point.x) * scaleX, y: frame.top + (frame.clientTop + point.y) * scaleY };
            parentPoints.unshift(point);
          }
          const geometry = framePath.length ? { expectedUrl: tab.url, viewport: frameGeometry[0].viewport, point } : localGeometry;
          let openedFileInput, inputObservation;
          const native = async (kind, extra = {}) => {
            selection?.assertCurrent();
            assertTime(); await observe(() => target(args.handle, tab.url)); await scopedPage("check", args);
            for (const [index, frame] of framePath.entries()) {
              await observedPage("check", frame, frame.frameId);
              await observedPage("pointCheck", { ...frame, point: parentPoints[index], frameRect: frameGeometry[index].frame }, frame.frameId);
            }
            await scopedPage("pointCheck", { ...args, node: interaction.node, point: localGeometry.point });
            let token, observation;
            if (["click", "key"].includes(kind) && request.agentOwner !== undefined) {
              token = environment.crypto.randomUUID();
              observation = { tabId: tab.id, frameId, url: framePath.at(-1)?.childUrl || tab.url,
                documentId: args.documentId, snapshotId: args.snapshotId };
              inputObservation = observation;
              fileInputObservations.set(token, observation);
              fileInputTokens.add(token);
              await scopedPage("filechooser_arm", { ...args, token, sourceNode: interaction.node, point: localGeometry.point });
            }
            let result;
            assertTime();
            result = unwrap(await send({ action: "liveInput", id: request.id, profileId, sessionId,
              input: { action: kind, ...geometry, windowBounds, ...extra } }));
            if (observation?.value && !observation.ambiguous) openedFileInput = observation.value;
            nativeSteps.push({ action: kind, node: interaction.node, ...result });
            if (result.eventsPosted > 0) { inputDelivered = true; lastDelivered = { type: kind, node: interaction.node, result, recorded: false }; }
            return result;
          };
          const fileChooserOpened = async () => {
            selection?.holdDialog?.("filechooser");
            const observedInput = inputObservation?.ambiguous ? null : inputObservation?.value || openedFileInput;
            if (!observedInput || args.agentScope?.ownerId !== request.agentOwner || typeof args.agentScope?.sessionId !== "string" || typeof args.agentScope?.turnId !== "string") {
              return { completed, tab: describe(current), fileChooserOpen: true,
                fileChooserError: "The native file chooser opened without a verified DOM file-input click. Cancel this chooser before continuing; custom showPicker-only controls are unsupported. The opening click was not repeated." };
            }
            const scope = { profileId, tabId: String(tab.id), documentId: observedInput.documentId, node: observedInput.node,
              ownerId: request.agentOwner, sessionId: args.agentScope.sessionId, turnId: args.agentScope.turnId };
            if (Object.entries(args.fileChooserScope || {}).length !== 6 || Object.entries(args.fileChooserScope).some(([key, value]) => scope[key] !== value)) throw fail("FILE_CHOOSER_SCOPE_CHANGED", "The observed file input no longer matches this original agent operation's source scope.");
            assertTime(); selection?.assertCurrent();
            const result = unwrap(await send({ action: "liveFileChooser", id: request.id, profileId, sessionId,
              input: { action: "fileChooser", operation: "inspect", expectedUrl: tab.url, windowBounds,
                scope, isMultiple: observedInput.isMultiple } }));
            if (!result.fileChooser?.id || result.fileChooser.isMultiple !== observedInput.isMultiple) throw fail("FILE_CHOOSER_UNVERIFIABLE", "The native chooser did not retain its observed source file input. The opening click was not repeated.");
            fileChoosers.set(result.fileChooser.id, { tabId: tab.id, url: tab.url, windowBounds, scope,
              ownerId: request.agentOwner, sessionId: scope.sessionId, turnId: scope.turnId, isMultiple: observedInput.isMultiple });
            return { completed, tab: describe(current), fileChooserOpen: true, fileChooser: { ...result.fileChooser, scope },
              nextAction: "Use the registered original file chooser's setFiles after upload approval. No later input was delivered." };
          };
          activeFileChooserOpened = fileChooserOpened;
          if (interaction.type === "type" && interaction.requireFocused !== true) {
            const clicked = await native("click");
            if (clicked.fileChooserOpen === true) {
              completed.push({ type: "click", node: interaction.node, result: clicked }); return fileChooserOpened();
            }
            if (clicked.dialogOpen === true) {
              completed.push({ type: "click", node: interaction.node, result: clicked }); selection?.holdDialog?.();
              return { completed, tab: describe(current), dialogOpen: true, nextAction: "Inspect the current JavaScript dialog before continuing. No text or later input was delivered." };
            }
            await scopedPage("focused", { ...args, node: interaction.node });
          }
          // A key must not implicitly click/activate a button or move a caret.
          if (interaction.type === "key" || (interaction.type === "type" && interaction.requireFocused === true)) await scopedPage("focused", { ...args, node: interaction.node });
          const result = await native(interaction.type, { text: interaction.value, replaceAll: interaction.replaceAll === true,
            key: interaction.key, deltaX: interaction.deltaX, deltaY: interaction.deltaY,
            clickCount: interaction.clickCount, button: interaction.button, modifiers: interaction.modifiers, path: interaction.path,
            options: interaction.options, multiple: interaction.multiple });
          completed.push({ type: interaction.type, node: interaction.node, result });
          if (lastDelivered?.result === result) lastDelivered.recorded = true;
          if (result.fileChooserOpen === true) return fileChooserOpened();
          if (result.dialogOpen === true) {
            selection?.holdDialog?.();
            return { completed, tab: describe(current), dialogOpen: true, nextAction: "Inspect the current JavaScript dialog before continuing. Later input was not delivered." };
          }
          await delay(80);
        }
        const after = await ready(tab.id, observe);
        if (after.status !== "complete") return { completed, tab: describe(after), pagePending: true,
          nextAction: "Read this handle with live_read_page to inspect the loading document. Do not repeat the interaction." };
        return { completed, page: await read(after, 20000, observe) };
      } catch (error) {
        if (error.code === "POST_INPUT_READBACK_TIMEOUT" && inputDelivered && lastWindowBounds) {
          // Safari can present a modal after native click observation finishes.
          // A blocked read is not retried; inspect its actual native target once
          // and free the serialized poll so a dialog response can be delivered.
          try {
            selection?.assertCurrent(); assertTime();
            const modal = unwrap(await send({ action: "liveModal", id: request.id, profileId, sessionId,
              input: { expectedUrl: tab.url, windowBounds: lastWindowBounds } }));
            if (modal.dialogOpen === true || modal.fileChooserOpen === true) {
              if (lastDelivered && !lastDelivered.recorded) { completed.push({ type: lastDelivered.type, node: lastDelivered.node, result: lastDelivered.result }); lastDelivered.recorded = true; }
              if (modal.fileChooserOpen === true && activeFileChooserOpened) return await activeFileChooserOpened();
              selection?.holdDialog?.();
              return { completed, tab: describe(lastCurrent), dialogOpen: true,
                nextAction: "Inspect the current JavaScript dialog before continuing. The delivered input and blocked page read were not repeated." };
            }
          } catch (nativeError) {
            error.message += ` Native modal inspection failed: ${nativeError.message}`;
          }
        }
        const details = error.data;
        error.data = { completed, nativeSteps, eventsPosted: error.eventsPosted, mayHavePostedInput: error.mayHavePostedInput,
          ...(details ? { details } : {}),
          outcome: nativeSteps.some(step => step.eventsPosted > 0) || error.mayHavePostedInput ? "partial or uncertain; read current page before continuing" : "no native input confirmed" };
        throw error;
      } finally {
        for (const token of fileInputTokens) fileInputObservations.delete(token);
      }
    }
    async function poll() {
      if (stopped || polling || !profileId) return;
      polling = true;
      try {
        const selection = environment.ChatGPTSafariSidebar?.selectionDiagnostics();
        const response = await send({ action: "livePoll", profileId, sessionId, ...(selection ? { selection } : {}) });
        if (response?.ok !== true) return; // A poll never launches a user-quit app.
        for (const request of response.requests || []) {
          let response;
          try { response = { ok: true, result: await execute(request) }; }
          catch (error) {
            const native = {};
            for (const key of ["actionsPerformed", "eventsPosted"]) {
              if (Number.isSafeInteger(error[key]) && error[key] >= 0) native[key] = error[key];
            }
            for (const key of ["mutationApplied", "doNotReplay", "mayHavePostedInput"]) {
              if (typeof error[key] === "boolean") native[key] = error[key];
            }
            for (const key of ["tabBarRestoration", "nativeSidebarRestoration"]) {
              if (["restored", "unconfirmed"].includes(error[key])) native[key] = error[key];
            }
            const hasNative = Object.keys(native).length > 0;
            const details = hasNative ? { ...(error.data && typeof error.data === "object" && !Array.isArray(error.data)
              ? error.data : error.data === undefined ? {} : { details: error.data }), ...native } : error.data;
            response = { ok: false, error: { code: error.code || "SAFARI_API_ERROR", message: error.message,
              ...(details === undefined ? {} : { data: details }) } };
          }
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
    async function releaseLogs(tabId, scope) {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab || tab.incognito || !/^https?:\/\//i.test(tab.url || "")) return;
      const value = await page(tab, "logs_release", { scope });
      if (value.token) await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: consoleCapture, args: ["stop", value.token] });
    }
    function releaseFileChoosers({ sessionId: originalSession, turnId }) {
      for (const [id, chooser] of fileChoosers) if (chooser.sessionId === originalSession && (turnId == null || chooser.turnId === turnId)) fileChoosers.delete(id);
    }
    return { start, poll, execute, releaseLogs, releaseFileChoosers,
      stop() { stopped = true; environment.clearInterval(timer); fileChoosers.clear(); fileInputObservations.clear(); } };
  }
  if (typeof module === "object" && module.exports) module.exports = { createLive, pageOperation, consoleCapture };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) {
    root.ChatGPTSafariLive = createLive(api);
    root.ChatGPTSafariLive.start().catch(() => {});
  }
})(globalThis);
