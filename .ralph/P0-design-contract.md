# P0: Planning & Contract Lock

**Status**: LOCKED ✓  
**Iteration**: 1  
**Date**: 2026-02-17

---

## 1. Code Path Mapping

### Current Architecture (Verified)

```
TUI (TypeScript)
  ├─ tui/index.ts
  │  ├─ launchDistMode: "single" | "one-to-one"
  │  ├─ launchExecMode: "direct" | "tmux"
  │  └─ launchSelectedGpus: Array<{node_alias, gpu_index}>
  │
  └─ [BOUNDARY] → Python Backend (via spawn/exec)
      │
      ├─ src/opensmi/executor.py
      │  ├─ route_command_to_target(context: RemoteExecutionContext) → RemoteExecResult
      │  ├─ inject_cuda_visible_devices(target: NodeTarget) → GPUEnvConfig
      │  └─ validate_gpu_availability(target: NodeTarget) → List[int]
      │
      ├─ src/opensmi/sshutil.py
      │  ├─ ssh_exec_remote(node, command, env_vars, timeout_s) → RemoteExecResult
      │  ├─ ssh_run_with_retry(node, remote_args, ...) → (rc, stdout, stderr)
      │  └─ ssh_bash_script(node, script, ...) → (rc, stdout, stderr)
      │
      ├─ src/opensmi/models.py
      │  ├─ NodeConfig (alias, address, user, port)
      │  ├─ NodeTarget (node_alias, gpu_indices, node_config)
      │  ├─ RemoteExecutionContext (target, command, env_vars, execution_mode, tmux_session, timeout_s)
      │  ├─ GPUEnvConfig (gpu_indices, cuda_visible_devices, additional_env)
      │  ├─ PreflightCheck (check_type, node_alias, target_gpu_indices, command_to_validate)
      │  └─ PreflightResult (check, passed, error_message, metadata)
      │
      └─ src/opensmi/gpu_ranker.py
         ├─ rank_gpus(snapshot, ...) → List[(node_alias, gpu_index, GPUInfo)]
         └─ select_gpus_per_node(snapshot, gpus_per_node, ...) → Dict[str, List[int]]
```

### Execution Flow (Verified)

```
[TUI Layer]
1. User configures:
   - Command(s): single command OR multiple commands (one-to-one)
   - GPU count: selected via +/- keys
   - Execution mode: direct vs tmux
   - Distribution mode: single vs one-to-one

2. GPU Selection:
   - TUI uses gpu_ranker.py logic (mirrored in TS)
   - Selects top-N GPUs by priority ranking
   - Result: [(node_alias, gpu_index), ...]

3. Command Preparation:
   - single mode: Same command → all GPUs
   - one-to-one mode: Different command per GPU (validated: len(commands) == len(gpus))

[Backend Layer - CURRENT GAP]
4. Execution Routing (NEEDS ENHANCEMENT):
   ✓ EXISTING: Single node, direct execution
   ✗ MISSING: Multi-node orchestration
   ✗ MISSING: one-to-one mode proper GPU targeting per command
   ✗ MISSING: DDP env var injection for dist=single across nodes

5. SSH Execution (SOLID):
   ✓ Command escaping (via bash -c)
   ✓ Environment variable injection
   ✓ Retry logic with exponential backoff
   ✓ tmux session management
```

---

## 2. Data Contract Definition

### 2.1 ExecutionTarget (EXISTING: NodeTarget)

**Status**: REUSE EXISTING `NodeTarget`  
**Location**: `src/opensmi/models.py:69-75`

```python
@dataclass
class NodeTarget:
    """Specifies a target node and GPU(s) for remote execution."""
    node_alias: str
    gpu_indices: List[int]
    node_config: Optional[NodeConfig] = None
```

**Contract**:
- `node_alias`: Must match a node in ClusterConfig
- `gpu_indices`: List of GPU indices on THIS node (NOT global indices)
- `node_config`: Must be populated before execution (validated in executor.py)

