/* A destination document owns only its approved hop's Response and reader.
 * Original source authority, policy, native receipts and writing stay outside. */
(function (root) {
  "use strict";

  // Self-contained: WebExtension scripting serializes this function into an
  // ISOLATED world. Never replace its destination identity with the source ID.
  async function realmPageOperation(operation, args) {
    const fail = (code, message) => ({ ok: false, error: { code, message } });
    const success = result => ({ ok: true, result });
    const maximumBytes = 32 * 1024 * 1024, chunkBytes = 48 * 1024, maximumNonces = 1024;
    if (!args || typeof args !== "object") return fail("INVALID_DOWNLOAD_REALM", "An exact destination-document lease is required.");
    const live = globalThis.__chatGPTSafariLiveDocument;
    const stateKey = "__chatGPTSafariDownloadRealms";
    let state = globalThis[stateKey];
    const discard = value => {
      clearTimeout(value.timer);
      value.controller?.abort();
      if (value.reader) void value.reader.cancel().catch(() => {});
      else if (value.response?.body) void value.response.body.cancel().catch(() => {});
      value.reader = null; value.response = null; value.pending = null;
      if (state.leases.get(value.id) === value) state.leases.delete(value.id);
    };
    if (!state) {
      state = { leases: new Map(), usedNonces: new Set() };
      Object.defineProperty(globalThis, stateKey, { value: state });
      addEventListener("pagehide", () => {
        for (const value of state.leases.values()) discard(value);
      }, { once: true });
    }
    const item = state.leases.get(args.intentId);
    const matches = value => value && value.scope === args.scope && value.documentId === args.documentId
      && value.snapshotId === args.snapshotId && value.pageUrl === args.expectedUrl && value.href === args.href;
    const current = value => matches(value) && state.leases.get(value.id) === value
      && globalThis.__chatGPTSafariLiveDocument === live && live?.documentId === value.documentId
      && live.snapshotId === value.snapshotId && live.url === value.pageUrl && location.href === value.pageUrl
      && Date.now() < value.deadline;
    if (operation === "cancel") {
      if (matches(item)) discard(item);
      return success({ cancelled: true });
    }
    if (operation === "arm") {
      if (state.usedNonces.size >= maximumNonces) {
        return fail("DOWNLOAD_REALM_CAPACITY", "This document exhausted its 1024 one-use download nonces. No nonce was discarded or request started.");
      }
      if (typeof args.intentId !== "string" || !args.intentId || args.intentId.length > 128
        || typeof args.scope !== "string" || !args.scope || args.scope.length > 4096
        || !live || live.documentId !== args.documentId || live.snapshotId !== args.snapshotId
        || live.url !== args.expectedUrl || location.href !== args.expectedUrl || item) {
        return fail("INVALID_DOWNLOAD_REALM", "Arm one unused exact destination-document lease.");
      }
      let href;
      try { href = new URL(args.href); } catch { return fail("INVALID_DOWNLOAD_REALM", "An exact same-origin HTTP(S) destination is required."); }
      if (!["http:", "https:"].includes(href.protocol) || href.username || href.password
        || href.origin !== location.origin || href.href !== args.href || href.hash) {
        return fail("INVALID_DOWNLOAD_REALM", "An exact same-origin HTTP(S) destination without credentials or a fragment is required.");
      }
      const value = { id: args.intentId, scope: args.scope, documentId: args.documentId, snapshotId: args.snapshotId,
        pageUrl: args.expectedUrl, href: args.href, phase: "armed", deadline: Date.now() + 90000, bytes: 0, offset: 0 };
      state.leases.set(value.id, value);
      value.timer = setTimeout(() => discard(value), 90000); value.timer?.unref?.();
      return success({ armed: true });
    }
    if (!current(item)) {
      if (matches(item)) discard(item);
      return fail("STALE_DOWNLOAD_REALM", "The destination document, snapshot, scope or download deadline changed.");
    }
    if (operation === "check") return success({ alive: true, phase: item.phase });
    if (operation === "fetch") {
      if (item.phase !== "armed" || typeof args.nonce !== "string" || !/^[a-f0-9-]{36}$/iu.test(args.nonce)
        || state.usedNonces.has(args.nonce) || !Number.isInteger(args.remainingMs) || args.remainingMs < 1 || args.remainingMs > 30000) {
        return fail("DOWNLOAD_REALM_USED", "Use one fresh nonce and a 1–30000ms active budget for this hop; no request was repeated.");
      }
      if (state.usedNonces.size >= maximumNonces) {
        return fail("DOWNLOAD_REALM_CAPACITY", "This document exhausted its 1024 one-use download nonces. No nonce was discarded or request started.");
      }
      state.usedNonces.add(args.nonce); item.phase = "requesting";
      const started = Date.now();
      item.deadline = started + args.remainingMs; item.controller = new AbortController();
      clearTimeout(item.timer);
      item.timer = setTimeout(() => discard(item), args.remainingMs); item.timer?.unref?.();
      try {
        const response = await fetch(item.href, { method: "GET", mode: "same-origin", credentials: "same-origin",
          redirect: "manual", cache: "no-store", signal: item.controller.signal,
          headers: { "X-ChatGPT-Safari-Transfer": args.nonce } });
        if (!current(item)) {
          void response.body?.cancel().catch(() => {});
          throw new Error("stale");
        }
        const elapsedMs = Date.now() - started;
        if (response.type === "opaqueredirect") {
          item.phase = "redirect"; item.controller.abort();
          return success({ kind: "redirect", elapsedMs });
        }
        if (!response.ok || response.redirected || response.type === "opaque" || response.url !== item.href || !response.body) {
          void response.body?.cancel().catch(() => {});
          discard(item);
          return fail("DOWNLOAD_REALM_RESPONSE_REJECTED", "The response did not retain its exact approved destination and readable body.");
        }
        item.response = response; item.phase = "response";
        return success({ kind: "response", status: response.status, url: response.url, elapsedMs });
      } catch {
        discard(item);
        return fail("DOWNLOAD_REALM_FETCH_FAILED", "The destination request failed, expired or lost its document. It was not retried.");
      }
    }
    if (operation === "metadata") {
      if (item.phase !== "response" || !item.response) return fail("DOWNLOAD_REALM_USED", "Metadata requires the one retained response before reading its body.");
      const response = item.response;
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
        discard(item); return fail("DOWNLOAD_SIZE", "The destination response exceeds 32 MiB or has an invalid content length.");
      }
      let filename = "";
      const disposition = response.headers.get("content-disposition") || "";
      const utf8 = disposition.match(/(?:^|;)\s*filename\*=UTF-8''([^;]*)/iu);
      const quoted = disposition.match(/(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/iu);
      const plain = disposition.match(/(?:^|;)\s*filename=([^;]*)/iu);
      if (utf8) { try { filename = decodeURIComponent(utf8[1]); } catch { /* Keep the approved URL's filename for malformed encoding. */ } }
      else if (quoted) filename = quoted[1].replace(/\\(.)/gu, "$1");
      else if (plain) filename = plain[1].trim();
      if (!filename) {
        try { filename = decodeURIComponent(new URL(item.href).pathname.split("/").pop() || "download"); }
        catch { filename = "download"; }
      }
      try { item.reader = response.body.getReader(); }
      catch { discard(item); return fail("DOWNLOAD_REALM_USED", "The retained response body was already consumed."); }
      item.response = null; item.phase = "reading";
      return success({ filename, mime: (response.headers.get("content-type") || "application/octet-stream").split(";", 1)[0] });
    }
    if (operation !== "read") return fail("INVALID_DOWNLOAD_REALM", "Unknown destination download operation.");
    if (item.phase === "done") return fail("DOWNLOAD_REALM_USED", "The response body already reached EOF. Finish or cancel this lease without reading it again.");
    if (item.phase !== "reading" || !item.reader) return fail("DOWNLOAD_REALM_USED", "Start the retained response reader once before reading chunks.");
    if (item.busy) { discard(item); return fail("DOWNLOAD_REALM_SEQUENCE", "Concurrent body reads were cancelled; no chunk was returned."); }
    item.busy = true;
    try {
      if (!item.pending || item.offset === item.pending.byteLength) {
        const next = await item.reader.read();
        if (!current(item)) throw new Error("stale");
        if (next.done) {
          item.reader.releaseLock(); item.reader = null; item.pending = null; item.phase = "done";
          // Keep the original deadline and document lease for the caller's
          // native-writer finish check. Its final cancel releases this lease.
          return success({ done: true, bytes: item.bytes });
        }
        item.pending = next.value; item.offset = 0;
      }
      if (!current(item)) throw new Error("stale");
      const bytes = item.pending.subarray(item.offset, item.offset + chunkBytes);
      if (item.bytes + bytes.byteLength > maximumBytes) {
        discard(item); return fail("DOWNLOAD_SIZE", "The destination response exceeded 32 MiB; its body was cancelled.");
      }
      item.offset += bytes.byteLength; item.bytes += bytes.byteLength;
      let binary = "";
      for (let index = 0; index < bytes.byteLength; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      return success({ done: false, bytes: bytes.byteLength, data: btoa(binary) });
    } catch {
      discard(item);
      return fail("DOWNLOAD_REALM_READ_FAILED", "The destination body expired, failed or lost its document. No stale bytes were returned.");
    } finally { item.busy = false; }
  }

  const bridge = Object.freeze({ realmPageOperation, maximumBytes: 32 * 1024 * 1024, chunkBytes: 48 * 1024 });
  if (typeof module === "object" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariDownloadRealm", { value: bridge });
})(globalThis);
