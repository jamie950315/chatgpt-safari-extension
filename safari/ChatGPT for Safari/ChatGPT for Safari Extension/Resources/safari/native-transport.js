/* Safari's request/reply native messaging transports a persistent host via XPC. */
(() => {
  if (globalThis.location?.protocol !== "safari-web-extension:") return;
  const runtime = globalThis.chrome.runtime;
  const application = "dev.jamie.chatgpt-safari";
  const origin = runtime.getURL("/");
  const status = { state: "idle", receivedMessages: 0, sentMessages: 0 };
  globalThis.ChatGPTSafariNativeTransportStatus = status;

  function event() {
    const listeners = new Set();
    return {
      addListener: listener => listeners.add(listener),
      removeListener: listener => listeners.delete(listener),
      hasListener: listener => listeners.has(listener),
      emit: (...args) => {
        for (const listener of [...listeners]) {
          try { listener(...args); } catch (error) { console.error(error); }
        }
      },
    };
  }

  async function request(message) {
    const response = await runtime.sendNativeMessage(application, message);
    if (response?.ok !== true) {
      const error = new Error(response?.error?.message ?? "The Safari native bridge did not respond.");
      error.code = response?.error?.code ?? "NATIVE_BRIDGE_UNAVAILABLE";
      throw error;
    }
    return response;
  }

  globalThis.ChatGPTSafariConnectNative = name => {
    if (name !== "com.openai.codexextension") {
      throw new Error("This Safari port only supports the installed production OpenAI native host.");
    }
    const onMessage = event();
    const onDisconnect = event();
    let closed = false;
    let connectionId;
    let sending = Promise.resolve();
    Object.assign(status, { state: "connecting", error: null });
    const opening = request({ operation: "open", application: name, origin });

    function stop(error) {
      if (closed) return;
      closed = true;
      Object.assign(status, { state: "disconnected", error: error?.message || null, errorCode: error?.code || null });
      if (error) console.warn("[safari-native]", error.code ?? "TRANSPORT_ERROR", error.message);
      if (connectionId) request({ operation: "close", connectionId }).catch(() => {});
      onDisconnect.emit(port);
    }

    const port = {
      name,
      onMessage,
      onDisconnect,
      postMessage(message) {
        if (closed) throw new Error("The Safari native port is disconnected.");
        // Snapshot now, as native Port.postMessage does, and serialize writes.
        const copy = JSON.parse(JSON.stringify(message));
        status.sentMessages++;
        if (typeof copy.method === "string") status.lastSentMethod = copy.method;
        sending = sending.then(async () => {
          const opened = await opening;
          if (!closed) await request({ operation: "send", connectionId: opened.connectionId, message: copy });
        }).catch(stop);
      },
      disconnect() { stop(); },
    };

    opening.then(async opened => {
      connectionId = opened.connectionId;
      status.state = "connected";
      if (closed) {
        await request({ operation: "close", connectionId });
        return;
      }
      while (!closed) {
        const response = await request({ operation: "poll", connectionId });
        if (!closed) for (const message of response.messages) {
          status.receivedMessages++;
          if (typeof message.method === "string") status.lastReceivedMethod = message.method;
          onMessage.emit(message, port);
        }
      }
    }).catch(stop);
    return port;
  };
})();
