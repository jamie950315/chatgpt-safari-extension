"""Version-bound transforms for the original Safari-side agent kernel."""

import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources"
KERNEL_HOST = "chunks/js-kernel-host-Biytnb6r.js"
KERNEL_OFFSCREEN = "chunks/js-kernel-offscreen-DIYPN8p_.js"
KERNEL_WORKER = "chunks/js-kernel-Ja-7IJxY.js"
BRIDGE_BEGIN = "/* BEGIN GENERATED SAFARI AGENT BRIDGE */\n"
BRIDGE_END = "/* END GENERATED SAFARI AGENT BRIDGE */\n"

API_SUPPORT_OVERRIDES = {
    "Browser.user": True,
    "BrowserUser.getTabContext": True,
    "Browser.capabilities": True,
    "Browser.history": True,
    "Tabs.new": True,
    "Tabs.content": False,
    "Tab.ax": False,
    "Tab.capabilities": True,
    "Tab.clipboard": True,
    "Tab.content": True,
    "ContentAPI.export": False,
    "ContentAPI.exportGsuite": True,
    "ContentAPI.exportYouTubeTranscript": True,
    "Tab.cua": True,
    "Tab.dev": True,
    "Tab.dom_cua": True,
    "Tab.playwright": True,
    "PlaywrightAPI.evaluate": False,
    "PlaywrightLocator.evaluate": False,
    "PlaywrightLocator.evaluateAll": False,
    "PlaywrightAPI.waitForEvent": True,
    "PlaywrightAPI.elementInfo": False,
    "PlaywrightAPI.elementScreenshot": False,
    "Tab.screenshot": True,
    "Tab.getJsDialog": True,
    "Tab.requestManualHandoff": False,
    "DomCUAAPI.double_click": True,
    "DomCUAAPI.downloadMedia": True,
}

MANAGEMENT_DOCUMENTATION = """# Safari Browser Capability: management
Use only for browser organization the user requested. This capability controls
ordinary Safari tabs and actual native Safari Tab Groups, retaining their logins.
Do not move, close, pin, or rename unrelated tabs. Claim each tab with
`browser.user.claimTab(...)` before changing it. Re-query after every mutation.
Management tab/window IDs are positive integers from `tabs.query`/`windows.getAll`,
not the string IDs from `browser.user.openTabs`. Match the observed tab first;
pass its numeric native ID to management methods.

## Supported methods
- `tabs.query({windowId?, active?, pinned?, title?, url?})` and `tabs.get(tabId)`.
- `tabs.move(tabIds, {index, windowId?})`, `tabs.update(tabId, {pinned})`,
  and `tabs.remove(tabIds)`. Cross-window moves require an explicit user request.
- `tabs.group({tabIds, createProperties?: {windowId}})` creates a real named
  Safari group and returns its local group handle. All tabs must be unpinned and
  in one window. Use `tabs.group({tabIds, groupId})` to join an observed group.
- `tabs.ungroup(tabIds)` moves those tabs into Safari's ungrouped collection.
- `tabGroups.query({windowId?, title?})`, `tabGroups.get(groupId)`, and
  `tabGroups.update(groupId, {title})`. Query in the sidebar's current window.
  Claim a visible member before renaming an existing group. A group created
  successfully by this same sidebar session can be renamed from its source
  collection without opening its hidden destination tabs.
- `windows.get(id)`, `windows.getAll({populate?})`, `windows.getCurrent()`,
  `windows.getLastFocused()` (the owning sidebar window), and
  `windows.update(id, {focused?, left?, top?, width?, height?, state?})`.
  Claim all tabs in a window before changing its layout.
- `windows.create({focused?, height?, left?, state?, tabId?, top?, type?, width?})`
  creates a normal window. Omit arguments for an empty window. Moving `tabId`
  requires a claimed, unpinned, non-sidebar tab from a verified unshared source.
  URL, private-window, and window-removal arguments are not supported.
- `bookmarks.getTree()`, `search(query)`, `get(idOrIds)`, `getChildren(id)`,
  `getSubTree(id)`, `update(id, {title?, url?})`, `create({title, url?, parentId?})`,
  `remove(id)`, `removeTree(id)`, and `move(id, {parentId})`
  use Safari's native bookmarks editor in a temporary ordinary-profile window.
  Bookmark handles bind the current account, profile, and observed native row;
  search again after a stale or ambiguous handle. Creation and removal require
  exact native proof while preserving unrelated bookmarks. Omit URL to create a
  folder. URL creation uses the official Add Bookmark sheet for an inert local
  page, then replaces its URL and title without visiting the destination site.
  Folder destinations must have unique native names; root creation requires a
  verified native root label and actual selected destination. Movement appends
  into an explicit visible native folder and verifies its actual parent, index,
  entire subtree, and unchanged unrelated hierarchy. Root drops, explicit
  insertion indices, and obscured/offscreen drag targets are unsupported. Native
  editor search must be empty; built-in collections are protected. Use removeTree
  for a nonempty folder. Never replay an uncertain mutation or substitute a
  private plist write.

## Safari group semantics
Safari groups are separate tab collections, not Chrome's colored inline groups.
Moving a tab into a group can remove it from the current collection. It does not
create another login session. Query the current tabs after each operation;
never replay an uncertain move. Keep the tab hosting the active sidebar outside
group/ungroup operations; open the sidebar in another existing tab first. A group result contains `id`, `title`, `windowId`, and
`nativeIdentity: {kind: 'safari-native-title', title, windowIdentifier}`.
Handles are session-local; renaming or changing windows can invalidate them.
Duplicate names, shared groups, unknown sharing state, Chrome color/collapse,
group reordering, and other unlisted methods are rejected.

`getAuditTrail()` reports recent successful changes across tasks in this browser
session, scoped to the verified ChatGPT account and Safari profile. Results are
newest first, up to 50 entries from the past 72 hours. Available native window
snapshots are retained; Chrome-only tab-layout fields are omitted. It is
not a full browser history or an automatic undo mechanism. Tell the user what
changed and how to reverse it using observed tabs/groups.
"""


