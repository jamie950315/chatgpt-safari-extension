const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { operation } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/download-capture-main.js");
const { dispatch } = require("../safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/safari/agent-kernel-bridge.js");

function fixture(wait_ms = 1000) {
  const context = vm.createContext({ URL: class extends URL {}, Blob, Uint8Array, btoa, setTimeout, clearTimeout, queueMicrotask,
    location: { href: "https://example.test/owned" }, addEventListener() {}, removeEventListener() {} });
  vm.runInContext(`
    globalThis.window=globalThis;
    const listeners=new Set(), attrs=new Map();
    globalThis.source={isConnected:true,tagName:'BUTTON',hasAttribute:name=>attrs.has(name)};
    globalThis.document={querySelectorAll:selector=>attrs.has(selector.slice(1,-1))?[source]:[],
      addEventListener(type,fn){listeners.add(fn)},removeEventListener(type,fn){listeners.delete(fn)}};
    source.ownerDocument=document;
    globalThis.HTMLAnchorElement=class {
      constructor(){this.ownerDocument=document;this.isConnected=false;this.href='https://example.test/file';this.handlers=new Set()}
      hasAttribute(name){return name==='download'}getAttribute(){return 'owned.bin'}
      addEventListener(type,fn){this.handlers.add(fn)}removeEventListener(type,fn){this.handlers.delete(fn)}
      click(){const event={cancelable:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
        for(const fn of this.handlers)fn(event);if(!event.defaultPrevented)globalThis.unintercepted++}
    };
    let blobId=0;URL.createObjectURL=()=> 'blob:https://example.test/'+(++blobId);URL.revokeObjectURL=()=>{};
    globalThis.unintercepted=0;
    globalThis.nativeClick=callback=>{const event={isTrusted:true,cancelable:true,eventPhase:1,preventDefault(){},composedPath:()=>[source,document]};
      for(const fn of listeners)fn(event);event.eventPhase=3;callback();event.eventPhase=0};
    attrs.set('data-chatgpt-download-11111111-1111-4111-8111-111111111111','');
    globalThis.originalClick=HTMLAnchorElement.prototype.click;
  `, context);
  const args = { intentId: "11111111-1111-4111-8111-111111111111", expectedUrl: context.location.href, wait_ms,
    channelKey: "__chatGPTSafariCausal_0123456789abcdef0123456789abcdef" };
  const run = async (action, extra = {}) => {
    const value = await vm.runInContext(`(${operation.toString()})(action,args)`, Object.assign(context, { action, args: { ...args, ...(action === "arm" ? { freshChannel: !context[args.channelKey] } : {}), ...extra } }));
    if (!value.ok) throw new Error(value.error.message);
    return value.result;
  };
  const click = code => vm.runInContext(`nativeClick(()=>{${code}})`, context);
  return { context, args, run, click, eval: code => vm.runInContext(code, context) };
}

test("causal capture takes over detached export calls before any anchor listener or native default", async () => {
  const f = fixture(); await f.run("arm");
  f.click(`const a=new HTMLAnchorElement();a.addEventListener('click',()=>globalThis.handlerRan=true);a.click()`);
  const state = await f.run("poll"); assert.equal(state.ready, true); assert.equal(state.href, "https://example.test/file");
  assert.equal(f.context.handlerRan, undefined); assert.equal(f.context.unintercepted, 0);
  await f.run("cancel"); assert.equal(f.eval("HTMLAnchorElement.prototype.click===originalClick"), true);
});

test("the page cannot replace its immutable capture manager or forge a candidate", async () => {
  const f = fixture(); await f.run("arm"); f.click("");
  assert.equal(f.eval(`Reflect.defineProperty(globalThis,'${f.args.channelKey}',{value:{invoke:()=>({ok:true,result:{ready:true,href:'https://example.test/unrelated'}})}})`), false);
  assert.equal(f.eval(`Reflect.deleteProperty(globalThis,'${f.args.channelKey}')`), false);
  assert.equal((await f.run("poll")).ready, false);
  await f.run("cancel");
});

test("same-document URL changes still cancel hooks and the manager accepts a fresh subsequent operation", async () => {
  const f = fixture(); await f.run("arm"); f.click("setTimeout(()=>new HTMLAnchorElement().click(),50)");
  f.context.location.href += "#manual-change"; await f.run("cancel");
  assert.equal(f.eval("HTMLAnchorElement.prototype.click===originalClick"), true);
  f.args.expectedUrl = f.context.location.href; await f.run("arm"); f.click("new HTMLAnchorElement().click()");
  assert.equal((await f.run("poll")).ready, true); await f.run("cancel");
});

test("explicit Promise and timer chains retain operation context and wait for their callback tree", async () => {
  const f = fixture(); await f.run("arm");
  f.click(`Promise.resolve().then(()=>new Promise(resolve=>setTimeout(()=>{new HTMLAnchorElement().click();resolve()},25)))`);
  assert.equal((await f.run("poll")).ready, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await f.run("poll")).ready, true); assert.equal(f.context.unintercepted, 0);
  await f.run("cancel");
});

