# Control Safari with native tools

Use the `safari_native` MCP server to read a page, type, click, and navigate with
Apple's Safari automation APIs. The signed companion app owns one persistent
`/usr/bin/safaridriver --mcp` process. Both the extension and desktop MCP clients
use that same process through the companion's authenticated loopback service.

Safari opens an **isolated automation session**. Its tabs and website logins are
separate from ordinary Safari tabs. Existing user tabs cannot be claimed. Enable
Safari **Develop → Allow Remote Automation and External Agents** before use.

## Connect a desktop client

Build and register `dist/ChatGPT for Safari.app` first. Add
[`mcp-config.example.toml`](mcp-config.example.toml) to the existing Codex MCP
configuration, preserving the other servers. Reload the client's MCP connections.
For clients using JSON configuration, the same command is:

```json
{
  "mcpServers": {
    "safari_native": {
      "command": "/Users/jamie/Downloads/chatgpt-safari-extension/automation/launch-safari-mcp",
      "args": []
    }
  }
}
```

The entry point launches the companion with `chatgpt-safari://service` when needed;
this service launch does not open the chat panel. It reads the current port and
private token from the companion's mode-0600 descriptor in
`~/Library/Application Support/ChatGPT Safari/companion-control.json`. It never
starts its own Safari driver. Keep the repository at the configured location, or
update the command after moving it.

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
