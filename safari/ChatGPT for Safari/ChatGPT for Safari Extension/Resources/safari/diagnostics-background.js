/* Extension-owned navigation keeps diagnostics out of ordinary website origins. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (["chatgpt-safari:notification-status", "chatgpt-safari:notification-request-permission"].includes(message?.type)) {
      if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("diagnostics.html")) return false;
      const notifications = globalThis.ChatGPTSafariNotifications;
      if (!notifications) {
        respond({ ok: false, error: { code: "NOTIFICATIONS_UNAVAILABLE", message: "The app notification service is unavailable. Open the signed-in ChatGPT sidebar and try again." } });
        return false;
      }
      const operation = message.type === "chatgpt-safari:notification-status" ? "status" : "requestPermission";
      Promise.resolve().then(() => notifications[operation]()).then(
        result => respond({ ok: true, result }),
        error => respond({ ok: false, error: { code: error.code || "NOTIFICATION_FAILED", message: error.message } }),
      );
      return true;
    }
    if (message?.type === "chatgpt-safari:transport-status" && sender.id === api.runtime.id
      && sender.url === api.runtime.getURL("diagnostics.html")) {
      const methods = { captureVisibleTab: api.tabs?.captureVisibleTab, createWindow: api.windows?.create,
        moveTab: api.tabs?.move, frames: api.webNavigation?.getAllFrames,
        nativeBookmarks: api.bookmarks?.getTree, nativeHistory: api.history?.search,
        notifications: api.notifications?.create, recentlyClosed: api.sessions?.getRecentlyClosed,
        topSites: api.topSites?.get };
      respond({ manager: globalThis.ChatGPTSafariNativeManager?.getStatus(), transport: globalThis.ChatGPTSafariNativeTransportStatus,
        safariAPIs: Object.fromEntries(Object.entries(methods).map(([name, value]) => [name, typeof value === "function"])) });
      return false;
    }
    if (message?.type !== "chatgpt-safari:open-diagnostics" || sender.id !== api.runtime.id
      || sender.tab?.id == null || sender.frameId !== 0) return false;
    api.tabs.create({ url: api.runtime.getURL("diagnostics.html") })
      .then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
