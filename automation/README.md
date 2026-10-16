# Control existing Safari tabs

Use **safari_live** for ordinary Safari tabs, including their existing website
logins. It does not copy cookies or launch an isolated browser session. The
extension reads and targets pages through Safari Web Extension APIs; the signed
companion delivers real mouse and keyboard events through macOS Accessibility.

## Connect a desktop client

Build and register `dist/ChatGPT for Safari.app`. Add
[`mcp-config.example.toml`](mcp-config.example.toml) to the client's existing MCP
configuration, preserving other servers. Reload its MCP connections.
For JSON clients:

```json
{
  "mcpServers": {
    "safari_live": {
      "command": "/Users/jamie/Downloads/chatgpt-safari-extension/automation/launch-safari-live",
      "args": []
    }
  }
}
```

The launcher starts the signed companion service when a tool needs it; discovery
(`initialize` and `tools/list`) does not start the app or an Apple driver. The
private loopback descriptor is mode 0600. Extension polling never restarts an app
the user quit. Keep this checkout at the configured path, or update the command
if it moves.

For real input, enable **ChatGPT for Safari** in **System Settings → Privacy &
Security → Accessibility**. `live_permissions` with `{"prompt":true}` requests the
normal macOS prompt; `live_status` reports the actual permission. Reading and tab
navigation work without Accessibility permission.
After a new grant, macOS may require quitting and reopening the companion before
event posting becomes available; keep Safari running.

## Choose a real tab, then use its current snapshot

1. Call `live_list_tabs`. Choose the returned `handle` by URL/title; preserve the
   `profileId` when working across Safari profiles. Do not invent handles or
   assume the active tab. Private tabs are excluded.
2. Call `live_read_page` with `{"handle":"<returned handle>"}`. The result includes
   page text, actionable nodes, `documentId`, and `snapshotId`.
3. Pass those exact IDs into `live_interact`:

   ```json
   {
     "handle": "<returned handle>",
     "documentId": "<documentId from live_read_page>",
     "snapshotId": "<snapshotId from live_read_page>",
     "interactions": [
       {"type":"type","node":"<input node>","value":"Safari live test","replaceAll":true},
       {"type":"click","node":"<button node>"}
     ]
   }
   ```

   Safari selects the requested tab/window. The companion uses public
   Accessibility to activate that verified Safari window once. Keep Safari
   frontmost and avoid concurrent manual input. The result includes completed
   interactions and a fresh page snapshot. Check the actual result rather than
   assuming a click caused the intended effect.
4. Use a link's current node with `click`, or call `live_navigate` with `handle`,
   `url`, and the last observed `expectedUrl`. Read a new snapshot after navigation.

If navigation is still loading after the bounded observation window, the result
keeps the actual tab handle/status. An interaction returns `pagePending:true`
with its completed inputs; call `live_read_page` instead of repeating the action.

`key` accepts Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, arrow keys,
Home/End, and PageUp/PageDown, not application shortcuts. Its node must already
have page focus (for example, after typing or a native Tab); a key does not
implicitly click the node. `scroll` accepts pixel
`deltaY`/`deltaX`, optionally targeting a current node. Page snapshots describe the
top-level document and list embedded frames separately; node IDs do not cross
frame or document boundaries. Password values are not included in snapshots.

`live_create_tab` requires a returned `profileId` and URL. `live_select_tab` and
`live_close_tab` require `handle` and `expectedUrl`. Close only tabs the user
requested or scratch tabs you created; current tabs can contain unsaved work.

## Recover without repeating input

The broker permits one live command at a time across clients; concurrent requests
return `LIVE_BUSY` without queueing a later mutation. Profile/background identity,
URL, document, snapshot, element actionability, native window, page hit target,
and keyboard focus are checked. A changed target aborts with an explicit error.
A background restart invalidates delivered work instead of replaying it.