def prepare_management_documentation(source: str) -> str:
    start = source.index('"capabilities/browser/management":`') + len('"capabilities/browser/management":`')
    end = source.index('`,"', start)
    document = MANAGEMENT_DOCUMENTATION.replace('`', '\\`').replace('${', '\\${')
    return source[:start] + document + source[end:]


VIEWPORT_DOCUMENTATION = """# Safari Browser Capability: viewport
Use only when the task needs exact CSS viewport dimensions or responsive
breakpoint testing. Do not resize merely to improve a screenshot. Claim a tab
and make it the original session's logical active tab before calling `set()`.
The tab must be in the same native window as the owning sidebar.

`set({width, height})` changes the actual ordinary Safari window, including its
other tabs. It is not an isolated or hidden viewport, device emulation, forced
DPR, mobile mode, or page zoom. Width and height are positive integer CSS pixels.
Success requires an exact measurement of `window.innerWidth/innerHeight` in the
same claimed document, with verified native Safari foreground/window identity.
Safari minimum sizes, browser UI, screen space, fullscreen and minimized windows
can prevent a requested size. There are at most three measured native size
adjustments. A failure attempts to restore the original window bounds; an
uncertain result must never be replayed automatically.

`reset()` restores the original native bounds and confirms the original CSS
viewport. Reset before finishing. Turn, sidebar owner and account teardown also
request restoration. Restoration never steals focus, changes another native
window, or overwrites a user's subsequent move/resize. An unconfirmed restoration
is an explicit error, not a successful reset. Do not navigate or change the claimed source document or its native collection
while it is sized. A verified return to the owning sidebar is tracked for safe
rollback; do not manually change that terminal selection before reset.

```ts
interface ViewportSize { height: number; width: number; }
interface ViewportBrowserCapability {
  set(options: ViewportSize): Promise<void>;
  reset(): Promise<void>;
}
```
"""


def prepare_viewport_documentation(source: str) -> str:
    prefix = '"capabilities/browser/viewport":`'
    start = source.index(prefix) + len(prefix)
    end = source.index('`,"', start)
    document = VIEWPORT_DOCUMENTATION.replace('`', '\\`').replace('${', '\\${')
    return source[:start] + document + source[end:]


def prepare_download_documentation(source: str) -> str:
    original = "downloadMedia(options: DomDownloadMediaOptions): Promise<void>; // Trigger a media download for a DOM node."
    previous = "downloadMedia(options: DomDownloadMediaOptions): Promise<void>; // Save a visible same-origin HTTP(S) file link to ~/Downloads using the page login after download approval (32 MiB, 30 seconds). Redirects, blob URLs and JavaScript buttons are unsupported."
    adapted = "downloadMedia(options: DomDownloadMediaOptions): Promise<void>; // Save a visible HTTP(S) file link to ~/Downloads after original page/source download approval (32 MiB, 30 seconds). Cross-origin links require the destination's credentialed CORS support in the ordinary Safari profile. Redirects, blob URLs and JavaScript buttons require a verified browser download event and are unsupported by this link route."
    if adapted not in source:
        source = replace_once(source, previous if previous in source else original, adapted)
    return source


def prepare_file_chooser_documentation(source: str) -> str:
    # Safari supports the original chooser event, not Chrome's intercepted
    # download event. Advertise only the overload with a real native backend.
    download = "{text:'waitForEvent(event: \"download\", options?: WaitForEventOptions): Promise<PlaywrightDownload>; // Wait for the next download to complete; call before clicking its download control.',references:[\"WaitForEventOptions\",\"PlaywrightDownload\"]},"
    source = source.replace(download, "")
    source = source.replace("// Wait for a file chooser.", "// Register before the native click. Safari supports direct inputs, labels, and input.click() in the trusted gesture; showPicker-only controls are unsupported.")
    source = source.replace("// Register before the native click. Safari supports direct inputs, labels, and input.click() in the trusted gesture; showPicker-only controls are unsupported.",
                            "// Safari may suspend extension callbacks while its native chooser is open. For known upload controls use the nativeUploads capability with explicit files approved before its opening click; do not replay an already delivered click.")
    source = source.replace("// Set the files for this chooser using absolute paths visible to the browser.", "// Choose explicit absolute local regular files in the native Safari panel after original upload approval. Multiple files must share a directory; no file bytes are read by the bridge.")
    return source


