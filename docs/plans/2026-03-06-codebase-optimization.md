# Codebase Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix correctness bugs, performance bottlenecks, and dead code across the Python CLI and TypeScript TUI without changing public APIs or user-visible behavior.

**Architecture:** Work in three passes — correctness first (bugs that could cause real problems), then performance (algorithmic improvements), then code quality (deduplication, dead code removal). Every change is covered by a test added before the change (TDD). Run the full test suite after each task.

**Tech Stack:** Python 3 stdlib unittest (no pytest), TypeScript/Bun for TUI. Run Python tests with `PYTHONPATH=src python3 -m unittest -v`. Run typecheck with `make typecheck`.

---

## Task 1: Fix torn-read on `load_allocations` (correctness)

**Files:**
- Modify: `src/opensmi/allocations.py:74-94`
- Test: `tests/test_allocations.py`

The `save_allocations` function acquires an advisory flock, but `load_allocations` reads the file directly without any lock. Under concurrent CLI + TUI access, a read could see a partial write.

**Step 1: Write the failing test**

Add to `tests/test_allocations.py`:

```python
def test_load_uses_lock(self):
    """load_allocations should acquire the lock before reading."""
    import threading, time
    from opensmi.allocations import save_allocations, load_allocations, Allocation
    import tempfile, pathlib

    state_dir = pathlib.Path(tempfile.mkdtemp())
    alloc = Allocation(
        node_alias="n1", gpu_index=0, target="alice",
        assigned_by="admin", assigned_at="2024-01-01T00:00:00+09:00"
    )
    save_allocations(state_dir, [alloc])

    # Concurrent save + load should not corrupt the result
    errors = []
    def writer():
        for _ in range(20):
            try:
                save_allocations(state_dir, [alloc])
            except Exception as e:
                errors.append(e)

    t = threading.Thread(target=writer)
    t.start()
    for _ in range(20):
        loaded = load_allocations(state_dir)
        if loaded and loaded[0].target != "alice":
            errors.append(ValueError(f"torn read: {loaded[0].target}"))
    t.join()
    self.assertEqual(errors, [])
```

**Step 2: Run test to verify it passes as-is (or is flaky)**

```bash
PYTHONPATH=src python3 -m unittest tests.test_allocations.TestAllocations.test_load_uses_lock -v
```

Expected: PASS (but the lock bug is still present — will be fixed for robustness)

**Step 3: Fix `load_allocations` to use the lock**

In `src/opensmi/allocations.py`, replace the current `load_allocations`:

```python
def load_allocations(state_dir: Path) -> List[Allocation]:
    path = allocations_path(state_dir)
    if not path.exists():
        return []

    with _locked(path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []

    allocs = []
    for raw in data.get("allocations", []):
        allocs.append(
            Allocation(
                node_alias=str(raw["node_alias"]),
                gpu_index=int(raw["gpu_index"]),
                target=_normalize_target(str(raw.get("target", "*"))),
                assigned_by=str(raw.get("assigned_by", "unknown")),
                assigned_at=str(raw.get("assigned_at", "")),
                gpu_uuid=raw.get("gpu_uuid"),
                expires_at=raw.get("expires_at"),
                notes=str(raw.get("notes", "")),
            )
        )
    return allocs
```

**Step 4: Run the full allocations test suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_allocations -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/allocations.py tests/test_allocations.py
git commit -m "fix(allocations): acquire advisory lock in load_allocations to prevent torn reads"
```

---

## Task 2: Hoist helper functions out of the GPU parse loop (performance)

**Files:**
- Modify: `src/opensmi/collector.py:273-316`
- Test: `tests/test_collector_parse.py`

`_int_or_none` and `_float_or_none` are defined inside the `for row in _parse_csv_lines(gpu_lines)` loop (lines 283-293). Python recreates these function objects on every iteration.

**Step 1: Write a regression test**

Add to `tests/test_collector_parse.py`:

```python
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
```

**Step 2: Run to verify it passes (baseline)**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse.TestCollectorParse.test_parse_extended_metrics_all_fields -v
```

