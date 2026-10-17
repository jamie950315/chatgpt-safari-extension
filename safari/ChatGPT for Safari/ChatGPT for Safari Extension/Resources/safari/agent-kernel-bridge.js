/* The original agent's high-level Safari boundary, inside its security gate. */
(function (root) {
  "use strict";
  const nativeCommands = new Set([
    "dom_cua_get_visible_dom", "dom_cua_click", "dom_cua_double_click", "dom_cua_type",
    "dom_cua_keypress", "dom_cua_scroll", "dom_cua_download_media", "navigate_tab_url",
    "navigate_tab_back", "navigate_tab_forward", "navigate_tab_reload", "close_tab",
    "browser_management_call", "browser_management_get_audit_trail",
    "browser_viewport_set", "browser_viewport_reset",
    "tab_screenshot", "tab_get_js_dialog", "tab_handle_js_dialog",
    "cua_click", "cua_double_click", "cua_drag", "cua_move", "cua_keypress", "cua_scroll", "cua_type", "cua_download_media",
    "tab_clipboard_read", "tab_clipboard_read_text", "tab_clipboard_write", "tab_clipboard_write_text",
    "tab_dev_logs",
    "tab_page_assets_list", "tab_page_assets_bundle",
    "playwright_dom_snapshot", "playwright_locator_click", "playwright_locator_dblclick", "playwright_locator_fill",
    "playwright_locator_count", "playwright_locator_is_enabled", "playwright_locator_is_visible", "playwright_locator_press",
    "playwright_locator_get_attribute", "playwright_locator_inner_text", "playwright_locator_all_text_contents",
    "playwright_locator_press_sequentially", "playwright_locator_set_checked", "playwright_locator_text_content",
    "playwright_locator_read_all", "playwright_locator_wait_for", "playwright_locator_select_option", "playwright_wait_for_load_state",
    "playwright_wait_for_timeout", "playwright_wait_for_url", "playwright_locator_download_media",
    "playwright_wait_for_file_chooser", "playwright_file_chooser_set_files",
    "tab_content_export_gsuite", "tab_content_export_youtube_transcript",
  ]);
  const originalCommands = new Set([
    "browser_user_open_tabs", "browser_user_claim_tab", "browser_user_get_tab_context", "browser_user_history",
    "get_tab", "list_tabs", "create_tab", "selected_tab", "mark_tab", "name_session",
  ]);
  let hostDocument, hostPreparation;
  const status = { phase: "idle", requests: 0, replies: 0, failures: 0, connections: 0 };
  let browserConnection;
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

  async function dispatch(context, command, original) {
    if (context.clientInfo.family !== "safari") return original();
    if (!record(command) || typeof command.type !== "string") throw new Error("A Safari agent command is required.");
    if (originalCommands.has(command.type)) {
      // Original inventory/claim handlers do not call the live executor. Bind
      // these reads and leases to the same real sidebar owner as native input.
      await context.api.executeUnhandledCommand({ type: "browser_safari_context" });
      const result = await original();
      if (command.type === "create_tab" && typeof result?.id === "string") {
        await context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { type: "safari_created_tab_bind", browser_id: command.browser_id, tab_id: result.id } });
      }
      if (["browser_user_claim_tab", "create_tab"].includes(command.type) && typeof result?.id === "string") {
        await context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { type: "safari_logs_start", browser_id: command.browser_id, tab_id: result.id } });
      }
      return result;
    }
    if (!nativeCommands.has(command.type)) throw new Error(`Safari does not support agent command "${command.type}".`);
    if (typeof command.browser_id !== "string" || (!command.type.startsWith("browser_management_") && !command.type.startsWith("browser_viewport_")
      && (!/^[1-9]\d*$/u.test(command.tab_id || "") || !Number.isSafeInteger(Number(command.tab_id))))) {
      throw new Error("A Safari agent command requires its browser and claimed tab IDs.");
    }
    if (command.safari_download_intent !== undefined) {
      if (command.type !== "playwright_locator_click" || command.safari_native_modal !== undefined) throw new Error("A captured download requires its dedicated single locator-click capability.");
      let captured;
      try {
        captured = await context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, type: "safari_download_capture" } });
        // The actual anchor default is already cancelled. Original source and
        // destination policy runs before the first request or private file write.
        let href = captured.href;
        if (captured.kind === "blob") {
          // Match the original Blob download policy: it approves the current
          // website origin, not a fabricated HTTP URL for the opaque Blob UUID.
          const origin = new URL(href).origin;
          await context.security.ensureDownloadAllowed(Number(command.tab_id), origin);
          await context.security.ensureApprovedDownloadStillAllowed(Number(command.tab_id), origin);
        } else if (["same-origin-policy", "cross-origin-policy", "tab-origin-policy"].includes(command.safari_download_intent.redirects)) {
          let ready = false;
          for (let request = 0; request < 5; request++) {
            await context.security.ensureDownloadAllowed(Number(command.tab_id), href);
            const step = await context.api.executeUnhandledCommand({ type: "browser_safari_command",
              command: { ...command, type: "safari_download_redirect_step", intentId: captured.intentId, href } });
            if (!["redirect", "ready"].includes(step.kind) || typeof step.href !== "string") throw new Error("Safari returned no verified exact redirect hop. No request was repeated.");
            href = step.href;
            if (step.kind === "ready") { ready = true; break; }
          }
          if (!ready) throw new Error("The captured download reached its five-request redirect bound. No next request was sent.");
        } else await context.security.ensureDownloadAllowed(Number(command.tab_id), href);
        return await context.api.executeUnhandledCommand({ type: "browser_safari_command",
          command: { ...command, type: "safari_download_complete", intentId: captured.intentId, href } });
      } finally {
        if (captured) await context.api.executeUnhandledCommand({ type: "browser_safari_command",
          command: { ...command, type: "safari_download_cancel", intentId: captured.intentId } }).catch(() => {});
      }
    }
    if (command.safari_native_modal !== undefined) {
      if (command.type !== "playwright_locator_click") throw new Error("Only a single native locator click may preregister a modal response.");
      if (command.safari_native_modal?.kind === "upload") {
        const source = await context.api.executeUnhandledCommand({ type: "browser_safari_command",
          command: { ...command, type: "safari_native_upload_inspect" } });
        await context.security.ensureFileUploadAllowed(Number(command.tab_id));
        return context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, safari_upload_source: source } });
      }
    }
    if (["dom_cua_download_media", "playwright_locator_download_media", "cua_download_media"].includes(command.type)) {
      const link = await context.api.executeUnhandledCommand({ type: "browser_safari_command",
        command: { ...command, type: "safari_download_inspect", sourceType: command.type } });
      // Keep original source/destination download consent and policy. Only the
      // inspected href, never a model-supplied override, reaches the transfer.
      await context.security.ensureDownloadAllowed(Number(command.tab_id), link.href);
      return context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, href: link.href } });
    }
    if (command.type === "tab_page_assets_bundle") {
      const selected = await context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, type: "safari_assets_inspect" } });
      await context.security.ensurePageAssetDownloadAllowed(selected.pageUrl);
      const approved = new Set();
      for (const asset of selected.assets) if (!asset.inline && !approved.has(new URL(asset.url).origin)) {
        await context.security.ensurePageAssetFallbackFetchAllowed(selected.pageUrl, asset.url); approved.add(new URL(asset.url).origin);
      }
      return context.api.executeUnhandledCommand({ type: "browser_safari_command", command });
    }
    if (command.type === "playwright_file_chooser_set_files") {
      await context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, type: "safari_file_chooser_inspect" } });
      await context.security.ensureFileUploadAllowed(Number(command.tab_id));
      return context.api.executeUnhandledCommand({ type: "browser_safari_command", command });
    }
    if (["tab_content_export_gsuite", "tab_content_export_youtube_transcript"].includes(command.type)) {
      const selected = await context.api.executeUnhandledCommand({ type: "browser_safari_command",
        command: { ...command, type: "safari_content_export_inspect", exportType: command.type } });
      await context.security.ensureDownloadAllowed(Number(command.tab_id), selected.href);
      return context.api.executeUnhandledCommand({ type: "browser_safari_command", command: { ...command, exportId: selected.exportId } });
    }
    return context.api.executeUnhandledCommand({ type: "browser_safari_command", command });
  }

  function ensureHostDocument(api = root.chrome, document = root.document) {
    if (hostPreparation) return hostPreparation;
    if (!document?.body || root.window?.parent !== root.window) {
      return Promise.reject(new Error("Safari requires its persistent background document to start the agent kernel."));
    }
    hostPreparation = (async () => {
      // Safari's persistent background can outlive its containing app. Check
      // the owner-bound native resource, not an iframe's old successful load.
      const url = validateSandboxURL(await root.ChatGPTSafariSidebarOptions.companion.agentKernelURL());
      if (hostDocument?.url === url) return hostDocument.ready;
      if (hostDocument) retireHostDocument(hostDocument,
        new Error("The native Safari kernel service changed. The delivered execution was not retried; read the current page before continuing."));
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      const state = { frame, url, requests: new Set(), connections: new Set() };
      hostDocument = state;
      status.phase = "preparing";
      state.ready = new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          root.clearTimeout(timer);
          frame.removeEventListener("load", loaded);
          frame.removeEventListener("error", failed);
          if (error) reject(error);
          else resolve();
        };
        const loaded = () => { status.phase = "host_loaded"; finish(); };
        const failed = () => finish(new Error("The Safari agent host document could not load."));
        frame.addEventListener("load", loaded, { once: true });
        frame.addEventListener("error", failed, { once: true });
        timer = root.setTimeout(() => finish(new Error("The Safari agent host document did not load within 10 seconds.")), 10000);
        frame.src = api.runtime.getURL("js-kernel-offscreen.html") + "?kernel=" + encodeURIComponent(url);
        document.body.append(frame);
      }).catch(error => { retireHostDocument(state, error); throw error; });
      return state.ready;
    })().catch(error => { status.phase = "failed"; status.failures++; throw error; })
      .finally(() => { hostPreparation = undefined; });
    return hostPreparation;
  }

  function retireHostDocument(state, error) {
    if (hostDocument === state) hostDocument = undefined;
    // Removing a frame alone silently strands its MessagePorts and callers.
    // Settle the old delivered work, never forward it to the new service.
    for (const reject of state.requests) reject(error);
    for (const transport of state.connections) transport.close();
    state.frame.remove();
  }

  function validateSandboxURL(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !/^chatgpt-kernel-[a-f0-9-]+\.localhost$/u.test(url.hostname)
      || !url.port || url.username || url.password || url.hash || url.pathname !== "/sandbox"
      || [...url.searchParams].length !== 1 || !/^[a-f0-9]{64}$/u.test(url.searchParams.get("cap") || "")) {
      throw new Error("Invalid isolated Safari agent kernel URL.");
    }
    return url.href;
  }

  function sandboxURL() { return validateSandboxURL(new URLSearchParams(root.location.search).get("kernel")); }

  function portTransport(port) {
    const listeners = new Set();
    let closed = false, callback;
    const finish = () => {
      if (closed) return;
      closed = true; port.close();
      for (const listener of listeners) Promise.resolve(listener()).catch(() => {});
      listeners.clear();
    };
    port.onmessage = event => {
      if (closed) return;
      if (event.data?.type === "close") finish();
      else if (event.data?.type === "message") callback?.(event.data.value);
    };
    port.onmessageerror = finish;
    port.start();
    return {
      sendMessage(value) { if (closed) throw new Error("The Safari kernel browser connection is closed."); port.postMessage({ type: "message", value }); },
      setMessageCallback(value) { callback = value; },
      addCloseListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      close() { if (!closed) { port.postMessage({ type: "close" }); finish(); } },
    };
  }

  function connectBrowser(scopeId) {
    if (root.window.parent === root.window || root.window.parent.parent === root.window.parent) {
      throw new Error("The Safari kernel browser connection requires its background host.");
    }
    const channel = new root.MessageChannel();
    const transport = portTransport(channel.port1);
    root.window.parent.parent.postMessage({ type: "chatgpt-safari:kernel-browser", scopeId }, "*", [channel.port2]);
    return transport;
  }

  function onBrowserConnection(listener) {
    if (browserConnection) throw new Error("The Safari kernel browser listener is already registered.");
    browserConnection = listener;
    root.window.addEventListener("message", event => {
      if (!event.isTrusted || event.data?.type !== "chatgpt-safari:kernel-browser" || event.ports.length !== 1) return;
      const port = event.ports[0];
      let frame;
      try {
        const expected = new URL(root.chrome.runtime.getURL("js-kernel-host.html"));
        const origin = new URL(event.origin);
        if (origin.protocol !== expected.protocol || origin.host.toLowerCase() !== expected.host.toLowerCase()) throw new Error();
        frame = [...(hostDocument?.frame.contentDocument?.querySelectorAll("iframe") || [])].find(item => item.contentWindow === event.source);
        const url = new URL(frame?.src);
        if (url.protocol !== expected.protocol || url.host.toLowerCase() !== expected.host.toLowerCase()
          || url.pathname !== expected.pathname || !event.data.scopeId || url.searchParams.get("scopeId") !== event.data.scopeId) throw new Error();
      } catch { port.postMessage({ type: "close" }); port.close(); return; }
      const state = hostDocument, transport = portTransport(port);
      state.connections.add(transport);
      transport.addCloseListener(() => state.connections.delete(transport));
      status.connections++;
      listener(event.data.scopeId, transport);
    });
  }

  async function sendRequest(request) {
    status.requests++;
    await ensureHostDocument();
    const state = hostDocument, target = state.frame.contentWindow;
    if (!target) throw new Error("The Safari agent host document is unavailable.");
    // Safari treats an iframe in its persistent background as the same message
    // context: runtime.sendMessage does not deliver to this replacement for
    // Chrome's offscreen document. Use the original protocol over a real port.
    const channel = new root.MessageChannel();
    return new Promise((resolve, reject) => {
      let closed = false;
      const close = () => { closed = true; state.requests.delete(failed); channel.port1.close(); channel.port2.close(); };
      const failed = error => { if (closed) return; status.phase = "failed"; status.failures++; close(); reject(error); };
      state.requests.add(failed);
      channel.port1.onmessage = event => {
        if (closed) return;
        if (event.data?.type === "chatgpt-safari:kernel-progress" && event.data.phase === "received") {
          status.phase = "executing"; return;
        }
        status.replies++; status.phase = event.data?.ok === true ? "ready" : "failed";
        if (event.data?.ok !== true) status.failures++;
        close(); resolve(event.data);
      };
      channel.port1.onmessageerror = () => failed(new Error("The Safari agent host returned unreadable data."));
      try { status.phase = "sent"; target.postMessage(request, "*", [channel.port2]); }
      catch (error) { failed(error); }
    });
  }

  const bridge = Object.freeze({ dispatch, ensureHostDocument, sendRequest, sandboxURL, connectBrowser, onBrowserConnection,
    status: () => ({ ...status }) });
  if (typeof module !== "undefined" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariAgentKernel", { value: bridge });
})(globalThis);
