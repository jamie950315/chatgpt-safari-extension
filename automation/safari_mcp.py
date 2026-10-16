#!/usr/bin/env python3
"""MCP stdio entry point for the Safari companion's single native session.

The companion owns safaridriver. This process only translates JSON-RPC to its
authenticated loopback API; it never launches another automation driver.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request


DESCRIPTOR = Path.home() / "Library/Application Support/ChatGPT Safari/companion-control.json"
MAX_MESSAGE = 16 * 1024 * 1024
SUPPORTED_PROTOCOL = "2024-11-05"
INSTRUCTIONS = (
    "Control Safari through Apple's native automation APIs. This is one isolated "
    "automation session shared with the ChatGPT Safari companion, not the user's "
    "existing Safari tabs or login session. Use create_tab or navigate_to_url, then "
    "get_page_content to obtain current node UIDs. Use page_interactions for real "
    "typing, clicking and navigation. Do not substitute JavaScript-dispatched input. "
    "Safari's Develop > Allow Remote Automation and External Agents must be enabled. "
    "After a transport failure inspect safari_session_status; an action may already "
    "have taken effect. Do not replay mutations automatically. safari_session_stop "
    "explicitly ends the shared automation session."
)

LIFECYCLE_TOOLS = [
    {
        "name": "safari_session_status",
        "description": "Inspect the shared Safari-native automation session without starting a driver. Reports its isolated scope, lifecycle state, and failures.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "safari_session_stop",
        "description": "Explicitly stop the shared Safari automation driver and its isolated browsing session. The next native tool call starts a new session. This does not close ordinary user Safari tabs.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
]


class RPCError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data

    def value(self):
        result = {"code": self.code, "message": self.message}
        if self.data is not None:
            result["data"] = self.data
        return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        # The authenticated endpoint is loopback-only; credentials never follow
        # an HTTP redirect, including redirects to another local port.
        return None


class Companion:
    def __init__(self, descriptor: Path = DESCRIPTOR, startup_timeout: float = 12):
        self.descriptor = descriptor
        self.startup_timeout = startup_timeout
        self._startup_lock = threading.Lock()

    def _read_descriptor(self):
        # Only the signed-in user's private descriptor is accepted. Never print it.
        with self.descriptor.open("rb") as handle:
            info = os.fstat(handle.fileno())
            if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                raise RPCError(-32001, "The Safari companion descriptor must be owned by this user and have mode 0600.")
            raw = handle.read(8193)
        if len(raw) > 8192:
            raise RPCError(-32001, "The Safari companion descriptor is invalid.")
        value = json.loads(raw)
        port, token, pid = value.get("port"), value.get("token"), value.get("pid")
        if (type(port) is not int or not 1 <= port <= 65535 or
                not isinstance(token, str) or not token or len(token) > 4096 or
                type(pid) is not int or pid <= 0):
            raise RPCError(-32001, "The Safari companion descriptor is invalid.")
        os.kill(pid, 0)
        return port, token

    def _post(self, command, credentials):
        result = self._post_envelope({"action": "automation", "command": command}, credentials)
        return self._unwrap_response(result)

    def _post_envelope(self, envelope, credentials):
        port, token = credentials
        payload = json.dumps(envelope).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/command", data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        # Ignore shell proxy settings: the private credential must stay on loopback.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=135) as response:
            raw = response.read(MAX_MESSAGE + 1)
        if len(raw) > MAX_MESSAGE:
            raise RPCError(-32001, "The Safari companion response exceeds 16 MiB.")
        result = json.loads(raw)
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise RPCError(-32001, "The Safari companion returned an invalid response.")
        return result

    def _unwrap_response(self, result):
        if not result["ok"]:
            error = result.get("error", {})
            code = error.get("code", -32000)
            raise RPCError(code if type(code) is int else -32000,
                           str(error.get("message", "Safari automation failed.")), error.get("data"))
        return result.get("result")

    def call(self, command):
        # Resolve or launch before submitting the command. Once submitted, never retry:
        # a failed HTTP response does not prove a click/navigation did not happen.
        with self._startup_lock:
            try:
                credentials = self._read_descriptor()
            except (FileNotFoundError, ProcessLookupError):
                credentials = self._launch_and_wait()
            except (ValueError, KeyError, PermissionError, OSError) as error:
                raise RPCError(-32001, "Cannot read the private Safari companion descriptor.") from error
        try:
            return self._post(command, credentials)
        except RPCError:
            raise
        except urllib.error.HTTPError as error:
            raise RPCError(-32001, f"The Safari companion rejected the request (HTTP {error.code}). The action was not retried.") from error
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise RPCError(-32002, "The Safari companion connection failed. The action was not retried; it may already have taken effect. Reopen the companion and inspect safari_session_status.") from error

    def _launch_command(self):
        return ["/usr/bin/open", "-b", "dev.jamie.chatgpt-safari", "chatgpt-safari://service"]

    def _launch_and_wait(self):
        try:
            subprocess.run(
                self._launch_command(),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=8, check=True,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RPCError(-32001, "Could not open ChatGPT for Safari. Open the installed companion app before using Safari-native tools.") from error
        deadline = time.monotonic() + self.startup_timeout
        while time.monotonic() < deadline:
            try:
                return self._read_descriptor()
            except (FileNotFoundError, ProcessLookupError):
                time.sleep(0.1)
            except (OSError, ValueError) as error:
                raise RPCError(-32001, "The Safari companion descriptor is unavailable or invalid.") from error
        raise RPCError(-32001, "ChatGPT for Safari did not start its local control service. Open the companion app and try again.")


class Server:
    def __init__(self, companion=None):
        self.companion = companion or Companion()
        self.initialized = False
        self._output_lock = threading.Lock()
        # Native Safari tools share a single active context. Preserve client order;
        # parallel requests are not allowed to race switch_tab against an input.

    def dispatch(self, method, params):
        if method == "initialize":
            result = self.companion.call({"action": "initialize", "protocolVersion": params.get("protocolVersion", SUPPORTED_PROTOCOL)})
            self.initialized = True
            return {
                "protocolVersion": result["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "ChatGPT Safari Native", "version": "1.0.0"},
                "instructions": INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if not self.initialized:
            raise RPCError(-32000, "Initialize the Safari-native MCP server before requesting tools.")
        if method == "tools/list":
            command = {"action": "tools/list"}
            if "cursor" in params:
                command["cursor"] = params["cursor"]
            result = self.companion.call(command)
            if "cursor" not in params:
                result["tools"] = result.get("tools", []) + LIFECYCLE_TOOLS
            return result
        if method == "tools/call":
            name, arguments = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise RPCError(-32602, "Expected a tool name and arguments object.")
            if name in {"safari_session_status", "safari_session_stop"}:
                if arguments:
                    raise RPCError(-32602, "Session lifecycle tools do not accept arguments.")
                result = self.companion.call({"action": "status" if name == "safari_session_status" else "stop"})
                return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "structuredContent": result}
            return self.companion.call({"action": "tools/call", "name": name, "arguments": arguments})
        raise RPCError(-32601, f"Unknown MCP method: {method}.")

    def handle(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None,
                    "error": {"code": -32600, "message": "Expected a JSON-RPC 2.0 request."}}
        if "id" not in message:
            # The server requests no sampling/resources, so notifications need no reply.
            return None
        response = {"jsonrpc": "2.0", "id": message["id"]}
        try:
            params = message.get("params", {})
            if not isinstance(params, dict):
                raise RPCError(-32602, "JSON-RPC params must be an object.")
            response["result"] = self.dispatch(message["method"], params)
        except RPCError as error:
            response["error"] = error.value()
        except (KeyError, TypeError, ValueError):
            response["error"] = {"code": -32603, "message": "The Safari companion returned an invalid MCP result."}
        return response

    def run(self, source=None, output=None):
        source, output = source or sys.stdin.buffer, output or sys.stdout.buffer
        while True:
            line = source.readline(MAX_MESSAGE + 1)
            if not line:
                return
            if len(line) > MAX_MESSAGE:
                self._write(output, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "MCP request exceeds 16 MiB."}})
                return
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                self._write(output, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON."}})
                continue
            response = self.handle(message)
            if response is not None:
                self._write(output, response)

    def _write(self, output, value):
        with self._output_lock:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
            output.flush()


if __name__ == "__main__":
    # Disconnecting a desktop client must not stop the session used by another
    # client or the companion UI. The App owns its lifetime; stop is explicit.
    try:
        Server().run()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
