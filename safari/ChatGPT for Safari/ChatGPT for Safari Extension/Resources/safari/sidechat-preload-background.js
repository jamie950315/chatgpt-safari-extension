/* Safari supplies the exact extension origin to the MAIN world explicitly. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  function initializeFrame(origin, expectedUrl) {
    if (location.href !== expectedUrl || location.origin !== "https://chatgpt.com"
      || location.ancestorOrigins?.[0] !== origin) {
      throw new Error("The ChatGPT frame is not owned by this Safari extension");
    }
    if (window.__CODEX_BROWSER_SIDE_CHAT__ === true) return;
    Object.defineProperty(window, "__CODEX_BROWSER_SIDE_CHAT__", { value: true });
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") return;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const audio = !!constraints?.audio;
      const video = !!constraints?.video;
      if (!audio && !video) return getUserMedia(constraints);
      const permissions = await Promise.all([
        ...(audio ? ["microphone"] : []), ...(video ? ["camera"] : []),
      ].map(name => navigator.permissions.query({ name })));
      if (permissions.some(permission => permission.state === "prompt")) {
        const granted = Promise.all(permissions.filter(permission => permission.state === "prompt")
          .map(permission => new Promise((resolve, reject) => {
            permission.addEventListener("change", () => {
              if (permission.state === "granted") resolve();
              else reject(new DOMException("Media permission was not granted", "NotAllowedError"));
            }, { once: true });
          })));
        window.parent.postMessage({ type: "browser_side_chat_media_permission_request", audio, video }, origin);
        await granted;
      }
      return getUserMedia(constraints);
    };
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "chatgpt-safari:prepare-sidechat") return false;
    let url;
    try { url = new URL(sender.url); } catch { return false; }
    if (sender.id !== api.runtime.id || sender.tab?.id == null || !(sender.frameId > 0)
      || url.origin !== "https://chatgpt.com" || url.searchParams.get("surface") !== "browser_side_chat") return false;
    const extension = new URL(api.runtime.getURL("/"));
    api.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      world: "MAIN", func: initializeFrame,
      args: [extension.protocol + "//" + extension.host, sender.url],
    }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