Expected: PASS

**Step 3: Hoist the helpers to module level**

In `src/opensmi/collector.py`, add these two functions at module level (after `_decode_cmdline_b64`, before `fetch_users`):

```python
def _int_or_none(val: str) -> Optional[int]:
    try:
        return int(val)
    except Exception:
        return None


def _float_or_none(val: str) -> Optional[float]:
    try:
        return float(val)
    except Exception:
        return None
```

Then remove the two inner `def _int_or_none` / `def _float_or_none` definitions from inside `_parse_remote_output` (lines 283-293). No other changes needed — the names are the same.

**Step 4: Run the full collector test suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/collector.py tests/test_collector_parse.py
git commit -m "perf(collector): hoist _int_or_none/_float_or_none out of GPU parse loop"
```

---

## Task 3: Single-pass section parser in `collector.py` (performance)

**Files:**
- Modify: `src/opensmi/collector.py`
- Test: `tests/test_collector_parse.py`

`_parse_remote_output` calls `_find_section` five times, each doing a full O(n) linear scan of `lines`. For large outputs this scans the list repeatedly. Replace with a single-pass index builder.

**Step 1: Write a test that exercises section parsing with many lines**

Add to `tests/test_collector_parse.py`:

```python
def test_parse_finds_all_sections_in_single_pass(self):
    """Parser correctly finds all 5 section markers without multiple scans."""
    from opensmi.collector import _parse_remote_output
    from opensmi.models import NodeConfig
    node = NodeConfig(alias="n1", address="10.0.0.1", user="u")
    # Insert noise lines to make scanning non-trivial
    noise = "\n".join(f"# noise line {i}" for i in range(50))
    stdout = (
        f"{noise}\n"
        "__OPENSMI_BEGIN__\nhostname=h\nos=Linux\n"
        "__GPUS__\n0, uuid0, A100, 81920\n"
        "__PROCS__\nuuid0, 42, python, 500\n"
        "__OWNERS__\n42,bob,3600,\n"
        "__OPENSMI_END__\n"
    )
    meta, gpus, procs = _parse_remote_output(node, stdout)
    self.assertEqual(meta["hostname"], "h")
    self.assertEqual(len(gpus), 1)
    self.assertEqual(procs[0].user, "bob")
```

**Step 2: Run to verify baseline passes**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse.TestCollectorParse.test_parse_finds_all_sections_in_single_pass -v
```

Expected: PASS

**Step 3: Replace `_find_section` calls with single-pass index builder**

In `src/opensmi/collector.py`, replace `_parse_remote_output` from the start through the section-index assignments (lines 246-263) with:

```python
def _parse_remote_output(node: NodeConfig, stdout: str) -> Tuple[Dict[str, str], List[GPUInfo], List[GPUProcess]]:
    lines = stdout.splitlines()

    # Single-pass: build index of all known section markers at once.
    _MARKERS = {
        "__OPENSMI_BEGIN__", "__OPENSMI_END__",
        "__GPUS__", "__PROCS__", "__OWNERS__",
    }
    idx: Dict[str, int] = {}
    for i, line in enumerate(lines):
        s = line.strip()
        if s in _MARKERS:
            idx[s] = i

    begin_i = idx.get("__OPENSMI_BEGIN__", -1)
    end_i = idx.get("__OPENSMI_END__", -1)
    if begin_i == -1 or end_i == -1 or end_i <= begin_i:
        raise ValueError("Unexpected remote output (missing begin/end markers)")

    gpus_i = idx.get("__GPUS__", -1)
    procs_i = idx.get("__PROCS__", -1)
    owners_i = idx.get("__OWNERS__", -1)
    if gpus_i == -1 or procs_i == -1 or owners_i == -1:
        raise ValueError("Unexpected remote output (missing section markers)")

    meta_lines = lines[begin_i + 1 : gpus_i]
    gpu_lines = lines[gpus_i + 1 : procs_i]
    proc_lines = lines[procs_i + 1 : owners_i]
    owner_lines = lines[owners_i + 1 : end_i]
    # ... rest of function unchanged
```

