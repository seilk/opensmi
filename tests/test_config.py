import json
import tempfile
import unittest
from pathlib import Path

from opensmi.config import save_default_config, update_node_env


class TestConfigPersistence(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_default_config_respects_force_flag(self):
        path = self.tmpdir / "opensmi.json"
        save_default_config(path)
        original = path.read_text(encoding="utf-8")

        path.write_text('{"cluster_name":"manual"}\n', encoding="utf-8")
        save_default_config(path, force=False)
        self.assertEqual(
            path.read_text(encoding="utf-8"), '{"cluster_name":"manual"}\n'
        )

        save_default_config(path, force=True)
        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_update_node_env_updates_target_node(self):
        path = self.tmpdir / "opensmi.json"
        path.write_text(
            json.dumps(
                {
                    "cluster_name": "X",
                    "nodes": [
                        {"alias": "GPU-01", "address": "10.0.0.1", "user": "ubuntu"},
                        {"alias": "GPU-02", "address": "10.0.0.2", "user": "ubuntu"},
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        updated = update_node_env(path, "GPU-02", "conda", "ml", "~/work")
        self.assertTrue(updated)

        doc = json.loads(path.read_text(encoding="utf-8"))
        first = doc["nodes"][0]
        second = doc["nodes"][1]
        self.assertNotIn("env_manager", first)
        self.assertEqual(second["env_manager"], "conda")
        self.assertEqual(second["env_name"], "ml")
        self.assertEqual(second["work_dir"], "~/work")


if __name__ == "__main__":
    unittest.main()
