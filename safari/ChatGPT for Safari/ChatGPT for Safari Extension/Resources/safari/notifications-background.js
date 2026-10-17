/* App notifications use the signed-in native owner, never a website-supplied icon or action. */
(function (root) {
  "use strict";
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const authorizations = new Set(["not_determined", "denied", "authorized", "provisional", "unknown"]);
  function createNotifications(api, companion) {
    async function execute(operation, request) {
      const content = {};
      if (operation === "create") {
        if (!record(request) || typeof request.title !== "string" || !request.title.trim()
          || request.title.length > 200 || request.title.includes("\0") || typeof request.message !== "string"
          || request.message.length > 4000 || request.message.includes("\0")) {
          throw new TypeError("A notification needs a nonempty title of at most 200 UTF-16 units and a message of at most 4000 UTF-16 units, without null characters");
        }
        content.title = request.title;
        content.message = request.message;
      }
      let owner;
      try { owner = await companion.agentOwner(); }
      catch {
        throw Object.assign(new Error("Open the ChatGPT sidebar in an ordinary Safari tab and sign in before managing app notifications."), { code: "NOTIFICATION_OWNER_REQUIRED" });
      }
      if (typeof owner.accountScope !== "string" || !owner.accountScope || owner.accountScope.length > 128) {
        throw Object.assign(new Error("The verified ChatGPT account scope is unavailable for notifications. Open the signed-in ChatGPT sidebar and try again."), { code: "NOTIFICATION_OWNER_REQUIRED" });
      }
      let response;
      try {
        response = await api.runtime.sendNativeMessage("dev.jamie.chatgpt-safari", { operation: "companion", command: {
          action: "personalData", ownerToken: owner.instanceId, profileId: owner.profileId,
          command: { action: "notification", profileId: owner.profileId,
            ...(operation === "create" ? {} : { operation }), ...content },
        } });
      } catch (error) {
        if (operation !== "status") {
          error.message += ". The native notification or permission request may already have completed; do not repeat it.";
          error.doNotReplay = true;
        }
        throw error;
      }
      let current;
      try { current = await companion.agentOwner(); } catch { /* Treat a closed or signed-out owner exactly like a changed one. */ }
      if (!current || current.instanceId !== owner.instanceId || current.profileId !== owner.profileId || current.accountScope !== owner.accountScope) {
        const error = new Error("The signed-in sidebar owner changed during the notification operation. A notification or permission request may already have completed; do not repeat it.");
        error.code = "STALE_NOTIFICATION_OWNER";
        error.doNotReplay = operation !== "status";
        throw error;
      }
      if (response?.ok !== true) {
        const error = new Error(response?.error?.message || "The macOS notification operation failed");
        error.code = response?.error?.code;
        error.data = response?.error?.data;
        if (error.data?.doNotReplay === true) error.doNotReplay = true;
        throw error;
      }
      const result = response.result;
      if (operation === "create") {
        if (!record(result) || typeof result.id !== "string" || !/^chatgpt-safari-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(result.id)
          || result.status !== "scheduled" || !["authorized", "provisional"].includes(result.authorization)) {
          throw Object.assign(new Error("The native notification result is invalid and scheduling was not confirmed; do not repeat a possibly completed request."),
            { code: "NOTIFICATION_RESULT_UNCONFIRMED", doNotReplay: true });
        }
        return result.id;
      }
      if (!record(result) || !authorizations.has(result.authorization)) throw new Error("The native notification result is invalid");
      if (typeof result.alertsEnabled !== "boolean" || typeof result.notificationCenterEnabled !== "boolean"
        || result.permissionRequestAvailable !== (result.authorization === "not_determined")
        || (operation === "requestPermission" && result.granted !== ["authorized", "provisional"].includes(result.authorization))) {
        throw new Error("The native notification permission result is invalid");
      }
      return result;
    }
    return Object.freeze({ create: request => execute("create", request), status: () => execute("status"),
      requestPermission: () => execute("requestPermission") });
  }
  if (typeof module === "object" && module.exports) module.exports = { createNotifications };
  const api = root.browser || root.chrome;
  if (api?.runtime?.id) root.ChatGPTSafariNotifications = createNotifications(api, root.ChatGPTSafariSidebarOptions.companion);
})(globalThis);