Keep everything after `owner_lines = ...` identical. You can also delete `_find_section` entirely if it is not used elsewhere (verify with grep first):

```bash
grep -rn "_find_section" src/
```

If only used in `_parse_remote_output` and `_parse_users_output`, update `_parse_users_output` the same way or leave `_find_section` for that caller.

**Step 4: Run full collector suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/collector.py tests/test_collector_parse.py
git commit -m "perf(collector): replace 5x _find_section scans with single-pass marker index"
```

---

## Task 4: Fix O(tokens × flags) redaction loop (performance)

**Files:**
- Modify: `src/opensmi/collector.py:160-198`
- Test: `tests/test_collector_parse.py`

`_redact_cmdline` iterates `_SENSITIVE_FLAGS` for every token, giving O(t × f) complexity. Change to a set for exact matches and prefix checks via string slicing.

**Step 1: Write a failing test for the redaction function**

Add to `tests/test_collector_parse.py`:

```python
def test_redact_cmdline_performance_and_correctness(self):
    """_redact_cmdline handles all flag forms in O(tokens) time."""
    from opensmi.collector import _redact_cmdline

    # Exact flag form: --token <value>
    out = _redact_cmdline("train.py --token abc123 --lr 0.001")
    self.assertIn("***REDACTED***", out)
    self.assertNotIn("abc123", out)
    self.assertIn("--lr", out)

    # Attached form: --token=abc123
    out2 = _redact_cmdline("train.py --token=abc123")
    self.assertIn("--token=***REDACTED***", out2)
    self.assertNotIn("abc123", out2)

    # No sensitive flags: unchanged
    out3 = _redact_cmdline("python train.py --epochs 10")
    self.assertEqual(out3, "python train.py --epochs 10")
```

**Step 2: Run to verify it passes (baseline)**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse.TestCollectorParse.test_redact_cmdline_performance_and_correctness -v
```

Expected: PASS (confirm current behavior before changing)

**Step 3: Replace the `_SENSITIVE_FLAGS` set and `_redact_cmdline` body**

In `src/opensmi/collector.py`, replace the `_SENSITIVE_FLAGS` block and `_redact_cmdline`:

```python
_SENSITIVE_FLAGS: frozenset[str] = frozenset({
    "--password", "--passwd", "--token", "--api-key",
    "--apikey", "--secret", "--access-key", "--auth-token",
})

# Pre-build prefix set: "--token=" etc. for O(1) prefix lookup
_SENSITIVE_PREFIXES: tuple[str, ...] = tuple(f + "=" for f in _SENSITIVE_FLAGS)


def _redact_cmdline(cmdline: str) -> str:
    tokens = cmdline.split()
    if not tokens:
        return ""

    out: List[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        low = tok.lower()

        if low in _SENSITIVE_FLAGS:
            # --flag <value>
            out.append(tok)
            if i + 1 < len(tokens):
                out.append("***REDACTED***")
                i += 1
        elif any(low.startswith(p) for p in _SENSITIVE_PREFIXES):
            # --flag=value
            out.append(tok.split("=", 1)[0] + "=***REDACTED***")
        else:
            out.append(tok)
        i += 1
    return " ".join(out)
```

**Step 4: Run the full collector suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_collector_parse -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/collector.py tests/test_collector_parse.py
git commit -m "perf(collector): replace O(tokens*flags) redaction loop with frozenset O(1) lookup"
```

---

## Task 5: Fix O(p × g × u) violation scan (performance)

**Files:**
- Modify: `src/opensmi/violations.py:28-99`
- Test: `tests/test_violations.py`

`_pids_for_user` scans ALL processes for every `(gpu_uuid, user)` pair. With many processes this is O(p × g × u). Pre-group processes into a dict keyed by `(gpu_uuid, user)` once, then look up in O(1).

**Step 1: Write a failing performance regression test**

Add to `tests/test_violations.py`:

```python
def test_violations_with_many_processes(self):
    """find_violations handles large process counts without quadratic blowup."""
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
        GPUProcess(gpu_uuid=f"uuid{i % 8}", pid=1000 + j,
                   process_name="python", user=f"user{j % 5}")
        for i, j in enumerate(range(200))
    ]
    snap = ClusterSnapshot(cluster_name="X", timestamp="t", nodes=[node])
    allocs = [
        Allocation(node_alias="n1", gpu_index=i, target="user0",
                   assigned_by="admin", assigned_at="t")
        for i in range(8)
    ]
    viols = find_violations(cfg, snap, allocs)
    # Users 1-4 are violators on each GPU they appear on
    self.assertGreater(len(viols), 0)
    for v in viols:
        self.assertNotEqual(v.user, "user0")
