/* Ask the background to initialize the exact, extension-owned ChatGPT frame. */
(() => {
  if (window.top === window || new URL(location.href).searchParams.get("surface") !== "browser_side_chat") return;
  const api = globalThis.browser || globalThis.chrome;
  api.runtime.sendMessage({ type: "chatgpt-safari:prepare-sidechat" }).then(result => {
    if (result?.ok !== true) throw new Error(result?.error || "The ChatGPT frame was not initialized");
  }).catch(error => console.error("ChatGPT Safari frame initialization failed", error));
})();
