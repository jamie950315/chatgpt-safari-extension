/* Mount ChatGPT in its owning Safari page without a separate native window. */
(function (root) {
  "use strict";
  const TYPE = "chatgpt-safari-sidebar:";
  const BOOTSTRAP_PREFIX = "chatgpt-safari-sidebar:";
  const PATHS = new Set(["/codex-work-sidepanel.html", "/waiting-room.html", "/side-panel-loading.html", "/embedded-sidechat.html"]);

  // Like Margina, reserve root width and adjust viewport-fixed controls rather
  // than wrapping the body, which would change sticky/fixed containing blocks.
  function createFixedLayout(document, page) {
    const candidates = new Set(), changed = new Map(), scans = [];
    let reserved = 0, timer;
    function restore() {
      for (const [element, properties] of changed) {
        for (const [name, item] of properties) {
          if (element.style.getPropertyValue(name) !== item.applied
            || element.style.getPropertyPriority(name) !== "important") continue;
          if (item.value) element.style.setProperty(name, item.value, item.priority);
          else element.style.removeProperty(name);
        }
      }
      changed.clear();
    }
    function set(element, name, value) {
      let properties = changed.get(element);
      if (!properties) changed.set(element, properties = new Map());
      if (!properties.has(name)) properties.set(name, {
        value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name), applied: value,
      });
      else properties.get(name).applied = value;
      element.style.setProperty(name, value, "important");
      properties.get(name).applied = element.style.getPropertyValue(name);
    }
    function enqueue(element) {
      if (!element || element.nodeType !== 1) return;
      candidates.add(element);
      for (let parent = element; parent; parent = parent.parentElement) {
        if (scans.some(scan => scan.root === parent)) return;
      }
      for (let index = scans.length - 1; index >= 0; index--) {
        for (let parent = scans[index].root.parentElement; parent; parent = parent.parentElement) {
          if (parent === element) { scans.splice(index, 1); break; }
        }
      }
      scans.push({ root: element, walker: document.createTreeWalker(element, 1) });
    }
    function schedule() {
      if (!reserved || timer != null) return;
      timer = page.setTimeout(() => { timer = undefined; refresh(); }, 50);
    }
    const observer = new page.MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") enqueue(record.target);
        else for (const node of record.addedNodes) enqueue(node);
      }
      schedule();
    });
    function viewportFixed(element) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = page.getComputedStyle(parent);
        if ((style.transform && style.transform !== "none") || (style.perspective && style.perspective !== "none")
          || (style.filter && style.filter !== "none") || /paint|layout|strict|content/.test(style.contain || "")
          || /transform|perspective|filter/.test(style.willChange || "")) return false;
      }
      return true;
    }
    function refresh() {
      observer.disconnect();
      restore();
      let budget = 350;
      while (scans.length && budget > 0) {
        const element = scans[0].walker.nextNode();
        if (!element) { scans.shift(); continue; }
        budget--;
        if (page.getComputedStyle(element).position === "fixed") candidates.add(element);
      }
      const available = Math.max(1, page.innerWidth - reserved);
      for (const element of candidates) {
        if (!element.isConnected) { candidates.delete(element); continue; }
        const style = page.getComputedStyle(element);
        if (style.position !== "fixed") { candidates.delete(element); continue; }
        if (!viewportFixed(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.right <= available || rect.left >= page.innerWidth) continue;
        if (rect.width > available) {
          set(element, "box-sizing", "border-box");
          set(element, "min-width", "0px");
          set(element, "max-width", `${available}px`);
        }
        const right = Number.parseFloat(style.right);
        if (Number.isFinite(right)) set(element, "right", `${right + reserved}px`);
        const adjusted = element.getBoundingClientRect();
        const left = Number.parseFloat(page.getComputedStyle(element).left);
        const shift = adjusted.left < 0 ? -adjusted.left : Math.min(0, available - adjusted.right);
        if (Number.isFinite(left) && shift) set(element, "left", `${left + shift}px`);
      }
      if (document.body) observer.observe(document.body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"],
      });
      else if (document.documentElement) observer.observe(document.documentElement, { childList: true });
      if (scans.length) schedule();
    }
    return {
      apply(width) {
        if (!reserved) enqueue(document.body);
        reserved = width;
        refresh();
      },
      rescan() { enqueue(document.body); if (reserved) refresh(); },
      clear() {
        reserved = 0;
        observer.disconnect();
        if (timer != null) page.clearTimeout(timer);
        timer = undefined;
        restore(); candidates.clear(); scans.length = 0;
      },
    };
  }

  function createSidebarContent(api, page = root) {
    const document = page.document;
    let mounted;
    const rootProperties = new Map();
    const fixedLayout = createFixedLayout(document, page);

    function reserveWidth(width) {
      const style = document.documentElement.style;
      for (const [name, applied] of [["width", `calc(100% - ${width}px)`], ["min-width", "0px"], ["margin-right", `${width}px`]]) {
        const previous = rootProperties.get(name);
        if (!previous || style.getPropertyValue(name) !== previous.applied || style.getPropertyPriority(name) !== "important") {
          rootProperties.set(name, { value: style.getPropertyValue(name), priority: style.getPropertyPriority(name), applied });
        } else previous.applied = applied;
        style.setProperty(name, applied, "important");
        rootProperties.get(name).applied = style.getPropertyValue(name);
      }
      fixedLayout.apply(width);
    }

    function restoreWidth() {
      fixedLayout.clear();
      const style = document.documentElement.style;
      for (const [name, item] of rootProperties) {
        if (style.getPropertyValue(name) !== item.applied || style.getPropertyPriority(name) !== "important") continue;
        if (item.value) style.setProperty(name, item.value, item.priority);
        else style.removeProperty(name);
      }
      rootProperties.clear();
    }

    function widthBounds() {
      const viewport = page.innerWidth || 1024;
      const minimum = Math.min(320, Math.max(0, viewport - 24));
      const maximum = Math.max(minimum, Math.min(720, viewport - 360));
      return { minimum, maximum };
    }

    function clampWidth(value) {
      const { minimum, maximum } = widthBounds();
      return Math.round(Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 420)));
    }

    function unmount(instanceId) {
      if (mounted && instanceId !== mounted.instanceId) return false;
      if (mounted) {
        mounted.cleanup();
        mounted.host.remove();
        mounted = undefined;
      }
      restoreWidth();
      return true;
    }

    function mount(message) {
      const target = new URL(message.iframeUrl);
      const expected = new URL(api.runtime.getURL("/"));
      if (target.protocol !== expected.protocol || target.host !== expected.host || !PATHS.has(target.pathname)
        || target.search || target.hash || typeof message.instanceId !== "string"
        || !Number.isSafeInteger(message.tabId) || !Number.isSafeInteger(message.windowId)) {
        throw new Error("The sidebar must load an authorized ChatGPT extension page");
      }
      if (!document.documentElement) throw new Error("The Safari page is not ready for a sidebar");
      if (mounted?.instanceId === message.instanceId && mounted.path === target.pathname) {
        mounted.applyWidth(message.width);
        return { ok: true, instanceId: mounted.instanceId };
      }
      if (mounted) unmount(mounted.instanceId);
      const host = document.createElement("div");
      host.setAttribute("data-chatgpt-safari-sidebar", "");
      host.style.cssText = "all:initial!important;position:fixed!important;top:0!important;right:0!important;bottom:0!important;z-index:2147483647!important;display:block!important;isolation:isolate!important";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        .panel { display:flex; flex-direction:column; height:100%; width:100%; background:Canvas; color:CanvasText; border-left:1px solid color-mix(in srgb,CanvasText 18%,transparent); box-shadow:-5px 0 20px #0001; }
        .bar { display:flex; align-items:center; justify-content:space-between; flex:none; height:42px; padding:0 12px 0 16px; font:600 13px -apple-system,BlinkMacSystemFont,sans-serif; border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent); }
        .close { border:0; border-radius:7px; background:transparent; color:inherit; width:28px; height:28px; font:22px -apple-system,sans-serif; cursor:pointer; }
        .close:hover { background:color-mix(in srgb,CanvasText 9%,transparent); }
        .close:focus-visible { outline:2px solid #0a84ff; outline-offset:1px; }
        iframe { display:block; flex:1; min-height:0; width:100%; border:0; background:Canvas; }
        .resize { position:absolute; left:-4px; top:0; bottom:0; width:8px; cursor:col-resize; touch-action:none; }
        .resize:focus-visible { outline:2px solid #0a84ff; outline-offset:-3px; }
        @media print { :host { display:none!important; } }
      `;
      const panel = document.createElement("section");
      panel.className = "panel";
      panel.setAttribute("aria-label", "ChatGPT sidebar");
      const bar = document.createElement("header");
      bar.className = "bar";
      const title = document.createElement("span");
      title.textContent = "ChatGPT";
      const close = document.createElement("button");
      close.className = "close";
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close ChatGPT sidebar");
      const diagnostics = document.createElement("button");
      diagnostics.type = "button";
      diagnostics.className = "close";
      diagnostics.textContent = "⋯";
      diagnostics.setAttribute("aria-label", "Open connection diagnostics");
      diagnostics.addEventListener("click", () => {
        api.runtime.sendMessage({ type: "chatgpt-safari:open-diagnostics" })
          .catch(error => console.error("ChatGPT Safari diagnostics could not open", error));
      });
      const actions = document.createElement("div");
      actions.append(diagnostics, close);
      bar.append(title, actions);
      const frame = document.createElement("iframe");
      frame.title = "ChatGPT";
      frame.name = BOOTSTRAP_PREFIX + JSON.stringify({
        version: 1, tabId: message.tabId, windowId: message.windowId, instanceId: message.instanceId,
      });
      frame.src = message.iframeUrl;
      frame.setAttribute("allow", "clipboard-write; microphone; camera");
      const resize = document.createElement("div");
      resize.className = "resize";
      resize.tabIndex = 0;
      resize.setAttribute("role", "separator");
      resize.setAttribute("aria-label", "Resize ChatGPT sidebar");
      resize.setAttribute("aria-orientation", "vertical");
      panel.append(bar, frame, resize);
      shadow.append(style, panel);
      let width = clampWidth(message.width);
      function applyWidth(next) {
        width = clampWidth(next);
        const { minimum, maximum } = widthBounds();
        host.style.setProperty("width", `${width}px`, "important");
        resize.setAttribute("aria-valuenow", String(width));
        resize.setAttribute("aria-valuemin", String(minimum));
        resize.setAttribute("aria-valuemax", String(maximum));
        resize.setAttribute("aria-valuetext", `${width} pixels`);
        reserveWidth(width);
      }
      function saveWidth() {
        api.runtime.sendMessage({ type: TYPE + "resized", instanceId: message.instanceId, width })
          .catch((error) => console.error("ChatGPT Safari sidebar width was not saved", error));
      }
      let dragStart;
      function pointerMove(event) { if (dragging) applyWidth(dragStart.width + dragStart.x - event.clientX); }
      let dragging = false;
      function pointerUp() {
        if (!dragging) return;
        dragging = false;
        frame.style.pointerEvents = "";
        saveWidth();
      }
      resize.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        dragging = true;
        dragStart = { width, x: event.clientX };
        frame.style.pointerEvents = "none";
        resize.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
      resize.addEventListener("pointermove", pointerMove);
      resize.addEventListener("pointerup", pointerUp);
      resize.addEventListener("pointercancel", pointerUp);
      resize.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        applyWidth(width + (event.key === "ArrowLeft" ? 24 : -24));
        saveWidth();
        event.preventDefault();
      });
      function onResize() { applyWidth(width); }
      function onLoad() { fixedLayout.rescan(); }
      page.addEventListener("resize", onResize);
      page.addEventListener("load", onLoad);
      close.addEventListener("click", () => {
        const instanceId = message.instanceId;
        if (unmount(instanceId)) {
          api.runtime.sendMessage({ type: TYPE + "closed", instanceId })
            .catch((error) => console.error("ChatGPT Safari sidebar close was not recorded", error));
        }
      });
      mounted = {
        host, path: target.pathname, instanceId: message.instanceId,
        applyWidth,
        cleanup() { page.removeEventListener("resize", onResize); page.removeEventListener("load", onLoad); },
      };
      try {
        document.documentElement.append(host);
        applyWidth(width);
      } catch (error) {
        unmount(message.instanceId);
        throw error;
      }
      return { ok: true, instanceId: message.instanceId };
    }

    function command(message) {
      try {
        if (message?.type === TYPE + "mount") return mount(message);
        if (message?.type === TYPE + "unmount") return { ok: unmount(message.instanceId), instanceId: message.instanceId };
        throw new Error("Unknown ChatGPT sidebar command");
      } catch (error) { return { ok: false, error: error.message }; }
    }
    const announce = () => api.runtime.sendMessage({ type: TYPE + "ready" })
      .catch((error) => console.error("ChatGPT Safari sidebar page was not registered", error));
    if (document.documentElement) announce();
    else {
      const observer = new page.MutationObserver(() => {
        if (document.documentElement) { observer.disconnect(); announce(); }
      });
      observer.observe(document, { childList: true });
    }
    return { mount, unmount, command };
  }

  if (typeof module === "object" && module.exports) module.exports = { createSidebarContent, createFixedLayout };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id && root.document && root.top === root && !root.__chatgptSafariSidebarContent) {
    root.__chatgptSafariSidebarContent = createSidebarContent(api);
  }
})(globalThis);