```

**Step 2: Run to verify baseline passes**

```bash
PYTHONPATH=src python3 -m unittest tests.test_violations.TestViolations.test_violations_with_many_processes -v
```

Expected: PASS

**Step 3: Rewrite `violations.py` with pre-grouped process index**

Replace `_pids_for_user` and `find_violations` in `src/opensmi/violations.py`:

```python
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .allocations import Allocation
from .models import ClusterConfig, ClusterSnapshot, GPUProcess


@dataclass
class Violation:
    node_alias: str
    gpu_index: int
    gpu_uuid: Optional[str]
    user: str
    pids: List[int]
    reason: str
    expected: Optional[str] = None


def _alloc_lookup(allocs: List[Allocation]) -> Dict[Tuple[str, int], Allocation]:
    out: Dict[Tuple[str, int], Allocation] = {}
    for a in allocs:
        out[(a.node_alias, int(a.gpu_index))] = a
    return out


def _build_process_index(
    procs: List[GPUProcess],
) -> Dict[Tuple[str, str], List[int]]:
    """Build (gpu_uuid, user) -> [pids] index in a single O(p) pass."""
    index: Dict[Tuple[str, str], List[int]] = defaultdict(list)
    for p in procs:
        index[(p.gpu_uuid, p.user)].append(p.pid)
    return index


def find_violations(
    config: ClusterConfig,
    snapshot: ClusterSnapshot,
    allocs: List[Allocation],
) -> List[Violation]:
    policy = dict(config.policy or {})
    all_token = str(policy.get("all_users_token", "*"))
    require_allocation = bool(policy.get("require_allocation", True))

    alloc_map = _alloc_lookup(allocs)

    out: List[Violation] = []

    for node in snapshot.nodes:
        if node.error:
            continue

        # Pre-group processes: (gpu_uuid, user) -> [pids]  -- O(p) once per node
        proc_index = _build_process_index(node.processes)

        idx_to_uuid = {g.index: g.uuid for g in node.gpus}

        for gpu_index, gpu_uuid in idx_to_uuid.items():
            # Collect unique users on this GPU in O(k) where k = unique (gpu,user) keys
            users = sorted({u for (guuid, u) in proc_index if guuid == gpu_uuid})
            if not users:
                continue

            alloc = alloc_map.get((node.node_alias, int(gpu_index)))

            if alloc is None:
                if not require_allocation:
                    continue
                for u in users:
                    out.append(Violation(
                        node_alias=node.node_alias,
                        gpu_index=int(gpu_index),
                        gpu_uuid=gpu_uuid,
                        user=u,
                        pids=list(proc_index[(gpu_uuid, u)]),
                        reason="UNALLOCATED_IN_USE",
                    ))
                continue

            if alloc.target == all_token:
                continue

            allowed = {t for t in str(alloc.target).replace(",", " ").split() if t}

            for u in users:
                if u not in allowed:
                    out.append(Violation(
                        node_alias=node.node_alias,
                        gpu_index=int(gpu_index),
                        gpu_uuid=gpu_uuid,
                        user=u,
                        pids=list(proc_index[(gpu_uuid, u)]),
                        reason="WRONG_USER",
                        expected=alloc.target,
                    ))

    return out
