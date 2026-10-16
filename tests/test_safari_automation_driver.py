#!/usr/bin/env python3
"""Deterministic MCP child for Swift protocol tests; never opens Safari."""
import json
import os
import sys
import threading
import time

lock = threading.Lock()
initialized = False
calls = 0


def send(value):
    with lock:
        print(json.dumps(value), flush=True)


def complete(request, count):
    name = request["params"]["name"]
    arguments = request["params"].get("arguments", {})
    time.sleep(arguments.get("delay", 0))
    if name == "crash":
        os._exit(23)
    if name == "hang":
        return
    if name == "malformed":
        print("not-json", flush=True)
        return
    if name == "tool_error":
        send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32099, "message": "fixture error", "data": {"preserved": True}}})
        return
    send({"jsonrpc": "2.0", "id": request["id"], "result": {
        "content": [{"type": "text", "text": "fixture"}],
        "structuredContent": {"value": arguments.get("value"), "pid": os.getpid(), "count": count, "initialized": initialized},
        "isError": name == "result_error",
    }})


for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request["id"], "result": {
            "protocolVersion": request["params"]["protocolVersion"],
            "serverInfo": {"name": "Fixture", "version": "1"}, "capabilities": {"tools": {}},
        }})
    elif method == "notifications/initialized":
        initialized = True
        # Notifications must not be confused with a request response.
        send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request["id"], "result": {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        calls += 1
        threading.Thread(target=complete, args=(request, calls), daemon=True).start()
