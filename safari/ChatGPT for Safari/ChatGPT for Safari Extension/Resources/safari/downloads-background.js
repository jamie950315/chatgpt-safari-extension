/* Downloads use the claimed page's own Safari session. Credentials never cross
 * the isolated-world boundary; only bounded response bytes reach the writer. */
(function (root) {
  "use strict";
  const maximumBytes = 32 * 1024 * 1024;
  const chunkBytes = 48 * 1024;

  // Self-contained because WebExtension scripting serializes this function.
  async function downloadPageOperation(operation, args) {
    const failure = (code, message) => ({ ok: false, error: { code, message } });
    const live = globalThis.__chatGPTSafariLiveDocument;
    const stateKey = "__chatGPTSafariDownloadState";
    let state = globalThis[stateKey];
    if (!state) {
      state = new Map();
      Object.defineProperty(globalThis, stateKey, { value: state });
      addEventListener("pagehide", () => {
        for (const transfer of state.values()) { transfer.controller.abort(); clearTimeout(transfer.timer); }
        state.clear();
      }, { once: true });
    }
    const stop = transfer => {
      transfer.controller.abort(); clearTimeout(transfer.timer); state.delete(args.transferId);
      transfer.reader?.cancel().catch(() => {});
    };
    if (operation === "cancel") {
      const transfer = state.get(args.transferId);
      if (transfer) stop(transfer);
      return { ok: true, result: { cancelled: true } };
    }
    const current = () => live && live.documentId === args.documentId && live.snapshotId === args.snapshotId
      && live.url === location.href && location.href === args.expectedUrl;
    const anchor = live?.nodes.get(args.node);
    const href = () => {
      if (!current() || !anchor?.isConnected || !anchor.matches("a[href]")) return null;
      const rect = anchor.getBoundingClientRect(), style = getComputedStyle(anchor);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
      try {
        const value = new URL(anchor.href);
        value.hash = "";
        if (!["https:", "http:"].includes(value.protocol) || value.origin !== location.origin || value.username || value.password) return null;
        return value.href;
      } catch { return null; }
    };
    const source = href();
    if (!source || (operation !== "inspect" && source !== args.href)) {
      const transfer = state.get(args.transferId);
      if (transfer) stop(transfer);
      return failure("DOWNLOAD_TARGET_CHANGED", "Read the current visible DOM before downloading a same-origin HTTP/HTTPS link. JavaScript buttons, blob URLs, and cross-origin links are not supported.");
    }
    if (operation === "inspect") return { ok: true, result: { href: source, url: location.href } };
    if (operation === "start") {
      if (typeof args.transferId !== "string" || state.has(args.transferId)) return failure("INVALID_DOWNLOAD", "A fresh download transfer is required.");
      const controller = new AbortController();
      const transfer = { controller, bytes: 0, pending: null, offset: 0 };
      transfer.timer = setTimeout(() => { controller.abort(); state.delete(args.transferId); }, 30000);
      state.set(args.transferId, transfer);
      try {
        // Never follow a redirect before the original download policy can
        // approve its destination. This bounded route rejects all redirects.
        const response = await fetch(source, { method: "GET", mode: "same-origin", credentials: "same-origin",
          redirect: "error", cache: "no-store", signal: controller.signal });
        if (!current() || href() !== source) throw new Error("The download document changed during the request.");
        if (!response.ok || response.redirected || response.type === "opaque" || new URL(response.url).origin !== location.origin) {
          throw new Error("The download response was rejected. Only successful same-origin responses without redirects are supported.");
        }
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/u.test(length) || Number(length) > 32 * 1024 * 1024)) throw new Error("This download exceeds the 32 MiB limit.");
        if (!response.body) throw new Error("The download response has no readable body.");
        transfer.reader = response.body.getReader();
        let filename = anchor.getAttribute("download") || "";
        const disposition = response.headers.get("content-disposition") || "";
        const utf8 = disposition.match(/(?:^|;)\s*filename\*=UTF-8''([^;]*)/iu);
        const quoted = disposition.match(/(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/iu);
        const plain = disposition.match(/(?:^|;)\s*filename=([^;]*)/iu);
        if (utf8) { try { filename = decodeURIComponent(utf8[1]); } catch { /* Use the link/URL filename when malformed. */ } }
        else if (quoted) filename = quoted[1].replace(/\\(.)/gu, "$1");
        else if (plain) filename = plain[1].trim();
        if (!filename) { try { filename = decodeURIComponent(new URL(source).pathname.split("/").pop() || "download"); } catch { filename = "download"; } }
        return { ok: true, result: { filename, mime: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] } };
      } catch (error) {
        stop(transfer);
        return failure("DOWNLOAD_FETCH_FAILED", error.name === "AbortError" ? "The download expired or its document closed. It was not retried." :
          "The download request failed. Only successful same-origin HTTP/HTTPS links without redirects are supported; the request was not retried.");
      }
    }
    const transfer = state.get(args.transferId);
    if (!transfer?.reader) return failure("STALE_DOWNLOAD", "The download is no longer active. It was not retried.");
    if (operation !== "read") { stop(transfer); return failure("INVALID_DOWNLOAD", "Unknown page download operation."); }
    try {
      if (!transfer.pending || transfer.offset === transfer.pending.byteLength) {
        const next = await transfer.reader.read();
        if (!current() || href() !== source) throw new Error("The page or download link changed during the transfer.");
        if (next.done) { stop(transfer); return { ok: true, result: { done: true, bytes: transfer.bytes } }; }
        transfer.pending = next.value; transfer.offset = 0;
      }
      const bytes = transfer.pending.subarray(transfer.offset, transfer.offset + 48 * 1024);
      if (transfer.bytes + bytes.byteLength > 32 * 1024 * 1024) throw new Error("This download exceeds the 32 MiB limit.");
      transfer.offset += bytes.byteLength; transfer.bytes += bytes.byteLength;
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { ok: true, result: { done: false, data: btoa(binary), bytes: bytes.byteLength } };
    } catch (error) {
      stop(transfer);
      return failure("DOWNLOAD_READ_FAILED", "The download stopped before completion. Its incomplete file will be discarded; it was not retried.");
    }
  }

  function createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap }) {
    async function page(tab, operation, args) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: downloadPageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    async function inspect(tab, args) {
      await target(args.handle, args.expectedUrl);
      const result = await page(tab, "inspect", args);
      await target(args.handle, args.expectedUrl);
      return result;
    }
    async function execute(request, tab, args) {
      if (typeof args.href !== "string" || typeof args.documentId !== "string" || typeof args.snapshotId !== "string"
        || typeof args.node !== "string" || typeof args.expectedUrl !== "string") throw new Error("A policy-approved link and its current document snapshot are required for download.");
      const transferArgs = { ...args, transferId: root.crypto.randomUUID() };
      let nativeID, sequence = 0, bytes = 0;
      const write = async input => {
        assertTime();
        await target(args.handle, args.expectedUrl);
        await page(tab, "inspect", args).then(result => { if (result.href !== args.href) throw new Error("The approved download link changed."); });
        return unwrap(await send({ action: "liveDownload", id: request.id, profileId, sessionId, input }));
      };
      try {
        assertTime();
        await inspect(tab, args);
        const metadata = await page(tab, "start", transferArgs);
        const writer = await write({ action: "begin", filename: metadata.filename });
        nativeID = writer.transferId;
        for (;;) {
          assertTime(); await target(args.handle, args.expectedUrl);
          const chunk = await page(tab, "read", transferArgs);
          if (chunk.done) {
            if (chunk.bytes !== bytes) throw new Error("The download byte count changed before completion.");
            const saved = await write({ action: "finish", transferId: nativeID, sequence, expectedBytes: bytes });
            nativeID = undefined;
            return { ...saved, mime: metadata.mime };
          }
          if (!Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > chunkBytes || bytes + chunk.bytes > maximumBytes) throw new Error("The download response exceeded its bounded transfer size.");
          const written = await write({ action: "append", transferId: nativeID, sequence, data: chunk.data });
          bytes += chunk.bytes; sequence++;
          if (written.bytesWritten !== bytes || written.sequence !== sequence) throw new Error("The native download writer did not confirm the expected bytes.");
        }
      } finally {
        await page(tab, "cancel", transferArgs).catch(() => {});
        if (nativeID) await send({ action: "liveDownload", id: request.id, profileId, sessionId,
          input: { action: "abort", transferId: nativeID } }).catch(() => {});
      }
    }
    return { inspect, execute };
  }
  const bridge = Object.freeze({ createDownloads, downloadPageOperation, maximumBytes, chunkBytes });
  if (typeof module === "object" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariDownloads", { value: bridge });
})(globalThis);
