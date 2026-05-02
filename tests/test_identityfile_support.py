import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from opensmi.cli import _host_to_config_node, _ob_ssh_test
from opensmi.config import load_all_clusters
from opensmi.models import NodeConfig, SlurmClusterConfig
from opensmi.slurm import _run_remote, collect_slurm_snapshot, snapshot_to_json
from opensmi.sshutil import _ssh_base_cmd


class TestIdentityfileSupport(unittest.TestCase):
    def test_node_config_positional_optional_fields_remain_compatible(self):
        node = NodeConfig("gpu-a", "10.0.0.10", "alice", 2222, 9, "conda", "ml", "~/work")

        self.assertEqual(node.env_manager, "conda")
        self.assertEqual(node.env_name, "ml")
        self.assertEqual(node.work_dir, "~/work")
        self.assertEqual(node.identityfile, "")
        self.assertEqual(node.proxyjump, "")

    def test_slurm_config_positional_optional_fields_remain_compatible(self):
        cluster = SlurmClusterConfig("HPC", "login-a", "alice", 2202, "/opt/slurm/bin")

        self.assertEqual(cluster.slurm_bin_prefix, "/opt/slurm/bin")
        self.assertEqual(cluster.identityfile, "")
        self.assertEqual(cluster.proxyjump, "")

    def test_host_to_config_node_preserves_identityfile_and_proxyjump(self):
        node = _host_to_config_node(
            {
                "alias": "gpu-a",
                "address": "10.0.0.10",
                "user": "alice",
                "port": 2222,
                "identityfile": "~/.ssh/id_gpu_a",
                "proxyjump": "bastion",
            }
        )

        self.assertEqual(
            node,
            {
                "alias": "gpu-a",
                "address": "10.0.0.10",
                "user": "alice",
                "port": 2222,
                "identityfile": "~/.ssh/id_gpu_a",
                "proxyjump": "bastion",
            },
        )

    def test_load_all_clusters_preserves_identityfile_fields(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "opensmi.json"
            cfg_path.write_text(
                json.dumps(
                    {
                        "cluster_name": "Lab",
                        "nodes": [
                            {
                                "alias": "gpu-a",
                                "address": "10.0.0.10",
                                "user": "alice",
                                "identityfile": "/tmp/id_gpu_a",
                                "proxyjump": "bastion-a",
                            }
                        ],
                        "slurm_clusters": [
                            {
                                "name": "HPC",
                                "login_node": "login-a",
                                "user": "alice",
                                "identityfile": "/tmp/id_hpc",
                                "proxyjump": "bastion-hpc",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            clusters = load_all_clusters(cfg_path)

        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0].nodes[0].identityfile, "/tmp/id_gpu_a")
        self.assertEqual(clusters[0].nodes[0].proxyjump, "bastion-a")
        self.assertEqual(clusters[0].slurm_clusters[0].identityfile, "/tmp/id_hpc")
        self.assertEqual(clusters[0].slurm_clusters[0].proxyjump, "bastion-hpc")

    def test_ssh_base_cmd_applies_identityfile_and_proxyjump(self):
        node = NodeConfig(
            alias="gpu-a",
            address="10.0.0.10",
            user="alice",
            port=2222,
            identityfile="~/.ssh/id_gpu_a",
            proxyjump="bastion-a",
        )

        cmd = _ssh_base_cmd(node)

        self.assertIn("-p", cmd)
        self.assertIn("2222", cmd)
        self.assertIn("-i", cmd)
        self.assertIn(str(Path("~/.ssh/id_gpu_a").expanduser()), cmd)
        self.assertIn("ProxyJump=bastion-a", cmd)

    def test_ob_ssh_test_expands_identityfile_before_invoking_ssh(self):
        with patch("opensmi.cli.subprocess.run") as run_mock:
            run_mock.return_value = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="",
                stderr="",
            )

            ok, message = _ob_ssh_test(
                "10.0.0.10",
                "alice",
                identityfile="~/.ssh/id_gpu_a",
                proxyjump="bastion-a",
            )

        self.assertTrue(ok)
        self.assertEqual(message, "")
        cmd = run_mock.call_args.args[0]
        self.assertIn(str(Path("~/.ssh/id_gpu_a").expanduser()), cmd)
        self.assertIn("ProxyJump=bastion-a", cmd)

    def test_slurm_run_remote_applies_identityfile_and_proxyjump(self):
        with patch("opensmi.slurm.subprocess.run") as run_mock:
            run_mock.return_value = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="ok\n",
                stderr="",
            )

            out = _run_remote(
                ["sinfo"],
                "login-a",
                user="alice",
                port=2202,
                identityfile="~/.ssh/id_hpc",
                proxyjump="bastion-hpc",
            )

        self.assertEqual(out, "ok\n")
        cmd = run_mock.call_args.args[0]
        self.assertIn("-p", cmd)
        self.assertIn("2202", cmd)
        self.assertIn(str(Path("~/.ssh/id_hpc").expanduser()), cmd)
        self.assertIn("ProxyJump=bastion-hpc", cmd)

    def test_slurm_snapshot_serializes_identityfile_and_proxyjump(self):
        with patch("opensmi.slurm._parse_sinfo", return_value={}):
            with patch("opensmi.slurm._run_remote", return_value=""):
                snap = collect_slurm_snapshot(
                    login_node="login-a",
                    ssh_user="alice",
                    ssh_port=2202,
                    identityfile="~/.ssh/id_hpc",
                    proxyjump="bastion-hpc",
                )

        data = json.loads(snapshot_to_json(snap))
        self.assertEqual(data["identityfile"], str(Path("~/.ssh/id_hpc").expanduser()))
        self.assertEqual(data["proxyjump"], "bastion-hpc")


if __name__ == "__main__":
    unittest.main()
