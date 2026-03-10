import unittest

from opensmi.models import (
    ClusterConfig,
    GPUInfo,
    GPUProcess,
    NodeConfig,
    NodeSnapshot,
    ClusterSnapshot,
)
from opensmi.allocations import Allocation
from opensmi.violations import find_violations


class TestViolations(unittest.TestCase):
    def _base(self):
        cfg = ClusterConfig(
            cluster_name="X",
            nodes=[NodeConfig(alias="GPU-01", address="10.0.0.1", user="ubuntu")],
            policy={"require_allocation": True, "all_users_token": "*"},
        )

        node = NodeSnapshot(node_alias="GPU-01", address="10.0.0.1")
        node.gpus = [
            GPUInfo(index=0, uuid="GPU-uuid0", name="A6000", memory_total_mib=49140)
        ]
        node.processes = [
            GPUProcess(
                gpu_uuid="GPU-uuid0",
                pid=111,
                process_name="python",
                used_memory_mib=10,
                user="bob",
            )
        ]

        snap = ClusterSnapshot(cluster_name="X", timestamp="t", nodes=[node])
        return cfg, snap

    def test_unallocated_in_use_is_violation(self):
        cfg, snap = self._base()
        viols = find_violations(cfg, snap, allocs=[])
        self.assertEqual(len(viols), 1)
        self.assertEqual(viols[0].reason, "UNALLOCATED_IN_USE")

    def test_star_allows_everyone(self):
        cfg, snap = self._base()
        allocs = [
            Allocation(
                node_alias="GPU-01",
                gpu_index=0,
                target="*",
                assigned_by="admin",
                assigned_at="t",
            )
        ]
        viols = find_violations(cfg, snap, allocs=allocs)
        self.assertEqual(viols, [])

    def test_wrong_user(self):
        cfg, snap = self._base()
        allocs = [
            Allocation(
                node_alias="GPU-01",
                gpu_index=0,
                target="alice",
                assigned_by="admin",
                assigned_at="t",
            )
        ]
        viols = find_violations(cfg, snap, allocs=allocs)
        self.assertEqual(len(viols), 1)
        self.assertEqual(viols[0].reason, "WRONG_USER")
        self.assertEqual(viols[0].expected, "alice")

    def test_unallocated_allowed_when_policy_disabled(self):
        cfg, snap = self._base()
        cfg.policy["require_allocation"] = False
        viols = find_violations(cfg, snap, allocs=[])
        self.assertEqual(viols, [])

    def test_violations_with_many_processes(self):
        """find_violations handles large process counts correctly."""
        from opensmi.models import (
            ClusterConfig, NodeConfig, ClusterSnapshot, NodeSnapshot,
            GPUInfo, GPUProcess,
        )
        from opensmi.allocations import Allocation
        from opensmi.violations import find_violations

        cfg = ClusterConfig(
            cluster_name="X",
            nodes=[NodeConfig(alias="n1", address="10.0.0.1", user="u")],
            policy={"require_allocation": True, "all_users_token": "*"},
        )
        node = NodeSnapshot(node_alias="n1", address="10.0.0.1")
        node.gpus = [GPUInfo(index=i, uuid=f"uuid{i}", name="A100") for i in range(8)]
        node.processes = [
            GPUProcess(gpu_uuid=f"uuid{i % 8}", pid=1000 + i,
                       process_name="python", user=f"user{i % 5}")
            for i in range(200)
        ]
        snap = ClusterSnapshot(cluster_name="X", timestamp="t", nodes=[node])
        allocs = [
            Allocation(node_alias="n1", gpu_index=i, target="user0",
                       assigned_by="admin", assigned_at="t")
            for i in range(8)
        ]
        viols = find_violations(cfg, snap, allocs)
        # users 1-4 are violators; user0 is the allowed user
        self.assertGreater(len(viols), 0)
        for v in viols:
            self.assertNotEqual(v.user, "user0")


if __name__ == "__main__":
    unittest.main()
