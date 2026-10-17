/* Downloads use the claimed page's own Safari session. Credentials never cross
 * the isolated-world boundary; only bounded response bytes reach the writer. */
(function (root) {
  "use strict";
  const maximumBytes = 32 * 1024 * 1024;
  const chunkBytes = 48 * 1024;

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
    const inventory = args.assetId ? live?.assetInventories?.get(args.inventoryId) : null;
    const asset = inventory && inventory.scope === args.scope ? inventory.items.get(args.assetId) : null;
    const current = () => live && live.documentId === args.documentId && location.href === args.expectedUrl
      && (args.assetId ? inventory?.documentId === live.documentId && inventory.pageUrl === location.href : live.snapshotId === args.snapshotId && live.url === location.href);
    const anchor = live?.nodes.get(args.node);
    const href = () => {
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
      const controller = new AbortController();
      const transfer = { controller, bytes: 0, pending: null, offset: 0 };
      transfer.timer = setTimeout(() => { controller.abort(); state.delete(args.transferId); }, 30000);
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
        const response = await fetch(source, { method: "GET", mode: asset || crossOrigin ? "cors" : "same-origin", credentials: asset || crossOrigin ? "include" : "same-origin",
          redirect: "manual", cache: "no-store", signal: controller.signal });
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
        let filename = asset?.name || anchor.getAttribute("download") || "";
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
      item.timer = setTimeout(() => { item.controller?.abort(); item.bytes = null; live.contentExports.delete(id); }, 30000);
      item.timer?.unref?.();
      return { ok: true, result: { exportId: id, documentId: item.documentId, pageUrl: item.pageUrl, href, kind: item.kind, format, videoId, filename: item.filename } };
    }
    const item = live.contentExports.get(args.exportId);
    const current = () => item && item.scope === args.scope && item.documentId === live.documentId && item.pageUrl === location.href && Date.now() - item.createdAt <= 30000;
    if (operation === "cancel") {
      if (item?.scope === args.scope) { item.controller?.abort(); clearTimeout(item.timer); live.contentExports.delete(item.id); }
      return { ok: true, result: { cancelled: true } };
    }
    if (!current()) return fail("The content export no longer belongs to this exact document and sidebar scope.");
    if (operation === "check") return { ok: true, result: { current: true, pageUrl: item.pageUrl, documentId: item.documentId, kind: item.kind, format: item.format, videoId: item.videoId } };
    if (operation === "start") {
      if (item.bytes || item.controller) return fail("This export transfer already started; it was not repeated.");
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

  function createDownloads({ api, target, send, profileId, sessionId, assertTime, unwrap }) {
    async function page(tab, operation, args) {
      const [value] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: downloadPageOperation, args: [operation, args] });
      return unwrap(value?.result);
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
    return { inspect, execute, listAssets, inspectAssets, bundle };
  }
  const bridge = Object.freeze({ createDownloads, createExports, downloadPageOperation, contentExportPageOperation, youtubeTranscriptPageOperation, formatYouTubeTranscript, assetInventoryPageOperation, maximumBytes, chunkBytes });
  if (typeof module === "object" && module.exports) module.exports = bridge;
  else Object.defineProperty(root, "ChatGPTSafariDownloads", { value: bridge });
})(globalThis);
