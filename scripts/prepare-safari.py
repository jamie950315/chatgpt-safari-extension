#!/usr/bin/env python3
"""Apply version-bound Safari adaptations to preserved upstream resources."""

from pathlib import Path
import copy
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_safari_agent

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "vendor/background.chrome.js"
TARGET = ROOT / "safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/background.js"

BROWSER_SESSION_SOURCE = r'''async function Ar(e){
jn++;
const timeout=AbortSignal.timeout(us),signal=e==null?timeout:AbortSignal.any([e,timeout]);
signal.throwIfAborted();
const companion=globalThis.ChatGPTSafariSidebarOptions?.companion;
if(typeof companion?.readBrowserSession!=="function")throw new Error("The app-owned ChatGPT session provider is unavailable");
let cancel;
try{
const value=await Promise.race([companion.readBrowserSession(),new Promise((resolve,reject)=>{
cancel=()=>reject(signal.reason);signal.addEventListener("abort",cancel,{once:!0});if(signal.aborted)cancel();
})]);
signal.throwIfAborted();
if(value===null)return{status:200,session:null};
try{
if(typeof value?.accessToken!=="string"||!value.accessToken.trim()||value.accessToken.length>131072)return{status:200,error:"decode"};
return{status:200,session:{accessToken:value.accessToken,account:ps(value.account,value.user.id)}};
}catch{return{status:200,error:"decode"}}
}finally{if(cancel)signal.removeEventListener("abort",cancel)}
}'''

# This state never contains the upstream setup object, registration IDs, account
# identifiers, native capabilities, or credentials. The original tunnel owns retries.
CLOUD_TUNNEL_DIAGNOSTICS = r'''
var safariTunnelState={kernelGate:null,running:!1,registered:!1,setup:null,polling:null};
function safariTunnelHttpStatus(value){return Number.isInteger(value)&&value>=100&&value<=599?value:null}
function safariObserveTunnelSetup(value,outcome){
const triggers=["startup","navigation","retry","unauthorized","invalid_tunnel","app_session"],
stages=["session","session_decode","read_configuration","create_tunnel","save_registration","configure_polling","start_polling"],
outcomes=["created","refreshed","unchanged","invalid_session","failed"];
safariTunnelState.setup={trigger:triggers.includes(value.trigger)?value.trigger:"unknown",stage:stages.includes(value.stage)?value.stage:"unknown",outcome:outcomes.includes(outcome)?outcome:"unknown",httpStatus:safariTunnelHttpStatus(value.http_status)};
safariTunnelState.registered=["created","refreshed","unchanged"].includes(outcome);
if(!safariTunnelState.registered)safariTunnelState.polling={state:"stopped",reason:null,httpStatus:null};
}
function safariObserveTunnelPolling(state,reason,httpStatus){
safariTunnelState.polling={state:["connected","failed","offline","stopped","recovered"].includes(state)?state:"unknown",reason:["http","network","invalid_response","unknown"].includes(reason)?reason:null,httpStatus:safariTunnelHttpStatus(httpStatus)};
}
globalThis.ChatGPTSafariGetCloudTunnelState=()=>JSON.parse(JSON.stringify(safariTunnelState));
'''

