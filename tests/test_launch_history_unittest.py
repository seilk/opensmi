import json
import tempfile
import unittest
from pathlib import Path

from opensmi.launch_history import launch_history_path, load_history, save_history


class TestLaunchHistoryPersistence(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_history_writes_expected_json_shape(self):
        data = {"node1": {0: "2025-01-01T00:00:00Z", 1: "2025-01-01T01:00:00Z"}}
        save_history(self.tmpdir, data)

        raw = json.loads(launch_history_path(self.tmpdir).read_text(encoding="utf-8"))
        self.assertEqual(
            raw, {"node1": {"0": "2025-01-01T00:00:00Z", "1": "2025-01-01T01:00:00Z"}}
        )

    def test_save_history_overwrites_and_loads_latest(self):
        save_history(self.tmpdir, {"node1": {0: "t1"}})
        save_history(self.tmpdir, {"node1": {0: "t2"}, "node2": {3: "t3"}})

        loaded = load_history(self.tmpdir)
        self.assertEqual(loaded, {"node1": {0: "t2"}, "node2": {3: "t3"}})


if __name__ == "__main__":
    unittest.main()
