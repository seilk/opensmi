import unittest

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


if __name__ == "__main__":
    unittest.main()