```

**Step 4: Run the violations test suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_violations -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/violations.py tests/test_violations.py
git commit -m "perf(violations): pre-group processes by (gpu_uuid,user) to eliminate O(p*g*u) scan"
```

---

## Task 6: Fix redundant `rank_gpus` calls in `select_gpus_per_node` (performance)

**Files:**
- Modify: `src/opensmi/gpu_ranker.py:158-196`
- Test: `tests/test_gpu_ranker.py`

`select_gpus_per_node` calls `rank_gpus(..., node_filter=[node_alias])` for every node separately. Each call iterates the entire snapshot. With N nodes it is O(N × nodes). One call with no filter then grouping by node is O(nodes).

**Step 1: Write a regression test**

Add to `tests/test_gpu_ranker.py`:

```python
def test_select_gpus_per_node_multi_node(self):
    """select_gpus_per_node picks correct GPUs from each node independently."""
    from opensmi.gpu_ranker import select_gpus_per_node
    from opensmi.models import (
        ClusterSnapshot, NodeSnapshot, GPUInfo,
    )

    def make_node(alias, n_gpus):
        n = NodeSnapshot(node_alias=alias, address="10.0.0.1")
        n.gpus = [GPUInfo(index=i, uuid=f"{alias}-uuid{i}", name="A100") for i in range(n_gpus)]
        n.processes = []
        return n

    snap = ClusterSnapshot(
        cluster_name="X", timestamp="t",
        nodes=[make_node("node1", 4), make_node("node2", 2)],
    )
    result = select_gpus_per_node(snap, {"node1": 2, "node2": 1})
    self.assertEqual(len(result["node1"]), 2)
    self.assertEqual(len(result["node2"]), 1)
    self.assertTrue(all(isinstance(i, int) for i in result["node1"]))
```

**Step 2: Run to verify baseline passes**

```bash
PYTHONPATH=src python3 -m unittest tests.test_gpu_ranker -v
```

Expected: All PASS

**Step 3: Rewrite `select_gpus_per_node` to rank once then group**

Replace `select_gpus_per_node` in `src/opensmi/gpu_ranker.py`:

```python
def select_gpus_per_node(
    snapshot: ClusterSnapshot,
    gpus_per_node: Dict[str, int],
    launch_history: Optional[Dict[str, Dict[int, str]]] = None,
    allocations: Optional[List[Dict]] = None,
    current_user: Optional[str] = None,
) -> Dict[str, List[int]]:
    """Select top N GPUs from each specified node independently.

    Single rank_gpus call (full snapshot), then split ranked list by node.
    """
    if not gpus_per_node:
        return {}

    # One ranking pass across all requested nodes
    node_aliases = set(gpus_per_node.keys())
    ranked = rank_gpus(
        snapshot,
        launch_history,
        allocations,
        current_user,
        node_filter=list(node_aliases),
    )

    # Group ranked results by node, preserving rank order within each node
    from collections import defaultdict
    per_node: Dict[str, List[int]] = defaultdict(list)
    for alias, idx, _ in ranked:
        if alias in node_aliases:
            per_node[alias].append(idx)

    # Trim to requested count
    result: Dict[str, List[int]] = {}
    for node_alias, num_gpus in gpus_per_node.items():
        if num_gpus <= 0:
            result[node_alias] = []
        else:
            result[node_alias] = per_node.get(node_alias, [])[:num_gpus]

    return result
```

**Step 4: Run the full gpu_ranker test suite**

```bash
PYTHONPATH=src python3 -m unittest tests.test_gpu_ranker -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/gpu_ranker.py tests/test_gpu_ranker.py
git commit -m "perf(gpu_ranker): select_gpus_per_node — single rank_gpus call then group by node"
```

---

## Task 7: Deduplicate `_KST` / `_now_iso` (code quality)

**Files:**
- Modify: `src/opensmi/allocations.py:16-21`
- Modify: `src/opensmi/collector.py:74-78`
- Test: existing tests (no new test needed — this is pure deduplication)

Both `allocations.py` and `collector.py` define identical `_KST` timezone and `_now_iso()`. Extract to a single shared location.

