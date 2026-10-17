#!/usr/bin/env python3
"""Restart only this checkout's containing app; never restart Safari."""

from pathlib import Path
import os
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "automation"))
from live_mcp import LiveCompanion

status = LiveCompanion().call({"action": "status", "arguments": {}})
if status.get("clipboard", {}).get("pending"):
    raise SystemExit("Cannot restart while memory-only clipboard recovery is pending.")

app = ROOT / "dist/ChatGPT for Safari.app"
executable = str(app / "Contents/MacOS/ChatGPT for Safari")
# comm is the executable path, unlike command which includes --service arguments.
pids = [
    int(fields[0])
    for line in subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True).splitlines()
    if len(fields := line.strip().split(None, 1)) == 2 and fields[1] == executable
]
if len(pids) > 1:
    raise SystemExit("Multiple containing apps are running; inspect their pending operations before restarting.")
for pid in pids:
    os.kill(pid, signal.SIGTERM)
for _ in range(100):
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
    if not alive:
        break
    time.sleep(0.1)
else:
    raise SystemExit("Containing app did not exit; no duplicate was started.")
subprocess.run(["open", "-g", "-n", "-a", str(app), "chatgpt-safari://service"], check=True)
print("Containing app restarted; Safari was preserved.")
