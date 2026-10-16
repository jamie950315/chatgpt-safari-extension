#!/usr/bin/env python3
"""MCP tools for ordinary, already logged-in Safari extension tabs.

The signed companion and Safari extension own all browser state and native input.
This stdio process validates requests and forwards them once over private loopback.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

from safari_mcp import Companion, RPCError, SUPPORTED_PROTOCOL, Server as NativeServer


TOOLS = json.loads(Path(__file__).with_name("live-tools.json").read_text())
APP_BUNDLE = Path(__file__).resolve().parents[1] / "dist/ChatGPT for Safari.app"
TOOL_ACTIONS = {
    "live_status": "status",
    "live_permissions": "permissions",
    "live_list_tabs": "list_tabs",
    "live_read_page": "read_page",
    "live_interact": "interact",
    "live_navigate": "navigate",
    "live_select_tab": "select_tab",
    "live_create_tab": "create_tab",
    "live_close_tab": "close_tab",
}
TOOL_INDEX = {tool["name"]: tool for tool in TOOLS}
INSTRUCTIONS = (
    "Control Safari's ordinary, currently open tabs and existing website logins. "
    "This server does not create an isolated Apple automation session. Start with "
    "live_list_tabs and use returned profile IDs and opaque handles; never invent "
    "them or assume the active tab. Read the chosen tab with live_read_page to get "
    "its documentId, snapshotId and node IDs before live_interact. Input uses real "
    "native events and needs Accessibility permission for ChatGPT for Safari; "
    "listing, reading and tab navigation do not. Do not substitute JavaScript input "
    "events. A stale document, changed target or user focus change aborts input: "
    "read the tab again rather than replaying an action. Tab navigation, selection "
    "and closing require the last observed expectedUrl. Close only tabs the user "
    "asked to close or scratch tabs you created. Existing tabs may contain drafts "
    "and sensitive account data. After a transport failure inspect live_status "
    "and the target page; an action may already have taken effect. No mutation "
    "is retried automatically. A key interaction requires its node to already "
    "have page focus; it never implicitly clicks the node."
)


class NativeFailure(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__(error["message"])


class LiveCompanion(Companion):
    def _launch_command(self):
        if not APP_BUNDLE.is_dir():
            raise RPCError(
                -32001,
                "Build ChatGPT for Safari first with ./scripts/build-safari.sh. "
                f"The companion app is missing at {APP_BUNDLE}.",
            )
        return ["/usr/bin/open", "-a", str(APP_BUNDLE), "chatgpt-safari://service"]

    def _post(self, command, credentials):
        result = self._post_envelope({"action": "live", "command": command}, credentials)
        if not result["ok"]:
            error = result.get("error")
            if not isinstance(error, dict) or type(error.get("code")) not in (str, int) or not isinstance(error.get("message"), str):
                raise RPCError(-32001, "The Safari companion returned an invalid live error.")
            raise NativeFailure(error)
        value = result.get("result")
        if not isinstance(value, dict):
            raise RPCError(-32001, "The Safari companion returned an invalid live result.")
        return value

    def call(self, command):
        try:
            return super().call(command)
        except RPCError as error:
            if error.code == -32002:
                raise RPCError(
                    error.code,
                    "The Safari companion connection failed. The action was not retried; "
                    "it may already have taken effect. Inspect live_status and the target page.",
                    error.data,
                ) from error
            raise


def _validate(value, schema, path="arguments"):
    """Validate the small JSON Schema vocabulary used by the static tool list."""
    for keyword, required_matches in (("oneOf", 1), ("anyOf", None)):
        if keyword in schema:
            matches = 0
            for option in schema[keyword]:
                try:
                    _validate(value, option, path)
                    matches += 1
                except RPCError:
                    pass
            if matches == 0 or (required_matches == 1 and matches != 1):
                raise RPCError(-32602, f"{path} does not match a supported interaction shape.")
    expected = schema.get("type")
    valid_type = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": type(value) is bool,
        "integer": type(value) is int,
        "number": type(value) is int or (type(value) is float and math.isfinite(value)),
        None: True,
    }.get(expected, False)
    if not valid_type:
        raise RPCError(-32602, f"{path} must be {expected}.")
    if "enum" in schema and value not in schema["enum"]:
        raise RPCError(-32602, f"{path} has an unsupported value.")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise RPCError(-32602, f"{path}.{name} is required.")
        for name, item in value.items():
            if name in properties:
                _validate(item, properties[name], f"{path}.{name}")
            elif schema.get("additionalProperties") is False:
                raise RPCError(-32602, f"{path}.{name} is not supported.")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", math.inf):
            raise RPCError(-32602, f"{path} has an invalid number of items.")
        if "items" in schema:
            for index, item in enumerate(value):
                _validate(item, schema["items"], f"{path}[{index}]")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        raise RPCError(-32602, f"{path} must not be empty.")
    if type(value) in (int, float):
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise RPCError(-32602, f"{path} is outside the supported range.")


def _validate_url(value, field):
    try:
        url = urlsplit(value)
        if (url.scheme not in ("http", "https") or not url.hostname or
                url.username is not None or url.password is not None or
                any(char.isspace() or ord(char) < 32 for char in value)):
            raise ValueError("Unsupported URL")
        # Accessing port detects malformed and out-of-range port literals.
        url.port
    except ValueError as error:
        raise RPCError(-32602, f"arguments.{field} must be an HTTP(S) URL without credentials.") from error


class Server(NativeServer):
    def __init__(self, companion=None):
        super().__init__(companion or LiveCompanion())

    def dispatch(self, method, params):
        if method == "initialize":
            self.initialized = True
            return {
                "protocolVersion": SUPPORTED_PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "ChatGPT Safari Live", "version": "1.0.0"},
                "instructions": INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if not self.initialized:
            raise RPCError(-32000, "Initialize the Safari-live MCP server before requesting tools.")
        if method == "tools/list":
            if "cursor" in params:
                raise RPCError(-32602, "Safari-live tools are not paginated; omit cursor.")
            return {"tools": copy.deepcopy(TOOLS)}
        if method == "tools/call":
            name, arguments = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or name not in TOOL_INDEX:
                raise RPCError(-32602, "Unknown Safari-live tool.")
            _validate(arguments, TOOL_INDEX[name]["inputSchema"])
            for field in ("url", "expectedUrl"):
                if field in arguments:
                    _validate_url(arguments[field], field)
            try:
                value = self.companion.call({"action": TOOL_ACTIONS[name], "arguments": arguments})
            except NativeFailure as error:
                value = {"error": error.error}
                return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                        "structuredContent": value, "isError": True}
            return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                    "structuredContent": value}
        raise RPCError(-32601, f"Unknown MCP method: {method}.")


if __name__ == "__main__":
    try:
        Server().run()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
