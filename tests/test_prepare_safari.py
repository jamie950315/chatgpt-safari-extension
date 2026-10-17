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
        self.assertFalse(helper.API_SUPPORT_OVERRIDES["Tabs.new"])
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


if __name__ == "__main__":
    unittest.main()
