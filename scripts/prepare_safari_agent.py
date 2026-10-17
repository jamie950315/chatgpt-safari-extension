"""Version-bound transforms for the original Safari-side agent kernel."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources"
KERNEL_HOST = "chunks/js-kernel-host-Biytnb6r.js"
KERNEL_OFFSCREEN = "chunks/js-kernel-offscreen-DIYPN8p_.js"
BRIDGE_BEGIN = "/* BEGIN GENERATED SAFARI AGENT BRIDGE */\n"
BRIDGE_END = "/* END GENERATED SAFARI AGENT BRIDGE */\n"

API_SUPPORT_OVERRIDES = {
    "Browser.user": True,
    "BrowserUser.getTabContext": True,
    "Browser.capabilities": False,
    "Browser.history": False,
    "Tabs.new": False,
    "Tabs.content": False,
    "Tab.ax": False,
    "Tab.capabilities": False,
    "Tab.clipboard": False,
    "Tab.content": False,
    "Tab.cua": False,
    "Tab.dev": False,
    "Tab.dom_cua": True,
    "Tab.playwright": False,
    "Tab.screenshot": False,
    "Tab.getJsDialog": False,
    "Tab.requestManualHandoff": False,
    "DomCUAAPI.double_click": False,
    "DomCUAAPI.downloadMedia": False,
}

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
x(n,request).then(value=>port.postMessage(value),error=>port.postMessage({error:y(error),id:request.id,ok:!1})).finally(()=>port.close());
});chrome.runtime.onMessage.addListener('''
OFFSCREEN_HOST_URL = 'e.src=`${chrome.runtime.getURL("js-kernel-host.html")}?scopeId=${encodeURIComponent(n)}`'
OFFSCREEN_SANDBOX_URL = OFFSCREEN_HOST_URL + '+"&kernel="+encodeURIComponent(new URLSearchParams(location.search).get("kernel")??"")'

KERNEL_REPLACEMENTS = {
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
    source = replace_once(source, OFFSCREEN_START,
                          'async function Ud(){await globalThis.ChatGPTSafariAgentKernel.ensureHostDocument()}')
    source = replace_once(source, PORT_ORIGIN,
                          'a.protocol!==s.protocol||a.host.toLowerCase()!==s.host.toLowerCase()')
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
    source = replace_once(source, ',await n.endTurn(r)}async getInfo(e)',
                          ';try{await n.endTurn(r)}finally{globalThis.ChatGPTSafariAgent.release(t,r)}}async getInfo(e)')
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
    for name, transform in ((KERNEL_HOST, prepare_kernel_host), (KERNEL_OFFSCREEN, prepare_offscreen)):
        target = resources / name
        target.write_text(transform(target.read_text()))
