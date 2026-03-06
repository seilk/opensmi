import unittest

from opensmi.allocations import Allocation, remove_allocation, upsert_allocation


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


    def test_load_acquires_lock(self):
        """load_allocations should hold the advisory lock while reading."""
        import threading
        from opensmi.allocations import save_allocations, load_allocations, Allocation
        import tempfile, pathlib

        state_dir = pathlib.Path(tempfile.mkdtemp())
        alloc = Allocation(
            node_alias="n1", gpu_index=0, target="alice",
            assigned_by="admin", assigned_at="2024-01-01T00:00:00+09:00"
        )
        save_allocations(state_dir, [alloc])

        errors = []
        def writer():
            for _ in range(30):
                try:
                    save_allocations(state_dir, [alloc])
                except Exception as e:
                    errors.append(e)

        t = threading.Thread(target=writer)
        t.start()
        for _ in range(30):
            loaded = load_allocations(state_dir)
            if loaded and loaded[0].target != "alice":
                errors.append(ValueError(f"torn read: {loaded[0].target}"))
        t.join()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
