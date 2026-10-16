import importlib.util
from pathlib import Path
import unittest

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
            self.assertEqual(patched.count(new), source.count(new) + expected)
            expected_source = expected_source.replace(old, new)
        self.assertEqual(patched, expected_source)

    def test_changed_upstream_fails_instead_of_silently_skipping_a_guard(self):
        source = module.SOURCE.read_text().replace("chrome.debugger.onDetach.addListener", "changed")
        with self.assertRaises(ValueError):
            module.prepare(source)


if __name__ == "__main__":
    unittest.main()
