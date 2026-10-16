import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("safari_mcp", ROOT / "automation/safari_mcp.py")
MCP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MCP)


class SafariMCPTests(unittest.TestCase):
    def setUp(self):
        self.commands = []
        self.token = "private-test-credential"
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != "/command" or self.headers.get("Authorization") != "Bearer " + owner.token:
                    self.send_error(401)
                    return
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.commands.append(request)
                command = request["command"]
                action = command["action"]
                if action == "initialize":
                    result = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "Safari"}, "capabilities": {"tools": {}}}
                elif action == "tools/list":
                    result = {"tools": [{"name": "page_interactions", "inputSchema": {"type": "object"}}]}
                elif action in {"status", "stop"}:
                    result = {"state": "ready" if action == "status" else "idle", "scope": "isolated_automation_session"}
                elif command["name"] == "fail":
                    result = None
                else:
                    result = {"content": [{"type": "text", "text": "native result"}], "isError": command["name"] == "tool_error"}
                payload = {"ok": True, "result": result} if result is not None else {"ok": False, "error": {"code": -32099, "message": "Native error", "data": {"original": True}}}
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "companion-control.json"
        self.path.write_text(json.dumps({"pid": os.getpid(), "port": self.http.server_port, "token": self.token}))
        self.path.chmod(0o600)
        self.companion = MCP.Companion(self.path)
        self.server = MCP.Server(self.companion)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def rpc(self, method, params=None, request_id=1):
        return self.server.handle({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})

    def test_native_schema_and_actions_are_preserved(self):
        self.assertIn("error", self.rpc("tools/list"))
        init = self.rpc("initialize", {"protocolVersion": "2024-11-05"})
        self.assertIn("isolated", init["result"]["instructions"])
        self.assertEqual(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}), None)
        names = [tool["name"] for tool in self.rpc("tools/list")["result"]["tools"]]
        self.assertEqual(names, ["page_interactions", "safari_session_status", "safari_session_stop"])
        arguments = {"interactions": [{"type": "type", "node": "42", "value": "hello", "purpose": "Fill test input"}]}
        result = self.rpc("tools/call", {"name": "page_interactions", "arguments": arguments}, "desktop-request")
        self.assertEqual(result["id"], "desktop-request")
        self.assertEqual(result["result"], {"content": [{"type": "text", "text": "native result"}], "isError": False})
        self.assertEqual(self.commands[-1], {"action": "automation", "command": {"action": "tools/call", "name": "page_interactions", "arguments": arguments}})
        self.assertTrue(self.rpc("tools/call", {"name": "tool_error"})["result"]["isError"])
        self.assertEqual(self.rpc("tools/call", {"name": "fail"})["error"], {"code": -32099, "message": "Native error", "data": {"original": True}})
        state = self.rpc("tools/call", {"name": "safari_session_status"})["result"]["structuredContent"]
        self.assertEqual(state["scope"], "isolated_automation_session")
        self.assertEqual(self.rpc("tools/call", {"name": "safari_session_stop"})["result"]["structuredContent"]["state"], "idle")

    def test_private_descriptor_and_no_mutation_replay(self):
        self.path.chmod(0o644)
        with self.assertRaises(MCP.RPCError) as raised:
            self.companion.call({"action": "status"})
        self.assertNotIn(self.token, str(raised.exception))
        self.path.chmod(0o600)
        with patch.object(self.companion, "_post", side_effect=OSError("fixture connection failure")) as post:
            with self.assertRaises(MCP.RPCError) as raised:
                self.companion.call({"action": "tools/call", "name": "page_interactions", "arguments": {}})
            self.assertEqual(post.call_count, 1)
            self.assertIn("not retried", str(raised.exception))
            self.assertNotIn(self.token, str(raised.exception))

    def test_stdio_jsonrpc_parse_errors_and_notification_lifetime(self):
        source = io.BytesIO(b'not-json\n' + json.dumps({"jsonrpc": "2.0", "id": 9, "method": "ping"}).encode() + b'\n')
        output = io.BytesIO()
        self.server.run(source, output)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(messages[0]["error"]["code"], -32700)
        self.assertEqual(messages[1], {"jsonrpc": "2.0", "id": 9, "result": {}})
        self.assertEqual(self.commands, [], "Client EOF must not end the companion-owned session")


if __name__ == "__main__":
    unittest.main()