REPLACEMENTS = {
    'async function Ar(e){jn++;const t=AbortSignal.timeout(us),r=await fetch(`${qn}/api/auth/session`,{cache:"no-store",credentials:"include",redirect:"error",signal:e==null?t:AbortSignal.any([e,t])}),{status:n}=r;if(!r.ok)return{status:n,error:"http",retryAfterMs:ms(r)};let i;try{i=await r.json()}catch{return{status:n,error:"decode"}}if(typeof i=="object"&&i!=null&&!Array.isArray(i)&&Object.keys(i).length===0)return{status:n,session:null};try{const a=i;return a.error!=null||!a.accessToken.trim()?{status:n,error:"decode"}:{status:n,session:{accessToken:a.accessToken,account:ps(a.account,a.user.id),...typeof a.user.email=="string"?{email:a.user.email}:{}}}}catch{return{status:n,error:"decode"}}}':
        (BROWSER_SESSION_SOURCE, 1),
    'var Vs=3e4': (CLOUD_TUNNEL_DIAGNOSTICS + 'var Vs=3e4', 1),
    'function Qd(){let e;return(t,r)=>{const n={...t,outcome:r},i=JSON.stringify(n);i!==e&&(e=i,ai("setup",n))}}':
        ('function Qd(){let e;return(t,r)=>{safariObserveTunnelSetup(t,r);const n={...t,outcome:r},i=JSON.stringify(n);i!==e&&(e=i,ai("setup",n))}}', 1),
    'function zd(e){let t;return(r,n,i)=>{const a=`${r}:${n??""}:${i??""}`;if(a===t)return;const s=r==="connected"&&t!==void 0;t=a,ai("polling",{state:s?"recovered":r,tunnel_id:e,reason:n,http_status:i})}}':
        ('function zd(e){let t;return(r,n,i)=>{safariObserveTunnelPolling(r,n,i);const a=`${r}:${n??""}:${i??""}`;if(a===t)return;const s=r==="connected"&&t!==void 0;t=a,ai("polling",{state:s?"recovered":r,tunnel_id:e,reason:n,http_status:i})}}', 1),
    'chrome.webNavigation.onCompleted.addListener(h,{url:[{hostEquals:new URL(qn).hostname}]});const d=f=>':
        ('safariTunnelState.running=!0;const safariSessionChanged=()=>l("app_session");globalThis.ChatGPTSafariBrowserSessionChanged=safariSessionChanged;chrome.webNavigation.onCompleted.addListener(h,{url:[{hostEquals:new URL(qn).hostname}]});const d=f=>', 1),
    'm.stop()}}async function rh':
        ('m.stop();safariTunnelState.running=!1;safariTunnelState.registered=!1;safariTunnelState.polling={state:"stopped",reason:null,httpStatus:null};if(globalThis.ChatGPTSafariBrowserSessionChanged===safariSessionChanged)delete globalThis.ChatGPTSafariBrowserSessionChanged}}async function rh', 1),
    'Rr(Iw,v=>{v&&d()},m.signal)':
        ('Rr(Iw,v=>{safariTunnelState.kernelGate=v===!0;v&&d()},m.signal)', 1),
    'JSON.stringify({device_name:"Chrome",instance_id:l})':
        ('JSON.stringify({device_name:"Safari",instance_id:l})', 1),
    'async function xv({reason:e}){e!=="install"||Mn(globalThis.navigator)==="opera"||await wt(Dv).catch(()=>!1)&&await chrome.tabs.create({active:!0,url:`${Ir}/work/extension/installed`})}':
        ('async function xv(){}', 1),  # Setup belongs to the native Safari companion, not Chrome's installation page.
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
        ('const f=new av(t);globalThis.ChatGPTSafariNativeManager=f;globalThis.ChatGPTSafariHooks={getInstanceId:Ce,getTabMentions:v=>l.getUserTabs(v)};if(r)', 1),
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
    "chrome.action.": ("chrome.browserAction.", 11),
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


def prepare_manifest(original: dict) -> dict:
    """Use Safari's supported persistent background without changing authority."""
    if original["manifest_version"] != 3:
        raise ValueError("The preserved Safari input manifest must use version 3")
    manifest = copy.deepcopy(original)
    manifest["manifest_version"] = 2
    manifest["background"] = {"scripts": ["background.js"], "persistent": True}
    manifest["browser_action"] = manifest.pop("action")
    manifest["commands"]["_execute_browser_action"] = manifest["commands"].pop("_execute_action")
    manifest["permissions"] += manifest.pop("host_permissions")
    policy = manifest["content_security_policy"]
    if set(policy) != {"extension_pages", "sandbox"}:
        raise ValueError("Unexpected upstream content security policies")
    manifest["content_security_policy"] = policy["extension_pages"] + " frame-src 'self' https://chatgpt.com http://*.localhost:*;"
    manifest["sandbox"]["content_security_policy"] = policy["sandbox"]
    resources = manifest["web_accessible_resources"]
    if not all(set(group) == {"matches", "resources"} and group["matches"] == ["<all_urls>"] for group in resources):
        raise ValueError("A scoped web-accessible resource group cannot be flattened")
    manifest["web_accessible_resources"] = [resource for group in resources for resource in group["resources"]] + ["embedded-sidechat.html"]
    return manifest


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
    manifest = prepare_manifest(json.loads((ROOT / "vendor/manifest.safari-input.json").read_text()))
    (resources / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    adapters = ["native-transport.js", "diagnostics-background.js", "sidechat-preload-background.js", "companion-background.js", "live-background.js", "agent-background.js", "sidebar-adapter.js", "session-windows.js"]
    TARGET.write_text(sidebar_functions() + "\n".join((resources / "safari" / name).read_text() for name in adapters)
                      + "\n" + prepare_safari_agent.prepare_background(prepare(SOURCE.read_text())))
    prepare_safari_agent.prepare_resources(resources)
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
    print("Prepared Safari transport, persistent background, and native side-chat adapters.")