**Usage Pattern**:
```python
# Single node target
target = NodeTarget(
    node_alias="gpu01",
    gpu_indices=[0, 1, 2],
    node_config=config.nodes["gpu01"]
)

# Multiple targets (for one-to-one or dist=single)
targets = [
    NodeTarget("gpu01", [0, 1], node_config=...),
    NodeTarget("gpu02", [3], node_config=...),
]
```

---

### 2.2 RemoteExecRequest (EXISTING: RemoteExecutionContext)

**Status**: REUSE EXISTING `RemoteExecutionContext`  
**Location**: `src/opensmi/models.py:78-87`

```python
@dataclass
class RemoteExecutionContext:
    """Context for executing a command on a remote node with GPU assignment."""
    target: NodeTarget
    command: str
    env_vars: Dict[str, str] = field(default_factory=dict)
    execution_mode: str = "direct"  # "direct" or "tmux"
    tmux_session: Optional[str] = None
    timeout_s: int = 300
```

**Contract**:
- `target`: NodeTarget with populated node_config
- `command`: Shell command string (will be escaped via bash -c)
- `env_vars`: Environment variables (CUDA_VISIBLE_DEVICES injected here)
- `execution_mode`: "direct" (ssh + bash -c) OR "tmux" (ssh + tmux new-session -d)
- `tmux_session`: REQUIRED if execution_mode="tmux"
- `timeout_s`: SSH execution timeout (default 300s = 5min)

**Usage Pattern**:
```python
# Direct execution
ctx = RemoteExecutionContext(
    target=target,
    command="python train.py --epochs 10",
    env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
    execution_mode="direct",
    timeout_s=600
)

# Tmux execution
ctx = RemoteExecutionContext(
    target=target,
    command="python train.py --epochs 100",
    env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
    execution_mode="tmux",
    tmux_session="opensmi-1739742482",
    timeout_s=300
)
```

---

### 2.3 RemoteExecResult (EXISTING)

**Status**: KEEP AS-IS  
**Location**: `src/opensmi/sshutil.py:152-164`

```python
@dataclass
class RemoteExecResult:
    """Result of a remote command execution."""
    exit_code: int
    stdout: str
    stderr: str
    node_alias: str
    command: str
    success: bool = field(init=False)  # Auto-computed: exit_code == 0
```

**Contract**:
- `exit_code`: SSH command exit code (0 = success)
- `stdout`, `stderr`: Captured output (tail if tmux detached)
- `node_alias`: Identifies which node this result came from
- `command`: Original command (for tracing)
- `success`: Auto-computed property

**Usage Pattern**:
```python
result = await route_command_to_target(ctx)
if result.success:
    print(f"✓ {result.node_alias}: {result.stdout}")
else:
    print(f"✗ {result.node_alias}: {result.stderr}")
```

---

### 2.4 NEW: DistributedExecutionPlan

**Status**: NEW (for P3 - DDP orchestration)  
**Location**: `src/opensmi/models.py` (TO BE ADDED)

```python
@dataclass
class DistributedExecutionPlan:
    """Plan for executing a command across multiple nodes/GPUs with DDP env vars.
    
    This is for dist=single mode where the same command runs on multiple GPUs
    with proper rank/world-size/master coordination.
    """
    contexts: List[RemoteExecutionContext]  # One per GPU
    world_size: int  # Total number of GPUs
    master_addr: str  # Master node address
    master_port: int  # Master communication port
    
    def __post_init__(self):
        if len(self.contexts) != self.world_size:
            raise ValueError(f"contexts count ({len(self.contexts)}) != world_size ({self.world_size})")
```

**Contract**:
- `contexts`: List of RemoteExecutionContext, one per GPU
- Each context has RANK injected in env_vars (0, 1, 2, ...)
- `world_size`: Total number of participating GPUs
- `master_addr`: IP/hostname of rank 0 node
- `master_port`: Port for inter-process communication (default: 29500)

