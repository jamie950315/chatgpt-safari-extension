/* Fixed MAIN-world download capture. No extension API, credentials or model code. */
(function(root) {
  "use strict";
  // Self-contained: Safari serializes this function into the page's own realm.
  function operation(action, args) {
    const fail = message => ({ ok: false, error: { code: "CAUSAL_DOWNLOAD_REJECTED", message } });
    const key = args.channelKey;
    if (typeof key !== "string" || !/^__chatGPTSafariCausal_[a-f0-9]{32}$/.test(key)) return fail("A background-owned causal channel is required.");
    let channel = globalThis[key];
    if (action === "arm" && args.freshChannel === true) {
      if (Object.prototype.hasOwnProperty.call(globalThis, key)) return fail("The fresh causal channel already exists.");
      let capture;
      channel = Object.freeze({ invoke(method, input) {
        if (method === "arm") {
          if (capture?.active()) return fail("This document already has a causal download operation.");
          capture?.retire();
          const next = createCapture(input);
          if (!next.ok) return next;
          capture = next;
          return { ok: true, result: next.result };
        }
        return capture?.invoke(method, input) || fail("The causal download is no longer active.");
      } });
      // The unguessable channel name is allocated by the background and is
      // never used as source authority. Its immutable facade cannot be replaced
      // by page code; all candidate and Blob state stays in its private closure.
      Object.defineProperty(globalThis, key, { value: channel });
    }
    if (!channel) return fail("The background-owned causal channel is unavailable.");
    return channel.invoke(action, args);

    function createCapture(args) {
    if (!/^[a-f0-9-]{36}$/i.test(args.intentId || "") || args.expectedUrl !== location.href
      || !Number.isInteger(args.wait_ms) || args.wait_ms < 1 || args.wait_ms > 15000) return fail("An exact page and bounded preparation deadline are required.");
    const marker = "data-chatgpt-download-" + args.intentId;
    const sources = document.querySelectorAll("[" + marker + "]");
    if (sources.length !== 1) return fail("The exact isolated-world source marker is unavailable.");
    const source = sources[0], pageUrl = location.href, id = args.intentId;
    const original = { timeout: window.setTimeout, clear: window.clearTimeout, microtask: window.queueMicrotask,
      then: Promise.prototype.then, click: HTMLAnchorElement.prototype.click, create: URL.createObjectURL };
    const pending = new Set(), timerTasks = new Map(), blobs = new Map();
    const expires = Date.now() + 90000;
    let gesture, current = false, cancelled = false, error, captured, count = 0, blobBytes = 0, preparationTimer, lifetimeTimer, transferTimer, offset = 0, transferring = false, transferDeadline, preparationDeadline, prepared = false;
    const valid = () => !cancelled && Date.now() <= expires && (prepared || !preparationDeadline || Date.now() <= preparationDeadline)
      && (!transferring || Date.now() < transferDeadline) && location.href === pageUrl && source.isConnected && source.ownerDocument === document;
    const tagged = () => current || gesture?.eventPhase > 0;
    const inside = () => valid() && tagged();
    const later = (fn, ms) => Reflect.apply(original.timeout, window, [fn, ms]);
    const clear = timer => Reflect.apply(original.clear, window, [timer]);
    const wrap = (callback, task) => function(...values) {
      if (!valid()) { pending.delete(task); return; }
      const before = current; current = valid();
      try { return Reflect.apply(callback, this, values); }
      finally { current = before; pending.delete(task); }
    };
    const timeout = function(callback, ms, ...values) {
      if (!inside() || typeof callback !== "function") return Reflect.apply(original.timeout, window, [callback, ms, ...values]);
      const task = {}; pending.add(task);
      let timer;
      const wrapped = wrap(function(...parameters) { timerTasks.delete(timer); return Reflect.apply(callback, this, parameters); }, task);
      timer = Reflect.apply(original.timeout, window, [wrapped, ms, ...values]); timerTasks.set(timer, task); return timer;
    };
    const clearTimeout = function(timer) { const task = timerTasks.get(timer); if (task) { pending.delete(task); timerTasks.delete(timer); } return clear(timer); };
    const microtask = function(callback) {
      if (!inside() || typeof callback !== "function") return Reflect.apply(original.microtask, window, [callback]);
      const task = {}; pending.add(task); return Reflect.apply(original.microtask, window, [wrap(callback, task)]);
    };
    const then = function(fulfilled, rejected) {
      if (!inside()) return Reflect.apply(original.then, this, arguments);
      const task = {}; pending.add(task);
      const branch = (callback, rejection) => wrap(function(value) {
        if (typeof callback === "function") return Reflect.apply(callback, undefined, [value]);
        if (rejection) throw value;
        return value;
      }, task);
      try { return Reflect.apply(original.then, this, [branch(fulfilled, false), branch(rejected, true)]); }
      catch (failure) { pending.delete(task); throw failure; }
    };
    const create = function(object) {
      const url = Reflect.apply(original.create, this, arguments);
      if (inside() && object instanceof Blob) {
        if (blobs.size >= 16 || blobBytes + object.size > 32 * 1024 * 1024) error = "The causal Blob preparation exceeded its bounded inventory.";
        else { blobs.set(url, object); blobBytes += object.size; }
      }
      return url;
    };
    const capture = (anchor, event) => {
      if (!inside() || anchor.ownerDocument !== document || !anchor.hasAttribute("download")) return;
      if (!event.cancelable) { error = "The exact anchor default could not be cancelled."; return; }
      event.preventDefault();
      let url; try { url = new URL(anchor.href); } catch { error = "The causal anchor has no valid URL."; return; }
      url.hash = "";
      const blob = url.protocol === "blob:" ? blobs.get(url.href) : null;
      if (!["http:", "https:", "blob:"].includes(url.protocol) || url.username || url.password
        || url.protocol === "blob:" && (!blob || blob.size > 32 * 1024 * 1024)) {
        error = "Only HTTP(S), or a bounded Blob created in this exact causal operation, can be captured."; return;
      }
      count++;
      if (count !== 1) { error = "This source operation produced multiple download anchors; none can be transferred."; return; }
      captured = { href: url.href, filename: (anchor.getAttribute("download") || "").slice(0, 240), blob };
    };
    const click = function(...values) {
      if (!tagged() || this.ownerDocument !== document || !this.hasAttribute("download")) return Reflect.apply(original.click, this, values);
      if (!valid()) { error = "The causal export exceeded its preparation or source deadline; no request was sent."; return; }
      // Take over this programmatic export invocation before page listeners or
      // a default action can issue a request. Only the original source input is
      // native; no replacement click or synthetic input is dispatched here.
      capture(this, { cancelable: true, preventDefault() {} });
    };
    const trusted = event => {
      if (!valid() || !event.isTrusted || !event.composedPath().includes(source)) return;
      if (gesture) { error = "A second source click invalidated this one-click operation."; return; }
      gesture = event;
      preparationDeadline = Date.now() + args.wait_ms;
      if (event.cancelable) event.preventDefault();
      preparationTimer = later(() => { error ||= "File preparation exceeded its deadline; the source click was not repeated."; cancel(); }, args.wait_ms);
      if (source.tagName === "A") capture(source, event);
    };
    const installed = () => window.setTimeout === timeout && window.clearTimeout === clearTimeout
      && window.queueMicrotask === microtask && Promise.prototype.then === then
      && HTMLAnchorElement.prototype.click === click && URL.createObjectURL === create;
    const cleanup = () => {
      for (const [object, name, replacement, previous] of [[window, "setTimeout", timeout, original.timeout], [window, "clearTimeout", clearTimeout, original.clear],
        [window, "queueMicrotask", microtask, original.microtask], [Promise.prototype, "then", then, original.then],
        [HTMLAnchorElement.prototype, "click", click, original.click], [URL, "createObjectURL", create, original.create]]) {
        if (object[name] === replacement) object[name] = previous;
      }
      clear(preparationTimer); clear(lifetimeTimer); clear(transferTimer);
      document.removeEventListener("click", trusted, true); window.removeEventListener("pagehide", cancel);
    };
    const cancel = () => {
      cancelled = true;
      for (const timer of timerTasks.keys()) clear(timer);
      cleanup(); blobs.clear(); captured = null; pending.clear(); timerTasks.clear();
    };
    const check = () => {
      if (!valid() || error || !installed()) return fail(error || "The source page, control or capture hooks changed; no download was adopted.");
      const ready = !!gesture && gesture.eventPhase === 0 && pending.size === 0 && count === 1;
      if (ready) { prepared = true; clear(preparationTimer); }
      return { ok: true, result: { ready, intentId: id, href: captured?.href, filename: captured?.filename,
        kind: captured?.blob ? "blob" : "http", bytes: captured?.blob?.size } };
    };
    const invoke = async (method, input) => {
      if (input.intentId !== id || input.expectedUrl !== pageUrl) return fail("The causal capture belongs to a different document operation.");
      if (method === "cancel") { cancel(); return { ok: true, result: { cancelled: true } }; }
      const result = check(); if (!result.ok || method === "poll" || method === "check") return result;
      if (!result.result.ready || !captured?.blob || input.href !== captured.href) return fail("A policy-approved exact causal Blob is required.");
      if (method === "start") {
        if (transferring) return fail("This Blob transfer was already started; it cannot be replayed.");
        transferring = true; transferDeadline = Date.now() + 30000;
        transferTimer = later(() => { error = "The Blob exceeded its 30-second active transfer deadline."; cancel(); }, 30000);
        return { ok: true, result: { filename: captured.filename || "download", mime: captured.blob.type || "application/octet-stream", bytes: captured.blob.size } };
      }
      if (method !== "read" || !transferring) return fail("Start the approved Blob before reading bounded bytes.");
      if (offset === captured.blob.size) return { ok: true, result: { done: true, bytes: offset } };
      const blob = captured.blob, begin = offset;
      const bytes = new Uint8Array(await blob.slice(begin, begin + 48 * 1024).arrayBuffer());
      if (!valid() || error || captured?.blob !== blob || offset !== begin) return fail("The Blob operation changed during its read.");
      offset += bytes.length;
      let binary = ""; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      return { ok: true, result: { done: false, bytes: bytes.length, data: btoa(binary) } };
    };
    try {
      window.setTimeout = timeout; window.clearTimeout = clearTimeout; window.queueMicrotask = microtask;
      Promise.prototype.then = then; HTMLAnchorElement.prototype.click = click; URL.createObjectURL = create;
      if (!installed()) throw new Error("The page's callable APIs cannot be instrumented.");
      document.addEventListener("click", trusted, true); window.addEventListener("pagehide", cancel, { once: true });
      lifetimeTimer = later(() => { error = "The causal capture expired with its operation."; cancel(); }, 90000);
      return { ok: true, result: { armed: true, intentId: id }, active: valid, invoke, retire: cancel };
    } catch (failure) { cancel(); return fail(failure.message); }
    }
  }
  const api = Object.freeze({ operation });
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.defineProperty(root, "ChatGPTSafariDownloadCapture", { value: api });
})(globalThis);
