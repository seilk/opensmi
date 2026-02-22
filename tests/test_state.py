import tempfile
import unittest
from pathlib import Path

from opensmi.state import atomic_write_text


class TestAtomicWriteText(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_creates_parent_and_writes_content(self):
        target = self.tmpdir / "nested" / "state.json"
        atomic_write_text(target, '{"ok": true}\n')
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(encoding="utf-8"), '{"ok": true}\n')

    def test_replaces_existing_content(self):
        target = self.tmpdir / "state.json"
        target.write_text("old\n", encoding="utf-8")
        atomic_write_text(target, "new\n")
        self.assertEqual(target.read_text(encoding="utf-8"), "new\n")

    def test_does_not_leave_temp_files(self):
        target = self.tmpdir / "history.json"
        atomic_write_text(target, "{}\n")
        leftovers = list(self.tmpdir.glob("history.json.*"))
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