**Usage Pattern** (P3):
```python
# Example: 3 GPUs across 2 nodes
plan = DistributedExecutionPlan(
    contexts=[
        # gpu01:0 (rank 0 = master)
        RemoteExecutionContext(
            target=NodeTarget("gpu01", [0], node_config=...),
            command="python train.py",
            env_vars={
                "CUDA_VISIBLE_DEVICES": "0",
                "RANK": "0",
                "WORLD_SIZE": "3",
                "MASTER_ADDR": "10.0.0.1",
                "MASTER_PORT": "29500"
            }
        ),
        # gpu01:1 (rank 1)
        RemoteExecutionContext(
            target=NodeTarget("gpu01", [1], node_config=...),
            command="python train.py",
            env_vars={
                "CUDA_VISIBLE_DEVICES": "1",
                "RANK": "1",
                "WORLD_SIZE": "3",
                "MASTER_ADDR": "10.0.0.1",
                "MASTER_PORT": "29500"
            }
        ),
        # gpu02:0 (rank 2)
        RemoteExecutionContext(
            target=NodeTarget("gpu02", [0], node_config=...),
            command="python train.py",
            env_vars={
                "CUDA_VISIBLE_DEVICES": "0",
                "RANK": "2",
                "WORLD_SIZE": "3",
                "MASTER_ADDR": "10.0.0.1",
                "MASTER_PORT": "29500"
            }
        ),
    ],
    world_size=3,
    master_addr="10.0.0.1",
    master_port=29500
)
```

---

## 3. Mode-Specific Execution Contracts

### 3.1 Mode: `dist=single` (same command, multiple GPUs)

**Scenario**: User wants to run SAME command on N GPUs (potentially across multiple nodes)

**Input**:
- Command: `"python train.py --epochs 100"`
- GPUs: `[("gpu01", 0), ("gpu01", 1), ("gpu02", 3)]`
- Execution mode: `"tmux"`

**Expected Behavior** (P3 - DDP):
1. Create 3 RemoteExecutionContext objects (one per GPU)
2. Each context gets:
   - CUDA_VISIBLE_DEVICES set to node-local GPU index
   - RANK set to global rank (0, 1, 2)
   - WORLD_SIZE set to 3
   - MASTER_ADDR set to first node's address
   - MASTER_PORT set to 29500 (or user-configurable)
3. Execute all contexts in parallel (asyncio.gather)
4. Return aggregated results

**Current Gap**: NO DDP orchestration (RANK/WORLD_SIZE not injected)

---

### 3.2 Mode: `dist=one-to-one` (different command per GPU)

**Scenario**: User wants to run DIFFERENT commands on N GPUs

**Input**:
- Commands: `["python train.py --fold 0", "python train.py --fold 1", "python train.py --fold 2"]`
- GPUs: `[("gpu01", 0), ("gpu01", 1), ("gpu02", 3)]`
- Execution mode: `"tmux"`

**Expected Behavior** (P1):
1. Validate: len(commands) == len(gpus)
2. Create N RemoteExecutionContext objects (one per GPU)
3. Each context gets:
   - command = commands[i]
   - CUDA_VISIBLE_DEVICES = node-local GPU index
   - NO DDP env vars (commands are independent)
4. Execute all contexts in parallel (asyncio.gather)
5. Return per-GPU results

**Current Gap**: one-to-one mode NOT properly implemented in backend

---

## 4. Calling Conventions

### 4.1 Single Node Execution (EXISTING - WORKS)

```python
from opensmi.executor import route_command_to_target
from opensmi.models import NodeTarget, RemoteExecutionContext

target = NodeTarget(
    node_alias="gpu01",
    gpu_indices=[0, 1],
    node_config=cluster_config.nodes["gpu01"]
)

context = RemoteExecutionContext(
    target=target,
    command="python train.py",
    env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
    execution_mode="direct"
)

result = await route_command_to_target(context)
print(result.success, result.stdout)
```

---

### 4.2 Multi-Node Execution (TO BE IMPLEMENTED - P1)