NATIVE_DIALOG_DOCUMENTATION = """# Safari Tab Capability: nativeDialogs
Safari suspends extension execution while a native JavaScript dialog is open.
Before clicking a control known to open one, use this single-operation capability
instead of click-then-getJsDialog. Never repeat a click that already opened one;
an unarmed blocking dialog must be dismissed manually before work can resume.

`await (await tab.capabilities.get('nativeDialogs')).run({selector, type,
message, accept, promptText?, timeout_ms?})`

Specify the exact expected `type` (`alert`, `confirm`, or `prompt`) and full
`message`, plus an explicit `accept` boolean. Alerts require `accept: true`.
Only accepting a prompt permits `promptText`. The original selector engine
resolves one actionable element, then a single native click and the registered
response execute in the same owner/account/profile/session/turn/document scope.
The native app checks the actual Safari window, page origin, type and exact
message before responding. A mismatch leaves the modal open without guessing;
manual dismissal may be needed before Safari can deliver that error to chat.
The response is consumed once and expires after `timeout_ms` (default 10000,
maximum 10000). Manual focus changes abort; input is never replayed.

The result reports the actual `kind`, `type`, `message`, `accepted`,
`promptTextApplied`, `responseVerified` and `done`. Read the page afterwards to
verify its application result. Cross-origin iframe modals are unsupported.
`getJsDialog()` retains its existing inspect/respond contract; it cannot make a
new extension request run while Safari itself has suspended the extension.
"""

NATIVE_UPLOAD_DOCUMENTATION = """# Safari Tab Capability: nativeUploads
Safari can suspend extension callbacks while its native file chooser is open.
Use `await (await tab.capabilities.get('nativeUploads')).run({selector, files,
timeout_ms?})` to approve explicit local files BEFORE the opening click.

`selector` must identify exactly one visible enabled `input[type=file]` in the
top-level or same-origin document. Hidden inputs and JavaScript-only buttons
are unsupported. `files` contains explicit absolute regular local file paths;
multiple files require the actual input's multiple attribute and one directory.
The original upload approval runs before the native click. The exact source
document/input and local file identities are rechecked after approval. No file
contents, cookies or credentials pass through the browser bridge.

The native app clicks once, verifies the exact source Safari window and its
actual native panel, chooses the approved files, and verifies the panel closed
before replying. The response expires after `timeout_ms` (default/maximum 10000).
The result contains `kind: 'upload'`, `fileCount`, `responseVerified` and `done`.
Read the page to verify its upload result. A mismatch or manual focus change
leaves the panel untouched and reports uncertainty; never replay that click.
The ordinary `waitForEvent('filechooser')` contract remains available, but cannot
resume extension JavaScript while Safari's native modal blocks its event loop.
"""



NATIVE_DOWNLOAD_DOCUMENTATION = """# Safari Tab Capability: nativeDownloads
Use `await (await tab.capabilities.get('nativeDownloads')).run({selector,
timeout_ms?, redirects?})` for a known top-level control whose real click synchronously
clicks a connected `a[download]` HTTP(S) anchor. A direct download anchor also
qualifies. This is a bounded anchor-intent transfer, not a native request waiter.

The original locator resolves one visible enabled control. The bridge arms its
exact document/snapshot/source/owner/account/profile/session/turn observer, then
posts one plain trusted native click. It cancels the observed anchor's default
action while the original source click is still dispatching, retains its actual
URL, and obtains original source/destination download approval before fetching
or writing any file. It does not replay the click or submit a replacement event.
The control's real JavaScript handler still runs; use it only for a known download
control, not an arbitrary action whose other effects should be suppressed.

The result contains `state: 'complete'`, `path`, `bytesWritten` and response MIME
only after actual operation-bound writing finishes in Downloads. Existing page
cookies remain in ordinary Safari. Cross-origin destinations require their real
credentialed CORS support. Transfer limits remain 32 MiB and 30 seconds.
`timeout_ms` bounds post-click intent observation (default 1000, maximum 3000),
not consent time. Captured receipts expire after 90 seconds and are single-use.

By default redirects are rejected. To allow policy-gated same-origin hops, set
`redirects: 'same-origin-policy'` explicitly. Every request remains manual: a fresh
nonsecret `X-ChatGPT-Safari-Transfer` header binds that exact fetch to Safari's
real requestId/documentId/header events. The next full URL is approved before
its request. At most five GET hops are allowed; cycles and cross-origin hops
are rejected by that option.

For redirects that may leave the source origin, explicitly use
`redirects: 'cross-origin-policy'`. The same full-URL approval and native request
proof run before every next request. Each hop uses ordinary-page
`credentials: 'include'` with `redirect: 'manual'`; Safari supplies only that
host's applicable login cookies. Cookie and Authorization headers are never
copied from the previous host. A cross-origin server must allow the page's exact
origin, credentials, GET, and the `X-ChatGPT-Safari-Transfer` header in its CORS
preflight. Without real credentialed CORS access the operation fails, returns no
saved path, and does not retry through a different transport. A failed CORS
check can still mean the approved destination received its one request.

The same-origin server must accept this header; no alternate request or retry
is attempted. The 30-second active network/body budget excludes approvals while
no request is active. Missing or mismatched header observations fail closed.

Location assignment, forms, detached anchors, later-task downloads, cross-origin
frames, blob/data URLs and unobservable/noncancelable responses are unsupported
and do not produce a completion path. After any uncertain delivered
click, inspect the page and never repeat that click automatically. The generic
`waitForEvent('download')` is not advertised as supported in Safari.
"""


