import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "automation"))
SPEC = importlib.util.spec_from_file_location("live_mcp", ROOT / "automation/live_mcp.py")
LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIVE)


class SafariLiveMCPTests(unittest.TestCase):
    def setUp(self):
        self.commands = []
        self.token = "live-fixture-private-credential"
        self.failure = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != "/command" or self.headers.get("Authorization") != "Bearer " + owner.token:
                    self.send_error(401)
                    return
                command = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.commands.append(command)
                if owner.failure:
                    value = {"ok": False, "error": owner.failure}
                else:
                    value = {"ok": True, "result": {"scope": "live_safari_tabs", "received": command["command"]}}
                data = json.dumps(value).encode()
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
        self.companion = LIVE.LiveCompanion(self.path)
        self.server = LIVE.Server(self.companion)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def rpc(self, method, params=None):
        return self.server.handle({"jsonrpc": "2.0", "id": "fixture", "method": method, "params": params or {}})

    def call(self, name, arguments=None):
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}})

    def test_discovery_is_static_and_does_not_contact_or_launch_a_companion(self):
        with patch.object(self.companion, "call", side_effect=AssertionError("Unexpected native call")):
            self.assertIn("error", self.rpc("tools/list"))
            result = self.rpc("initialize", {"protocolVersion": "2024-11-05"})["result"]
            self.assertEqual(result["serverInfo"]["name"], "ChatGPT Safari Live")
            self.assertIn("currently open", result["instructions"])
            tools = self.rpc("tools/list")["result"]["tools"]
            self.assertEqual(set(tool["name"] for tool in tools), set(LIVE.TOOL_ACTIONS))
            self.assertTrue(next(tool for tool in tools if tool["name"] == "live_close_tab")["annotations"]["destructiveHint"])
            self.assertEqual(self.rpc("ping")["result"], {})
        self.assertEqual(self.commands, [])

    def test_forwarding_preserves_real_handles_and_distinct_live_envelope(self):
        self.rpc("initialize")
        cases = [
            ("live_status", {}),
            ("live_permissions", {"prompt": False}),
            ("live_list_tabs", {}),
            ("live_read_page", {"handle": "live:fixture-profile:23", "maxLength": 2000}),
            ("live_interact", {"handle": "live:fixture-profile:23", "documentId": "document-from-browser", "snapshotId": "snapshot-from-browser", "interactions": [
                {"type": "click", "node": "node-from-page"},
                {"type": "type", "node": "input-from-page", "value": "Unicode 🦁", "replaceAll": True},
                {"type": "key", "node": "input-from-page", "key": "Enter"},
                {"type": "scroll", "deltaX": 1.5, "deltaY": 300},
            ]}),
            ("live_navigate", {"handle": "live:fixture-profile:23", "url": "https://example.com/next", "expectedUrl": "https://example.com/"}),
            ("live_select_tab", {"handle": "live:fixture-profile:23", "expectedUrl": "https://example.com/"}),
            ("live_create_tab", {"profileId": "fixture-profile", "url": "http://127.0.0.1:8123/fixture", "windowId": 5}),
            ("live_close_tab", {"handle": "live:fixture-profile:23", "expectedUrl": "https://example.com/"}),
        ]
        for name, arguments in cases:
            with self.subTest(name=name):
                result = self.call(name, arguments)["result"]
                expected = {"action": LIVE.TOOL_ACTIONS[name], "arguments": arguments}
                self.assertEqual(self.commands[-1], {"action": "live", "command": expected})
                self.assertEqual(result["structuredContent"]["received"], expected)
                self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
                self.assertNotIn("isError", result)

    def test_native_string_failure_code_is_returned_as_a_tool_error(self):
        self.rpc("initialize")
        self.failure = {"code": "STALE_TARGET", "message": "Read the page again.", "data": {"documentChanged": True}}
        response = self.call("live_read_page", {"handle": "live:fixture-profile:23"})
        result = response["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"], {"error": self.failure})
        self.assertEqual(json.loads(result["content"][0]["text"]), {"error": self.failure})
        self.assertEqual(len(self.commands), 1)

    def test_invalid_inputs_are_rejected_before_a_native_request(self):
        self.rpc("initialize")
        good = {"handle": "live:profile:23", "documentId": "document", "snapshotId": "snapshot"}
        cases = [
            ("invented_tool", {}),
            ("live_status", {"other": 1}),
            ("live_permissions", {"prompt": 1}),
            ("live_read_page", {"handle": ""}),
            ("live_read_page", {"handle": "live:profile:23", "maxLength": True}),
            ("live_read_page", {"handle": "live:profile:23", "maxLength": 60001}),
            ("live_interact", {**good, "interactions": []}),
            ("live_interact", {**good, "interactions": [{"type": "click"}]}),
            ("live_interact", {**good, "interactions": [{"type": "type", "node": "node"}]}),
            ("live_interact", {**good, "interactions": [{"type": "key", "node": "node"}]}),
            ("live_interact", {**good, "interactions": [{"type": "scroll"}]}),
            ("live_interact", {**good, "interactions": [{"type": "scroll", "deltaY": float("nan")}]}),
            ("live_interact", {**good, "interactions": [{"type": "click", "node": "node", "script": "unsafe()"}]}),
            ("live_interact", {**good, "interactions": [{"type": "click", "node": "node"}] * 21}),
            ("live_create_tab", {"profileId": "profile", "url": "javascript:alert(1)"}),
            ("live_create_tab", {"profileId": "profile", "url": "https://user:secret@example.com/"}),
            ("live_create_tab", {"profileId": "profile", "url": "https://example.com:bad/"}),
            ("live_select_tab", {"handle": "live:profile:23", "expectedUrl": "file:///tmp/file"}),
            ("live_close_tab", {"handle": "live:profile:23"}),
        ]
        for name, arguments in cases:
            with self.subTest(name=name, arguments=arguments):
                self.assertEqual(self.call(name, arguments)["error"]["code"], -32602)
        self.assertEqual(self.commands, [])

    def test_private_transport_never_retries_an_ambiguous_mutation(self):
        self.path.chmod(0o644)
        with self.assertRaises(LIVE.RPCError) as failure:
            self.companion.call({"action": "status", "arguments": {}})
        self.assertNotIn(self.token, str(failure.exception))
        self.path.chmod(0o600)
        with patch.object(self.companion, "_post", side_effect=OSError("fixture failure")) as post:
            with self.assertRaises(LIVE.RPCError) as failure:
                self.companion.call({"action": "interact", "arguments": {}})
            self.assertEqual(post.call_count, 1)
            self.assertIn("not retried", str(failure.exception))
            self.assertIn("live_status", str(failure.exception))
            self.assertNotIn(self.token, str(failure.exception))

    def test_launcher_stdio_discovery_never_requires_an_installed_app(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        result = subprocess.run([str(ROOT / "automation/launch-safari-live")],
                                input="".join(json.dumps(message) + "\n" for message in messages),
                                text=True, capture_output=True, timeout=5, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in replies], [1, 2])
        self.assertEqual(len(replies[1]["result"]["tools"]), 9)
        self.assertEqual(result.stderr, "")

    def test_live_startup_uses_the_exact_dist_app_and_preserves_native_startup(self):
        bundle = Path(self.temp.name) / "dist/ChatGPT for Safari.app"
        bundle.mkdir(parents=True)
        with patch.object(LIVE, "APP_BUNDLE", bundle), \
                patch.object(self.companion, "_read_descriptor", return_value=(8123, "fixture-token")), \
                patch("safari_mcp.subprocess.run") as launch:
            self.assertEqual(self.companion._launch_and_wait(), (8123, "fixture-token"))
            self.assertEqual(launch.call_args.args[0], [
                "/usr/bin/open", "-a", str(bundle), "chatgpt-safari://service",
            ])
            self.assertEqual(launch.call_count, 1)
        self.assertEqual(LIVE.APP_BUNDLE, ROOT / "dist/ChatGPT for Safari.app")
        self.assertEqual(LIVE.Companion()._launch_command(), [
            "/usr/bin/open", "-b", "dev.jamie.chatgpt-safari", "chatgpt-safari://service",
        ])

    def test_missing_dist_app_fails_with_a_build_first_message_without_fallback(self):
        with patch.object(LIVE, "APP_BUNDLE", Path(self.temp.name) / "missing.app"), \
                patch("safari_mcp.subprocess.run") as launch:
            with self.assertRaises(LIVE.RPCError) as failure:
                self.companion._launch_and_wait()
            self.assertIn("Build ChatGPT for Safari first", str(failure.exception))
            self.assertIn("./scripts/build-safari.sh", str(failure.exception))
            launch.assert_not_called()

    def test_stdio_parse_error_does_not_end_a_browser_session(self):
        companion = Mock()
        server = LIVE.Server(companion)
        source = io.BytesIO(b'bad-json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
        output = io.BytesIO()
        server.run(source, output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(replies[1]["result"], {})
        companion.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