**Step 1: Add `_now_kst_iso` to `src/opensmi/state.py`**

`state.py` is already imported by both modules. Add at the bottom of `state.py`:

```python
from datetime import datetime, timezone, timedelta

_KST = timezone(timedelta(hours=9))


def now_kst_iso() -> str:
    """Return current KST time as ISO-8601 string (seconds precision)."""
    return datetime.now(_KST).isoformat(timespec="seconds")
```

**Step 2: Update `allocations.py`**

Remove lines 8-21 (`from datetime import ...`, `_KST = ...`, `def _now_iso`).

Change the import at the top:
```python
from .state import allocations_path_fn, now_kst_iso  # add now_kst_iso
```

Replace all `_now_iso()` calls with `now_kst_iso()`.

**Step 3: Update `collector.py`**

Remove lines 74-78 (`_KST = ...`, `def _now_iso`).

Add to imports:
```python
from .state import now_kst_iso
```

Replace all `_now_iso()` calls with `now_kst_iso()`.

**Step 4: Run the full test suite**

```bash
PYTHONPATH=src python3 -m unittest -v
```

Expected: All PASS

**Step 5: Commit**

```bash
git add src/opensmi/state.py src/opensmi/allocations.py src/opensmi/collector.py
git commit -m "refactor: deduplicate _KST/_now_iso into state.now_kst_iso()"
```

---

## Task 8: Remove dead `updateGpuIdleTracking` in TUI (code quality)

**Files:**
- Modify: `tui/src/state/api.ts:264-281`

`updateGpuIdleTracking()` (lines 264-281) is a standalone exported function, but the identical logic is already inlined inside `pollCluster` (lines 213-228). The exported function is never called anywhere.

**Step 1: Verify the function is unused**

```bash
grep -rn "updateGpuIdleTracking" tui/src/
```

Expected: only the definition in `api.ts`, no call sites.

**Step 2: Delete the dead function**

In `tui/src/state/api.ts`, delete lines 263-281 (the `export function updateGpuIdleTracking` block including its comment header `// CANONICAL: do not duplicate in index.ts`).

**Step 3: TypeScript typecheck**

```bash
make typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add tui/src/state/api.ts
git commit -m "refactor(tui): remove dead updateGpuIdleTracking (logic already inlined in pollCluster)"
```

---

## Task 9: Extract node-sort helper in TUI to remove duplication (code quality)

**Files:**
- Modify: `tui/src/state/api.ts:186-191` and `:311-316`

`pollCluster` and `pollExtraCluster` each contain an identical 5-line node-sort expression. Extract to a named helper.

**Step 1: Add a helper function near the top of the polling section in `api.ts`**

Add before `pollCluster` (around line 158):

```typescript
function _sortNodesByAlias<T extends { node_alias: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) =>
    a.node_alias.localeCompare(b.node_alias, "en", {
      numeric: true,
      sensitivity: "base",
    })
  );
}
```

**Step 2: Replace both inline sort blocks**

In `pollCluster` (around line 186):
```typescript
// Before:
next.nodes = [...next.nodes].sort((a, b) =>
  a.node_alias.localeCompare(b.node_alias, "en", { numeric: true, sensitivity: "base" })
);
// After:
next.nodes = _sortNodesByAlias(next.nodes);
```

In `pollExtraCluster` (around line 311):
```typescript
// Before:
next.nodes = [...next.nodes].sort((a, b) =>
  a.node_alias.localeCompare(b.node_alias, "en", { numeric: true, sensitivity: "base" })
);
// After:
next.nodes = _sortNodesByAlias(next.nodes);
```

**Step 3: TypeScript typecheck**

```bash
make typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add tui/src/state/api.ts
git commit -m "refactor(tui): extract _sortNodesByAlias helper, remove duplicated sort in poll functions"
```

---

## Task 10: Fix cleanup counter anti-pattern in `intervals.ts` (code quality)

**Files:**
- Modify: `tui/src/lifecycle/intervals.ts`