def native_download_sdk(base: str, click: str, define: str) -> str:
    return f'''class SafariNativeDownloadsCapability extends {base}{{
constructor({{browserId,documentation,info,tabId,transport}}){{super(transport,browserId,tabId,documentation,info)}}
async run(options){{
if(!options||typeof options!=="object"||Array.isArray(options)||Object.keys(options).some(key=>!["selector","timeout_ms","redirects"].includes(key))||typeof options.selector!=="string"||!options.selector||!Number.isInteger(options.timeout_ms??1000)||(options.timeout_ms??1000)<1||(options.timeout_ms??1000)>3000||options.redirects!==undefined&&!["same-origin-policy","cross-origin-policy"].includes(options.redirects))throw new Error("Specify one known download-control selector, a 1–3000ms intent deadline, and optional same-origin-policy or cross-origin-policy redirects");
return this.transport.send({{command:{click}({{browser_id:this.browserId,tab_id:this.tabId,selector:options.selector,safari_download_intent:{{timeout_ms:options.timeout_ms??1000,...options.redirects===undefined?{{}}:{{redirects:options.redirects}}}}}}),timeoutMs:120000}})
}}
}}
var SafariNativeDownloadsDefinition={define}({{capability:SafariNativeDownloadsCapability,info:{{id:"nativeDownloads",description:"Capture one synchronous connected HTTP(S) anchor intent from a known native-clicked download control; approve its actual destination before ordinary-profile transfer. Read documentation first."}}}});
'''


def prepare_native_download_host(source: str) -> str:
    if "class SafariNativeDownloadsCapability" not in source:
        source = replace_once(source, 'safari_upload_source:Lt().optional()', 'safari_upload_source:Lt().optional(),safari_download_intent:Lt().optional()')
        source = replace_once(source, 'var Dp=ni({capability:Nk,info:Mk})', native_download_sdk("ri", "qT", "ni") + 'var Dp=ni({capability:Nk,info:Mk})')
        source = replace_once(source, 'Rp=[dk,nk,Qo,Ok,Dp,SafariNativeDialogsDefinition,SafariNativeUploadsDefinition]', 'Rp=[dk,nk,Qo,Ok,Dp,SafariNativeDialogsDefinition,SafariNativeUploadsDefinition,SafariNativeDownloadsDefinition]')
        source = replace_once(source, '"capabilities/tab/pageAssets":', '"capabilities/tab/nativeDownloads":' + json.dumps(NATIVE_DOWNLOAD_DOCUMENTATION) + ',"capabilities/tab/pageAssets":')
        source = replace_once(source, '{mode:"model",name:"capabilities/tab/pageAssets"}', '{mode:"model",name:"capabilities/tab/nativeDownloads"},{mode:"model",name:"capabilities/tab/pageAssets"}')
    else:
        start = source.index("class SafariNativeDownloadsCapability")
        end = source.index('var Dp=ni({capability:Nk,info:Mk})', start)
        source = source[:start] + native_download_sdk("ri", "qT", "ni") + source[end:]
    key = '"capabilities/tab/nativeDownloads":'
    start = source.index(key) + len(key)
    _, consumed = json.JSONDecoder().raw_decode(source[start:])
    source = source[:start] + json.dumps(NATIVE_DOWNLOAD_DOCUMENTATION) + source[start + consumed:]
    return source


def native_modal_sdk(base: str, click: str, define: str) -> str:
    """Use the original locator-click transport and original security gate."""
    return f'''class SafariNativeDialogsCapability extends {base}{{
constructor({{browserId,documentation,info,tabId,transport}}){{super(transport,browserId,tabId,documentation,info)}}
async run(options){{
if(!options||typeof options!=="object"||Object.keys(options).some(key=>!["selector","type","message","accept","promptText","timeout_ms"].includes(key)))throw new Error("Specify an exact native dialog selector, type, message, and explicit response");
const policy={{kind:"dialog",type:options.type,message:options.message,accept:options.accept,timeout_ms:options.timeout_ms??10000,...options.promptText===undefined?{{}}:{{promptText:options.promptText}}}};
return this.transport.send({{command:{click}({{browser_id:this.browserId,tab_id:this.tabId,selector:options.selector,safari_native_modal:policy}})}})
}}
}}
class SafariNativeUploadsCapability extends {base}{{
constructor({{browserId,documentation,info,tabId,transport}}){{super(transport,browserId,tabId,documentation,info)}}
async run(options){{
if(!options||typeof options!=="object"||Object.keys(options).some(key=>!["selector","files","timeout_ms"].includes(key)))throw new Error("Specify one visible file-input selector and explicit local files");
return this.transport.send({{command:{click}({{browser_id:this.browserId,tab_id:this.tabId,selector:options.selector,safari_native_modal:{{kind:"upload",files:options.files,timeout_ms:options.timeout_ms??10000}}}})}})
}}
}}
var SafariNativeDialogsDefinition={define}({{capability:SafariNativeDialogsCapability,info:{{id:"nativeDialogs",description:"Respond to one exact expected native JavaScript dialog within its opening click, before Safari suspends extension callbacks."}}}}),
SafariNativeUploadsDefinition={define}({{capability:SafariNativeUploadsCapability,info:{{id:"nativeUploads",description:"Approve explicit local files before clicking one visible file input, then complete its actual native Safari chooser atomically."}}}});
'''


