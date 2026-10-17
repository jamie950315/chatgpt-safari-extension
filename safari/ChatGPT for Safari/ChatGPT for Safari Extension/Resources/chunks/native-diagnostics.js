const runtime = browser.runtime;
const result = document.querySelector("#result");
const refresh = async () => {
  const status = await runtime.sendMessage({ type: "chatgpt-safari:transport-status" });
  document.querySelector("#background").textContent = JSON.stringify(status, null, 2);
};
document.querySelector("#refresh").addEventListener("click", () => refresh().catch(console.error));
refresh().catch(console.error);
document.querySelector("#automation").addEventListener("click", async () => {
  const output = document.querySelector("#automation-result");
  output.textContent = "Checking…";
  try {
    const response = await runtime.sendNativeMessage("dev.jamie.chatgpt-safari", {
      operation: "companion", command: { action: "automation", command: { action: "status" } },
    });
    if (!response?.ok) throw new Error(response?.error?.message || "The Safari companion is unavailable.");
    output.textContent = JSON.stringify(response.result, null, 2);
  } catch (error) { output.textContent = error.message; }
});
document.querySelector("#test").addEventListener("click", async () => {
  let connectionId;
  const request = async message => {
    const response = await runtime.sendNativeMessage("dev.jamie.chatgpt-safari", message);
    if (!response?.ok) throw new Error(JSON.stringify(response));
    return response;
  };
  result.textContent = "Connecting…";
  try {
    ({ connectionId } = await request({ operation: "open", application: "com.openai.codexextension", origin: runtime.getURL("/") }));
    await request({ operation: "send", connectionId, message: { jsonrpc: "2.0", id: "safari-diagnostics", method: "codexRuntime/hello" } });
    const response = await request({ operation: "poll", connectionId });
    const hello = response.messages.find(message => message.id === "safari-diagnostics");
    if (hello?.result?.nativeHostProtocolVersion !== 2) throw new Error("The native host did not return the expected protocol handshake.");
    result.textContent = "OpenAI native host connected through Safari native messaging and XPC.\n\n" + JSON.stringify(hello.result, null, 2);
  } catch (error) {
    result.textContent = "Connection failed: " + error.message;
  } finally {
    if (connectionId) await request({ operation: "close", connectionId }).catch(() => {});
  }
});

const notificationRefresh = document.querySelector("#notifications-refresh");
const notificationEnable = document.querySelector("#notifications-enable");
const notificationOutput = document.querySelector("#notifications-result");
let notificationBusy = false, canRequestNotifications = false;
function notificationState(settings) {
  canRequestNotifications = settings.authorization === "not_determined" && settings.permissionRequestAvailable === true;
  switch (settings.authorization) {
  case "not_determined": return "Notifications are not enabled. Choose Enable notifications to request permission.";
  case "denied": return "Notifications are blocked. Allow ChatGPT for Safari in System Settings > Notifications, then check again.";
  case "authorized":
  case "provisional":
    if (!settings.alertsEnabled && !settings.notificationCenterEnabled) return "Alerts and Notification Center are disabled. Enable either for ChatGPT for Safari in System Settings > Notifications.";
    return settings.authorization === "provisional" ? "Notifications are allowed quietly." : "Notifications are allowed.";
  default: return "macOS did not return a supported notification permission state.";
  }
}
async function refreshNotifications(requestPermission = false) {
  if (notificationBusy || (requestPermission && !canRequestNotifications)) return;
  notificationBusy = true;
  notificationRefresh.disabled = true; notificationEnable.disabled = true;
  notificationOutput.textContent = requestPermission ? "Waiting for your choice in the macOS permission prompt…" : "Checking notification permission…";
  try {
    const response = await runtime.sendMessage({ type: requestPermission
      ? "chatgpt-safari:notification-request-permission" : "chatgpt-safari:notification-status" });
    if (!response?.ok) throw new Error(response?.error?.message || "The app notification service is unavailable. Open the signed-in ChatGPT sidebar and try again.");
    notificationOutput.textContent = notificationState(response.result);
  } catch (error) {
    canRequestNotifications = false;
    notificationOutput.textContent = error.message;
  } finally {
    notificationBusy = false;
    notificationRefresh.disabled = false; notificationEnable.disabled = !canRequestNotifications;
  }
}
notificationRefresh.addEventListener("click", () => refreshNotifications());
notificationEnable.addEventListener("click", () => refreshNotifications(true));
void refreshNotifications();
