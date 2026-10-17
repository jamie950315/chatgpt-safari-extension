/* Original agent commands use the same ordinary-profile native backend as live
 * desktop control. This module has no MCP transport and never starts a driver. */
(function (root) {
  "use strict";
  const supported = new Set(["dom_cua_get_visible_dom", "dom_cua_click", "dom_cua_type", "dom_cua_keypress", "dom_cua_scroll",
    "navigate_tab_url", "navigate_tab_back", "navigate_tab_forward", "navigate_tab_reload", "close_tab",
    "browser_management_call", "browser_management_get_audit_trail", "safari_download_inspect", "dom_cua_download_media"]);
  function createAgent(api, companion) {
    const snapshots = new Map();
    const turnOwners = new Map();
    const management = root.ChatGPTSafariManagement?.createManagement(api, companion);
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
        DELETE: "Delete", SPACE: "Space", ARROWLEFT: "ArrowLeft", LEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", RIGHT: "ArrowRight",
        ARROWUP: "ArrowUp", UP: "ArrowUp", ARROWDOWN: "ArrowDown", DOWN: "ArrowDown", HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown" };
      const normalized = keys.map(key => key.toUpperCase());
      if (normalized.length === 2 && normalized.includes("SHIFT") && normalized.includes("TAB")) return "Shift+Tab";
      if (normalized.length === 1 && names[normalized[0]]) return names[normalized[0]];
      throw new Error("Safari supports page editing/navigation keys here, not application shortcuts");
    }
    async function authorize(session, metadata) {
      if (typeof metadata?.session_id !== "string" || typeof metadata.turn_id !== "string"
        || session.currentTurnId !== metadata.turn_id) throw new Error("The Safari agent turn is no longer active");
      const owner = await companion.agentOwner();
      const key = turnKey(metadata), previous = turnOwners.get(key);
      if (previous && previous !== owner.instanceId) throw new Error("The Safari sidebar owner changed during this agent turn. Start a new turn before using another sidebar owner");
      turnOwners.set(key, owner.instanceId);
      return owner;
    }
    async function execute(command, session, metadata) {
      if (!command || !supported.has(command.type)) throw new Error("This agent command is not implemented by the Safari native backend");
      const owner = await authorize(session, metadata);
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
          // Original RPC serializes message only. Preserve uncertainty there.
          throw new Error(`${error.message}. Completed steps: ${completed}. Input was not retried. Read the current visible DOM before deciding the next action; do not repeat a possibly delivered input.`);
        }
      };
      if (command.type === "dom_cua_get_visible_dom") {
        const page = await run("read_page", { maxLength: 60000 });
        const snapshot = retain(key, page, owner, true);
        const nodes = page.nodes.map(item => `[${virtual(snapshot, item.node)}] ${item.role || item.tag} ${JSON.stringify(item.label)}${item.disabled ? " (disabled)" : ""}`);
        return `URL: ${page.url}\nTitle: ${page.title}\n${page.text}\n\nVisible controls:\n${nodes.join("\n")}\n\nNode IDs belong to this document snapshot. Read visible DOM again after an interaction before using another node ID.`;
      }
      if (command.type.startsWith("navigate_tab_") || command.type === "close_tab") {
        const tab = await api.tabs.get(tabId);
        snapshots.delete(key);
        const args = { expectedUrl: tab.url };
        const result = command.type === "navigate_tab_url" ? await run("navigate", { ...args, url: command.url })
          : command.type === "close_tab" ? await run("close_tab", args)
          : await run("history", { ...args, direction: command.type.slice("navigate_tab_".length) });
        if (result?.status === "loading") throw new Error("Safari accepted the navigation and the page is still loading. Read the current page; do not repeat the navigation");
        return {};
      }
      const snapshot = snapshots.get(key);
      if (!snapshot || snapshot.owner !== owner.instanceId) throw new Error("Read the current visible DOM before interacting with this Safari tab");
      const { page } = snapshot;
      if (command.type === "safari_download_inspect" || command.type === "dom_cua_download_media") {
        const node = snapshot.nodes.get(command.node_id);
        if (!node) throw new Error("Read the current visible DOM before choosing a download link");
        const result = await run(command.type === "safari_download_inspect" ? "download_link_inspect" : "download_link", {
          expectedUrl: page.url, documentId: page.documentId, snapshotId: page.snapshotId, node,
          ...(command.type === "dom_cua_download_media" ? { href: command.href } : {}),
        });
        return command.type === "safari_download_inspect" ? result : {};
      }
      let interaction;
      if (command.type === "dom_cua_click" || (command.type === "dom_cua_scroll" && command.node_id != null)) {
        const node = snapshot.nodes.get(command.node_id);
        if (!node) throw new Error("This visible DOM node belongs to an earlier snapshot. Read the visible DOM again before clicking or scrolling");
        interaction = command.type === "dom_cua_click" ? { type: "click", node }
          : { type: "scroll", node, deltaX: command.scroll_x, deltaY: command.scroll_y };
      } else if (command.type === "dom_cua_scroll") {
        interaction = { type: "scroll", deltaX: command.scroll_x, deltaY: command.scroll_y };
      } else {
        if (!page.focusedNode) throw new Error("No page control has keyboard focus. Click the intended control before typing or pressing a key");
        interaction = command.type === "dom_cua_type" ? { type: "type", node: page.focusedNode, value: command.text, requireFocused: true }
          : { type: "key", node: page.focusedNode, key: keyboard(command.keys) };
      }
      const result = await run("interact", { documentId: page.documentId, snapshotId: page.snapshotId, interactions: [interaction] });
      retain(key, result.page, owner);
      if (result.pagePending) throw new Error("The native input was delivered and the page is loading. Read the current page; do not repeat the input");
      return {};
    }
    function release(sessionId, turnId) {
      if (turnId == null) management?.release(sessionId);
      for (const key of snapshots.keys()) {
        const [session, turn] = JSON.parse(key);
        if (session === sessionId && (turnId == null || turn === turnId)) snapshots.delete(key);
      }
      for (const key of turnOwners.keys()) {
        const [session, turn] = JSON.parse(key);
        if (session === sessionId && (turnId == null || turn === turnId)) turnOwners.delete(key);
      }
    }
    return { execute, authorize, release, supported };
  }
  if (typeof module === "object" && module.exports) module.exports = { createAgent, supported };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariAgent = createAgent(api, root.ChatGPTSafariSidebarOptions.companion);
})(globalThis);