def prepare_native_modal_host(source: str) -> str:
    if "class SafariNativeDialogsCapability" not in source:
        source = replace_once(source, '),NL=I({}),UT="playwright_locator_click"',
                              ').extend({safari_native_modal:Lt().optional(),safari_upload_source:Lt().optional()}),NL=I({}),UT="playwright_locator_click"')
        source = replace_once(source, 'var Dp=ni({capability:Nk,info:Mk}),Rp=[dk,nk,Qo,Ok,Dp]',
                              native_modal_sdk("ri", "qT", "ni") + 'var Dp=ni({capability:Nk,info:Mk}),Rp=[dk,nk,Qo,Ok,Dp,SafariNativeDialogsDefinition,SafariNativeUploadsDefinition]')
    for name, document in [("nativeDialogs", NATIVE_DIALOG_DOCUMENTATION), ("nativeUploads", NATIVE_UPLOAD_DOCUMENTATION)]:
        key = f'"capabilities/tab/{name}":'
        if key not in source:
            source = replace_once(source, '"capabilities/tab/pageAssets":', key + json.dumps(document) + ',"capabilities/tab/pageAssets":')
            source = replace_once(source, '{mode:"model",name:"capabilities/tab/pageAssets"}',
                                  f'{{mode:"model",name:"capabilities/tab/{name}"}},{{mode:"model",name:"capabilities/tab/pageAssets"}}')
    source = source.replace("// Get the active JavaScript dialog for this tab, if one is currently open.",
                            "// Inspect an existing dialog. Safari suspends extension callbacks while native modals are open; for a known opening control use nativeDialogs.run before the click, not a click-then-inspect round trip.")
    return source


def prepare_kernel_worker(source: str) -> str:
    if "class SafariNativeDialogsCapability" not in source:
        source = replace_once(source, '}), $u = n({}), Ys = "playwright_locator_click";',
                              '}).extend({safari_native_modal:Z().optional(),safari_upload_source:Z().optional()}), $u = n({}), Ys = "playwright_locator_click";')
        source = replace_once(source, '\tconst jo = de({', native_modal_sdk("ce", "Xs", "de") + '\tconst jo = de({')
        source = replace_once(source, '\t\tDo,\n\t\tjo\n', '\t\tDo,\n\t\tSafariNativeDialogsDefinition,\n\t\tSafariNativeUploadsDefinition,\n\t\tjo\n')
    if "class SafariNativeDownloadsCapability" not in source:
        source = replace_once(source, 'safari_upload_source:Z().optional()', 'safari_upload_source:Z().optional(),safari_download_intent:Z().optional()')
        source = replace_once(source, '\tconst jo = de({', native_download_sdk("ce", "Xs", "de") + '\tconst jo = de({')
        source = replace_once(source, '\t\tSafariNativeUploadsDefinition,\n', '\t\tSafariNativeUploadsDefinition,\n\t\tSafariNativeDownloadsDefinition,\n')
    else:
        start = source.index("class SafariNativeDownloadsCapability")
        end = source.index('\tconst jo = de({', start)
        source = source[:start] + native_download_sdk("ce", "Xs", "de") + source[end:]
    return source


def prepare_content_export_documentation(source: str) -> str:
    source = source.replace("// Export a Google Workspace tab using an explicit GSuite export type.",
                            "// Save this claimed, signed-in Google Workspace document to Downloads after download approval (32 MiB, 30 seconds). Documents: pdf/md/docx; sheets: pdf/xlsx/csv; slides: pdf/pptx. Return a path only after exact native writing succeeds.")
    source = source.replace("// Export an HTTPS youtube.com or www.youtube.com /watch transcript to a UTF-8 .txt file.",
                            "// Save the current claimed HTTPS YouTube watch video's captions to a UTF-8 txt file after download approval. The fixed player helper restores the original captions state. Missing captions fail explicitly; no logged-out network fetch is used.")
    return source


