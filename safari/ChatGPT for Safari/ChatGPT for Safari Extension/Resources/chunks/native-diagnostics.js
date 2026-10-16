const runtime = browser.runtime;
const result = document.querySelector("#result");
const refresh = async () => {
  const status = await runtime.sendMessage({ type: "chatgpt-safari:transport-status" });
  document.querySelector("#background").textContent = JSON.stringify(status, null, 2);
};
document.querySelector("#refresh").addEventListener("click", () => refresh().catch(console.error));
refresh().catch(console.error);
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
