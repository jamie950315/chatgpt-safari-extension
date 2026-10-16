/* Mount the upstream ChatGPT side panel inside its owning Safari page. */
(function (root) {
  "use strict";
  const TYPE = "chatgpt-safari-sidebar:";
  const BOOTSTRAP_PREFIX = "chatgpt-safari-sidebar:";
  const PATHS = new Set(["/codex-work-sidepanel.html", "/waiting-room.html", "/side-panel-loading.html"]);

  function createSidebarContent(api, page = root) {
    const document = page.document;
    let mounted;
    let savedWidth;
    let reservedWidth;

    function reserveWidth(width) {
      const style = document.documentElement.style;
      if (!savedWidth || (reservedWidth != null
        && (style.getPropertyValue("width") !== reservedWidth
          || style.getPropertyPriority("width") !== "important"))) {
        savedWidth = {
          value: style.getPropertyValue("width"),
          priority: style.getPropertyPriority("width"),
        };
      }
      style.setProperty("width", `calc(100% - ${width}px)`, "important");
      reservedWidth = style.getPropertyValue("width");
    }

    function restoreWidth() {
      if (!savedWidth) return;
      const style = document.documentElement.style;
      if (style.getPropertyValue("width") === reservedWidth
        && style.getPropertyPriority("width") === "important") {
        if (savedWidth.value) style.setProperty("width", savedWidth.value, savedWidth.priority);
        else style.removeProperty("width");
      }
      savedWidth = undefined;
      reservedWidth = undefined;
    }

    function clampWidth(value) {
      const viewport = page.innerWidth || 1024;
      const maximum = Math.min(1200, Math.max(280, viewport - 96));
      return Math.round(Math.min(maximum, Math.max(280, Number.isFinite(value) ? value : 420)));
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
        host.style.setProperty("width", `${width}px`, "important");
        resize.setAttribute("aria-valuenow", String(width));
        reserveWidth(width);
      }
      function saveWidth() {
        api.runtime.sendMessage({ type: TYPE + "resized", instanceId: message.instanceId, width })
          .catch((error) => console.error("ChatGPT Safari sidebar width was not saved", error));
      }
      function pointerMove(event) { if (dragging) applyWidth(page.innerWidth - event.clientX); }
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
      page.addEventListener("resize", onResize);
      close.addEventListener("click", () => {
        const instanceId = message.instanceId;
        if (unmount(instanceId)) {
          api.runtime.sendMessage({ type: TYPE + "closed", instanceId })
            .catch((error) => console.error("ChatGPT Safari sidebar close was not recorded", error));
        }
      });
      mounted = {
        host, path: target.pathname, instanceId: message.instanceId,
        cleanup() { page.removeEventListener("resize", onResize); },
      };
      document.documentElement.append(host);
      applyWidth(width);
      return { ok: true, instanceId: message.instanceId };
    }

    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== api.runtime.id || !message) return false;
      if (message.type !== TYPE + "mount" && message.type !== TYPE + "unmount") return false;
      try {
        respond(message.type === TYPE + "mount"
          ? mount(message) : { ok: unmount(message.instanceId) });
      } catch (error) { respond({ ok: false, error: error.message }); }
      return false;
    });
    const announce = () => api.runtime.sendMessage({ type: TYPE + "ready" })
      .catch((error) => console.error("ChatGPT Safari sidebar page was not registered", error));
    if (document.documentElement) announce();
    else {
      const observer = new page.MutationObserver(() => {
        if (document.documentElement) { observer.disconnect(); announce(); }
      });
      observer.observe(document, { childList: true });
    }
    return { mount, unmount };
  }

  if (typeof module === "object" && module.exports) module.exports = { createSidebarContent };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id && root.document && root.top === root && !root.__chatgptSafariSidebarContent) {
    root.__chatgptSafariSidebarContent = createSidebarContent(api);
  }
})(globalThis);
