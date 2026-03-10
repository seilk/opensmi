import unittest
import base64

from opensmi.collector import _parse_remote_output
from opensmi.models import NodeConfig


class TestCollectorParse(unittest.TestCase):
    def test_parse_remote_output_basic(self):
        node = NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")

        stdout = """__OPENSMI_BEGIN__
hostname=testnode
os=Ubuntu 22.04
__GPUS__
0, GPU-uuid0, NVIDIA RTX A6000, 49140
__PROCS__
GPU-uuid0, 123, python, 1000
__OWNERS__
123,alice
__OPENSMI_END__
"""

        meta, gpus, procs = _parse_remote_output(node, stdout)
        self.assertEqual(meta["hostname"], "testnode")
        self.assertEqual(meta["os"], "Ubuntu 22.04")

        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0].index, 0)
        self.assertEqual(gpus[0].uuid, "GPU-uuid0")

        self.assertEqual(len(procs), 1)
        self.assertEqual(procs[0].pid, 123)
        self.assertEqual(procs[0].user, "alice")

    def test_parse_remote_output_no_processes_line(self):
        node = NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")

        stdout = """__OPENSMI_BEGIN__
hostname=testnode
os=Ubuntu 22.04
__GPUS__
0, GPU-uuid0, NVIDIA RTX A6000, 49140
__PROCS__
No running processes found
__OWNERS__
__OPENSMI_END__
"""

        _meta, _gpus, procs = _parse_remote_output(node, stdout)
        self.assertEqual(procs, [])

    def test_parse_remote_output_extended_gpu_metrics(self):
        node = NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")

        stdout = """__OPENSMI_BEGIN__
hostname=testnode
os=Ubuntu 22.04
__GPUS__
0, GPU-uuid0, NVIDIA RTX A6000, 49140, 1024, 35, 62, 145.5
__PROCS__
No running processes found
__OWNERS__
__OPENSMI_END__
"""

        _meta, gpus, _procs = _parse_remote_output(node, stdout)
        self.assertEqual(len(gpus), 1)
        gpu = gpus[0]

        self.assertEqual(gpu.memory_total_mib, 49140)
        self.assertEqual(gpu.memory_used_mib, 1024)
        self.assertEqual(gpu.memory_free_mib, 48116)
        self.assertEqual(gpu.utilization_gpu_percent, 35)
        self.assertEqual(gpu.temperature_c, 62)
        self.assertEqual(gpu.power_draw_w, 145.5)

    def test_parse_remote_output_cmdline_from_owner_section(self):
        node = NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")
        cmd = "python3 train.py --epochs 100"
        cmd_b64 = base64.b64encode(cmd.encode("utf-8")).decode("ascii")

        stdout = f"""__OPENSMI_BEGIN__
hostname=testnode
os=Ubuntu 22.04
__GPUS__
0, GPU-uuid0, NVIDIA RTX A6000, 49140
__PROCS__
GPU-uuid0, 123, python3, 1000
__OWNERS__
123,alice,3600,{cmd_b64}
__OPENSMI_END__
"""

        _meta, _gpus, procs = _parse_remote_output(node, stdout)
        self.assertEqual(len(procs), 1)
        self.assertEqual(procs[0].cmdline, cmd)

    def test_parse_remote_output_cmdline_redacts_sensitive_flag(self):
        node = NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")
        cmd = "python train.py --token abc123 --api-key=secretvalue"
        cmd_b64 = base64.b64encode(cmd.encode("utf-8")).decode("ascii")

        stdout = f"""__OPENSMI_BEGIN__
hostname=testnode
os=Ubuntu 22.04
__GPUS__
0, GPU-uuid0, NVIDIA RTX A6000, 49140
__PROCS__
GPU-uuid0, 123, python, 1000
__OWNERS__
123,alice,120,{cmd_b64}
__OPENSMI_END__
"""

        _meta, _gpus, procs = _parse_remote_output(node, stdout)
        self.assertEqual(len(procs), 1)
        self.assertEqual(
            procs[0].cmdline,
            "python train.py --token ***REDACTED*** --api-key=***REDACTED***",
        )


    def test_parse_extended_metrics_all_fields(self):
        """All numeric GPU fields parse correctly after hoisting helpers."""
        from opensmi.collector import _parse_remote_output
        from opensmi.models import NodeConfig
        node = NodeConfig(alias="n1", address="10.0.0.1", user="u")
        stdout = (
            "__OPENSMI_BEGIN__\nhostname=h\nos=Linux\n"
            "__GPUS__\n"
            "0, uuid0, Tesla T4, 16160, 2048, 75, 68, 70.5\n"
            "__PROCS__\n__OWNERS__\n__OPENSMI_END__\n"
        )
        _meta, gpus, _procs = _parse_remote_output(node, stdout)
        self.assertEqual(gpus[0].memory_total_mib, 16160)
        self.assertEqual(gpus[0].memory_used_mib, 2048)
        self.assertEqual(gpus[0].utilization_gpu_percent, 75)
        self.assertEqual(gpus[0].temperature_c, 68)
        self.assertAlmostEqual(gpus[0].power_draw_w, 70.5)


if __name__ == "__main__":
    unittest.main()