```python
import asyncio
from opensmi.executor import route_command_to_target
from opensmi.models import NodeTarget, RemoteExecutionContext

# Define targets
targets = [
    NodeTarget("gpu01", [0, 1], node_config=config.nodes["gpu01"]),
    NodeTarget("gpu02", [3], node_config=config.nodes["gpu02"]),
]

# Create execution contexts
contexts = [
    RemoteExecutionContext(
        target=targets[0],
        command="python train.py",
        env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
        execution_mode="tmux",
        tmux_session="opensmi-123-gpu01"
    ),
    RemoteExecutionContext(
        target=targets[1],
        command="python train.py",
        env_vars={"CUDA_VISIBLE_DEVICES": "3"},
        execution_mode="tmux",
        tmux_session="opensmi-123-gpu02"
    ),
]

# Execute in parallel
results = await asyncio.gather(*[route_command_to_target(ctx) for ctx in contexts])

# Check results
for result in results:
    print(f"{result.node_alias}: {'✓' if result.success else '✗'} {result.stderr}")
```

---

### 4.3 one-to-one Mode (TO BE IMPLEMENTED - P1)

```python
# User input (from TUI)
commands = [
    "python train.py --fold 0",
    "python train.py --fold 1",
    "python train.py --fold 2"
]
selected_gpus = [("gpu01", 0), ("gpu01", 1), ("gpu02", 3)]

# Validate
if len(commands) != len(selected_gpus):
    raise ValueError(f"Command count ({len(commands)}) != GPU count ({len(selected_gpus)})")

# Build contexts
contexts = []
for i, (cmd, (node_alias, gpu_idx)) in enumerate(zip(commands, selected_gpus)):
    target = NodeTarget(
        node_alias=node_alias,
        gpu_indices=[gpu_idx],  # ONE GPU per context
        node_config=config.nodes[node_alias]
    )
    
    env_config = inject_cuda_visible_devices(target)
    
    ctx = RemoteExecutionContext(
        target=target,
        command=cmd,
        env_vars=env_config.to_env_dict(),
        execution_mode="tmux",
        tmux_session=f"opensmi-{timestamp}-{node_alias}-{gpu_idx}"
    )
    contexts.append(ctx)

# Execute in parallel
results = await asyncio.gather(*[route_command_to_target(ctx) for ctx in contexts])
```

---

### 4.4 DDP Orchestration (TO BE IMPLEMENTED - P3)

```python
from opensmi.executor import create_distributed_execution_plan, execute_distributed_plan

# User input
command = "python train.py --epochs 100"
selected_gpus = [("gpu01", 0), ("gpu01", 1), ("gpu02", 3)]

# Create DDP plan
plan = create_distributed_execution_plan(
    command=command,
    gpus=selected_gpus,
    config=cluster_config,
    execution_mode="tmux",
    tmux_session_prefix="opensmi-ddp-123"
)

# Execute
results = await execute_distributed_plan(plan)

# Verify
if all(r.success for r in results):
    print("✓ Distributed training launched successfully")
else:
    for r in results:
        if not r.success:
            print(f"✗ {r.node_alias}: {r.stderr}")
```

---

## 5. Preflight Check Integration (P2)

### Contract

```python
from opensmi.models import PreflightCheck, PreflightCheckType, PreflightResult

# Define checks
checks = [
    PreflightCheck(
        check_type=PreflightCheckType.TMUX_AVAILABLE,
        node_alias="gpu01"
    ),
    PreflightCheck(
        check_type=PreflightCheckType.GPU_AVAILABILITY,
        node_alias="gpu01",
        target_gpu_indices=[0, 1]
    ),
    PreflightCheck(
        check_type=PreflightCheckType.COMMAND_SYNTAX,
        node_alias="gpu01",
        command_to_validate="python train.py"
    ),
]

# Execute checks
results: List[PreflightResult] = await run_preflight_checks(checks)

# Validate
critical_failures = [r for r in results if r.is_critical_failure()]
if critical_failures:
    for failure in critical_failures:
        print(f"✗ {failure.check.node_alias}: {failure.error_message}")
    raise RuntimeError("Preflight checks failed")
```