test("a retained causal Blob survives immediate URL revocation and reads once in bounded chunks", async () => {
  const f = fixture(); await f.run("arm");
  f.click(`const a=new HTMLAnchorElement();a.href=URL.createObjectURL(new Blob(['A'.repeat(60000)]));a.click();URL.revokeObjectURL(a.href)`);
  const state = await f.run("poll"); assert.equal(state.kind, "blob"); assert.equal(state.bytes, 60000);
  const args = { href: state.href }; assert.equal((await f.run("start", args)).bytes, 60000);
  await assert.rejects(f.run("start", args), /already started/);
  const first = await f.run("read", args), second = await f.run("read", args), done = await f.run("read", args);
  assert.equal(first.bytes, 49152); assert.equal(second.bytes, 10848); assert.equal(done.done, true); assert.equal(done.bytes, 60000);
  assert.equal(Buffer.from(first.data + "", "base64").length + Buffer.from(second.data, "base64").length, 60000);
  await f.run("cancel");
});

test("multiple causal anchors, expired preparation and native-await gaps never become ready", async () => {
  for (const mode of ["multiple", "expiry", "await"]) {
    const f = fixture(mode === "expiry" ? 15 : 1000); await f.run("arm");
    if (mode === "multiple") f.click(`setTimeout(()=>new HTMLAnchorElement().click(),1);setTimeout(()=>new HTMLAnchorElement().click(),10)`);
    if (mode === "expiry") f.click("");
    if (mode === "await") f.click(`(async()=>{await null;new HTMLAnchorElement().click()})()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    if (mode === "await") { assert.equal((await f.run("poll")).ready, false); assert.equal(f.context.unintercepted, 1); }
    else await assert.rejects(f.run("poll"), mode === "multiple" ? /multiple/ : /deadline/);
    await f.run("cancel");
  }
});

test("unrelated calls and cancelled operations are not captured; changed hooks are not overwritten", async () => {
  const f = fixture(); await f.run("arm");
  f.eval("new HTMLAnchorElement().click()"); assert.equal((await f.run("poll")).ready, false); assert.equal(f.context.unintercepted, 1);
  f.click(`const timer=setTimeout(()=>new HTMLAnchorElement().click(),500);clearTimeout(timer);new HTMLAnchorElement().click()`);
  assert.equal((await f.run("poll")).ready, true);
  f.eval("globalThis.foreignClick=function(){};HTMLAnchorElement.prototype.click=foreignClick");
  await assert.rejects(f.run("poll"), /hooks changed/);
  await f.run("cancel"); assert.equal(f.eval("HTMLAnchorElement.prototype.click===foreignClick"), true);
});

test("cancelling preparation retires only its tagged timers and queued Promise callbacks", async () => {
  const f = fixture(); await f.run("arm");
  f.eval("setTimeout(()=>globalThis.unrelatedRan=true,20)");
  f.click("setTimeout(()=>new HTMLAnchorElement().click(),25);Promise.resolve().then(()=>new HTMLAnchorElement().click())");
  await f.run("cancel");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.context.unintercepted, 0); assert.equal(f.context.unrelatedRan, true);
});

test("an expired synchronous handler cannot outrun a throttled preparation timer and issue a default request", async () => {
  const f = fixture(1); await f.run("arm");
  f.click("const until=Date.now()+10;while(Date.now()<until){};new HTMLAnchorElement().click()");
  await assert.rejects(f.run("poll"), /deadline/);
  assert.equal(f.context.unintercepted, 0); await f.run("cancel");
});

test("original Blob security approves its real website origin before writer completion", async () => {
  const calls = [], command = { type: "playwright_locator_click", browser_id: "0", tab_id: "12",
    safari_download_intent: { capture: "causal", redirects: "cross-origin-policy" } };
  const context = { clientInfo: { family: "safari" }, security: {
    async ensureDownloadAllowed(tab, origin) { assert.equal(tab, 12); assert.equal(origin, "https://example.test"); calls.push("approve"); },
    async ensureApprovedDownloadStillAllowed() { calls.push("recheck"); }
  }, api: { async executeUnhandledCommand({ command: value }) {
    calls.push(value.type);
    if (value.type === "safari_download_capture") return { kind: "blob", intentId: "actual", href: "blob:https://example.test/object" };
    if (value.type === "safari_download_complete") return { state: "complete", path: "/Downloads/actual" };
  } } };
  assert.equal((await dispatch(context, command, () => assert.fail())).state, "complete");
  assert.deepEqual(calls, ["safari_download_capture", "approve", "recheck", "safari_download_complete", "safari_download_cancel"]);
});


test("an expired native command cannot arm capture and does not prevent exact cleanup", async () => {
  const f = fixture();
  await assert.rejects(f.run("arm", { commandDeadline: Date.now() - 1 }), /expired before capture delivery/);
  assert.equal(f.eval("HTMLAnchorElement.prototype.click===originalClick"), true);
  await f.run("arm");
  await f.run("cancel", { commandDeadline: Date.now() - 1 });
  assert.equal(f.eval("HTMLAnchorElement.prototype.click===originalClick"), true);
});
