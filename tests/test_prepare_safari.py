import importlib.util
from pathlib import Path
import unittest
import json
import subprocess

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("prepare_safari", ROOT / "scripts/prepare-safari.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafariPreparationTests(unittest.TestCase):
    def test_generated_agent_background_and_kernel_parse_and_are_idempotent(self):
        helper = module.prepare_safari_agent
        background = helper.prepare_background(module.prepare(module.SOURCE.read_text()))
        subprocess.run(["node", "--check"], input=background, text=True, capture_output=True, check=True)
        original = (ROOT / "unpacked" / helper.KERNEL_HOST).read_text()
        prepared = helper.prepare_kernel_host(original)
        self.assertEqual(helper.prepare_kernel_host(prepared), prepared)
        subprocess.run(["node", "--input-type=module", "--check"], input=prepared, text=True, capture_output=True, check=True)
        self.assertIn("ChatGPTSafariAgent.release(t,r)", background)
        for member in ["Tabs.new", "Browser.history", "Tab.dev", "Tab.capabilities", "Tab.playwright", "Tab.screenshot", "Tab.getJsDialog", "DomCUAAPI.double_click"]:
            self.assertTrue(helper.API_SUPPORT_OVERRIDES[member])
        self.assertFalse(helper.API_SUPPORT_OVERRIDES["PlaywrightAPI.evaluate"])
        self.assertTrue(helper.API_SUPPORT_OVERRIDES["PlaywrightAPI.waitForEvent"])
        self.assertTrue(helper.API_SUPPORT_OVERRIDES["Tab.content"])
        self.assertTrue(helper.API_SUPPORT_OVERRIDES["ContentAPI.exportGsuite"])
        self.assertTrue(helper.API_SUPPORT_OVERRIDES["ContentAPI.exportYouTubeTranscript"])
        self.assertFalse(helper.API_SUPPORT_OVERRIDES["ContentAPI.export"])
        self.assertIn("ChatGPTSafariAgentKernel.sendRequest(n)", background)
        offscreen = helper.prepare_offscreen((ROOT / "unpacked" / helper.KERNEL_OFFSCREEN).read_text())
        self.assertEqual(helper.prepare_offscreen(offscreen), offscreen)
        subprocess.run(["node", "--input-type=module", "--check"], input=offscreen, text=True, capture_output=True, check=True)

    def test_agent_host_channel_requires_its_real_extension_parent_and_reply_port(self):
        source = module.prepare_safari_agent.OFFSCREEN_PARENT_LISTENER
        source = source.removesuffix('chrome.runtime.onMessage.addListener(') + '}'
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
let listener,calls=0;
const parent={},window={parent,addEventListener(type,callback){assert.equal(type,"message");listener=callback}};
const sandbox={window,URL,Map,chrome:{runtime:{getURL:()=>"safari-web-extension://ACTUAL-OWNER/"}},
  m:value=>value?.type==="js-kernel:execute",y:()=>({name:"Error",message:"Synthetic execution failure"}),
  x:async(_scopes,request)=>{calls++;return{id:request.id,ok:true,output:{contentItems:[]}}}};
vm.createContext(sandbox);vm.runInContext(SOURCE+";E()",sandbox);
let response,closed=false;
const port={postMessage(value){response=value},close(){closed=true}};
const event={source:parent,isTrusted:true,origin:"safari-web-extension://actual-owner",ports:[port],data:{type:"js-kernel:execute",id:"fixture"}};
listener({...event,source:{}});listener({...event,isTrusted:false});listener({...event,origin:"https://attacker.invalid"});listener({...event,ports:[]});
assert.equal(calls,0);listener(event);
setImmediate(()=>{assert.equal(calls,1);assert.equal(response.id,"fixture");assert.equal(response.ok,true);assert.equal(closed,true)});
'''.replace("SOURCE", json.dumps(source)))

    def test_native_modal_capabilities_use_original_click_transport_and_parse_in_the_real_worker(self):
        helper = module.prepare_safari_agent
        host = helper.prepare_kernel_host((ROOT / "unpacked" / helper.KERNEL_HOST).read_text())
        worker = helper.prepare_kernel_worker((ROOT / "unpacked" / helper.KERNEL_WORKER).read_text())
        self.assertEqual(helper.prepare_kernel_worker(worker), worker)
        self.assertIn("safari_native_modal:Lt().optional()", host)
        self.assertIn('"capabilities/tab/nativeDialogs":', host)
        self.assertIn('"capabilities/tab/nativeUploads":', host)
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
const bundle=WORKER,start=bundle.indexOf("var c=")+6,end=bundle.indexOf("`,o=typeof self",start)+1;
assert.ok(start>5&&end>start);const worker=vm.runInNewContext(bundle.slice(start,end));new vm.Script(worker);
const calls=[],actual={kind:"dialog",type:"prompt",message:"Exact?",accepted:true,responseVerified:true,done:true};
class Base{constructor(transport,browserId,tabId,documentation,info){Object.assign(this,{transport,browserId,tabId,documentation,info})}}
const scope={Base,click:payload=>({type:"playwright_locator_click",...payload}),define:value=>value};
vm.createContext(scope);vm.runInContext(SDK,scope);
const transport={async send(value){calls.push(value.command);return actual}};
const options={browserId:"0",tabId:"12",transport};
const dialog=new scope.SafariNativeDialogsDefinition.capability(options),upload=new scope.SafariNativeUploadsDefinition.capability(options);
(async()=>{
assert.equal(await dialog.run({selector:"button",type:"prompt",message:"Exact?",accept:true,promptText:"Answer"}),actual);
assert.equal(calls[0].type,"playwright_locator_click");assert.equal(calls[0].tab_id,"12");assert.equal(calls[0].safari_native_modal.timeout_ms,10000);
assert.equal(calls[0].safari_native_modal.promptText,"Answer");
await upload.run({selector:"input[type=file]",files:["/owned/fixture.txt"]});
assert.equal(calls[1].safari_native_modal.kind,"upload");assert.equal(calls[1].safari_native_modal.files[0],"/owned/fixture.txt");
await assert.rejects(dialog.run({selector:"button",force:true}),/exact native dialog/);assert.equal(calls.length,2);
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace("WORKER", json.dumps(worker)).replace("SDK", json.dumps(helper.native_modal_sdk("Base", "click", "define"))))

    def test_original_tab_context_reads_open_authenticated_tabs_with_bounded_content(self):
        background = module.prepare_safari_agent.prepare_background(module.prepare(module.SOURCE.read_text()))
        # Execute only the preserved reader functions, never the application
        # bootstrap. The browser mock runs the actual extractor in each tab's
        # separate document, with no remote fetch or mutation API available.
        source = "\n".join([
            module.bounded_function(background, "function Vu(", 'var Hu="'),
            module.bounded_function(background, "async function Zu(", "function Ju("),
            module.bounded_function(background, "async function Bm(", "var Bi="),
        ])
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
const calls=[],tabs=new Map(),text=value=>({nodeType:3,textContent:value});
const element=(tag,children=[],attributes={})=>({nodeType:1,tagName:tag.toUpperCase(),
  namespaceURI:"http://www.w3.org/1999/xhtml",childNodes:children,
  getAttribute:name=>attributes[name]??null,...(tag==="input"?{type:attributes.type,value:attributes.value}: {})});
const documentFor=(url,body,title="Private tab")=>({location:{href:url},baseURI:url,title,body});
tabs.set(11,{id:11,url:"https://authenticated.example.invalid/one",document:documentFor(
  "https://authenticated.example.invalid/one",element("body",[text("SESSION_ONLY_ONE"),
    element("input",[],{type:"password",value:"DO_NOT_READ_PASSWORD"}),element("script",[text("DO_NOT_READ_SCRIPT")])]))});
tabs.set(12,{id:12,url:"https://authenticated.example.invalid/two",document:documentFor(
  "https://authenticated.example.invalid/two",element("body",[text("SESSION_ONLY_TWO")]))});
let afterCapture;
const sandbox={URL,Error,Ku:80000,it:"The selected tab changed while being read",chrome:{
  tabs:{get:async id=>({...tabs.get(id)})},scripting:{executeScript:async request=>{
    calls.push(request);assert.equal(request.world,"ISOLATED");
    const tab=tabs.get(request.target.tabId),scope={document:tab.document,URL,Node:{TEXT_NODE:3,ELEMENT_NODE:1},
      window:{getComputedStyle:()=>({display:"block",whiteSpace:"normal"})}};
    vm.createContext(scope);scope.args=request.args;
    const result=vm.runInContext("("+request.func.toString()+")(...args)",scope);
    afterCapture?.();return[{documentId:"document-"+tab.id,result}];
  }}}};
vm.createContext(sandbox);vm.runInContext(SOURCE+";globalThis.read=Bm;",sandbox);
const read=(id=11)=>sandbox.read({tabId:id,expectedUrl:tabs.get(id).url,read:{kind:"page"}});
(async()=>{
  const first=await read(),second=await read(12);
  assert.match(first.text,/SESSION_ONLY_ONE/);assert.doesNotMatch(first.text,/SESSION_ONLY_TWO|DO_NOT_READ/);
  assert.match(second.text,/SESSION_ONLY_TWO/);assert.doesNotMatch(second.text,/SESSION_ONLY_ONE/);
  assert.equal(first.truncated,false);assert.equal(second.truncated,false);
  assert.deepEqual(calls.map(call=>call.target.tabId),[11,12]);
  assert.deepEqual(Array.from(calls[0].args),[tabs.get(11).url,80000,80000]);
  tabs.get(12).document.body=element("body",[text("A".repeat(79999)+"😀TAIL"),text("SKIP_AFTER_LIMIT")]);
  const bounded=await read(12);assert.equal(bounded.text.length,79999);assert.equal(bounded.truncated,true);
  assert.doesNotMatch(bounded.text,/TAIL|SKIP_AFTER_LIMIT/);assert.equal(bounded.text.endsWith("\ud83d"),false);
  tabs.get(11).incognito=true;
  const before=calls.length;await assert.rejects(read(),/selected tab changed/);assert.equal(calls.length,before);
  tabs.get(11).incognito=false;afterCapture=()=>{tabs.get(11).url+="?changed"};
  await assert.rejects(read(),/selected tab changed/);
  afterCapture=undefined;
  await assert.rejects(sandbox.read({tabId:11,expectedUrl:"file:///private",read:{kind:"page"}}),/HTTP or HTTPS/);
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace("SOURCE", json.dumps(source)))

    def test_only_expected_capability_guards_are_applied(self):
        source = module.SOURCE.read_text()
        patched = module.prepare(source)
        expected_source = source
        for old, (new, expected) in module.REPLACEMENTS.items():
            expected_source = expected_source.replace(old, new)
        self.assertEqual(patched, expected_source)
        self.assertEqual(patched.count("chrome.browserAction."), 11)

    def test_persistent_manifest_preserves_permissions_resources_and_security_policies(self):
        original = json.loads((ROOT / "vendor/manifest.safari-input.json").read_text())
        result = module.prepare_manifest(original)
        self.assertEqual(result["manifest_version"], 2)
        self.assertEqual(result["background"], {"scripts": ["background.js"], "persistent": True})
        self.assertEqual(set(result["permissions"]), set(original["permissions"] + original["host_permissions"]))
        self.assertEqual(result["browser_action"], original["action"])
        self.assertEqual(result["commands"]["_execute_browser_action"], original["commands"]["_execute_action"])
        self.assertEqual(result["content_scripts"], original["content_scripts"])
        self.assertEqual(result["content_security_policy"], original["content_security_policy"]["extension_pages"] + " frame-src 'self' https://chatgpt.com http://*.localhost:*;")
        self.assertEqual(result["sandbox"]["content_security_policy"], original["content_security_policy"]["sandbox"])
        self.assertEqual(result["web_accessible_resources"], [r for group in original["web_accessible_resources"] for r in group["resources"]] + ["embedded-sidechat.html"])

    def test_changed_upstream_fails_instead_of_silently_skipping_a_guard(self):
        source = module.SOURCE.read_text().replace("chrome.debugger.onDetach.addListener", "changed")
        with self.assertRaises(ValueError):
            module.prepare(source)

    def run_javascript(self, source):
        subprocess.run(["node", "-e", source], check=True, capture_output=True, text=True)

    def test_browser_session_uses_only_the_owner_bound_native_provider(self):
        original = module.SOURCE.read_text()
        patched = module.prepare(original)
        session = module.bounded_function(patched, "async function Ar(e){", "var Cr=class")
        account = module.bounded_function(original, "function ps(e,t){", "function ms(e){")
        self.assertNotIn("fetch(", session)
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
let nativeCalls=0,fetchCalls=0,value;
const sandbox={AbortSignal,Promise,Error,jn:0,us:15000,
  fetch(){fetchCalls++;throw new Error("Safari cookies must not be read")},
  ChatGPTSafariSidebarOptions:{companion:{readBrowserSession(){nativeCalls++;return typeof value==="function"?value():Promise.resolve(value)}}}};
vm.createContext(sandbox);
vm.runInContext(SOURCE+"\nglobalThis.readSession=Ar;",sandbox);
const plain=value=>JSON.parse(JSON.stringify(value));
(async()=>{
  value={accessToken:"synthetic-fixture-token",account:{id:"account-fixture",structure:"personal"},user:{id:"user-fixture",email:"not-forwarded@example.invalid"}};
  assert.deepEqual(plain(await sandbox.readSession()),{status:200,session:{accessToken:value.accessToken,account:{id:"account-fixture",userId:"user-fixture",structure:"personal"}}});
  value=null;assert.deepEqual(plain(await sandbox.readSession()),{status:200,session:null});
  value={accessToken:"synthetic-fixture-token",account:{id:"account-fixture",structure:"invalid"},user:{id:"user-fixture"}};
  assert.deepEqual(plain(await sandbox.readSession()),{status:200,error:"decode"});
  value=()=>Promise.reject(new Error("Native owner changed"));
  await assert.rejects(sandbox.readSession(),/Native owner changed/);
  const before=nativeCalls,alreadyAborted=new AbortController();alreadyAborted.abort(new Error("Already closed"));
  await assert.rejects(sandbox.readSession(alreadyAborted.signal),/Already closed/);assert.equal(nativeCalls,before);
  value=()=>new Promise(()=>{});const closed=new AbortController(),pending=sandbox.readSession(closed.signal);
  closed.abort(new Error("Closed while reading"));await assert.rejects(pending,/Closed while reading/);
  assert.equal(fetchCalls,0);
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace("SOURCE", json.dumps(session + account)))

    def test_cloud_tunnel_diagnostics_expose_only_bounded_nonsecret_state(self):
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm"),sandbox={};
vm.createContext(sandbox);vm.runInContext(SOURCE,sandbox);
sandbox.safariObserveTunnelSetup({trigger:"startup",stage:"configure_polling",http_status:200,tunnel_id:"private-tunnel-fixture",apiKey:"private-token-fixture",account:{id:"private-account-fixture"}},"created");
sandbox.safariObserveTunnelPolling("connected",undefined,204);
let state=sandbox.ChatGPTSafariGetCloudTunnelState();
assert.equal(state.registered,true);assert.equal(state.polling.state,"connected");
const serialized=JSON.stringify(state);assert.equal(serialized.includes("private-"),false);
state.setup.stage="mutated-copy";assert.equal(sandbox.ChatGPTSafariGetCloudTunnelState().setup.stage,"configure_polling");
sandbox.safariObserveTunnelSetup({trigger:"private-trigger",stage:"private-stage",http_status:9999},"private-outcome");
state=sandbox.ChatGPTSafariGetCloudTunnelState();assert.equal(state.setup.trigger,"unknown");assert.equal(state.setup.stage,"unknown");
assert.equal(state.setup.httpStatus,null);assert.equal(state.registered,false);assert.equal(state.polling.state,"stopped");
'''.replace("SOURCE", json.dumps(module.CLOUD_TUNNEL_DIAGNOSTICS)))

    def test_app_session_refresh_reuses_original_setup_and_cleans_hook_on_stop(self):
        patched = module.prepare(module.SOURCE.read_text())
        tunnel = module.bounded_function(patched, "async function th(e){", "async function rh(")
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
const events={addListener(){},removeListener(){}},triggers=[];
let stopped=0;
const sandbox={Promise,AbortController,Date,URL,Error,console,setTimeout,clearTimeout,Vs:30000,Hs:60000,qn:"https://chatgpt.com",Dr:"retry",li:"health",
  Qd:()=>()=>{},nh:async metadata=>{triggers.push(metadata.trigger);return "unchanged"},
  rh:async()=>({suspend(){},resume:async()=>{},ensurePolling:async()=>{},stop(){stopped++}}),
  xr:async()=>null,
  chrome:{webNavigation:{onCompleted:events},alarms:{onAlarm:events,create:async()=>{},clear:async()=>{}}}};