def prepare_assets_documentation(source: str) -> str:
    prefix = '"capabilities/tab/pageAssets":'
    start = source.index(prefix) + len(prefix)
    literal = re.match(r'''(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")''', source[start:])
    if not literal:
        raise ValueError("Expected the original pageAssets documentation literal")
    document = """# Safari Tab Capability: pageAssets
Use `list()` to inventory file URLs and inline SVGs observed in the current
document, its open shadow roots, same-origin frames, and Resource Timing entries.
Load lazy content first, then list again. Keep the returned inventory ID.

Call `bundle({inventoryId, assetIds?, kinds?})` to save observed images, fonts,
stylesheets, and videos in a new private `ChatGPT Page Assets` directory in
Downloads. The original asset-download approval and each fetch-origin approval
run before transfer. Session cookies stay inside Safari. Redirects are rejected.
The bundle is limited to 32 MiB including its manifest and 256 files including
the manifest. Script and other asset kinds are inventory-only.

The result contains actual saved paths, `directoryPath`, `manifestPath`,
`failures`, and the requested/downloaded/failed counts. Inspect `failures` before
claiming an asset was saved. Cancelling discards incomplete files and preserves
completed files. Files are quarantined and never opened automatically.
"""
    return source[:start] + json.dumps(document) + source[start + literal.end():]

OFFSCREEN_START = 'async function Ud(){const e="js-kernel-offscreen.html",t=chrome.runtime.getURL(e);if(!((await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[t]})).length>0)){Lr==null&&(Lr=chrome.offscreen.createDocument({justification:"Run isolated, persistent browser JavaScript kernels.",reasons:["IFRAME_SCRIPTING","WORKERS"],url:e}));try{await Lr}finally{Lr=null}}}'
PORT_ORIGIN = 'a.origin!==s.origin||a.protocol!==s.protocol||a.host!==s.host'
OFFSCREEN_ORIGIN = 'i.protocol!==c.protocol||i.host!==c.host'
OFFSCREEN_LISTENER = 'function E(){const n=new Map;chrome.runtime.onMessage.addListener('
OFFSCREEN_PARENT_LISTENER = '''function E(){const n=new Map;
window.addEventListener("message",event=>{
if(event.source!==window.parent||window.parent===window||!event.isTrusted||!m(event.data)||event.ports.length!==1)return;
let origin;try{origin=new URL(event.origin)}catch{return}
const expected=new URL(chrome.runtime.getURL(""));
if(origin.protocol!==expected.protocol||origin.host.toLowerCase()!==expected.host.toLowerCase())return;
const port=event.ports[0],request=event.data;
port.postMessage({type:"chatgpt-safari:kernel-progress",phase:"received"});
x(n,request).then(value=>port.postMessage(value),error=>port.postMessage({error:y(error),id:request.id,ok:!1})).finally(()=>port.close());
});chrome.runtime.onMessage.addListener('''
OFFSCREEN_HOST_URL = 'e.src=`${chrome.runtime.getURL("js-kernel-host.html")}?scopeId=${encodeURIComponent(n)}`'
OFFSCREEN_SANDBOX_URL = OFFSCREEN_HOST_URL + '+"&kernel="+encodeURIComponent(new URLSearchParams(location.search).get("kernel")??"")'

KERNEL_REPLACEMENTS = {
    'const c=new cF(chrome.runtime.connect({name:`browser-use-kernel:${e}`})),d=new uF(l)':
        'const c=globalThis.ChatGPTSafariAgentKernel.connectBrowser(e),d=new uF(l)',
    'function vl(e){return Jy[e?.family??"chrome"]}':
        'function vl(e){return e?.family==="safari"?{displayName:"Safari",shortDisplayName:"Safari",backendCompatibilityKey:"chrome"}:Jy[e?.family??"chrome"]}',
    'return await W.security.runCommand({type:V,params:j},async()=>(':
        'return await W.security.runCommand({type:V,params:j},async()=>globalThis.ChatGPTSafariAgentKernel.dispatch(W,{type:V,...j},async()=>(',
    'await W.executeUnhandledCommand({type:V,...j}))))}),V===Hs.type':
        'await W.executeUnhandledCommand({type:V,...j})))))}),V===Hs.type',
    'if(u==null)throw new Error("JavaScript browser session is unavailable");':
        'if(u==null)throw Object.assign(new Error(d.ok?"JavaScript browser session is unavailable":d.error?.message??"JavaScript sandbox initialization failed"),{name:d.ok?"Error":d.error?.name??"Error"});',
    't.src=chrome.runtime.getURL("js-kernel.html")':
        't.sandbox="allow-scripts allow-same-origin",t.src=globalThis.ChatGPTSafariAgentKernel.sandboxURL()',
}


def replace_once(source: str, old: str, new: str) -> str:
    count = source.count(old)
    if count != 1:
        raise ValueError(f"Expected one upstream Safari agent match for {old!r}; found {count}")
    return source.replace(old, new)


def bridge_source() -> str:
    return (RESOURCES / "safari/agent-kernel-bridge.js").read_text()


