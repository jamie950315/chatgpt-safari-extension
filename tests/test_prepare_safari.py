import importlib.util
from pathlib import Path
import unittest
import json

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("prepare_safari", ROOT / "scripts/prepare-safari.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafariPreparationTests(unittest.TestCase):
    def test_only_expected_capability_guards_are_applied(self):
        source = module.SOURCE.read_text()
        patched = module.prepare(source)
        expected_source = source
        for old, (new, expected) in module.REPLACEMENTS.items():
            expected_source = expected_source.replace(old, new)
        self.assertEqual(patched, expected_source)
        self.assertEqual(patched.count("chrome.browserAction."), 11)

    def test_persistent_manifest_preserves_permissions_resources_and_security_policies(self):
        original = json.loads((ROOT / "vendor/manifest.safari-input.json").read_text())
        result = module.prepare_manifest(original)
        self.assertEqual(result["manifest_version"], 2)
        self.assertEqual(result["background"], {"scripts": ["background.js"], "persistent": True})
        self.assertEqual(set(result["permissions"]), set(original["permissions"] + original["host_permissions"]))
        self.assertEqual(result["browser_action"], original["action"])
        self.assertEqual(result["commands"]["_execute_browser_action"], original["commands"]["_execute_action"])
        self.assertEqual(result["content_scripts"], original["content_scripts"])
        self.assertEqual(result["content_security_policy"], original["content_security_policy"]["extension_pages"] + " frame-src 'self' https://chatgpt.com http://*.localhost:*;")
        self.assertEqual(result["sandbox"]["content_security_policy"], original["content_security_policy"]["sandbox"])
        self.assertEqual(result["web_accessible_resources"], [r for group in original["web_accessible_resources"] for r in group["resources"]] + ["embedded-sidechat.html"])

    def test_changed_upstream_fails_instead_of_silently_skipping_a_guard(self):
        source = module.SOURCE.read_text().replace("chrome.debugger.onDetach.addListener", "changed")
        with self.assertRaises(ValueError):
            module.prepare(source)


if __name__ == "__main__":
    unittest.main()
