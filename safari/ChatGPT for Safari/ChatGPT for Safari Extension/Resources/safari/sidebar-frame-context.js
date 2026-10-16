/* Load the original side-chat UI only after validating its Safari owner. */
const api = globalThis.browser || globalThis.chrome;
const prefix = "chatgpt-safari-sidebar:";

async function owningTab() {
  if (!window.name.startsWith(prefix)) throw new Error("The ChatGPT sidebar has no Safari owner");
  let context;
  try { context = JSON.parse(window.name.slice(prefix.length)); }
  catch { throw new Error("The ChatGPT sidebar owner is invalid"); }
  window.name = "";
  if (context?.version !== 1 || !Number.isSafeInteger(context.tabId)
    || !Number.isSafeInteger(context.windowId) || typeof context.instanceId !== "string") {
    throw new Error("The ChatGPT sidebar owner is invalid");
  }
  const result = await api.runtime.sendMessage({
    type: prefix + "authorize-frame",
    tabId: context.tabId,
    windowId: context.windowId,
    instanceId: context.instanceId,
  });
  if (result?.ok !== true || result.tab?.id !== context.tabId || result.tab.windowId !== context.windowId) {
    throw new Error(result?.error || "The ChatGPT sidebar is no longer active");
  }
  return { context, tab: result.tab };
}

try {
  const { context, tab } = await owningTab();
  const invoke = async (operation, payload = {}) => {
    const result = await api.runtime.sendMessage({
      ...context, type: prefix + "operation", operation, payload,
    });
    if (result?.ok !== true) throw new Error(result?.error || "The Safari sidebar operation failed");
    return result.value;
  };
  globalThis.ChatGPTSafariSidebarFrame = Object.freeze({
    owningTabPromise: Promise.resolve([tab]),
    executeSelection: request => invoke("selection", request),
    getUserSettings: () => invoke("getUserSettings"),
    getCommands: () => invoke("getCommands"),
    tabs: Object.freeze({
      get: tabId => invoke("getOwner", { tabId }),
      create: options => invoke("createTab", options),
      update: (tabId, options) => invoke("focusOwner", { tabId, options }),
      remove: tabId => invoke("closeMedia", { tabId }),
    }),
  });
  await import("../chunks/codex-work-sidepanel-16q48QQM.js");
} catch (error) {
  const container = document.querySelector("#work-sidepanel-frame-container");
  if (container) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = error.message;
    container.replaceChildren(message);
  }
  console.error("ChatGPT Safari sidebar failed to initialize", error);
}