def prepare_background(source: str) -> str:
    """Run on the already guarded upstream background, before adapter prefixing."""
    # Keep the original authenticated-tab extractor and security gate. Its
    # caller disables both native bounds with null; Safari context reads need
    # the extractor's existing traversal and output limits instead.
    source = replace_once(source, 'case"page":return await r(Vu,[e,null,null],"ISOLATED")',
                          'case"page":return await r(Vu,[e,8e4,8e4],"ISOLATED")')
    source = replace_once(source, OFFSCREEN_START,
                          'async function Ud(){await globalThis.ChatGPTSafariAgentKernel.ensureHostDocument()}')
    source = replace_once(source, PORT_ORIGIN,
                          'a.protocol!==s.protocol||a.host.toLowerCase()!==s.host.toLowerCase()')
    # Same-document Safari frames do not deliver runtime messaging to their own
    # background. Accept the real host MessagePort after exact frame validation,
    # without inventing a runtime sender or changing the original RPC/security.
    old = 'r.get(i)?.close();const o=new Rd(n);r.set(i,o),o.addCloseListener(()=>{r.get(i)===o&&(r.delete(i),t?.(i))});const[l,h]=kd(o,m=>"type"in m&&m.type==="control"?"a":"b",(m,d)=>d==="a"?{...m,type:"control"}:m);try{e(i,h,l)}catch(m){throw o.close(),m}})}'
    new = 'accept(i,new Rd(n))});function accept(i,o){r.get(i)?.close();r.set(i,o),o.addCloseListener(()=>{r.get(i)===o&&(r.delete(i),t?.(i))});const[l,h]=kd(o,m=>"type"in m&&m.type==="control"?"a":"b",(m,d)=>d==="a"?{...m,type:"control"}:m);try{e(i,h,l)}catch(m){throw o.close(),m}}globalThis.ChatGPTSafariAgentKernel.onBrowserConnection(accept)}'
    source = replace_once(source, old, new)
    source = replace_once(source, 't=await chrome.runtime.sendMessage(e),r=this.readResponse(t,e.id)',
                          't=await globalThis.ChatGPTSafariAgentKernel.sendRequest(e),r=this.readResponse(t,e.id)')
    source = replace_once(source, 'const s=chrome.runtime.sendMessage(n);try{',
                          'const s=globalThis.ChatGPTSafariAgentKernel.sendRequest(n);try{')
    source = replace_once(source, 'a=chrome.runtime.sendMessage(d).catch(()=>{})',
                          'a=globalThis.ChatGPTSafariAgentKernel.sendRequest(d).catch(()=>{})')
    source = replace_once(source, 'async executeUnhandledCommand(e){const t=',
                          'async executeUnhandledCommand(e){if(e.type==="browser_safari_context"){const t=await this.activateSession(e);await globalThis.ChatGPTSafariAgent.authorize(t,e);return{}}if(e.type==="browser_safari_command"){const t=await this.activateSession(e);return globalThis.ChatGPTSafariAgent.execute(e.command,t,e)}const t=')
    source = replace_once(source, 'apiSupportOverrides:{"BrowserUser.getTabContext":!0}',
                          'apiSupportOverrides:' + json.dumps(API_SUPPORT_OVERRIDES, separators=(",", ":")))
    source = replace_once(source, 'browser:[Go.info,...await this.browserManagementEnabled?[Mo.info]:[]]',
                          'browser:[{...Go.info,description:"Set exact measured CSS dimensions by resizing the real ordinary Safari window. Native focus, screen and minimum-size limits apply. Read Safari-specific documentation and reset before finishing."},...await this.browserManagementEnabled?[{...Mo.info,description:"Organize ordinary Safari tabs and native named tab groups. Read Safari-specific documentation first."}]:[]]')
    source = replace_once(source, 'tab:[y_,...await this.webMcpConfig?.enabled()?[Ao]:[]]',
                          'tab:[y_,{id:"nativeDialogs",description:"Respond to one exact expected native JavaScript dialog within its opening click. Read documentation first."},{id:"nativeUploads",description:"Approve explicit files before clicking a visible file input, then complete its actual native Safari chooser. Read documentation first."},{id:"nativeDownloads",description:"Capture one synchronous connected HTTP(S) anchor intent from a known download control; approve before ordinary-profile transfer. Read documentation first."}]')
    source = replace_once(source, ',await n.endTurn(r)}async getInfo(e)',
                          ';try{await n.endTurn(r)}finally{await globalThis.ChatGPTSafariAgent.release(t,r)}}async getInfo(e)')
    return bridge_source() + "\n" + source


