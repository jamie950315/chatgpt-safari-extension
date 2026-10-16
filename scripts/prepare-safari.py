#!/usr/bin/env python3
"""Apply version-bound Safari adaptations to preserved upstream resources."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "vendor/background.chrome.js"
TARGET = ROOT / "safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/background.js"

REPLACEMENTS = {
    'async function El(e,t){await oa(e,':
        ('async function El(e,t){if(!chrome.debugger)throw new Error("Safari browser control is unavailable: the desktop runtime requires a CDP debugger, which Safari does not expose.");await oa(e,', 1),
    'async function k_(e,t){await Pl(t,':
        ('async function k_(e,t){if(!chrome.debugger)throw new Error("Safari browser control is unavailable: the desktop runtime requires a CDP debugger, which Safari does not expose.");await Pl(t,', 1),
    "const n=await P_(r.length===0?t:void 0);":
        ("const n=Yt(await this.tabGroups.createTab(this.sessionId,r.length===0?t:void 0));", 1),
    'tabGroups=zg.getInstance();':
        ('tabGroups=globalThis.ChatGPTSafariSessionWindows;', 1),
    'chrome.runtime.connectNative(this.application)':
        ('globalThis.ChatGPTSafariConnectNative(this.application)', 1),
    'function nc(){chrome.action.onClicked.addListener':
        ('function nc(){if(globalThis.ChatGPTSafariSidebar)return;chrome.action.onClicked.addListener', 1),
    'const f=new av(t);if(r)':
        ('const f=new av(t);globalThis.ChatGPTSafariNativeManager=f;if(r)', 1),
    'async function Fv(e){let t;const r=a=>{t=a,ga=ga.then(async()=>{if(e.aborted||a!==t||a.kind===ar?.kind)return;ar=void 0;const s=await ec(a);if(e.aborted||a!==t)return;const o=s?a:At;await wa(o,!0),ar=o}).catch(()=>{console.warn("Failed to update Chrome side panel destination.")})},i=await zv();if(!e.aborted){i?.kind==="work_sidepanel"&&await wa(i);try{await Rr(Ws,(a,s,o)=>{s==="Ready"?r(Zl(o==null||a)):t=void 0},e)}catch{r({kind:"waiting_room"})}}}':
        ('async function Fv(e){if(!e.aborted){await ec({kind:"work_sidepanel"});await wa({kind:"work_sidepanel"},!0)}}', 1),
    'family:this.browserFamily,name:Te[this.browserFamily].shortDisplayName,version:':
        ('family:"safari",name:"Safari",version:', 1),
    "this.onUpdateAvailable.addListener": ("this.onUpdateAvailable?.addListener", 1),
    "chrome.debugger.onDetach.addListener": ("chrome.debugger?.onDetach?.addListener", 2),
    "chrome.debugger.onEvent.addListener": ("chrome.debugger?.onEvent?.addListener", 1),
    "chrome.downloads.onCreated.addListener": ("chrome.downloads?.onCreated?.addListener", 1),
    "chrome.downloads.onChanged.addListener": ("chrome.downloads?.onChanged?.addListener", 1),
    "chrome.webNavigation.onCreatedNavigationTarget.addListener":
        ("chrome.webNavigation.onCreatedNavigationTarget?.addListener", 1),
    "const r=await chrome.debugger.getTargets();":
        ("if(chrome.debugger==null)return;const r=await chrome.debugger.getTargets();", 1),
}


def prepare(source: str) -> str:
    for old, (new, expected) in REPLACEMENTS.items():
        count = source.count(old)
        if count != expected:
            raise ValueError(f"Expected {expected} upstream matches for {old!r}; found {count}")
        source = source.replace(old, new)
    return source


def bounded_function(source: str, start: str, end: str) -> str:
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"Unexpected upstream function boundary: {start}")
    return source[source.index(start):source.index(end)]


def sidebar_functions() -> str:
    source = (ROOT / "vendor/chunks/codex-work-sidepanel-16q48QQM.js").read_text()
    workspace = (ROOT / "vendor/chunks/google-workspace-BnXIlG7d.js").read_text()
    declarations = [
        bounded_function(source, "function he(", "function Ye("),
        bounded_function(source, "function Ye(", 'var Fe="'),
        bounded_function(workspace, "function m(", "export{"),
    ]
    return "/* Preserved upstream selection functions, executed only by the background. */\n" + \
        "(()=>{" + "\n".join(declarations) + \
        "globalThis.ChatGPTSafariSidebarFunctions=Object.freeze({selection:he,removeSelection:Ye,recoverSelection:m});})();\n"


if __name__ == "__main__":
    resources = TARGET.parent
    adapters = ["native-transport.js", "diagnostics-background.js", "sidechat-preload-background.js", "sidebar-adapter.js", "session-windows.js"]
    TARGET.write_text(sidebar_functions() + "\n".join((resources / "safari" / name).read_text() for name in adapters)
                      + "\n" + prepare(SOURCE.read_text()))
    origin = '(()=>{const u=new URL(chrome.runtime.getURL("/"));return u.protocol+"//"+u.host})()'
    adaptations = {
        "codex-work-sidepanel.html": (
            '/chunks/codex-work-sidepanel-16q48QQM.js', '/safari/sidebar-frame-context.js', 1),
        "chunks/codex-work-sidepanel-16q48QQM.js": (
            'globalThis.chrome?.tabs?.query?.({active:!0,currentWindow:!0})',
            'globalThis.ChatGPTSafariSidebarFrame.owningTabPromise', 1),
        "content-scripts/side-chat-tab-mentions.js": (
            '`chrome-extension://${chrome.runtime.id}`', origin, 3),
    }
    for name, (old, new, expected) in adaptations.items():
        source = (ROOT / "vendor" / name).read_text()
        if source.count(old) != expected:
            raise ValueError(f"Unexpected upstream content in {name}")
        (resources / name).write_text(source.replace(old, new))
    chunk = resources / "chunks/codex-work-sidepanel-16q48QQM.js"
    source = chunk.read_text()
    replacements = {
        "chrome.scripting.executeScript": ("globalThis.ChatGPTSafariSidebarFrame.executeSelection", 4),
        "func:he": ('operation:"selection"', 2),
        "func:ke": ('operation:"recoverSelection"', 1),
        "func:Ye": ('operation:"removeSelection"', 1),
        "chrome.tabs.get(": ("globalThis.ChatGPTSafariSidebarFrame.tabs.get(", 3),
        "globalThis.chrome?.tabs?.get?.(r)": ("globalThis.ChatGPTSafariSidebarFrame.tabs.get(r)", 1),
        "chrome.tabs.create(": ("globalThis.ChatGPTSafariSidebarFrame.tabs.create(", 2),
        "chrome.tabs.update(": ("globalThis.ChatGPTSafariSidebarFrame.tabs.update(", 1),
        "chrome.tabs.remove(": ("globalThis.ChatGPTSafariSidebarFrame.tabs.remove(", 1),
        "chrome.action.getUserSettings()": ('globalThis.ChatGPTSafariSidebarFrame.getUserSettings()', 1),
        "chrome.commands.getAll()": ('globalThis.ChatGPTSafariSidebarFrame.getCommands()', 1),
    }
    for old, (new, expected) in replacements.items():
        if source.count(old) != expected:
            raise ValueError(f"Unexpected sidebar operation: {old}")
        source = source.replace(old, new)
    chunk.write_text(source)
    print("Prepared Safari transport, content sidebar, and bounded upstream adaptations.")