---

## 6. Connection Points

### 6.1 TUI → Backend

**Current**: TUI spawns Python process (unclear contract)  
**Required**: Well-defined JSON API

**Proposed**:
```typescript
// TUI sends JSON to Python backend
const launchRequest = {
  mode: "one-to-one" | "single",
  execution_mode: "direct" | "tmux",
  commands: string[],  // Single element for mode=single
  gpus: Array<{node_alias: string, gpu_index: number}>,
  timeout_s: number,
  preflight: boolean  // Run preflight checks?
}

// Python backend returns JSON
const launchResponse = {
  success: boolean,
  results: Array<{
    node_alias: string,
    gpu_index: number,
    command: string,
    exit_code: number,
    stdout: string,
    stderr: string,
    tmux_session?: string
  }>,
  errors: string[]
}
```

**Implementation Path**:
- Create `src/opensmi/launch.py` as backend entry point
- Parse JSON from stdin
- Call executor functions
- Return JSON to stdout

---

### 6.2 Executor → SSH

**Current**: SOLID ✓  
**No changes needed**

`route_command_to_target()` → `ssh_exec_remote()` → `ssh_run_with_retry()` → SSH subprocess

---

## 7. Safety & Escaping

### Current Status: SOLID ✓

**Verified safe patterns**:
1. `ssh_exec_remote()` uses `bash -c <command>` with proper quoting
2. Environment variables injected via `KEY=VALUE` prefix
3. No string interpolation vulnerabilities found
4. Tmux session names are user-controlled (low risk, validated format)

**Example**:
```python
# Safe: env vars are NOT interpolated into command string
env_vars = {"CUDA_VISIBLE_DEVICES": "0,1"}
command = "python train.py"
full_command = f"CUDA_VISIBLE_DEVICES=0,1 python train.py"
# Executed as: ssh user@host bash -c 'CUDA_VISIBLE_DEVICES=0,1 python train.py'
```

---

## 8. Acceptance Criteria

### P0 Complete When:
- [x] Code paths mapped and documented
- [x] Data contracts defined with exact types
- [x] Mode-specific execution flows documented
- [x] Calling conventions established
- [x] Connection points identified (TUI ↔ Backend)
- [x] Safety mechanisms verified
- [ ] Design reviewed and LOCKED (no further changes without explicit decision)

---

## 9. Next Steps (P1-P4)

### P1: Targeted Routing
- Implement `one-to-one` mode backend logic
- Multi-node parallel execution (asyncio.gather)
- Per-GPU CUDA_VISIBLE_DEVICES injection

### P2: Preflight Checks
- Implement `run_preflight_checks()` function
- Check tmux availability: `ssh user@host 'which tmux'`
- Check GPU availability: `validate_gpu_availability()` (already exists)
- Check command syntax: `ssh user@host 'bash -n -c <command>'`

### P3: DDP Orchestration
- Implement `create_distributed_execution_plan()`
- Rank assignment algorithm (deterministic)
- Master selection (first node = rank 0)
- MASTER_ADDR/MASTER_PORT injection

### P4: Hardening
- Add integration tests for multi-node execution
- Add tests for preflight failures
- Document race conditions and failure modes
- Add retry logic for transient failures

---

## 10. Open Questions

**Q1**: Should we support mixed execution modes (some GPUs in direct, some in tmux)?  
**A1**: NO. All GPUs in a single launch use the same execution mode. Simplifies implementation.

**Q2**: What happens if one GPU fails in a multi-GPU launch?  
**A2**: (P4) All results returned. User sees per-GPU status. No automatic rollback.

**Q3**: Should preflight checks be mandatory or optional?  
**A3**: (P2) Optional by default. TUI can enable via checkbox. CLI flag `--preflight`.

**Q4**: How to handle port conflicts for MASTER_PORT in DDP?  
**A4**: (P3) Default to 29500. Allow user override via env var or config. No automatic port scanning (too complex).

---

**END OF P0 CONTRACT**