def prepare_kernel_host(source: str) -> str:
    """Rebuild the tiny bounded patch in the tracked upstream host resource."""
    generated = source.startswith(BRIDGE_BEGIN)
    if generated:
        if source.count(BRIDGE_BEGIN) != 1 or source.count(BRIDGE_END) != 1:
            raise ValueError("Unexpected generated Safari agent bridge boundary")
        source = source.split(BRIDGE_END, 1)[1]
        for old, new in KERNEL_REPLACEMENTS.items():
            source = replace_once(source, new, old) if new in source else replace_once(source, old, old)
    for old, new in KERNEL_REPLACEMENTS.items():
        source = replace_once(source, old, new)
    source = source.replace('unsupportedByDefaultIn:["iab","mcpapps"],documented:!1},get_visible_dom:',
                            'unsupportedByDefaultIn:["iab","mcpapps"],documented:!0},get_visible_dom:')
    source = prepare_management_documentation(source)
    source = prepare_viewport_documentation(source)
    source = prepare_download_documentation(source)
    source = prepare_file_chooser_documentation(source)
    source = prepare_content_export_documentation(source)
    source = prepare_assets_documentation(source)
    source = prepare_native_modal_host(source)
    source = prepare_native_download_host(source)
    source = source.replace("// Read clipboard items, including text and binary payloads.",
                            "// Read this original session clipboard only; no OS clipboard read occurs. Supported native page copy/cut results retain their text/HTML/PNG/TIFF/JPEG/PDF/RTF MIME entries.")
    source = source.replace("// Write clipboard items.",
                            "// Store session MIME items only. Rich Cmd+V uses a short-lived native clipboard bridge, preserves prior user clipboard data in memory, and restores it only after its exact trusted page-event receipt unless a newer user copy supersedes it. Missing delivery receipt leaves safe temporary data and memory-only recovery pending; do not replay input or restart the app while pending. Supported native paste: plain/HTML/RTF text, PNG/TIFF/JPEG/PDF binary, 8 MiB. Unknown/file-URL types fail explicitly; no synthetic paste or silent plaintext downgrade.")
    source = source.replace("Read console log messages captured for this tab.",
                            "Read this turn's console capture (up to 500 messages, starting at first claim or navigation, for at most five minutes). Earlier browser logs are unavailable.")
    return BRIDGE_BEGIN + bridge_source() + "\n" + BRIDGE_END + source


def prepare_offscreen(source: str) -> str:
    adapted = 'i.protocol!==c.protocol||i.host.toLowerCase()!==c.host.toLowerCase()'
    if adapted not in source:
        source = replace_once(source, OFFSCREEN_ORIGIN, adapted)
    if OFFSCREEN_PARENT_LISTENER not in source:
        source = replace_once(source, OFFSCREEN_LISTENER, OFFSCREEN_PARENT_LISTENER)
    if OFFSCREEN_SANDBOX_URL not in source:
        source = replace_once(source, OFFSCREEN_HOST_URL, OFFSCREEN_SANDBOX_URL)
    return source


def prepare_resources(resources: Path = RESOURCES) -> None:
    """Update host resources without requiring a duplicate upstream bundle."""
    for name, transform in ((KERNEL_HOST, prepare_kernel_host), (KERNEL_OFFSCREEN, prepare_offscreen), (KERNEL_WORKER, prepare_kernel_worker)):
        target = resources / name
        target.write_text(transform(target.read_text()))
    prepare_playwright_helper(resources)


def prepare_playwright_helper(resources: Path) -> None:
    """Package the upstream selector engine as static isolated-world code.

    Only a string literal is decoded. The upstream bundle is never evaluated by
    the build, and runtime model scripts never enter this helper.
    """
    source = (resources / KERNEL_HOST).read_text()
    matches = re.findall(r"var rO=('(?:\\.|[^'\\])*'),nO=", source)
    if len(matches) != 1:
        raise ValueError("Expected exactly one upstream Playwright injected literal")
    engine = ast.literal_eval(matches[0])
    if not engine.startswith("var PlaywrightInjected=") or not engine.endswith(";\n"):
        raise ValueError("Unexpected upstream Playwright injected resource")
    header = "/* Upstream Playwright selector helper, preserved from extension 1.26.1005.11759. */\n"
    initializer = r'''
if (!globalThis.__chatGPTSafariPlaywright) {
  const injected = new PlaywrightInjected.InjectedScript(window, {
    isUnderTest: false, sdkLanguage: "javascript", testIdAttributeName: "data-testid",
    stableRafCount: 1, browserName: "webkit", customEngines: [],
  });
  injected.isProtectedCredentialField = element => {
    if (!element.matches("input,textarea,select")) return false;
    if (element.getAttribute("type")?.toLowerCase() === "hidden") return true;
    const attributes = ["type", "autocomplete", "id", "name", "placeholder", "aria-label", "title"];
    return /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\botp\b|\b(?:2fa|mfa)\b|phone|mobile|\btel\b/i.test(attributes.map(name => element.getAttribute(name) || "").join(" "));
  };
  Object.defineProperty(globalThis, "__chatGPTSafariPlaywright", { value: injected });
  window.addEventListener("message", event => {
    if (!event.isTrusted || event.source !== window.parent || window.parent === window
      || event.data?.type !== "chatgpt-safari:resolve-frame" || !/^[a-f0-9-]{36}$/.test(event.data.nonce || "")) return;
    const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
    const key = "__chatGPTSafariLiveDocument";
    if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: {
      documentId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""),
      nodes: new Map(), snapshotId: null, url: location.href,
    } });
    runtime?.sendMessage({ type: "chatgpt-safari:frame-identity", nonce: event.data.nonce, documentId: globalThis[key].documentId }).catch(() => {});
  });
}
'''
    (resources / "safari/playwright-injected.js").write_text(header + "(() => {\n" + engine + initializer + "\n})();\n")