Errors retain the native code and any partial-delivery information. After an
uncertain result, read the current page and decide the next action; do not
blindly repeat a click, form submission, or text entry. No mutation is retried by
the MCP transport. Browser-generated dialogs remain Safari UI rather than DOM
nodes in this backend.

## Optional isolated Safari automation

The separate `safari_native` server exposes Apple's actual automation tools
through one companion-owned `/usr/bin/safaridriver --mcp` process. Its tabs and
logins are isolated from ordinary Safari and from native side chat. Use it for
clean-session tests, not to claim existing user tabs. Enable Safari **Develop →
Allow Remote Automation and External Agents** before using this backend.

Its entry point is `automation/launch-safari-mcp`, configured separately in the
same example file. The following workflow and protocol apply only to that
isolated backend.

## Read, type, click, and follow a link

The server returns Apple's actual tool schemas and results. Start with:

1. Call `create_tab` with `{"url":"https://example.com/"}`, or call
   `navigate_to_url` with a URL. Save the returned tab handle.
2. Call `get_page_content` with `{"region":"entire_page"}` to read the current
   page and obtain current node UIDs.
3. Use those UIDs with `page_interactions`. Batch related input and click actions:

   ```json
   {
     "interactions": [
       {
         "type": "type",
         "node": "<input UID from the current page>",
         "value": "Safari native test",
         "replaceAll": true,
         "purpose": "Fill the test input"
       },
       {
         "type": "click",
         "node": "<button UID from the current page>",
         "purpose": "Apply the test input"
       }
     ],
     "fullText": true
   }
   ```

4. Inspect the returned content to confirm the result. Click a current link UID
   with `page_interactions` to navigate; Safari waits for the resulting page.
5. Close only the automation tabs you created using `close_tab`. Use
   `safari_session_stop` to end the whole isolated session.

UIDs belong to the current extracted page; read again after navigation. Use
`switch_tab` before acting on a different automation tab. Each native tool call
finishes before the next call starts, so different clients cannot race two
in-flight native interactions. They still share the current active context.

`evaluate_javascript` is available for page computation, not as a replacement for
native input. `page_interactions` uses Safari's actual interaction implementation.

## Inspect and recover a failed session

`safari_session_status` reports the session ID, driver PID, isolated scope, and
state without starting a driver. A native tool failure is returned unchanged,
including MCP `isError` and JSON-RPC error details.

A driver crash, malformed response, or 120-second request timeout leaves the
session in `failed`. No action is replayed automatically: a click or navigation
may already have taken effect. Call `safari_session_stop` explicitly, then start
a new automation session with a native tool. Ending a desktop stdio connection
does not terminate the companion-owned session used by another client.

## Native integration contract

The companion forwards its authenticated HTTP command:

```json
{
  "action": "automation",
  "command": {
    "action": "tools/call",
    "name": "get_page_content",
    "arguments": {"region": "entire_page"}
  }
}
```

to `SafariAutomation.handle(_:reply:)`. Supported inner actions are `initialize`,
`tools/list`, `tools/call`, `status`, and `stop`. Responses are either
`{"ok":true,"result":<actual MCP result>}` or
`{"ok":false,"error":<JSON-RPC error>}`. The class must be retained once by the
containing app, not instantiated once per request. Call `close()` during app
termination. The native host used by the original browser extension remains a
separate connection; this backend does not emulate CDP.

## Protocol tests

The following tests use a fake MCP driver and a loopback fixture. They do not open
Safari or change existing browser tabs:

```sh
mkdir -p build/automation-tests
xcrun swiftc -swift-version 5 native/SafariAutomation.swift \
  tests/SafariAutomationProtocol.swift -o build/automation-tests/protocol-test
build/automation-tests/protocol-test "$(command -v python3)" \
  "$PWD/tests/test_safari_automation_driver.py"
python3 -m unittest discover -s tests -p test_safari_automation_mcp.py -v
```

Installed acceptance requires the desktop client to complete the read/input/
click/navigation sequence through this MCP entry point and the signed companion.
