/* Downloads use the claimed page's own Safari session. Credentials never cross
 * the isolated-world boundary; only bounded response bytes reach the writer. */
(function (root) {
  "use strict";
  const maximumBytes = 32 * 1024 * 1024;
  const chunkBytes = 48 * 1024;
  const realmTransfers = new Map();
  const causalChannels = new Map();
  const destinationRealm = typeof module === "object" && module.exports ? require("./download-realm-background.js") : root.ChatGPTSafariDownloadRealm;
  const causalCapture = typeof module === "object" && module.exports ? require("./download-capture-main.js") : root.ChatGPTSafariDownloadCapture;

  function assetInventoryPageOperation(operation, args) {
    const fail = message => ({ ok: false, error: { code: "STALE_ASSET_INVENTORY", message } });
    const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = "__chatGPTSafariLiveDocument";
    if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: { documentId: newId(), nodes: new Map(), snapshotId: null, url: location.href } });
    const state = globalThis[key]; state.assetInventories ||= new Map();
    if (operation !== "list") {
      const inventory = state.assetInventories.get(args.inventoryId);
      if (!inventory || inventory.scope !== args.scope || inventory.documentId !== state.documentId || inventory.pageUrl !== location.href) return fail("List assets in the current claimed document before bundling them.");
      const requested = args.assetIds || [...inventory.items.keys()];
      if (requested.some(id => !inventory.items.has(id))) return fail("The bundle contains an unknown asset ID.");
      let items = [...new Set(requested)].map(id => inventory.items.get(id));
      if (args.kinds) items = items.filter(item => args.kinds.includes(item.kind));
      if (args.assetIds && items.some(item => !["font", "image", "stylesheet", "video"].includes(item.kind))) return fail("Only font, image, stylesheet, and video assets can be bundled.");
      items = items.filter(item => ["font", "image", "stylesheet", "video"].includes(item.kind));
      return { ok: true, result: { pageUrl: inventory.pageUrl, documentId: inventory.documentId, items } };
    }
    const byURL = new Map(), inlineSvgs = [], items = new Map();
    const kindFor = (value, hint) => /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(value) ? "font"
      : /\.(png|jpe?g|gif|webp|avif|svg|ico)(?:[?#]|$)/i.test(value) ? "image"
      : /\.css(?:[?#]|$)/i.test(value) ? "stylesheet" : /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value) ? "video" : hint || "other";
    const add = (raw, kind, source, base = document.baseURI) => {
      if (!raw) return;
      let url; try { url = new URL(raw, base); } catch { return; }
      if (!["https:", "http:", "data:", "blob:"].includes(url.protocol) || url.username || url.password) return;
      url.hash = "";
      let asset = byURL.get(url.href);
      if (!asset) {
        const id = "asset-" + (byURL.size + 1);
        let name; try { name = decodeURIComponent(url.pathname.split("/").pop() || id); } catch { name = id; }
        asset = { id, kind: kindFor(url.href, kind), name: name.slice(0, 240), sources: [], url: url.href };
        byURL.set(url.href, asset); items.set(id, asset);
      }
      if (!asset.sources.some(item => item.kind === source.kind && item.property === source.property)) asset.sources.push(source);
    };
    const visit = root => {
      for (const element of root.querySelectorAll("*")) {
        const tag = element.tagName.toLowerCase(), source = property => ({ kind: "attribute", property });
        if (tag === "img") add(element.currentSrc || element.src, "image", source("currentSrc"), element.baseURI);
        if (tag === "video") { add(element.currentSrc || element.src, "video", source("currentSrc"), element.baseURI); add(element.poster, "image", source("poster"), element.baseURI); }
        if (tag === "image") add(element.href?.baseVal, "image", source("href"), element.baseURI);
        if (tag === "script") add(element.src, "script", source("src"), element.baseURI);
        if (tag === "link" && element.relList.contains("stylesheet")) add(element.href, "stylesheet", source("href"), element.baseURI);
        if (tag === "svg") {
          const svg = { id: "svg-" + (inlineSvgs.length + 1), markup: element.outerHTML, name: element.getAttribute("aria-label") || element.querySelector("title")?.textContent || "Inline SVG" };
          inlineSvgs.push(svg); items.set(svg.id, { ...svg, kind: "image", url: "inline-svg:" + svg.id, inline: true });
        }
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        for (const property of ["background-image", "border-image-source", "list-style-image", "mask-image"]) {
          for (const match of style.getPropertyValue(property).matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) add(match[2], "image", { kind: "computedStyle", property }, element.baseURI);
        }
        if (element.shadowRoot) visit(element.shadowRoot);
        if (tag === "iframe") { try { if (element.contentDocument) visit(element.contentDocument); } catch { /* Cross-origin subdocuments remain outside their parent's DOM inventory. */ } }
      }
    };
    visit(document);
    for (const entry of performance.getEntriesByType("resource")) add(entry.name, ({ img: "image", css: "stylesheet", script: "script", video: "video" })[entry.initiatorType], { kind: "resource" });
    const assets = [...byURL.values()], byKind = { font: 0, image: 0, other: 0, script: 0, stylesheet: 0, video: 0 };
    for (const asset of assets) byKind[asset.kind]++;
    const id = newId();
    state.assetInventories.set(id, { scope: args.scope, documentId: state.documentId, pageUrl: location.href, items });
    return { ok: true, result: { assets, id, inlineSvgs, pageUrl: location.href,
      summary: { byKind, inlineSvgCount: inlineSvgs.length, totalCount: assets.length } } };
  }

  // The default route observes connected anchors. The explicit causal route
  // pairs this exact isolated source event with a fixed MAIN-world interceptor.
  async function downloadIntentPageOperation(operation, args) {
    const fail = message => ({ ok: false, error: { code: "DOWNLOAD_INTENT_REJECTED", message } });
    const live = globalThis.__chatGPTSafariLiveDocument;
    if (!live) return fail("Read and resolve the current claimed page before capturing a download intent.");
    live.downloadIntents ||= new Map();
    const item = live.downloadIntents.get(args.intentId);
    const current = value => value && value.scope === args.scope && value.documentId === live.documentId
      && value.snapshotId === live.snapshotId && value.pageUrl === location.href && live.url === location.href
      && value.source.isConnected && Date.now() <= value.expires;
    const discard = value => {
      value.stop(); value.close?.(); value.abort?.(); clearTimeout(value.expiry);
      value.source.removeAttribute?.("data-chatgpt-download-" + value.id);
      live.downloadIntents.delete(value.id);
    };
    if (operation === "cancel") {
      if (item?.scope === args.scope) discard(item);
      return { ok: true, result: { cancelled: true } };
    }
    if (operation === "arm") {
      if (typeof args.intentId !== "string" || !/^[a-f0-9-]{36}$/i.test(args.intentId)
        || typeof args.scope !== "string" || !args.scope || args.scope.length > 4096
        || live.documentId !== args.documentId || live.snapshotId !== args.snapshotId || live.url !== location.href
        || location.href !== args.expectedUrl || live.downloadIntents.has(args.intentId)) return fail("A fresh exact-document download-intent lease is required.");
      for (const previous of live.downloadIntents.values()) {
        if (previous.documentId !== live.documentId || previous.snapshotId !== live.snapshotId || previous.pageUrl !== location.href
          || !previous.source.isConnected || Date.now() > previous.expires) discard(previous);
        else return fail("A download intent is already active in this exact document.");
      }
      const source = live.nodes.get(args.node);
      if (!source?.isConnected || source.ownerDocument !== document) return fail("Download intents require a connected top-level source control.");
      const value = { id: args.intentId, scope: args.scope, source, documentId: live.documentId,
        snapshotId: live.snapshotId, pageUrl: location.href, phase: "armed", expires: Date.now() + 90000, capture: args.capture };
      if (args.capture === "causal") source.setAttribute("data-chatgpt-download-" + value.id, "");
      let timer, ended = false;
      const stop = () => { clearTimeout(timer); document.removeEventListener("click", clicked, true); };
      const closed = () => discard(value);
      const clicked = event => {
        if (!current(value) || ended) { stop(); return; }
        const path = event.composedPath();
        if (event.isTrusted && path.includes(source)) {
          if (value.gesture) { value.error = "More than one trusted source gesture was observed; no intent was adopted."; return; }
          value.gesture = event;
          // Prevent the source's own default form/navigation while preserving
          // its real handler, including a synchronous handler's anchor.click().
          if (event.cancelable) event.preventDefault();
          if (value.capture !== "causal") timer = setTimeout(() => {
            ended = true; stop();
            if (value.phase === "armed") value.error = "The delivered click produced no synchronous cancelable HTTP(S) download anchor. Location/form, detached-anchor and later-task downloads are unsupported; do not replay the click.";
          }, 0);
        }
        if (value.capture === "causal") return;
        const anchor = path.find(node => node?.tagName === "A" && node.hasAttribute("download"));
        if (!anchor || !value.gesture || value.gesture.eventPhase === 0 || !navigator.userActivation?.isActive) return;
        if (event.cancelable) event.preventDefault();
        if (!event.cancelable || !event.defaultPrevented || !anchor.isConnected || anchor.ownerDocument !== document) {
          value.error = "Safari could not cancel this exact connected anchor default; no verified transfer is available."; return;
        }
        let href;
        try { href = new URL(anchor.href); } catch { value.error = "The observed download anchor has no valid URL."; return; }
        if (!["http:", "https:"].includes(href.protocol) || href.username || href.password) {
          value.error = "Only a synchronous HTTP(S) anchor intent is supported; blob/data and credential-bearing URLs are not transferred."; return;
        }
        href.hash = "";
        if (value.phase !== "armed") { value.error = "The source gesture produced multiple download anchors; none was transferred."; return; }
        value.href = href.href; value.filename = (anchor.getAttribute("download") || "").slice(0, 240); value.phase = "captured";
      };
      value.stop = stop; value.close = () => removeEventListener("pagehide", closed);
      live.downloadIntents.set(value.id, value);
      value.expiry = setTimeout(() => discard(value), 90000); value.expiry?.unref?.();
      document.addEventListener("click", clicked, true); addEventListener("pagehide", closed, { once: true });
      return { ok: true, result: { armed: true, intentId: value.id } };
    }
    if (!current(item)) { if (item?.scope === args.scope) discard(item); return fail("The download intent no longer belongs to its exact source document, snapshot, control and original sidebar scope."); }
    if (operation === "marker_clear") {
      item.source.removeAttribute("data-chatgpt-download-" + item.id);
      return { ok: true, result: { cleared: true } };
    }
    if (operation === "lease_check") {
      if (item.error || item.href !== args.href || !["captured", "redirect-pending", "realm-requesting", "headers-ready"].includes(item.phase)) return fail("The exact source download lease changed before destination transport.");
      return { ok: true, result: { current: true } };
    }
    if (operation === "causal_check" || operation === "causal_adopt") {
      if (item.capture !== "causal" || !item.gesture || item.gesture.eventPhase !== 0 || item.error) return fail("No exact completed trusted source event belongs to this causal operation.");
      if (operation === "causal_check") return { ok: true, result: { current: true } };
      if (item.phase !== "armed" || !["http", "blob"].includes(args.kind) || typeof args.href !== "string") return fail("Only one fresh causal download can be adopted.");
      const href = new URL(args.href), source = new URL(item.pageUrl);
      if (href.username || href.password || (args.kind === "blob" ? href.protocol !== "blob:" || href.origin !== source.origin : !["http:", "https:"].includes(href.protocol))) return fail("The causal download URL has an invalid source identity.");
      item.href = href.href; item.filename = args.filename; item.kind = args.kind; item.phase = "captured"; item.stop();
      return { ok: true, result: { intentId: item.id, href: item.href, kind: item.kind, filename: item.filename } };
    }
    if (operation === "realm_reserve") {
      const href = new URL(args.href);
      if (args.redirectPolicy !== "tab-origin-policy" || !["captured", "redirect-pending"].includes(item.phase)
        || href.href !== item.href || !["http:", "https:"].includes(href.protocol) || href.username || href.password
        || !/^[a-f0-9-]{36}$/i.test(args.nonce || "")) return fail("Only the exact approved URL may reserve one destination-document request.");
      item.visited ||= new Set(); item.requestCount ||= 0; item.activeMs ||= 0;
      if (item.visited.has(href.href) || item.requestCount >= 5 || item.activeMs >= 30000) return fail("The destination-document route exhausted its request, cycle or active-transfer bound.");
      item.visited.add(href.href); item.requestCount++; item.redirectPolicy = args.redirectPolicy; item.phase = "realm-requesting"; item.nonce = args.nonce;
      return { ok: true, result: { remainingMs: 30000 - item.activeMs } };
    }
    if (operation === "realm_response") {
      if (item.phase !== "realm-requesting" || item.nonce !== args.nonce || item.href !== args.href
        || !Number.isFinite(args.elapsedMs) || args.elapsedMs < 0) return fail("The destination response no longer belongs to its original source operation.");
      item.activeMs += args.elapsedMs;
      if (item.activeMs >= 30000) return fail("The destination response exhausted its active-transfer budget.");
      item.phase = args.kind === "redirect" ? "redirect-proof" : "response-proof";
      // The actual Response belongs to the independently bound destination
      // document, never to this source document or a fabricated source alias.
      item.realmResponse = args.kind === "response" ? { url: args.href, status: args.status } : null;
      return { ok: true, result: { current: true } };
    }
    if (operation === "redirect_fetch") {
      const source = new URL(item.pageUrl), href = new URL(args.href);
      const crossOriginPolicy = args.redirectPolicy === "cross-origin-policy";
      if (!["same-origin-policy", "cross-origin-policy", "tab-origin-policy"].includes(args.redirectPolicy)
        || item.redirectPolicy && item.redirectPolicy !== args.redirectPolicy
        || !["captured", "redirect-pending"].includes(item.phase) || item.href !== href.href || !crossOriginPolicy && href.origin !== source.origin
        || !["http:", "https:"].includes(href.protocol) || href.username || href.password
        || !/^[a-f0-9-]{36}$/i.test(args.nonce || "")) return fail("Only the exact approved redirect hop under its original policy may start once.");
      item.visited ||= new Set(); item.requestCount ||= 0; item.activeMs ||= 0;
      if (item.requestCount >= 5 || item.visited.has(href.href)) return fail("The captured download exceeded five requests or repeated a redirect URL. No request was repeated.");
      const remaining = 30000 - item.activeMs;
      if (remaining <= 0) return fail("The captured download exhausted its 30-second active transfer budget.");
      item.redirectPolicy = args.redirectPolicy;
      item.requestCount++; item.visited.add(href.href); item.phase = "requesting"; item.nonce = args.nonce;
      const controller = new AbortController(), started = Date.now();
      item.controller = controller; item.abort = () => { controller.abort(); clearTimeout(item.networkTimer); };
      item.transferDeadline = started + remaining;
      item.networkTimer = setTimeout(() => controller.abort(), remaining); item.networkTimer?.unref?.();
      try {
        const response = await fetch(href.href, { method: "GET", mode: crossOriginPolicy ? "cors" : "same-origin", credentials: crossOriginPolicy ? "include" : "same-origin", redirect: "manual",
          cache: "no-store", signal: controller.signal, headers: { "X-ChatGPT-Safari-Transfer": args.nonce } });
        item.activeMs += Date.now() - started;
        if (!current(item) || item.phase !== "requesting") throw new Error("The source lease changed during its request.");
        if (response.type === "opaqueredirect") {
          item.abort(); item.phase = "redirect-proof";
          return { ok: true, result: { kind: "redirect" } };
        }
        if (!response.ok || response.redirected || response.type === "opaque" || response.url !== href.href || !response.body) throw new Error("The response did not retain its exact approved URL.");
        item.response = response; item.phase = "response-proof";
        return { ok: true, result: { kind: "response", status: response.status, url: response.url } };
      } catch {
        discard(item); return fail("The exact approved request failed, expired, lost its source lease, or Safari denied credentialed CORS access. It was not repeated and no fallback was attempted.");
      }
    }
    if (operation === "redirect_bind") {
      if (item.nonce !== args.nonce || item.href !== args.href || item.redirectPolicy !== args.redirectPolicy) return fail("This header receipt belongs to a different exact hop.");
      if (args.kind === "redirect" && item.phase === "redirect-proof") {
        const next = new URL(args.nextHref), source = new URL(item.pageUrl); next.hash = "";
        if (args.redirectPolicy === "same-origin-policy" && next.origin !== source.origin || next.username || next.password || !["http:", "https:"].includes(next.protocol)) return fail("A cross-origin redirect was rejected before contacting its destination.");
        if (item.visited.has(next.href) || item.requestCount >= 5) return fail("The redirect repeated a URL or exceeded the five-request bound. No next request was sent.");
        item.href = next.href; item.phase = "redirect-pending"; item.nonce = null;
        return { ok: true, result: { kind: "redirect", href: next.href } };
      }
      if (args.kind !== "response" || item.phase !== "response-proof" || (item.response || item.realmResponse)?.status !== args.status
        || (item.response || item.realmResponse).url !== item.href) return fail("The observed native headers did not match this exact page response.");
      item.phase = "headers-ready"; item.nonce = null;
      return { ok: true, result: { kind: "ready", href: item.href } };
    }
    if (operation !== "read") return fail("Unknown download-intent operation.");
    const deadline = Date.now() + Math.min(args.timeout_ms ?? 1000, 3000);
    while (item.phase === "armed" && !item.error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!current(item) || item.error || item.phase !== "captured") {
      const message = item.error || "The delivered native click has no verified synchronous anchor intent. It was not replayed.";
      discard(item); return fail(message);
    }
    // Wait until the original source dispatch has ended, so a second anchor
    // from the same handler cannot be silently accepted after this read.
    if (item.gesture?.eventPhase !== 0) { discard(item); return fail("The source event has not finished dispatching; no transfer was started."); }
    item.stop(); item.gesture = null;
    return { ok: true, result: { intentId: item.id, href: item.href, filename: item.filename } };
  }

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
    const intent = args.intentId ? live?.downloadIntents?.get(args.intentId) : null;
    const intentCurrent = () => intent && intent.scope === args.scope && intent.id === args.intentId
      && intent.documentId === live.documentId && intent.snapshotId === live.snapshotId && intent.pageUrl === location.href
      && intent.source.isConnected && Date.now() <= intent.expires && !intent.error && ["captured", "headers-ready", "transferring"].includes(intent.phase);
    const inventory = args.assetId ? live?.assetInventories?.get(args.inventoryId) : null;
    const asset = inventory && inventory.scope === args.scope ? inventory.items.get(args.assetId) : null;
    const current = () => live && live.documentId === args.documentId && location.href === args.expectedUrl
      && (args.assetId ? inventory?.documentId === live.documentId && inventory.pageUrl === location.href : live.snapshotId === args.snapshotId && live.url === location.href);
    const anchor = live?.nodes.get(args.node);
    const href = () => {
      if (args.intentId) return current() && intentCurrent() ? intent.href : null;
      if (args.assetId) return current() && asset ? asset.url : null;
      if (!current() || !anchor?.isConnected || !anchor.matches("a[href]")) return null;
      const rect = anchor.getBoundingClientRect(), style = getComputedStyle(anchor);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
      try {
        const value = new URL(anchor.href);
        value.hash = "";
        if (!["https:", "http:"].includes(value.protocol) || value.username || value.password) return null;
        return value.href;
      } catch { return null; }
    };
    const source = href();
    if (!source || (operation !== "inspect" && source !== args.href)) {
      const transfer = state.get(args.transferId);
      if (transfer) stop(transfer);
      return failure("DOWNLOAD_TARGET_CHANGED", "Read the current visible DOM before downloading its exact HTTP/HTTPS link. JavaScript buttons and blob URLs require a verified browser download event and are unsupported by this link route.");
    }
    if (operation === "inspect") return { ok: true, result: { href: source, url: location.href } };
    if (operation === "start") {
      if (typeof args.transferId !== "string" || state.has(args.transferId)) return failure("INVALID_DOWNLOAD", "A fresh download transfer is required.");
      const prepared = ["same-origin-policy", "cross-origin-policy", "tab-origin-policy"].includes(args.redirectPolicy);
      if (args.intentId && (!intentCurrent() || intent.phase !== (prepared ? "headers-ready" : "captured"))) return failure("DOWNLOAD_INTENT_USED", "This exact captured intent was already consumed or cancelled; no request was repeated.");
      if (prepared && (!intent?.response || intent.response.url !== source || intent.transferDeadline <= Date.now())) return failure("DOWNLOAD_HEADERS_EXPIRED", "The approved exact response expired before body transfer; it was not requested again.");
      if (intent) intent.phase = "transferring";
      const controller = prepared ? intent.controller : new AbortController();
      const transfer = { controller, bytes: 0, pending: null, offset: 0 };
      if (intent) { clearTimeout(intent.networkTimer); intent.abort = () => stop(transfer); }
      transfer.timer = setTimeout(() => { controller.abort(); state.delete(args.transferId); }, prepared ? intent.transferDeadline - Date.now() : 30000);
      state.set(args.transferId, transfer);
      try {
        if (asset?.inline) {
          const bytes = new TextEncoder().encode(asset.markup); let consumed = false;
          transfer.reader = { async read() { if (consumed) return { done: true }; consumed = true; return { done: false, value: bytes }; }, async cancel() {} };
          return { ok: true, result: { filename: asset.id + ".svg", mime: "image/svg+xml" } };
        }
        // Cross-origin sources pass original source/destination approval.
        // Ordinary-profile fetch preserves Safari's real credentialed CORS.
        // Manual redirects never contact an unapproved next destination.
        const crossOrigin = new URL(source).origin !== location.origin;
        const response = prepared ? intent.response : await fetch(source, { method: "GET", mode: asset || crossOrigin ? "cors" : "same-origin", credentials: asset || crossOrigin ? "include" : "same-origin",
          redirect: "manual", cache: "no-store", signal: controller.signal });
        if (prepared) intent.response = null;
        if (!current() || href() !== source) throw new Error("The download document changed during the request.");
        if (response.type === "opaqueredirect" || response.redirected || response.status >= 300 && response.status < 400) {
          stop(transfer);
          return failure("DOWNLOAD_REDIRECT_APPROVAL_REQUIRED", "Safari returned a redirect without a policy-approved destination identity. No redirected request or file write was performed; this download needs a verified browser download event.");
        }
        const responseURL = new URL(response.url);
        if (!response.ok || response.type === "opaque" || responseURL.href !== source ||
          (!["http:", "https:"].includes(responseURL.protocol) && !(asset && responseURL.protocol === "data:"))) {
          throw new Error("The download response did not retain its approved source identity.");
        }
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/u.test(length) || Number(length) > 32 * 1024 * 1024)) throw new Error("This download exceeds the 32 MiB limit.");
        if (!response.body) throw new Error("The download response has no readable body.");
        transfer.reader = response.body.getReader();
        let filename = asset?.name || intent?.filename || anchor?.getAttribute("download") || "";
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
          "The download request failed or Safari denied credentialed CORS access. Only the exact approved HTTP/HTTPS response can be saved; the request was not retried.");
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

  // Fixed, isolated-world export transfer. URLs are derived from the current
  // official document, never supplied by the model. Only bounded file bytes
  // cross to the operation-bound native writer after original download policy.
  async function contentExportPageOperation(operation, args) {
    const fail = message => ({ ok: false, error: { code: "CONTENT_EXPORT_REJECTED", message } });
    const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = "__chatGPTSafariLiveDocument";
    if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: { documentId: newId(), nodes: new Map(), snapshotId: null, url: location.href } });
    const live = globalThis[key];
    if (!live.contentExports) {
      live.contentExports = new Map();
      addEventListener("pagehide", () => { for (const item of live.contentExports.values()) { item.controller?.abort(); clearTimeout(item.timer); } live.contentExports.clear(); }, { once: true });
    }
    if (operation === "inspect") {
      if (typeof args.scope !== "string" || !args.scope || args.scope.length > 4096) return fail("A current sidebar account/session/turn scope is required.");
      const page = new URL(location.href);
      if (page.protocol !== "https:" || page.username || page.password || page.port) return fail("Exports require an official HTTPS document page.");
      let href, videoId, format = args.format;
      if (args.kind === "gsuite") {
        const parts = page.pathname.split("/").filter(Boolean), type = parts[0], position = parts.indexOf("d", 1), id = parts[position + 1];
        const formats = { document: ["pdf", "md", "docx"], spreadsheets: ["pdf", "xlsx", "csv"], presentation: ["pdf", "pptx"] };
        if (page.host !== "docs.google.com" || !formats[type]?.includes(format) || position < 0 || !/^[A-Za-z0-9_-]+$/.test(id || "") || parts.at(-1) === "pub") return fail("This Google Workspace page does not support the requested export format.");
        const exported = new URL(`https://docs.google.com/${type}/d/${id}/export`);
        exported.searchParams.set("format", format);
        if (page.searchParams.has("tab")) exported.searchParams.set("tab", page.searchParams.get("tab"));
        exported.hash = page.hash; href = exported.href;
      } else if (args.kind === "youtube") {
        videoId = page.searchParams.get("v"); format = "txt";
        if (!["www.youtube.com", "youtube.com"].includes(page.hostname) || page.pathname !== "/watch" || !/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return fail("Transcript export requires the current official YouTube watch page.");
        href = page.href;
      } else return fail("This content export is unsupported.");
      const titleParts = (args.kind === "youtube" ? "youtube-" + videoId : document.title || "ExportedContent").split(" - ");
      const title = (titleParts.length > 1 && titleParts.at(-1).startsWith("Google") ? titleParts.slice(0, -1).join(" - ") : titleParts.join(" - ")).replace(/[/\\?%*|"<>:\0]/gu, "_").trim().slice(0, 180) || "ExportedContent";
      const id = newId(), item = { id, scope: args.scope, documentId: live.documentId, pageUrl: location.href, href, kind: args.kind, format, videoId,
        filename: title + "-" + id + "." + format, createdAt: Date.now(), offset: 0 };
      if (live.contentExports.size >= 4) {
        const oldest = live.contentExports.values().next().value; oldest.controller?.abort(); clearTimeout(oldest.timer); live.contentExports.delete(oldest.id);
      }
      live.contentExports.set(id, item);
      // Original download approval can take longer than the byte-transfer limit.
      // Keep at most four small, exact-document inspections until approval;
      // pagehide, scope changes and eviction still invalidate their authority.
      return { ok: true, result: { exportId: id, documentId: item.documentId, pageUrl: item.pageUrl, href, kind: item.kind, format, videoId, filename: item.filename } };
    }
    const item = live.contentExports.get(args.exportId);
    const current = () => item && item.scope === args.scope && item.documentId === live.documentId && item.pageUrl === location.href
      && (item.startedAt === undefined || Date.now() - item.startedAt <= 30000);
    if (operation === "cancel") {
      if (item?.scope === args.scope) { item.controller?.abort(); clearTimeout(item.timer); live.contentExports.delete(item.id); }
      return { ok: true, result: { cancelled: true } };
    }
    if (!current()) return fail("The content export no longer belongs to this exact document and sidebar scope.");
    if (operation === "check") return { ok: true, result: { current: true, pageUrl: item.pageUrl, documentId: item.documentId, kind: item.kind, format: item.format, videoId: item.videoId } };
    if (operation === "start") {
      if (item.startedAt !== undefined) return fail("This export transfer already started; it was not repeated.");
      item.startedAt = Date.now();
      item.timer = setTimeout(() => { item.controller?.abort(); item.bytes = null; live.contentExports.delete(item.id); }, 30000);
      item.timer?.unref?.();
      if (item.kind === "youtube") {
        if (typeof args.text !== "string" || !args.text.startsWith("YouTube transcript\nVideo ID: " + item.videoId + "\n") || new TextEncoder().encode(args.text).length > 501000) return fail("The fixed YouTube helper returned an invalid or oversized transcript.");
        item.bytes = new TextEncoder().encode(args.text);
      } else {
        const controller = new AbortController(); item.controller = controller;
        try {
          const response = await fetch(item.href, { method: "GET", credentials: "same-origin", signal: controller.signal });
          const final = new URL(response.url), mime = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
          if (!current() || !response.ok || final.protocol !== "https:" || final.username || final.password
            || !(final.hostname === "docs.google.com" || final.hostname.endsWith(".googleusercontent.com")) || response.type === "opaque" || !response.body
            || !mime || /html|json|javascript|xml$/.test(mime)) throw new Error("The official Google export did not return an authenticated document response.");
          const declared = response.headers.get("content-length");
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > 32 * 1024 * 1024)) throw new Error("The Google export exceeds 32 MiB.");
          const reader = response.body.getReader(), chunks = []; let size = 0;
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (!current() || size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("The Google export changed document or exceeded 32 MiB."); }
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          if (!size || /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(new TextDecoder().decode(bytes.subarray(0, 256)))
            || item.format === "pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
            || ["docx", "pptx", "xlsx"].includes(item.format) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error("The Google response does not match the requested document format.");
          // Preserve the original Google's Markdown cleanup exactly.
          item.bytes = item.format === "md" ? new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/^\s*\[[^\]]+\]:\s*<data:[^>]+>\s*\n?/gm, "").trim()) : bytes;
        } catch (error) { return fail(error.message); }
        finally { controller.abort(); }
      }
      if (!current() || !item.bytes?.length) return fail("No nonempty document export was produced.");
      return { ok: true, result: { filename: item.filename, bytes: item.bytes.length } };
    }
    if (operation === "read") {
      if (!item.bytes) return fail("Start this approved content export before reading its bytes.");
      if (item.offset >= item.bytes.length) return { ok: true, result: { done: true, bytes: item.bytes.length } };
      const chunk = item.bytes.subarray(item.offset, item.offset + 48 * 1024); item.offset += chunk.length;
      let binary = ""; for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
      return { ok: true, result: { done: false, data: btoa(binary), bytes: chunk.length } };
    }
    return fail("Unknown fixed content export operation.");
  }

  // Adapted only from the version-bound upstream Me helper. MAIN is necessary
  // for YouTube's own player methods; no model script or extension API enters
  // this function. It restores the original captions state before returning.
  async function youtubeTranscriptPageOperation(videoId, expectedUrl) {
    const limits = { observationTimeoutMs: 4000, fetchTimeoutMs: 8000, maxJsonBytes: 5 * 1024 * 1024 };
    if (location.href !== expectedUrl || !/^https:\/\/(?:www\.)?youtube\.com\/watch\?/.test(expectedUrl) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const call = (object, name) => { const fn = Reflect.get(object, name); return typeof fn === "function" ? Reflect.apply(fn, object, []) : undefined; };
    const player = () => {
      const host = document.querySelector("ytd-player"), method = host && Reflect.get(host, "getPlayer");
      if (typeof method === "function") { const value = Reflect.apply(method, host, []); if (value && typeof value === "object") return value; }
      return document.querySelector("#movie_player");
    };
    const current = object => object && player() === object && location.href === expectedUrl && new URL(location.href).searchParams.get("v") === videoId && call(object, "getVideoData")?.video_id === videoId;
    const original = player();
    if (!current(original) || ["getVideoData", "isSubtitlesOn", "toggleSubtitles", "toggleSubtitlesOn"].some(name => typeof Reflect.get(original, name) !== "function")) return null;
    const started = performance.now(); let observed = null;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime + 0.5 >= started) {
        try { const url = new URL(entry.name); if (url.protocol === "https:" && url.hostname === "www.youtube.com" && url.pathname === "/api/timedtext" && url.searchParams.get("v") === videoId) observed = url; } catch { /* Ignore unrelated resource names. */ }
      }
    });
    observer.observe({ buffered: true, type: "resource" });
    const subtitles = !!call(original, "isSubtitlesOn");
    try {
      if (subtitles) call(original, "toggleSubtitles"); call(original, "toggleSubtitlesOn");
      const deadline = Date.now() + limits.observationTimeoutMs;
      while (Date.now() < deadline && !observed && current(original)) await new Promise(resolve => setTimeout(resolve, 150));
    } finally {
      try { if (current(original)) { const enabled = !!call(original, "isSubtitlesOn"); if (subtitles && !enabled) call(original, "toggleSubtitlesOn"); else if (!subtitles && enabled) call(original, "toggleSubtitles"); } }
      finally { observer.disconnect(); }
    }
    if (!observed || !current(original)) return null;
    observed.searchParams.set("fmt", "json3");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
    try {
      const response = await fetch(observed.href, { credentials: "include", redirect: "error", signal: controller.signal });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) return null;
      const declared = Number(response.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > limits.maxJsonBytes) return null;
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limits.maxJsonBytes || !current(original)) { await reader.cancel(); return null; } chunks.push(next.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return current(original) ? { body: new TextDecoder().decode(bytes), captionKind: observed.searchParams.get("kind"), captionLanguage: observed.searchParams.get("lang"), pageUrl: location.href } : null;
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); }
  }

  function formatYouTubeTranscript(videoId, data, expectedUrl) {
    if (!data || Object.keys(data).length !== 4 || data.pageUrl !== expectedUrl || typeof data.body !== "string" || new TextEncoder().encode(data.body).length > 5 * 1024 * 1024
      || [data.captionKind, data.captionLanguage].some(value => value !== null && (typeof value !== "string" || value.length > 100))) throw new Error("The fixed YouTube helper returned an invalid transcript response");
    let parsed; try { parsed = JSON.parse(data.body); } catch { throw new Error("The YouTube caption response was not JSON"); }
    if (!Array.isArray(parsed?.events)) throw new Error("No transcript is available for this YouTube video");
    const lines = ["YouTube transcript", `Video ID: ${videoId}`, `Language: ${data.captionLanguage ?? "unknown"}`, `Captions: ${data.captionKind === "asr" ? "auto-generated" : "authored or unspecified"}`, ""];
    const encoder = new TextEncoder(); let count = 0, size = encoder.encode(lines.join("\n")).length, truncated = false;
    for (const event of parsed.events) {
      if (count >= 5000) { truncated = true; break; }
      if (!event || typeof event.tStartMs !== "number" || !Number.isFinite(event.tStartMs) || event.tStartMs < 0 || !Array.isArray(event.segs)
        || !event.segs.every(segment => segment && typeof segment === "object" && (segment.utf8 === undefined || typeof segment.utf8 === "string"))) continue;
      const text = event.segs.map(segment => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim(); if (!text) continue;
      const second = Math.floor(event.tStartMs / 1000), hour = Math.floor(second / 3600), minute = Math.floor(second % 3600 / 60), remainder = second % 60;
      const line = `[${hour > 0 ? hour + ":" + String(minute).padStart(2, "0") : minute}:${String(remainder).padStart(2, "0")}] ${text}`;
      const bytes = encoder.encode("\n" + line).length; if (size + bytes > 500000) { truncated = true; break; }
      lines.push(line); size += bytes; count++;
    }
    if (!count) throw new Error("No transcript is available for this YouTube video");
    if (truncated) lines.push("", "[Transcript truncated]");
    return lines.join("\n");
  }

  function createExports({ api, target, send, profileId, sessionId, assertTime, unwrap }) {
    const page = async (tab, operation, args) => {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func: contentExportPageOperation, args: [operation, args] });
      return unwrap(value?.result);
    };
    const inspect = (tab, args) => page(tab, "inspect", args);
    async function execute(request, tab, args) {
      let nativeID, sequence = 0, bytes = 0;
      const check = async () => {
        assertTime(); await target(args.handle, tab.url); const binding = await page(tab, "check", args);
        if (binding.kind !== args.kind || args.kind === "gsuite" && binding.format !== args.format) throw new Error("The approved content export type or format changed");
        return binding;
      };
      const write = async input => { await check(); return unwrap(await send({ action: "liveDownload", id: request.id, profileId, sessionId, input })); };
      try {
        const binding = await check(); let text;
        if (binding.kind === "youtube") {
          const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: youtubeTranscriptPageOperation, args: [binding.videoId, binding.pageUrl] });
          await check(); text = formatYouTubeTranscript(binding.videoId, value?.result, binding.pageUrl);
        }
        const metadata = await page(tab, "start", { ...args, ...(text === undefined ? {} : { text }) });
        const opened = await write({ action: "begin", filename: metadata.filename }); nativeID = opened.transferId;
        for (;;) {
          await check(); const chunk = await page(tab, "read", args);
          if (chunk.done) {
            if (chunk.bytes !== bytes || bytes !== metadata.bytes) throw new Error("The exported document byte count changed before completion");
            const saved = await write({ action: "finish", transferId: nativeID, sequence, expectedBytes: bytes }); nativeID = undefined;
            return { path: saved.path };
          }
          if (!Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > chunkBytes || bytes + chunk.bytes > maximumBytes) throw new Error("The exported document exceeded its bounded transfer size");
          const written = await write({ action: "append", transferId: nativeID, sequence, data: chunk.data }); bytes += chunk.bytes; sequence++;
          if (written.bytesWritten !== bytes || written.sequence !== sequence) throw new Error("The native writer did not confirm the exact exported bytes");
        }
      } finally {
        await page(tab, "cancel", args).catch(() => {});
        if (nativeID) await send({ action: "liveDownload", id: request.id, profileId, sessionId, input: { action: "abort", transferId: nativeID } }).catch(() => {});
      }
    }
    return { inspect, execute };
  }

  function observeRedirectHeaders(api, tab, href, nonce, redirectPolicy = "same-origin-policy") {
    const names = ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived"];
    if (names.some(name => typeof api.webRequest?.[name]?.addListener !== "function" || typeof api.webRequest?.[name]?.removeListener !== "function")) {
      throw new Error("Safari's request/header observation APIs are unavailable. The redirect hop was not requested.");
    }
    const destination = new URL(href), filter = { urls: [destination.protocol + "//" + destination.hostname + "/*"] };
    const requests = new Map(), installed = []; let selected, timer, settled = false, resolve, reject, failure;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
    const fail = () => {
      failure ||= new Error("Safari could not prove one exact nonce/request/document-bound header response. The hop was not repeated.");
      if (!settled) { settled = true; reject(failure); }
    };
    const matches = details => details.tabId === tab.id && details.frameId === 0 && details.url === href;
    const identity = details => typeof details.requestId === "string" && details.requestId && typeof details.documentId === "string" && details.documentId;
    const before = details => {
      if (!matches(details)) return;
      if (!identity(details) || requests.size >= 16 && !requests.has(details.requestId)) { fail(); return; }
      requests.set(details.requestId, details.documentId);
    };
    const sent = details => {
      if (!matches(details)) return;
      const values = details.requestHeaders?.filter(header => header.name?.toLowerCase() === "x-chatgpt-safari-transfer") || [];
      if (!values.some(header => header.value === nonce)) return;
      if (values.length !== 1 || !identity(details) || requests.get(details.requestId) !== details.documentId
        || selected && selected.requestId !== details.requestId) { fail(); return; }
      selected = { requestId: details.requestId, documentId: details.documentId };
    };
    const headers = details => {
      if (!selected || details.requestId !== selected.requestId) return;
      if (!matches(details) || !identity(details) || details.documentId !== selected.documentId || !Number.isInteger(details.statusCode)) { fail(); return; }
      const locations = details.responseHeaders?.filter(header => header.name?.toLowerCase() === "location") || [];
      if ([301, 302, 303, 307, 308].includes(details.statusCode)) {
        if (locations.length !== 1 || typeof locations[0].value !== "string" || !locations[0].value.trim()) { fail(); return; }
        let next; try { next = new URL(locations[0].value, href); } catch { fail(); return; }
        next.hash = "";
        if (redirectPolicy === "same-origin-policy" && next.origin !== destination.origin || next.username || next.password || !["http:", "https:"].includes(next.protocol)) {
          failure = new Error("The observed redirect leaves its approved same origin. Its next destination was not contacted.");
          if (!settled) { settled = true; reject(failure); } return;
        }
        if (!settled) { settled = true; resolve({ kind: "redirect", href: next.href, status: details.statusCode }); }
      } else if (details.statusCode >= 200 && details.statusCode < 300 && locations.length === 0) {
        if (!settled) { settled = true; resolve({ kind: "response", href, status: details.statusCode }); }
      } else fail();
    };
    const cleanup = () => { clearTimeout(timer); for (const [event, listener] of installed) event.removeListener(listener); };
    try {
      for (const [name, callback, extra] of [[names[0], before, []], [names[1], sent, ["requestHeaders"]], [names[2], headers, ["responseHeaders"]]]) {
        api.webRequest[name].addListener(callback, filter, extra); installed.push([api.webRequest[name], callback]);
      }
      timer = setTimeout(fail, 30000); timer?.unref?.();
    } catch (error) { cleanup(); throw new Error("Safari denied the exact request/header observers. No redirect hop was requested."); }
    return { promise, cleanup, assertCurrent() { if (failure) throw failure; } };
  }

  function createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap, authorizeIntent }) {
    const main = async (tab, operation, args) => {
      const identity = JSON.stringify([tab.id, args.documentId]);
      let channelKey = causalChannels.get(identity), freshChannel = false;
      if (!channelKey && operation === "arm") {
        channelKey = "__chatGPTSafariCausal_" + root.crypto.randomUUID().replace(/-/g, "");
        causalChannels.set(identity, channelKey); freshChannel = true;
        // Retain only the current document's facade for each tab.
        for (const key of causalChannels.keys()) if (key !== identity && JSON.parse(key)[0] === tab.id) causalChannels.delete(key);
      }
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: causalCapture.operation,
        args: [operation, { channelKey, freshChannel, intentId: args.intentId, expectedUrl: args.expectedUrl, wait_ms: args.wait_ms, href: args.href }] });
      return unwrap(value?.result);
    };
    const causalCheck = async (tab, args) => {
      await authorizeIntent?.();
      if (args.capture !== "causal") return;
      await target(args.handle, args.expectedUrl);
      await intent(tab, "causal_check", args);
      const state = await main(tab, "check", args);
      if (!state.ready || (args.capturedHref || args.href) && state.href !== (args.capturedHref || args.href)) throw new Error("The causal download changed or is no longer ready; no request was repeated.");
    };
    async function page(tab, operation, args) {
      if (operation !== "cancel") await causalCheck(tab, args);
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: downloadPageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    async function intent(tab, operation, args) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func: downloadIntentPageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    async function realm(entry, operation, extra = {}) {
      if (operation !== "cancel") await target(entry.binding.handle, entry.binding.expectedUrl);
      const [value] = await api.scripting.executeScript({ target: { tabId: entry.tab.id, frameIds: [0] }, world: "ISOLATED",
        func: destinationRealm.realmPageOperation, args: [operation, { ...entry.binding, ...extra }] });
      return unwrap(value?.result);
    }
    async function cancelRealm(args) {
      const entry = realmTransfers.get(args.intentId);
      if (!entry || entry.binding.scope !== args.scope) return;
      realmTransfers.delete(args.intentId);
      await realm(entry, "cancel").catch(() => {});
    }
    async function sourceCheck(tab, args) {
      await authorizeIntent?.();
      assertTime(); await target(args.handle, args.expectedUrl); await causalCheck(tab, args);
      await intent(tab, "lease_check", args);
    }
    async function realmRedirectStep(tab, args) {
      await sourceCheck(tab, args);
      const matches = args.transportDocuments?.filter(document => new URL(document.expectedUrl).origin === new URL(args.href).origin) || [];
      if (matches.length !== 1) throw new Error("This destination requires one explicitly supplied, already-claimed ordinary Safari document of its own origin. No carrier tab or fallback request was created.");
      const binding = { ...matches[0], intentId: args.intentId, scope: args.scope, href: args.href };
      const entry = { tab: { id: binding.tabId }, binding }, nonce = root.crypto.randomUUID();
      await cancelRealm(args);
      const observer = observeRedirectHeaders(api, entry.tab, args.href, nonce, args.redirectPolicy);
      try {
        await realm(entry, "arm"); realmTransfers.set(args.intentId, entry);
        const budget = await intent(tab, "realm_reserve", { ...args, nonce });
        await sourceCheck(tab, args);
        const [response, receipt] = await Promise.all([realm(entry, "fetch", { nonce, remainingMs: Math.floor(budget.remainingMs) }), observer.promise]);
        observer.assertCurrent(); await target(args.handle, args.expectedUrl); await causalCheck(tab, args); await realm(entry, "check");
        if (response.kind !== receipt.kind || response.kind === "response" && (response.status !== receipt.status || response.url !== args.href)) throw new Error("The destination document response did not match its exact native nonce/request/document receipt.");
        await intent(tab, "realm_response", { ...args, nonce, kind: response.kind, elapsedMs: response.elapsedMs, status: response.status });
        const result = await intent(tab, "redirect_bind", { ...args, nonce, kind: receipt.kind, nextHref: receipt.href, status: receipt.status });
        if (result.kind === "redirect") await cancelRealm(args);
        return result;
      } catch (error) { await cancelRealm(args); await intent(tab, "cancel", args).catch(() => {}); throw error; }
      finally { observer.cleanup(); }
    }
    async function inventory(tab, operation, args) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: assetInventoryPageOperation, args: [operation, args] });
      return unwrap(value?.result);
    }
    async function listAssets(tab, args) {
      await target(args.handle);
      const result = await inventory(tab, "list", args);
      await target(args.handle, result.pageUrl); return result;
    }
    async function inspectAssets(tab, args) {
      const result = await inventory(tab, "inspect", args);
      await target(args.handle, result.pageUrl);
      return { pageUrl: result.pageUrl, assets: result.items.map(item => ({ id: item.id, url: item.url, inline: item.inline === true || /^(data|blob):/i.test(item.url) })) };
    }
    async function bundle(request, tab, args) {
      const started = Date.now(), selected = await inventory(tab, "inspect", args);
      if (!selected.items.length) throw new Error("The asset bundle matched no supported discovered assets");
      const binding = { ...args, documentId: selected.documentId, expectedUrl: selected.pageUrl };
      let bundleId, finished = false;
      const assets = [], failures = [];
      const write = async input => {
        assertTime(); await target(args.handle, binding.expectedUrl); await inventory(tab, "inspect", args);
        return unwrap(await send({ action: "liveDownload", id: request.id, profileId, sessionId, input }));
      };
      const acceptedType = (asset, contentType) => {
        const type = contentType?.split(";", 1)[0].trim().toLowerCase();
        if (!type) return asset.kind === "stylesheet";
        if (type === "application/octet-stream") return /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|css|mp4|webm|mov|m4v)(?:[?#]|$)/i.test(asset.url);
        return asset.kind === "image" ? type.startsWith("image/") : asset.kind === "video" ? type.startsWith("video/")
          : asset.kind === "stylesheet" ? type === "text/css" : type.startsWith("font/")
            || ["application/font-woff", "application/font-woff2", "application/vnd.ms-fontobject", "application/x-font-opentype", "application/x-font-ttf"].includes(type);
      };
      try {
        const destination = await write({ action: "bundleBegin" }); bundleId = destination.bundleId;
        for (const asset of selected.items) {
          assertTime();
          const transferArgs = { ...binding, assetId: asset.id, href: asset.url, transferId: root.crypto.randomUUID() };
          let nativeID, sequence = 0, bytes = 0, controller, reader, timer, contentType;
          try {
            const source = new URL(asset.url, binding.expectedUrl);
            const crossOrigin = !asset.inline && ["http:", "https:"].includes(source.protocol) && source.origin !== new URL(binding.expectedUrl).origin;
            let metadata;
            if (crossOrigin) {
              // The original security gate approved this observed asset origin.
              // Fetch inside Safari's extension process, never in the native app.
              controller = new AbortController(); timer = setTimeout(() => controller.abort(), 30000);
              const response = await fetch(source.href, { credentials: "include", redirect: "error", signal: controller.signal });
              if (!response.ok || response.redirected || response.type === "opaque" || !response.body) throw new Error("The observed asset could not be fetched without a redirect");
              contentType = response.headers.get("content-type"); reader = response.body.getReader();
              metadata = { filename: asset.id + "-" + asset.name, mime: contentType };
            } else metadata = await page(tab, "start", transferArgs);
            contentType ||= metadata.mime || null;
            if (!acceptedType(asset, contentType)) throw new Error(`Asset response type ${contentType || "missing"} is not valid for ${asset.kind}`);
            const opened = await write({ action: "begin", bundleId, filename: asset.id + "-" + (metadata.filename || asset.name) }); nativeID = opened.transferId;
            const append = async (encoded, count) => {
              if (bytes + count > maximumBytes) throw new Error("The asset exceeds the 32 MiB transfer limit");
              const written = await write({ action: "append", transferId: nativeID, sequence, data: encoded });
              bytes += count; sequence++;
              if (written.bytesWritten !== bytes || written.sequence !== sequence) throw new Error("The asset writer did not confirm the exact bytes");
            };
            for (;;) {
              assertTime(); await target(args.handle, binding.expectedUrl);
              if (reader) {
                const next = await reader.read();
                if (next.done) break;
                for (let offset = 0; offset < next.value.length; offset += chunkBytes) {
                  const chunk = next.value.subarray(offset, offset + chunkBytes);
                  let binary = ""; for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
                  await append(btoa(binary), chunk.length);
                }
              } else {
                const chunk = await page(tab, "read", transferArgs);
                if (chunk.done) { if (chunk.bytes !== bytes) throw new Error("The observed asset byte count changed"); break; }
                await append(chunk.data, chunk.bytes);
              }
            }
            const saved = await write({ action: "finish", transferId: nativeID, sequence, expectedBytes: bytes }); nativeID = undefined;
            assets.push({ contentType, id: asset.id, kind: asset.kind, name: asset.name, path: saved.path, url: asset.url });
          } catch (error) {
            if (["STALE_DOWNLOAD", "STALE_ASSET_INVENTORY", "AGENT_OWNER_CHANGED", "LIVE_TIMEOUT", "PROFILE_DISCONNECTED"].includes(error.code)) throw error;
            failures.push({ contentType: contentType || null, id: asset.id, name: asset.name, reason: error.message, url: asset.url });
          } finally {
            clearTimeout(timer); controller?.abort(); await reader?.cancel().catch(() => {});
            await page(tab, "cancel", transferArgs).catch(() => {});
            if (nativeID) await send({ action: "liveDownload", id: request.id, profileId, sessionId, input: { action: "abort", transferId: nativeID } }).catch(() => {});
          }
        }
        const result = await write({ action: "bundleFinish", bundleId, manifest: { assets, failures } }); finished = true;
        return { assets, failures, directoryPath: result.directoryPath, manifestPath: result.manifestPath,
          summary: { downloadedCount: assets.length, elapsedMs: Date.now() - started, failedCount: failures.length, requestedCount: selected.items.length } };
      } finally {
        if (bundleId && !finished) await send({ action: "liveDownload", id: request.id, profileId, sessionId, input: { action: "bundleCancel", bundleId } }).catch(() => {});
      }
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
    async function redirectStep(tab, args) {
      assertTime(); await target(args.handle, args.expectedUrl);
      await causalCheck(tab, args);
      const source = new URL(args.expectedUrl), destination = new URL(args.href);
      if (!["same-origin-policy", "cross-origin-policy", "tab-origin-policy"].includes(args.redirectPolicy)
        || !["http:", "https:"].includes(destination.protocol) || destination.username || destination.password
        || args.redirectPolicy === "same-origin-policy" && source.origin !== destination.origin) throw new Error("This explicit redirect route requires an exact HTTP(S) URL allowed by its selected policy.");
      if (args.redirectPolicy === "tab-origin-policy" && source.origin !== destination.origin) return realmRedirectStep(tab, args);
      const nonce = root.crypto.randomUUID(), observer = observeRedirectHeaders(api, tab, destination.href, nonce, args.redirectPolicy);
      try {
        const [response, receipt] = await Promise.all([intent(tab, "redirect_fetch", { ...args, nonce }), observer.promise]);
        observer.assertCurrent(); assertTime(); await target(args.handle, args.expectedUrl);
        if (response.kind !== receipt.kind || response.kind === "response" && (response.status !== receipt.status || response.url !== destination.href)) throw new Error("The observed headers did not match this exact manual page fetch. It was not repeated.");
        return await intent(tab, "redirect_bind", { ...args, nonce, kind: receipt.kind, nextHref: receipt.href, status: receipt.status });
      } catch (error) { await intent(tab, "cancel", args).catch(() => {}); throw error; }
      finally { observer.cleanup(); }
    }
    async function cancelIntent(tab, args) {
      await cancelRealm(args);
      if (args.capture === "causal") await main(tab, "cancel", args).catch(() => {});
      return intent(tab, "cancel", args);
    }
    async function armIntent(tab, args) {
      const result = await intent(tab, "arm", args);
      if (args.capture !== "causal") return result;
      try { await main(tab, "arm", args); await intent(tab, "marker_clear", args); return result; }
      catch (error) { await cancelIntent(tab, args).catch(() => {}); throw error; }
    }
    async function readIntent(tab, args) {
      if (args.capture !== "causal") return intent(tab, "read", args);
      const deadline = Date.now() + args.wait_ms;
      for (;;) {
        assertTime(); await target(args.handle, args.expectedUrl); await intent(tab, "causal_check", args);
        const state = await main(tab, "poll", args);
        if (state.ready) return intent(tab, "causal_adopt", { ...args, href: state.href, kind: state.kind, filename: state.filename });
        if (Date.now() >= deadline) throw new Error("File preparation exceeded its bounded wait. The delivered click was not repeated.");
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    }
    async function executeBlob(request, tab, args) {
      let nativeID, sequence = 0, bytes = 0;
      const write = async input => {
        assertTime(); await causalCheck(tab, args);
        return unwrap(await send({ action: "liveDownload", id: request.id, profileId, sessionId, input }));
      };
      try {
        await causalCheck(tab, args);
        const metadata = await main(tab, "start", args);
        const opened = await write({ action: "begin", filename: metadata.filename }); nativeID = opened.transferId;
        for (;;) {
          assertTime(); await causalCheck(tab, args);
          const chunk = await main(tab, "read", args);
          if (chunk.done) {
            if (chunk.bytes !== bytes || bytes !== metadata.bytes) throw new Error("The causal Blob byte count changed before completion.");
            const saved = await write({ action: "finish", transferId: nativeID, sequence, expectedBytes: bytes }); nativeID = undefined;
            return { ...saved, mime: metadata.mime };
          }
          if (!Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > chunkBytes || bytes + chunk.bytes > maximumBytes) throw new Error("The causal Blob exceeded its bounded transfer size.");
          const result = await write({ action: "append", transferId: nativeID, sequence, data: chunk.data }); bytes += chunk.bytes; sequence++;
          if (result.bytesWritten !== bytes || result.sequence !== sequence) throw new Error("The writer did not confirm the exact causal Blob bytes.");
        }
      } finally {
        if (nativeID) await send({ action: "liveDownload", id: request.id, profileId, sessionId, input: { action: "abort", transferId: nativeID } }).catch(() => {});
      }
    }
    async function executeRealm(request, tab, args) {
      const entry = realmTransfers.get(args.intentId);
      if (!entry || entry.binding.scope !== args.scope || entry.binding.href !== args.href) throw new Error("No exact approved destination-document response remains. It was not requested again.");
      let nativeID, sequence = 0, bytes = 0;
      const check = async () => { await sourceCheck(tab, args); await realm(entry, "check"); };
      const write = async input => { await check(); return unwrap(await send({ action: "liveDownload", id: request.id, profileId, sessionId, input })); };
      try {
        await check(); const metadata = await realm(entry, "metadata");
        const opened = await write({ action: "begin", filename: metadata.filename }); nativeID = opened.transferId;
        for (;;) {
          await check(); const chunk = await realm(entry, "read");
          if (chunk.done) {
            if (chunk.bytes !== bytes) throw new Error("The destination response byte count changed before completion.");
            const saved = await write({ action: "finish", transferId: nativeID, sequence, expectedBytes: bytes }); nativeID = undefined;
            return { ...saved, mime: metadata.mime };
          }
          if (!Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > chunkBytes || bytes + chunk.bytes > maximumBytes) throw new Error("The destination response exceeded its bounded transfer size.");
          const result = await write({ action: "append", transferId: nativeID, sequence, data: chunk.data }); bytes += chunk.bytes; sequence++;
          if (result.bytesWritten !== bytes || result.sequence !== sequence) throw new Error("The writer did not confirm the destination response's exact bytes.");
        }
      } finally {
        await cancelRealm(args);
        if (nativeID) await send({ action: "liveDownload", id: request.id, profileId, sessionId, input: { action: "abort", transferId: nativeID } }).catch(() => {});
      }
    }
    return { inspect, execute, listAssets, inspectAssets, bundle, redirectStep, armIntent, readIntent, cancelIntent, cancelTransport: cancelRealm,
      async executeIntent(request, tab, args) {
        try {
          if (args.capture === "causal" && new URL(args.href).protocol === "blob:") return await executeBlob(request, tab, args);
          if (args.redirectPolicy === "tab-origin-policy" && new URL(args.href).origin !== new URL(args.expectedUrl).origin) return await executeRealm(request, tab, args);
          return await execute(request, tab, args);
        }
        finally { await cancelIntent(tab, args).catch(() => {}); }
      } };
  }
  const bridge = Object.freeze({ createDownloads, createExports, downloadPageOperation, downloadIntentPageOperation, observeRedirectHeaders, contentExportPageOperation, youtubeTranscriptPageOperation, formatYouTubeTranscript, assetInventoryPageOperation, maximumBytes, chunkBytes });
  if (typeof module === "object" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariDownloads", { value: bridge });
})(globalThis);