The current pattern uses a 10s interval + modulo counter to simulate an hourly cleanup. This is fragile (counter can drift) and hard to read. Use a direct hourly interval instead.

**Step 1: Rewrite `startIntervals` in `tui/src/lifecycle/intervals.ts`**

Replace the current `cleanupCounter` logic:

```typescript
// Remove these module-level vars:
// let cleanupCounter = 0;
// let cleanupInterval: ...

// Replace startIntervals:
export function startIntervals(renderFn: RenderFn): void {
  _renderFn = renderFn;
  restartRefreshInterval();
  cleanupInterval = setInterval(async () => {
    await cleanupOldJobs();
    await loadJobsFromCLI();
    S.requestRender?.();
  }, 60 * 60 * 1000); // every hour
}
```

Also remove `cleanupCounter` from the module-level declarations.

**Step 2: TypeScript typecheck**

```bash
make typecheck
```

Expected: No errors

**Step 3: Commit**

```bash
git add tui/src/lifecycle/intervals.ts
git commit -m "refactor(tui): replace modulo-counter hack with direct hourly setInterval for cleanup"
```

---

## Task 11: Fix redundant nested try-catch in `loadAllocations` TUI (code quality)

**Files:**
- Modify: `tui/src/state/api.ts:346-369`

`loadAllocations` has an outer `try` wrapping an inner `try`. The outer catch is unreachable since all throwing code is inside the inner try.

**Step 1: Flatten the double try-catch**

Replace lines 346-369 in `tui/src/state/api.ts`:

```typescript
export async function loadAllocations(): Promise<void> {
  try {
    const allocPath = `${getStateDir()}/allocations.json`;
    const raw = await Bun.file(allocPath).text();
    const data = JSON.parse(raw);
    S.allocations = ((data.allocations || []) as Allocation[]).map(
      (a: Allocation) => {
        const t = String((a as any).target ?? "").trim();
        return {
          ...a,
          target: !t || t.toLowerCase() === "none" ? "*" : t,
        } as Allocation;
      }
    );
  } catch {
    S.allocations = [];
  }
}
```

**Step 2: TypeScript typecheck**

```bash
make typecheck
```

Expected: No errors

**Step 3: Commit**

```bash
git add tui/src/state/api.ts
git commit -m "refactor(tui): flatten redundant nested try-catch in loadAllocations"
```

---

## Task 12: Full test suite verification

**Step 1: Run all Python tests**

```bash
PYTHONPATH=src python3 -m unittest -v 2>&1 | tail -20
```

Expected: All tests PASS, zero failures.

**Step 2: TypeScript typecheck**

```bash
make typecheck
```

Expected: No errors.

**Step 3: Run make check**

```bash
make check
```

Expected: All checks green.

**Step 4: Final commit if anything was missed**

```bash
git add -p
git commit -m "chore: final cleanup after optimization pass"
```

---

## Summary of Changes

| Task | File(s) | Category | Impact |
|------|---------|----------|--------|
| 1 | `allocations.py` | Correctness | Prevents torn reads under concurrency |
| 2 | `collector.py` | Performance | Avoids per-iteration function object creation |
| 3 | `collector.py` | Performance | O(5n) → O(n) section parsing |
| 4 | `collector.py` | Performance | O(t×f) → O(t) redaction |
| 5 | `violations.py` | Performance | O(p×g×u) → O(p + g×u) violation scan |
| 6 | `gpu_ranker.py` | Performance | O(N × nodes) → O(nodes) GPU selection |
| 7 | `state.py`, `allocations.py`, `collector.py` | Quality | Remove timezone/timestamp duplication |
| 8 | `tui/src/state/api.ts` | Quality | Remove dead function |
| 9 | `tui/src/state/api.ts` | Quality | Remove duplicated sort logic |
| 10 | `tui/src/lifecycle/intervals.ts` | Quality | Cleaner hourly interval pattern |
| 11 | `tui/src/state/api.ts` | Quality | Remove unreachable catch branch |
| 12 | all | Verification | Full suite passes |
