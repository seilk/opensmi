# SLURM BETA PLAN (Personal Allocation Mode)

## Non-negotiable Requirements
1. **Stable default unchanged**: existing opensmi users must see zero behavior change.
2. **Slurm support is opt-in beta only**: enabled only by feature flag.
3. **Primary beta job**: detect and show exactly which GPUs are usable in current Slurm allocation.
4. **Hard safety boundary**: block any GPU outside allocated scope (UI + CLI path).
5. **Personal multi-experiment support**: run/track multiple jobs only within allocated set.

---

## Scope
- This is **BETA + optional feature flag** only.
- No team shared-gateway requirement in this plan.
- Target user is already allocated resources by Slurm.

## User Story
"I already have a Slurm allocation. opensmi should tell me exactly which GPUs I can use, and only let me run jobs on those GPUs."

---

## Beta Entry Conditions
A session enters Slurm beta mode only when one of:
1. CLI: `opensmi-tui --experimental-slurm`
2. Config: `"mode": "slurm-beta"`
3. Env: `OPENSMI_MODE=slurm-beta`

If none set, opensmi runs normal stable mode.

---

## Entitlement Precedence Policy (Fixed)

| Priority | Source | Role | Notes |
|---|---|---|---|
| 1 | `CUDA_VISIBLE_DEVICES` | **Final entitlement source** | Execution-time effective access; authoritative in beta mode |
| 2 | `SLURM_STEP_GPUS` / `SLURM_JOB_GPUS` | Cross-check only | Validate mapping consistency; not primary authority |
| 3 | `SLURM_GPUS_ON_NODE` | Count sanity-check only | Cardinality check; cluster-dependent quirks allowed |
| 4 | `nvidia-smi` full inventory | Inventory only | Never used as entitlement source |

**Rule:** if precedence sources conflict, prefer `CUDA_VISIBLE_DEVICES` and apply fail-closed policy for severe contradictions.

---

## Fail-Closed Leveling (Fixed)

### Immediate Block (Fail-Closed)
- Slurm beta mode entered but `SLURM_JOB_ID` missing
- `CUDA_VISIBLE_DEVICES` missing/empty/unparseable
- User requests GPU outside allowed set
- Clear disjoint conflict between CVD set and Slurm step/job set

### Warn + Continue
- `SLURM_STEP_ID`, `SLURM_STEP_GPUS`, or `SLURM_JOB_GPUS` missing
- `SLURM_GPUS_ON_NODE` count mismatch vs CVD count (site variant tolerated)

---

## Phase B0 (Must-have): Correct GPU Entitlement Detection

### Goal
Identify **user-usable GPUs** from Slurm allocation (not full machine GPUs).

### Inputs
- `SLURM_JOB_ID`
- `SLURM_STEP_ID` (optional)
- `CUDA_VISIBLE_DEVICES`
- Optional validation: `SLURM_STEP_GPUS`, `SLURM_JOB_GPUS`, `SLURM_GPUS_ON_NODE`

### Behavior
- Parse effective allowed GPU set from `CUDA_VISIBLE_DEVICES`.
- Normalize mapping (logical vs physical where applicable).
- Cross-validate via precedence table.
- UI shows:
  - `Allocated GPUs: <list>`
  - `Blocked GPUs: <list>`
- Non-allocated GPU attempts are hard-blocked with explicit error code.

### Additional Guard
- **Entitlement snapshot**: capture resolved allowed set at submit time and store in job metadata.

---

## Phase B1: Safe Execution in Slurm Context

### Goal
Prevent running outside allocation/cgroup and avoid zombie behavior.

### Behavior
- In slurm-beta mode, execute via Slurm-aware path (`srun`/step-aware), not raw detached path.
- Do not override Slurm `CUDA_VISIBLE_DEVICES`.
- On allocation end/cancel, mark jobs terminated and clean state.

---

## Phase B2: TUI UX (Simple + Obvious)

### Goal
Make "what I can use" instantly visible.

### UI
- Header badge: `[SLURM BETA]`
- Top line: `Allocation: <jobid>  Node: <node>  GPUs: <allowed set>`
- GPU table default filter: show allocated GPUs first.
- Submit modal default target: allocated set only.

---

## Phase B3: Multi-Experiment Convenience (Personal)

### Goal
From one session, launch multiple experiments safely within allocated GPUs.

### Features
- Quick presets: `1 GPU`, `2 GPU`, `all allocated`
- Queue limited to allocated set
- Per-job pinning inside allowed set
- Tracking view for multiple running experiments

---

## Safety / Red-Team Requirements

### P0
1. Atomic state write (`tmp -> fsync -> rename`)
2. Lock scope covers read-modify-write critical section
3. Entitlement precedence is fixed (this document) + tests

### P1
4. Mismatch detector with fail-closed for severe contradictions
5. Error taxonomy fixed + user-facing messages
6. Test matrix across common Slurm env shapes

### Error Taxonomy
- `E_NO_SLURM_ALLOC`
- `E_PARSE_CVD`
- `E_SET_MISMATCH`
- `E_GPU_OUT_OF_SCOPE`

---

## Release Policy
- Version tag includes beta marker (e.g. `v0.x.y-beta.slurm.1`)
- Changelog section: `Experimental: Slurm Personal Allocation Mode`
- Startup warning every run in beta mode
- Docs explicitly: "May change without compatibility guarantees"

---

## Definition of Done (Beta v1)
1. With active Slurm allocation, opensmi correctly lists only usable GPUs.
2. Non-allocated GPU selection is impossible in UI/CLI path.
3. Job execution remains inside Slurm allocation lifecycle.
4. User can run and track multiple experiments within allocated set.
5. Stable mode users experience zero behavior change.
6. **Precedence + fail-closed policy is fixed in docs and covered by tests.**
