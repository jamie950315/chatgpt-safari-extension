#!/usr/bin/env python3
"""Apply bounded Safari capability guards to the preserved Chrome background."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "vendor/background.chrome.js"
TARGET = ROOT / "safari/ChatGPT for Safari/ChatGPT for Safari Extension/Resources/background.js"

REPLACEMENTS = {
    "this.onUpdateAvailable.addListener": ("this.onUpdateAvailable?.addListener", 1),
    "chrome.debugger.onDetach.addListener": ("chrome.debugger?.onDetach?.addListener", 2),
    "chrome.debugger.onEvent.addListener": ("chrome.debugger?.onEvent?.addListener", 1),
    "chrome.downloads.onCreated.addListener": ("chrome.downloads?.onCreated?.addListener", 1),
    "chrome.downloads.onChanged.addListener": ("chrome.downloads?.onChanged?.addListener", 1),
    "chrome.webNavigation.onCreatedNavigationTarget.addListener":
        ("chrome.webNavigation.onCreatedNavigationTarget?.addListener", 1),
    "const r=await chrome.debugger.getTargets();":
        ("if(chrome.debugger==null)return;const r=await chrome.debugger.getTargets();", 1),
}


def prepare(source: str) -> str:
    for old, (new, expected) in REPLACEMENTS.items():
        count = source.count(old)
        if count != expected:
            raise ValueError(f"Expected {expected} upstream matches for {old!r}; found {count}")
        source = source.replace(old, new)
    return source


if __name__ == "__main__":
    TARGET.write_text(prepare(SOURCE.read_text()))
    print("Applied Safari guards for unavailable Chrome events and CDP cleanup.")