vm.createContext(sandbox);vm.runInContext(SOURCE+"\nglobalThis.startTunnel=th;",sandbox);
(async()=>{
  const dispose=await sandbox.startTunnel(()=>{});
  assert.deepEqual(triggers,["startup"]);assert.equal(sandbox.ChatGPTSafariGetCloudTunnelState().running,true);
  await sandbox.ChatGPTSafariBrowserSessionChanged();assert.deepEqual(triggers,["startup","app_session"]);
  dispose();assert.equal(stopped,1);assert.equal(sandbox.ChatGPTSafariBrowserSessionChanged,undefined);
  assert.equal(sandbox.ChatGPTSafariGetCloudTunnelState().running,false);
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace("SOURCE", json.dumps(module.CLOUD_TUNNEL_DIAGNOSTICS + tunnel)))

    def test_inline_remount_does_not_cancel_active_tunnel_for_unchanged_app_session(self):
        self.run_javascript(r'''
const assert=require("node:assert/strict"),vm=require("node:vm");
let refreshes=0,observed,cached;
const account={id:"synthetic-account",userId:"synthetic-user",structure:"personal"};
const sandbox={xr:async()=>cached,Ar:async()=>observed,l:async trigger=>{assert.equal(trigger,"app_session");refreshes++}};
vm.createContext(sandbox);vm.runInContext(SOURCE+"globalThis.changed=safariSessionChanged",sandbox);
(async()=>{
  cached={apiKey:"synthetic-token",account}; observed={session:{accessToken:"synthetic-token",account}};
  await sandbox.changed(); assert.equal(refreshes,0,"Remount must leave active browser RPCs running");
  observed={session:{accessToken:"refreshed-token",account}};
  await sandbox.changed(); assert.equal(refreshes,1);
  observed={session:{accessToken:"synthetic-token",account:{...account,id:"another-account"}}};
  await sandbox.changed(); assert.equal(refreshes,2);
  observed={session:null}; await sandbox.changed(); assert.equal(refreshes,3);
  cached=null; await sandbox.changed(); assert.equal(refreshes,4);
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace("SOURCE", json.dumps(module.APP_SESSION_CHANGED)))


if __name__ == "__main__":
    unittest.main()
