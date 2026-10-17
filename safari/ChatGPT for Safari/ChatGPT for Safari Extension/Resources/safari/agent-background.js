/* Original agent commands use the same ordinary-profile native backend as live
 * desktop control. This module has no MCP transport and never starts a driver. */
(function (root) {
  "use strict";
  const supported = new Set(["dom_cua_get_visible_dom", "dom_cua_click", "dom_cua_double_click", "dom_cua_type", "dom_cua_keypress", "dom_cua_scroll",
    "navigate_tab_url", "navigate_tab_back", "navigate_tab_forward", "navigate_tab_reload", "close_tab",
    "browser_management_call", "browser_management_get_audit_trail", "safari_download_inspect", "dom_cua_download_media",
    "browser_viewport_set", "browser_viewport_reset",
    "tab_screenshot", "tab_get_js_dialog", "tab_handle_js_dialog", "tab_clipboard_read", "tab_clipboard_read_text", "tab_clipboard_write", "tab_clipboard_write_text",
    "safari_logs_start", "tab_dev_logs",
    "tab_page_assets_list", "tab_page_assets_bundle", "safari_assets_inspect",
    "cua_click", "cua_double_click", "cua_drag", "cua_move", "cua_keypress", "cua_scroll", "cua_type", "cua_download_media",
    "playwright_dom_snapshot", "playwright_locator_click", "playwright_locator_dblclick", "playwright_locator_fill",
    "playwright_locator_count", "playwright_locator_is_enabled", "playwright_locator_is_visible", "playwright_locator_press",
    "playwright_locator_get_attribute", "playwright_locator_inner_text", "playwright_locator_all_text_contents",
    "playwright_locator_press_sequentially", "playwright_locator_set_checked", "playwright_locator_text_content",
    "playwright_locator_read_all", "playwright_locator_wait_for", "playwright_locator_select_option", "playwright_wait_for_load_state",
    "playwright_wait_for_timeout", "playwright_wait_for_url", "playwright_locator_download_media",
    "playwright_wait_for_file_chooser", "playwright_file_chooser_set_files", "safari_file_chooser_inspect", "safari_native_upload_inspect",
    "tab_content_export_gsuite", "tab_content_export_youtube_transcript", "safari_content_export_inspect"]);
  function createAgent(api, companion) {
    const snapshots = new Map();
    const turnOwners = new Map();
    const clipboards = new Map();
    const logLeases = new Map();
    const fileChooserWaiters = new Map(), fileChoosers = new Map();
    const management = root.ChatGPTSafariManagement?.createManagement(api, companion);
    const viewport = root.ChatGPTSafariViewport?.createViewport(api, companion);
    let generation = 0;
    const scopeKey = (metadata, tabId) => JSON.stringify([metadata.session_id, metadata.turn_id, tabId]);
    const turnKey = metadata => JSON.stringify([metadata.session_id, metadata.turn_id]);
    const virtual = (snapshot, node) => `d${snapshot.generation}_${node}`;
    function retain(key, page, owner, expose = false) {
      if (!page?.documentId || !page?.snapshotId) { snapshots.delete(key); return; }
      const snapshot = { page, owner: owner.instanceId, generation: ++generation, nodes: new Map() };
      if (expose) for (const item of page.nodes || []) snapshot.nodes.set(virtual(snapshot, item.node), item.node);
      snapshots.set(key, snapshot);
      return snapshot;
    }
    function keyboard(keys) {
      if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error("A page key array is required");
      const names = { ENTER: "Enter", RETURN: "Enter", TAB: "Tab", ESC: "Escape", ESCAPE: "Escape", BACKSPACE: "Backspace",
        DELETE: "Delete", INSERT: "Insert", SPACE: "Space", ARROWLEFT: "ArrowLeft", LEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", RIGHT: "ArrowRight",
        ARROWUP: "ArrowUp", UP: "ArrowUp", ARROWDOWN: "ArrowDown", DOWN: "ArrowDown", HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown" };
      if (keys.length === 1 && keys[0].includes("+")) keys = keys[0].split("+");
      const modifiers = { CMD: "Meta", COMMAND: "Meta", META: "Meta", SUPER: "Meta", CONTROLORMETA: "Meta",
        CTRL: "Meta", CONTROL: "Control", ALT: "Alt", OPTION: "Alt", SHIFT: "Shift" };
      const normalized = keys.map(key => modifiers[key.toUpperCase()] || names[key.toUpperCase()] ||
        (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key) ? key.toUpperCase() : key.length === 1 ? key : null));
      const regular = normalized.filter(key => key && !["Meta", "Control", "Alt", "Shift"].includes(key));
      if (normalized.some(key => !key) || regular.length !== 1 || normalized.length > 5 || new Set(normalized).size !== normalized.length) {
        throw new Error("A key combination requires one page key and optional Meta, Control, Alt, and Shift modifiers");
      }
      return [...normalized.filter(key => key !== regular[0]), regular[0]].join("+");
    }
    async function authorize(session, metadata) {
      if (typeof metadata?.session_id !== "string" || typeof metadata.turn_id !== "string"
        || session.currentTurnId !== metadata.turn_id) throw new Error("The Safari agent turn is no longer active");
      const owner = await companion.agentOwner();
      if (![owner.instanceId, owner.profileId, owner.accountScope].every(value => typeof value === "string" && value.length > 0)) throw new Error("A current Safari sidebar, profile, and signed-in ChatGPT account scope are required");
      const key = turnKey(metadata), previous = turnOwners.get(key);
      const identity = JSON.stringify([owner.instanceId, owner.profileId, owner.accountScope]);
      if (previous && previous !== identity) {
        await release(metadata.session_id, undefined, true);
        throw new Error("The Safari sidebar owner changed, including its profile or ChatGPT account, during this agent turn. Start a new turn before using another sidebar owner");
      }
      turnOwners.set(key, identity);
      return owner;
    }
    async function execute(command, session, metadata) {
      if (!command || !supported.has(command.type)) throw new Error("This agent command is not implemented by the Safari native backend");
      const owner = await authorize(session, metadata);
      if (command.type.startsWith("browser_viewport_")) {
        if (!viewport) throw new Error("Safari's measured native viewport capability is unavailable");
        return viewport.execute(command, session, metadata, owner, () => authorize(session, metadata));
      }
      if (command.type.startsWith("browser_management_")) {
        if (!management) throw new Error("Safari browser management is unavailable");
        return management.execute(command, session, metadata, owner, () => authorize(session, metadata));
      }
      const tabId = Number(command.tab_id);
      if (!Number.isSafeInteger(tabId) || tabId <= 0 || String(tabId) !== command.tab_id) throw new Error("A real Safari tab ID is required");
      await session.requireOwnedTab(tabId);
      const handle = `live:${owner.profileId}:${tabId}`;
      const key = scopeKey(metadata, tabId);
      const run = async (action, args) => {
        if (session.currentTurnId !== metadata.turn_id) throw new Error("The Safari agent turn ended before delivery");
        await session.requireOwnedTab(tabId);
        try { return await companion.runAgentCommand({ action, arguments: { ...args, handle } }, owner); }
        catch (error) {
          snapshots.delete(key);
          const completed = error.data?.completed?.length || 0;
          const modalOutcome = args.nativeModal ? ` Native modal events posted: ${Number.isSafeInteger(error.data?.eventsPosted) ? error.data.eventsPosted : "unknown"}; mutation or response may be partial.` : "";
          // Original RPC serializes message only. Preserve uncertainty there.
          throw new Error(`${error.message}.${modalOutcome} Completed steps: ${completed}. Input was not retried. Read the current visible DOM before deciding the next action; do not repeat a possibly delivered input.`);
        }
      };
      const query = type => run("dom_query", { command: { ...command, ...(type ? { type } : {}) } });
      if (["tab_content_export_gsuite", "tab_content_export_youtube_transcript", "safari_content_export_inspect"].includes(command.type)) {
        const type = command.type === "safari_content_export_inspect" ? command.exportType : command.type;
        if (!["tab_content_export_gsuite", "tab_content_export_youtube_transcript"].includes(type)) throw new Error("This Safari content export is unsupported");
        const args = { kind: type === "tab_content_export_gsuite" ? "gsuite" : "youtube", format: command.format,
          scope: JSON.stringify([metadata.session_id, metadata.turn_id, owner.instanceId, owner.profileId, owner.accountScope]) };
        if (command.type === "safari_content_export_inspect") return run("dom_query", { command: { type: command.type, ...args } });
        if (!/^[a-f0-9]{32}$/.test(command.exportId || "")) throw new Error("Inspect and approve this exact content export before starting it");
        return run("content_export", { ...args, exportId: command.exportId });
      }
      const agentScope = { ownerId: owner.instanceId, sessionId: metadata.session_id, turnId: metadata.turn_id };
      const interact = async (target, interactions, nativeModal) => {
        try {
          const result = await run("interact", { documentId: target.documentId, snapshotId: target.snapshotId, interactions, agentScope,
            fileChooserScope: { profileId: owner.profileId, tabId: String(tabId), documentId: target.documentId, ...agentScope },
            ...(target.frameId ? { frameId: target.frameId, framePath: target.framePath } : {}),
            ...(interactions.some(item => item.type === "clipboard") ? { expectedUrl: target.url,
              agentScope: { ...agentScope, accountScope: owner.accountScope } } : {}),
            ...(nativeModal ? { nativeModal, expectedUrl: target.url, agentScope: { ...agentScope, accountScope: owner.accountScope },
              ...(nativeModal.kind === "upload" ? { uploadSource: { node: target.node, isMultiple: target.isMultiple } } : {}) } : {}) });
          if (result.fileChooserOpen) {
            const waiter = fileChooserWaiters.get(key);
            if (result.fileChooser?.id && typeof result.fileChooser.isMultiple === "boolean") {
              fileChoosers.set(key, { ...result.fileChooser, owner: owner.instanceId });
              waiter?.resolve({ file_chooser_id: result.fileChooser.id, is_multiple: result.fileChooser.isMultiple });
            } else waiter?.reject(new Error(result.fileChooserError || "Safari opened a file chooser without a verified source file input. Cancel that chooser; the click was not repeated"));
          }
          for (const step of result.completed || []) if (step.type === "clipboard") {
            const observed = step.result?.nativeClipboard;
            if (!observed?.nativeKeyDelivered || observed.trustedPageReceipt !== true || !["restored", "unchanged", "newer-change-preserved"].includes(observed.clipboardRestoration)) {
              throw new Error("The native clipboard shortcut or user clipboard restoration is unconfirmed. Do not replay the delivered shortcut");
            }
            if (["copy", "cut"].includes(observed.operation)) {
              await authorize(session, metadata);
              if (!Array.isArray(observed.items)) throw new Error("Safari returned no verified native clipboard items after the delivered shortcut");
              clipboards.set(clipboardKey, structuredClone(observed.items));
            }
          }
          return result;
        } catch (error) { fileChooserWaiters.get(key)?.reject(error); throw error; }
      };
      if (command.type === "safari_native_upload_inspect") {
        if (typeof command.selector !== "string" || !command.selector) throw new Error("An exact native upload source selector is required");
        return query("safari_native_upload_inspect");
      }
      if (command.type === "playwright_wait_for_file_chooser") {
        if (fileChooserWaiters.has(key)) throw new Error("A file chooser waiter is already registered for this claimed tab and turn");
        const timeout = command.timeout_ms ?? 30000;
        if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 120000) throw new Error("File chooser timeout must be between 1 and 120000 milliseconds");
        // Register locally before the click. Holding an ordinary live-broker
        // command while waiting would prevent the opening click from running.
        return new Promise((resolve, reject) => {
          let timer;
          const settle = callback => value => { clearTimeout(timer); fileChooserWaiters.delete(key); callback(value); };
          const waiter = { owner: owner.instanceId, resolve: settle(resolve), reject: settle(reject) };
          fileChooserWaiters.set(key, waiter);
          timer = setTimeout(() => waiter.reject(new Error(`Timed out after ${timeout}ms waiting for a Safari file chooser`)), timeout);
        });
      }
      if (["safari_file_chooser_inspect", "playwright_file_chooser_set_files"].includes(command.type)) {
        const chooser = fileChoosers.get(key);
        if (!chooser || chooser.owner !== owner.instanceId || chooser.id !== command.file_chooser_id) throw new Error("Unknown or stale Safari file chooser for this claimed tab and turn");
        if (!Array.isArray(command.files) || !command.files.length || command.files.some(path => typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))) throw new Error("fileChooser.setFiles requires at least one explicit absolute local file path");
        if (!chooser.isMultiple && command.files.length > 1) throw new Error("File chooser does not accept multiple files");
        if (command.type === "safari_file_chooser_inspect") return {};
        fileChoosers.delete(key);
        await run("filechooser", { operation: "setFiles", chooserId: chooser.id, scope: chooser.scope, files: command.files, agentScope }); return {};
      }
      const clipboardKey = JSON.stringify([metadata.session_id, owner.instanceId, owner.profileId, owner.accountScope]);
      const pageKey = async (keypress, node) => {
        const tokens = keypress.split("+"), base = tokens.pop(), modifiers = new Set(tokens);
        let action;
        if (modifiers.size === 1 && base === "Insert" && modifiers.has("Control")) action = "copy";
        if (modifiers.size === 1 && base === "Insert" && modifiers.has("Shift")) action = "paste";
        if (modifiers.size === 1 && base === "Delete" && modifiers.has("Shift")) action = "cut";
        const primary = (modifiers.has("Meta") || modifiers.has("Control")) && !(modifiers.has("Meta") && modifiers.has("Control"));
        if (primary && (modifiers.size === 1 || modifiers.size === 2 && modifiers.has("Shift"))) {
          if (/^c$/i.test(base) && !modifiers.has("Shift")) action = "copy";
          if (/^x$/i.test(base) && !modifiers.has("Shift")) action = "cut";
          if (/^v$/i.test(base)) action = modifiers.has("Shift") ? "paste-plain-text" : "paste";
        }
        const permittedShiftShortcut = /^[cx]$/i.test(base) && modifiers.size === 2 && modifiers.has("Shift") && primary;
        if (!action && !permittedShiftShortcut && ((/^[cxv]$/i.test(base) && (modifiers.has("Meta") || modifiers.has("Control")))
          || base === "Insert" && (modifiers.has("Control") || modifiers.has("Shift")) || base === "Delete" && modifiers.has("Shift"))) {
          throw new Error("Native clipboard shortcuts are disabled; use the browser session's virtual clipboard");
        }
        if (!action) return { type: "key", node, key: keypress };
        if (action.startsWith("paste")) {
          let items = clipboards.get(clipboardKey) || [];
          if (action === "paste-plain-text") items = items.map(item => ({ ...item, entries: item.entries.filter(entry => entry.mime_type === "text/plain") })).filter(item => item.entries.length);
          if (!items.length) return null;
          if (items.some(item => item.entries.some(entry => entry.mime_type !== "text/plain"))) return { type: "clipboard", node, operation: "paste", items: structuredClone(items) };
          const text = items.flatMap(item => item.entries).find(entry => entry.mime_type === "text/plain")?.text;
          if (typeof text !== "string") throw new Error("The session clipboard contains no plain-text payload to paste through native input");
          return { type: "type", node, value: text, requireFocused: true };
        }
        return { type: "clipboard", node, operation: action };
      };
      const logScope = JSON.stringify([metadata.session_id, owner.instanceId, metadata.turn_id]);
      const startLogs = async () => {
        const tab = await api.tabs.get(tabId);
        if (!/^https?:\/\//i.test(tab.url || "")) return { capturing: false };
        const lease = { sessionId: metadata.session_id, turnId: metadata.turn_id, tabId, scope: logScope };
        logLeases.set(key, lease);
        try { return await run("dom_query", { command: { type: "safari_logs_start", scope: logScope } }); }
        catch (error) { lease.error = error.message; return { capturing: false }; }
      };
      if (command.type === "safari_logs_start") return startLogs();
      if (command.type === "tab_dev_logs") {
        if (!logLeases.has(key)) await startLogs();
        const lease = logLeases.get(key);
        if (!lease || lease.error) throw new Error(lease?.error || "Console capture requires a claimed HTTP/HTTPS page");
        return run("dom_query", { command: { type: "safari_logs_read", scope: logScope,
          levels: command.levels, filter: command.filter, limit: command.limit } });
      }
      if (["tab_page_assets_list", "tab_page_assets_bundle", "safari_assets_inspect"].includes(command.type)) {
        const arguments_ = { scope: logScope, inventoryId: command.inventoryId, assetIds: command.assetIds, kinds: command.kinds };
        return command.type === "tab_page_assets_bundle" ? run("asset_bundle", arguments_)
          : run("dom_query", { command: { type: command.type === "tab_page_assets_list" ? "safari_assets_list" : "safari_assets_inspect", ...arguments_ } });
      }
      if (command.type.startsWith("tab_clipboard_")) {
        const items = clipboards.get(clipboardKey) || [];
        if (command.type === "tab_clipboard_read") return { items: structuredClone(items) };
        if (command.type === "tab_clipboard_read_text") return { text: items.flatMap(x => x.entries).find(x => x.mime_type === "text/plain")?.text || "" };
        const incoming = command.type === "tab_clipboard_write_text"
          ? [{ entries: [{ mime_type: "text/plain", text: command.text }], presentation_style: "unspecified" }] : command.items;
        if (!Array.isArray(incoming) || incoming.length > 32 || JSON.stringify(incoming).length > 8 * 1024 * 1024
          || incoming.some(item => !Array.isArray(item.entries) || item.entries.some(entry => typeof entry.mime_type !== "string"
            || (typeof entry.text === "string") === (typeof entry.base64 === "string")))) throw new Error("Invalid session clipboard items");
        clipboards.set(clipboardKey, structuredClone(incoming)); return {};
      }
      if (command.type === "tab_screenshot") {
        const image = await run("screenshot", { fullPage: command.fullPage === true,
          ...(command.cropX === undefined ? {} : { clip: { x: command.cropX, y: command.cropY, width: command.cropWidth, height: command.cropHeight } }) });
        const data = image.data || image.dataUrl?.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
        if (typeof data !== "string" || !data) throw new Error("Safari returned no screenshot bytes");
        return { data };
      }
      if (command.type === "tab_get_js_dialog" || command.type === "tab_handle_js_dialog") {
        return run("dialog", { operation: command.type === "tab_get_js_dialog" ? "inspect" : command.action,
          dialogId: command.dialog_id, promptText: command.prompt_text });
      }
      if (["playwright_wait_for_timeout", "playwright_wait_for_url", "playwright_wait_for_load_state"].includes(command.type)) {
        const timeout = Math.min(command.timeout_ms ?? 10000, 30000);
        if (command.type === "playwright_wait_for_timeout") {
          if (!Number.isFinite(command.timeout_ms) || command.timeout_ms < 0 || command.timeout_ms > 30000) throw new Error("A Safari wait must be between 0 and 30000 milliseconds");
          await new Promise(resolve => setTimeout(resolve, command.timeout_ms)); await authorize(session, metadata); return {};
        }
        if (command.wait_until === "networkidle" || command.state === "networkidle") throw new Error("Safari cannot prove networkidle; use a DOM locator or URL condition instead");
        const deadline = Date.now() + timeout;
        do {
          await authorize(session, metadata); await session.requireOwnedTab(tabId);
          const tab = await api.tabs.get(tabId);
          const urlMatched = command.type !== "playwright_wait_for_url" || tab.url === command.url;
          const loaded = command.wait_until === "commit" || command.state === "commit" || tab.status === "complete";
          if (urlMatched && loaded) return { url: tab.url };
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error("Safari did not reach the requested page URL/load state before the timeout");
      }
      if (command.type.startsWith("playwright_") && !["playwright_locator_download_media"].includes(command.type)) {
        if (["playwright_dom_snapshot", "playwright_locator_count", "playwright_locator_is_enabled", "playwright_locator_is_visible",
          "playwright_locator_get_attribute", "playwright_locator_inner_text", "playwright_locator_all_text_contents", "playwright_locator_text_content",
          "playwright_locator_read_all"].includes(command.type)) return query();
        if (command.type === "playwright_locator_wait_for") {
          const deadline = Date.now() + Math.min(command.timeout_ms ?? 10000, 30000);
          do {
            if ((await query()).matched) return {};
            await new Promise(resolve => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
          throw new Error(`Safari locator did not become ${command.state || "visible"} before the timeout`);
        }
        if (command.type === "playwright_locator_set_checked") {
          const before = await query("safari_checked_read");
          if (before.checked === command.checked) return {};
          if (before.isRadio && !command.checked) throw new Error("Cannot uncheck a radio button");
        }
        let selectedOptions;
        if (command.type === "playwright_locator_select_option") {
          const observed = await query("safari_select_read");
          if (!Array.isArray(command.selections) || !command.selections.length || (!observed.multiple && command.selections.length !== 1)) throw new Error("A single-select requires exactly one option");
          const options = command.selections.map(selection => {
            const matches = observed.options.filter(option => (selection.index === undefined || selection.index === option.index)
              && (selection.label === undefined || selection.label === option.label) && (selection.value === undefined || selection.value === option.value));
            if (matches.length !== 1 || matches[0].disabled) throw new Error("The requested native option is unavailable, disabled, or ambiguous");
            return { index: matches[0].index, label: matches[0].nativeLabel };
          });
          selectedOptions = { options, multiple: observed.multiple };
        }
        let nativeModal;
        if (command.safari_native_modal !== undefined) {
          const value = command.safari_native_modal;
          if (command.type !== "playwright_locator_click" || !value || typeof value !== "object" || Array.isArray(value)
            || command.force === true || command.button && command.button !== "left" || command.modifiers?.length
            || !["dialog", "upload"].includes(value.kind) || !Number.isInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 10000) {
            throw new Error("A preregistered native modal requires one plain locator click with a 1–10000ms response deadline");
          }
          if (value.kind === "dialog") {
            if (Object.keys(value).some(key => !["kind", "timeout_ms", "type", "message", "accept", "promptText"].includes(key))
              || !["alert", "confirm", "prompt"].includes(value.type) || typeof value.message !== "string" || value.message.length > 8000
              || typeof value.accept !== "boolean" || value.type === "alert" && !value.accept
              || value.promptText !== undefined && (value.type !== "prompt" || !value.accept || typeof value.promptText !== "string" || value.promptText.length > 20000)) {
              throw new Error("Specify the exact expected dialog type/message and explicit response; promptText only applies to an accepted prompt");
            }
          } else if (Object.keys(value).some(key => !["kind", "timeout_ms", "files"].includes(key))
            || !Array.isArray(value.files) || !value.files.length || value.files.length > 128
            || value.files.some(path => typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) || !command.safari_upload_source) {
            throw new Error("Native upload needs explicit absolute files and its original consent-bound source input preflight");
          }
          nativeModal = { ...value };
        }
        let target = await query(nativeModal?.kind === "upload" ? "safari_native_upload_inspect"
          : ["playwright_locator_press", "playwright_locator_press_sequentially"].includes(command.type) ? "safari_locator_focus" : "safari_locator_prepare");
        if (nativeModal && target.frameId) throw new Error("Preregistered native modals currently require a top-level or same-origin source, not a cross-origin frame");
        if (command.type === "playwright_locator_press_sequentially") {
          if (typeof command.value !== "string") throw new Error("A string input value is required");
          const characters = Array.from(command.value), deadline = Date.now() + Math.min(command.timeout_ms ?? 5000, 5000);
          let completed = 0;
          while (completed < characters.length) {
            if (Date.now() >= deadline) throw new Error(`Sequential typing timed out after ${completed} delivered characters. Input was not repeated`);
            const batch = characters.slice(completed, completed + 20).map(value => ({ type: "type", node: target.node, value, requireFocused: true }));
            const result = await interact(target, batch);
            snapshots.delete(key);
            if (!Array.isArray(result?.completed) || result.completed.length > batch.length
              || result.completed.some(step => step.type !== "type")) {
              throw new Error("Sequential typing delivery is uncertain because the native completion record is invalid. Input was not repeated; do not repeat possibly delivered characters");
            }
            completed += result.completed.length;
            if (result.dialogOpen || result.fileChooserOpen) return {};
            if (result.pagePending) throw new Error(`Sequential typing delivered ${completed} characters and the page started loading. Do not repeat the input`);
            if (result.completed.length !== batch.length) throw new Error(`Sequential typing stopped after ${completed} confirmed characters because the native batch was incomplete. Do not repeat possibly delivered input`);
            if (completed < characters.length) target = await query("safari_locator_focus");
          }
          snapshots.delete(key); return {};
        }
        const modifierNames = command.modifiers || [];
        let interactions;
        if (["playwright_locator_click", "playwright_locator_dblclick", "playwright_locator_set_checked"].includes(command.type)) {
          interactions = [{ type: "click", node: target.node, clickCount: command.type === "playwright_locator_dblclick" ? 2 : 1,
            button: command.button || "left", modifiers: modifierNames }];
        } else if (command.type === "playwright_locator_select_option") {
          interactions = [{ type: "select", node: target.node, ...selectedOptions }];
        } else if (command.type === "playwright_locator_fill") {
          const text = command.value;
          if (typeof text !== "string") throw new Error("A string input value is required");
          interactions = [{ type: "type", node: target.node, value: text,
            replaceAll: command.type === "playwright_locator_fill" && command.replace !== false }];
        } else if (command.type === "playwright_locator_press") {
          const interaction = await pageKey(keyboard([command.value]), target.node);
          if (!interaction) return {};
          interactions = [interaction];
        } else throw new Error(`Safari does not implement ${command.type}`);
        const outcome = await interact(target, interactions, nativeModal); snapshots.delete(key);
        if (nativeModal) {
          const response = outcome.completed?.[0]?.result?.nativeModal;
          if (outcome.completed?.length !== 1 || !response?.done || response.responseVerified !== true || response.kind !== nativeModal.kind) {
            throw new Error("The native modal response is unconfirmed after a delivered click. Do not replay the input or assume a dialog response/upload succeeded");
          }
          return response;
        }
        if (outcome.dialogOpen || outcome.fileChooserOpen) return {};
        if (command.type === "playwright_locator_set_checked" && (await query("safari_checked_read")).checked !== command.checked) {
          throw new Error(`Native click did not change checked state to ${command.checked}; it was not repeated`);
        }
        if (selectedOptions) {
          const after = await query("safari_select_read");
          const selected = after.options.filter(option => option.selected).map(option => option.index).sort((a, b) => a - b);
          const wanted = [...new Set(selectedOptions.options.map(option => option.index))].sort((a, b) => a - b);
          if (JSON.stringify(selected) !== JSON.stringify(wanted)) throw new Error("The native select result did not match the requested options; selection was not repeated");
        }
        return {};
      }
      if (command.type === "dom_cua_get_visible_dom") {
        const page = await run("read_page", { maxLength: 60000 });
        const snapshot = retain(key, page, owner, true);
        const nodes = page.nodes.map(item => `[${virtual(snapshot, item.node)}] ${item.role || item.tag} ${JSON.stringify(item.label)}${item.disabled ? " (disabled)" : ""}`);
        return `URL: ${page.url}\nTitle: ${page.title}\n${page.text}\n\nVisible controls:\n${nodes.join("\n")}\n\nNode IDs belong to this document snapshot. Read visible DOM again after an interaction before using another node ID.`;
      }
      if (command.type.startsWith("navigate_tab_") || command.type === "close_tab") {
        const tab = await api.tabs.get(tabId);
        snapshots.delete(key);
        let expectedUrl = tab.url;
        if (expectedUrl == null || expectedUrl === "") {
          if (typeof root.ChatGPTSafariLive?.navigationSourceUrl !== "function") throw new Error("Safari did not expose this tab's committed URL or native navigation-source verifier. Its source was not assumed to be blank");
          expectedUrl = await root.ChatGPTSafariLive.navigationSourceUrl(tabId);
        }
        const args = { expectedUrl };
        const result = command.type === "navigate_tab_url" ? await run("navigate", { ...args, url: command.url })
          : command.type === "close_tab" ? await run("close_tab", args)
          : await run("history", { ...args, direction: command.type.slice("navigate_tab_".length) });
        if (result?.status === "loading") throw new Error("Safari accepted the navigation and the page is still loading. Read the current page; do not repeat the navigation");
        if (command.type !== "close_tab") await startLogs();
        return {};
      }
      if (command.type.startsWith("cua_") && command.type !== "cua_download_media") {
        const page = await run("read_page", { maxLength: 1000 });
        const modifiers = command.keys || [];
        let interaction;
        if (["cua_click", "cua_double_click", "cua_move", "cua_scroll"].includes(command.type)) {
          if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) throw new Error("A finite viewport point is required");
          interaction = { type: command.type === "cua_move" ? "move" : command.type === "cua_scroll" ? "scroll" : "click",
            point: { x: command.x, y: command.y }, modifiers,
            ...(command.type === "cua_scroll" ? { deltaX: command.scroll_x, deltaY: command.scroll_y }
              : command.type === "cua_move" ? {} : { clickCount: command.type === "cua_double_click" ? 2 : 1,
                button: command.button === 2 ? "right" : command.button === 1 ? "middle" : "left" }) };
        } else if (command.type === "cua_drag") {
          if (!Array.isArray(command.path) || command.path.length < 2 || command.path.length > 500
            || command.path.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("A drag requires 2–500 finite viewport points");
          interaction = { type: "drag", point: command.path[0], path: command.path, modifiers };
        } else {
          if (!page.focusedNode) throw new Error("Click a page control before keyboard input");
          interaction = command.type === "cua_type" ? { type: "type", node: page.focusedNode, value: command.text, requireFocused: true }
            : await pageKey(keyboard(command.keys), page.focusedNode);
          if (!interaction) return {};
        }
        const result = await interact(page, [interaction]); retain(key, result.page, owner); return {};
      }
      const snapshot = snapshots.get(key);
      const page = snapshot?.owner === owner.instanceId ? snapshot.page : undefined;
      if (["safari_download_inspect", "dom_cua_download_media", "playwright_locator_download_media", "cua_download_media"].includes(command.type)) {
        let target = page, node;
        if (command.sourceType === "playwright_locator_download_media" || command.type === "playwright_locator_download_media") {
          target = await query("safari_locator_prepare"); node = target.node;
        } else if (command.sourceType === "cua_download_media" || command.type === "cua_download_media") {
          target = await run("dom_query", { command: { type: "safari_point_prepare", x: command.x, y: command.y } }); node = target.node;
        } else node = snapshot?.owner === owner.instanceId ? snapshot.nodes.get(command.node_id) : undefined;
        if (!node) throw new Error("Read the current visible DOM before choosing a download link");
        const result = await run(command.type === "safari_download_inspect" ? "download_link_inspect" : "download_link", {
          expectedUrl: target.url, documentId: target.documentId, snapshotId: target.snapshotId, node,
          ...(command.type !== "safari_download_inspect" ? { href: command.href } : {}),
        });
        return command.type === "safari_download_inspect" ? result : command.type === "playwright_locator_download_media" ? { path: result.path } : {};
      }
      if (!page) throw new Error("Read the current visible DOM before interacting with this Safari tab");
      let interaction;
      if (["dom_cua_click", "dom_cua_double_click"].includes(command.type) || (command.type === "dom_cua_scroll" && command.node_id != null)) {
        const node = snapshot.nodes.get(command.node_id);
        if (!node) throw new Error("This visible DOM node belongs to an earlier snapshot. Read the visible DOM again before clicking or scrolling");
        interaction = ["dom_cua_click", "dom_cua_double_click"].includes(command.type) ? { type: "click", node, ...(command.type === "dom_cua_double_click" ? { clickCount: 2 } : {}) }
          : { type: "scroll", node, deltaX: command.scroll_x, deltaY: command.scroll_y };
      } else if (command.type === "dom_cua_scroll") {
        interaction = { type: "scroll", deltaX: command.scroll_x, deltaY: command.scroll_y };
      } else {
        if (!page.focusedNode) throw new Error("No page control has keyboard focus. Click the intended control before typing or pressing a key");
        if (command.type === "dom_cua_type") interaction = { type: "type", node: page.focusedNode, value: command.text, requireFocused: true };
        else {
          interaction = await pageKey(keyboard(command.keys), page.focusedNode);
          if (!interaction) return {};
        }
      }
      const result = await interact(page, [interaction]);
      retain(key, result.page, owner);
      if (result.pagePending) throw new Error("The native input was delivered and the page is loading. Read the current page; do not repeat the input");
      return {};
    }
    function release(sessionId, turnId, keepOwnerGuards = false) {
      root.ChatGPTSafariLive?.releaseFileChoosers({ sessionId, turnId });
      for (const [key, waiter] of fileChooserWaiters) {
        const [session, turn] = JSON.parse(key);
        if (session === sessionId && (turnId == null || turn === turnId)) waiter.reject(new Error("The file chooser waiter ended with its original sidebar session or turn"));
      }
      for (const key of fileChoosers.keys()) {
        const [session, turn] = JSON.parse(key);
        if (session === sessionId && (turnId == null || turn === turnId)) fileChoosers.delete(key);
      }
      if (turnId == null) {
        management?.release(sessionId);
        for (const key of clipboards.keys()) if (JSON.parse(key)[0] === sessionId) clipboards.delete(key);
      }
      for (const key of snapshots.keys()) {
        const [session, turn] = JSON.parse(key);
        if (session === sessionId && (turnId == null || turn === turnId)) snapshots.delete(key);
      }
      for (const key of turnOwners.keys()) {
        const [session, turn] = JSON.parse(key);
        if (!keepOwnerGuards && session === sessionId && (turnId == null || turn === turnId)) turnOwners.delete(key);
      }
      const cleanup = [];
      if (viewport) cleanup.push(viewport.release(sessionId, turnId));
      for (const [key, lease] of logLeases) if (lease.sessionId === sessionId && (turnId == null || lease.turnId === turnId)) {
        logLeases.delete(key);
        cleanup.push(root.ChatGPTSafariLive?.releaseLogs(lease.tabId, lease.scope).catch(() => {}));
      }
      return Promise.all(cleanup);
    }
    async function invalidateAll() {
      const sessions = new Set([...turnOwners.keys()].map(key => JSON.parse(key)[0]));
      await Promise.all([...sessions].map(session => release(session)));
      clipboards.clear(); snapshots.clear();
    }
    return { execute, authorize, release, invalidateAll, supported };
  }
  if (typeof module === "object" && module.exports) module.exports = { createAgent, supported };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariAgent = createAgent(api, root.ChatGPTSafariSidebarOptions.companion);
})(globalThis);
