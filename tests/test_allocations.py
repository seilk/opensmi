import unittest

from micvgpus.allocations import Allocation, remove_allocation, upsert_allocation


class TestAllocations(unittest.TestCase):
    def test_upsert_and_remove(self):
        allocs = []
        a1 = Allocation(
            node_alias="GPU-01",
            gpu_index=0,
            target="alice",
            assigned_by="admin",
            assigned_at="t",
        )
        allocs = upsert_allocation(allocs, a1)
        self.assertEqual(len(allocs), 1)
        self.assertEqual(allocs[0].target, "alice")

        a2 = Allocation(
            node_alias="GPU-01",
            gpu_index=0,
            target="bob",
            assigned_by="admin",
            assigned_at="t2",
        )
        allocs = upsert_allocation(allocs, a2)
        self.assertEqual(len(allocs), 1)
        self.assertEqual(allocs[0].target, "bob")

        allocs = remove_allocation(allocs, node_alias="GPU-01", gpu_index=0)
        self.assertEqual(allocs, [])


if __name__ == "__main__":
    unittest.main()
