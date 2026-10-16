/* Extension-owned navigation keeps diagnostics out of ordinary website origins. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "chatgpt-safari:transport-status" && sender.id === api.runtime.id
      && sender.url === api.runtime.getURL("diagnostics.html")) {
      respond({ manager: globalThis.ChatGPTSafariNativeManager?.getStatus(), transport: globalThis.ChatGPTSafariNativeTransportStatus });
      return false;
    }
    if (message?.type !== "chatgpt-safari:open-diagnostics" || sender.id !== api.runtime.id
      || sender.tab?.id == null || sender.frameId !== 0) return false;
    api.tabs.create({ url: api.runtime.getURL("diagnostics.html") })
      .then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
