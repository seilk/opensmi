# Job Queue & Lifecycle Management — Implementation Plan

> opensmi의 철학: DL researcher를 위한 meta terminal.
> "GPU 비면 내 학습 자동으로 시작" — Slurm 없이 Slurm.

---

## 프로젝트 철학 (마스터 원문)

- User는 원하는 GPU에 원하는 job을 opensmi TUI에서 직접 제출 가능.
- Job은 연결된 node/GPU에 one-to-one으로 제출 가능 && distributed parallel running으로 single job을 서로 다른 node와 GPU에 제출 가능. 그리고 안정적인 실행.
- 제출된 job을 TUI에서 log를 보게하거나 tmux session을 통해 관찰 가능하게 함.
- 이로써 opensmi는 multinode and multi GPU 환경에서:
  - GPU health 및 상태 관찰
  - Multi node & GPU 환경에서 극도의 편리성을 제공하는 meta terminal
  - Deep learning training/inference를 한 차원 더 편리하게 해주는 helper service

---

## 현재 Command Runner 구조 (as-is)

### 있는 것
- **Runner Pane:** Dashboard 하단 dock, fold/unfold/focus
- **GPU 선택:** Auto(ranking) / Manual(클릭) 두 모드
- **Distribution:** Single (하나의 command → 여러 GPU) / One-to-one (각 GPU에 각 command)
- **Execution:** Direct(결과 즉시) / Tmux(백그라운드 세션)
- **Remote Execution:** `opensmi exec` CLI → SSH → 원격 노드 실행
- **Preflight:** tmux 존재, command 구문, GPU 유효성 사전 검증
- **Launch History:** GPU 사용 이력 저장 → ranking에 반영
- **State Machine:** idle → queued → preparing → sent → running / failed

### 없는 것 (Job Queue 관점)
- ❌ **Job persistence** — TUI 닫으면 job 정보 사라짐
- ❌ **Job list** — 현재 실행 중/완료/실패 job 목록 없음
- ❌ **Auto-scheduling** — GPU 비면 자동 실행하는 대기열 없음
- ❌ **Job status tracking** — tmux 세션 생사 확인 안 함
- ❌ **Multi-job management** — 한 번에 하나만 실행 가능

---

## Phase 1: Job Persistence & Status Tracking (기반)

**목표:** TUI를 닫아도 job 정보가 살아있고, 다시 열면 상태를 복원한다.

### 1-A. Job 데이터 모델

**파일:** `src/opensmi/jobs.py`

```python
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple
import json, uuid
from datetime import datetime, timezone
from pathlib import Path
from .state import ensure_state_dir

JOBS_FILENAME = "jobs.json"

@dataclass
class Job:
    id: str                                    # 8자리 short uuid
    command: str                               # 실행 명령어 (single mode)
    commands: List[str] = field(default_factory=list)  # one-to-one mode 명령어들
    gpus: List[Tuple[str, int]] = field(default_factory=list)  # [(node_alias, gpu_idx), ...]
    requested_gpu_count: int = 0               # queued mode: 필요한 GPU 수
    dist_mode: str = "single"                  # "single" | "one-to-one"
    exec_mode: str = "tmux"                    # "direct" | "tmux"
    tmux_sessions: List[str] = field(default_factory=list)  # 생성된 tmux 세션명들
    status: str = "queued"                     # "queued" | "running" | "done" | "failed" | "cancelled"
    submitted_at: str = ""                     # ISO timestamp
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    exit_codes: List[int] = field(default_factory=list)  # 각 GPU별 exit code
    error: Optional[str] = None
    user: str = ""                             # OPERATOR (제출한 사용자)
    restart_policy: str = "never"              # "never" | "on-failure" | "always"
    retry_count: int = 0
    max_retries: int = 3
    tags: List[str] = field(default_factory=list)  # 사용자 태그
    queue_mode: str = "immediate"              # "immediate" | "queued"

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex[:8]
```

### 1-B. Job Store

**파일:** `src/opensmi/jobs.py` (계속)

```python
def jobs_path(state_dir: Path) -> Path:
    return state_dir / JOBS_FILENAME

def load_jobs(state_dir: Path) -> List[Job]:
    path = jobs_path(state_dir)
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return [Job(**j) for j in data.get("jobs", [])]
    except (json.JSONDecodeError, ValueError, OSError, TypeError):
        return []

def save_jobs(state_dir: Path, jobs: List[Job]) -> None:
    ensure_state_dir(state_dir)
    path = jobs_path(state_dir)
    serializable = {"jobs": [asdict(j) for j in jobs]}
    with path.open("w", encoding="utf-8") as f:
        json.dump(serializable, f, indent=2)

def upsert_job(jobs: List[Job], job: Job) -> List[Job]:
    out = [j for j in jobs if j.id != job.id]
    out.append(job)
    return out

def get_job(jobs: List[Job], job_id: str) -> Optional[Job]:
    for j in jobs:
        if j.id == job_id:
            return j
    return None
```

### 1-C. Tmux Session Health Check

**파일:** `src/opensmi/jobs.py` (계속)

```python
from .sshutil import ssh_run
from .config import load_config
from .state import resolve_config_path

async def check_job_alive(job: Job, cfg) -> bool:
    """SSH로 tmux has-session 확인. 하나라도 살아있으면 True."""
    if job.exec_mode != "tmux" or not job.tmux_sessions:
        return False
    
    for session_name in job.tmux_sessions:
        node_alias = job.gpus[0][0] if job.gpus else None
        if not node_alias:
            continue
        
        node = None
        for n in cfg.nodes:
            if n.alias == node_alias:
                node = n
                break
        if not node:
            continue
        
        try:
            rc, _, _ = await ssh_run(node, ["tmux", "has-session", "-t", session_name], timeout_s=5)
            if rc == 0:
                return True
        except Exception:
            continue
    
    return False
```

### 1-D. TUI 통합 — executeLaunch() 수정

현재 `executeLaunch()`가 실행하면 끝인데, Job 객체를 생성하고 저장해야 함:

```typescript
// executeLaunch() 시작 부분에 추가
const job: Job = {
  id: crypto.randomUUID().slice(0, 8),
  command: launchDistMode === "single" ? launchCommand : "",
  commands: launchDistMode === "one-to-one" ? [...launchCommands] : [],
  gpus: launchSelectedGpus.map(g => [g.node, g.gpu]),
  dist_mode: launchDistMode,
  exec_mode: launchMode,
  tmux_sessions: [],
  status: "running",
  submitted_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  user: OPERATOR,
  // ...
};

// 실행 후
job.status = launchErrorMsg ? "failed" : "running";
await saveJobToStore(job);
```

### 검증 기준
- [ ] TUI에서 job 실행 → `~/.opensmi/jobs.json`에 기록됨
- [ ] TUI 재시작 → 이전 job 목록 복원됨
- [ ] tmux session 종료 → poll cycle에서 status 업데이트됨

---

## Phase 2: Jobs Tab UI

**목표:** 내가 제출한 job들의 상태를 한 눈에 본다.

### 2-A. Jobs Tab 등록

```typescript
tabRegistry.register({
  id: "jobs",
  label: "Jobs",
  shortcut: "j",
  render: renderJobsView,
  onEnter: async () => { await refreshJobList(); },
});
```

### 2-B. Job List View

```
┌──────────────────────────────────────────────────────────────────────┐
│  Jobs                                                    [r] Refresh │
├──────────────────────────────────────────────────────────────────────┤
│  ID       Status     GPUs              Command             Time     │
│  a3f2     ● running  gpu01:0,1         python train.py     14:30    │
│  b7c1     ✓ done     gpu02:3           python eval.py      14:25    │
│  d9e4     ○ queued   (auto×2)          python sweep.py     14:35    │
│  f1a8     ✗ failed   gpu01:2           python bug.py       14:20    │
├──────────────────────────────────────────────────────────────────────┤
│  [Enter] Detail  [c] Cancel  [r] Retry  [d] Delete  [q] Queue new  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2-C. Status 아이콘
- `○` queued (대기 중) — dim
- `◐` preparing (준비 중) — yellow
- `●` running (실행 중) — green
- `✓` done (완료) — cyan
- `✗` failed (실패) — red
- `⊘` cancelled (취소됨) — dim

### 2-D. Job Detail View (Enter)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Job a3f2 — python train.py                                         │
├──────────────────────────────────────────────────────────────────────┤
│  Status:    ● running                                                │
│  GPUs:      gpu01:GPU0, gpu01:GPU1                                   │
│  Mode:      tmux / single                                            │
│  Session:   opensmi-1771330000-gpu01                                 │
│  Submitted: 2026-02-17 14:30:00 KST                                 │
│  Started:   2026-02-17 14:30:02 KST                                 │
│  Restart:   on-failure (0/3 retries)                                 │
│                                                                      │
│  Preflight:                                                          │
│    gpu01 tmux_available: PASS                                        │
│    gpu01 command_syntax: PASS                                        │
│    gpu01 gpu_availability: PASS                                      │
│                                                                      │
│  Attach:                                                             │
│    ssh gpu01 -t tmux attach -t opensmi-1771330000-gpu01              │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  [c] Cancel  [r] Retry  [Esc] Back                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2-E. 키보드 단축키

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Job 선택 |
| `Enter` | Detail view |
| `c` | Cancel selected job |
| `r` (on failed job) | Retry (re-queue) |
| `d` | Delete from list |
| `q` | Queue new job (runner 열기) |
| `Esc` | Dashboard로 돌아가기 |

### 검증 기준
- [ ] Jobs 탭에서 모든 job 상태 확인 가능
- [ ] Detail에서 tmux attach command 표시
- [ ] Cancel/Retry/Delete 동작

---

## Phase 3: Job Queue with Auto-dispatch (핵심)

**목표:** "GPU 비면 자동 실행" — opensmi의 killer feature.

### 3-A. Queue Semantics

Job 제출 시 두 가지 모드:

1. **Immediate** (현재와 동일)
   - GPU 직접 지정 → 즉시 실행
   - 실패하면 바로 실패

2. **Queued** (새 기능)
   - GPU 개수만 지정 (또는 조건)
   - Dispatcher가 주기적으로 체크
   - 조건 맞으면 자동 배치 + 실행

### 3-B. TUI Queue Mode

Command Runner에 모드 추가:

```typescript
// 기존
launchQueueMode: "immediate" | "queued"

// Runner pane UI
// [Q] Toggle queue mode
// queued일 때: "Will auto-start when 2 GPUs become available"
// immediate일 때: "Will start immediately on selected GPUs"
```

### 3-C. Dispatcher Loop

TUI의 poll cycle에 통합 (pollCluster 후 실행):

```typescript
async function dispatchQueuedJobs(): Promise<void> {
  const queued = jobList
    .filter(j => j.status === "queued" && j.queue_mode === "queued")
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)); // FIFO
  
  if (queued.length === 0) return;
  
  for (const job of queued) {
    const needed = job.requested_gpu_count || job.gpus.length;
    if (needed === 0) continue;
    
    // GPU 가용성 판단
    const available = findAvailableGpus(snapshot, needed, job.user);
    
    if (available.length >= needed) {
      // 배치 결정
      job.gpus = available.slice(0, needed).map(g => [g.node, g.gpu]);
      job.status = "running";
      job.started_at = new Date().toISOString();
      
      // 실행
      await executeJobRemote(job);
      await saveJobStore();
      
      setStatus(`Auto-dispatched job ${job.id}: ${job.command.slice(0, 30)}...`);
    }
  }
}
```

### 3-D. GPU 가용성 판단 기준

```typescript
function findAvailableGpus(
  snapshot: ClusterSnapshot,
  count: number,
  user: string
): Array<{node: string, gpu: number}> {
  // 1. 내 할당 GPU 중 idle인 것 우선
  // 2. Unallocated GPU 중 idle인 것
  // 3. '*' (공용) 할당 GPU 중 idle인 것
  
  // "idle" 정의:
  //   - 해당 GPU에 프로세스 0개
  //   - 해당 GPU에 다른 queued job이 예약하지 않은 것
  
  // GPU ranker 재사용 가능 (rank_gpus → idle 필터)
  const ranked = rank_gpus(snapshot, history, allocations, user);
  return ranked
    .filter(([alias, idx, gpu]) => {
      const procs = getProcessesOnGpu(snapshot, alias, gpu.uuid);
      return procs.length === 0;
    })
    .slice(0, count);
}
```

### 3-E. Queue Priority

기본은 FIFO. 향후 확장:
- User priority (admin 설정)
- GPU affinity (특정 노드 선호)
- Estimated duration (짧은 job 먼저)

### 검증 기준
- [ ] Job을 queued 모드로 제출
- [ ] GPU가 차있으면 대기
- [ ] GPU가 비면 자동 실행
- [ ] 실행 시 TUI에 알림 표시

---

## Phase 4: Job Lifecycle Management

### 4-A. Cancel

```bash
opensmi job cancel <job_id>
```

구현:
```python
async def cancel_job(job: Job, cfg) -> bool:
    """Cancel a running job by killing its tmux sessions."""
    if job.status not in ("running", "queued"):
        return False
    
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = datetime.now(timezone.utc).isoformat()
        return True
    
    # Kill tmux sessions
    for session in job.tmux_sessions:
        node_alias = job.gpus[0][0] if job.gpus else None
        if not node_alias:
            continue
        node = find_node(cfg, node_alias)
        try:
            await ssh_run(node, ["tmux", "kill-session", "-t", session], timeout_s=5)
        except Exception:
            pass
    
    job.status = "cancelled"
    job.finished_at = datetime.now(timezone.utc).isoformat()
    return True
```

### 4-B. Retry

```bash
opensmi job retry <job_id>
```

구현:
```python
def retry_job(job: Job) -> Job:
    """Create a new queued job from a failed/cancelled job."""
    new_job = Job(
        id=Job.new_id(),
        command=job.command,
        commands=list(job.commands),
        gpus=list(job.gpus),        # 같은 GPU에서 재시도
        requested_gpu_count=job.requested_gpu_count,
        dist_mode=job.dist_mode,
        exec_mode=job.exec_mode,
        status="queued",
        submitted_at=datetime.now(timezone.utc).isoformat(),
        user=job.user,
        restart_policy=job.restart_policy,
        tags=list(job.tags),
        queue_mode=job.queue_mode,
    )
    return new_job
```

### 4-C. Auto-restart (Watchdog)

Poll cycle에 통합:

```typescript
async function watchRunningJobs(): Promise<void> {
  const running = jobList.filter(j => j.status === "running" && j.exec_mode === "tmux");
  
  for (const job of running) {
    const alive = await checkJobAlive(job);
    
    if (!alive) {
      // Tmux session이 사라짐
      if (job.restart_policy === "on-failure" && job.retry_count < job.max_retries) {
        job.status = "queued";
        job.retry_count++;
        setStatus(`Job ${job.id} died, re-queuing (retry ${job.retry_count}/${job.max_retries})`);
      } else if (job.restart_policy === "always") {
        job.status = "queued";
        job.retry_count++;
        setStatus(`Job ${job.id} died, re-queuing (always restart)`);
      } else {
        job.status = "failed";
        job.finished_at = new Date().toISOString();
        job.error = "tmux session terminated unexpectedly";
        setStatus(`Job ${job.id} failed: session terminated`);
      }
      await saveJobStore();
    }
  }
}
```

### 검증 기준
- [ ] Running job cancel → tmux 세션 종료
- [ ] Failed job retry → 새 job queued
- [ ] Tmux 세션 죽으면 → restart_policy에 따라 자동 처리

---

## Phase 5: CLI Integration

### 5-A. opensmi job 서브커맨드

```bash
# Job 목록
opensmi job list [--status running|queued|done|failed] [--json]

# Job 제출
opensmi job submit <node> --gpus 0,1 --command "python train.py" [--queue] [--tmux] [--restart on-failure]
opensmi job submit --auto-gpus 2 --command "python train.py" --queue  # GPU 자동 배치

# Job 상태
opensmi job status <job_id> [--json]

# Job 관리
opensmi job cancel <job_id>
opensmi job retry <job_id>
opensmi job delete <job_id>

# Job 로그 (tmux capture-pane)
opensmi job log <job_id> [--lines 100]
```

### 5-B. CLI ↔ TUI 양방향

- 공통 데이터: `~/.opensmi/jobs.json`
- CLI에서 submit한 job → TUI의 Jobs 탭에 표시
- TUI에서 submit한 job → CLI에서 관리 가능
- File lock으로 동시 접근 보호 (fcntl.flock)

### 5-C. argparse 추가

```python
sp_job = sub.add_parser("job", help="Manage GPU jobs")
job_sub = sp_job.add_subparsers(dest="job_cmd", required=True)

sp_jl = job_sub.add_parser("list", help="List jobs")
sp_jl.add_argument("--status", choices=["queued", "running", "done", "failed", "cancelled"])
sp_jl.add_argument("--json", action="store_true")

sp_js = job_sub.add_parser("submit", help="Submit a job")
sp_js.add_argument("node", nargs="?", help="Node alias (optional with --auto-gpus)")
sp_js.add_argument("--gpus", help="Comma-separated GPU indices")
sp_js.add_argument("--auto-gpus", type=int, help="Auto-select N GPUs")
sp_js.add_argument("--command", required=True)
sp_js.add_argument("--queue", action="store_true", help="Queue for auto-dispatch")
sp_js.add_argument("--tmux", action="store_true", default=True)
sp_js.add_argument("--restart", choices=["never", "on-failure", "always"], default="never")
sp_js.add_argument("--json", action="store_true")

sp_jc = job_sub.add_parser("cancel", help="Cancel a job")
sp_jc.add_argument("job_id")

sp_jr = job_sub.add_parser("retry", help="Retry a failed job")
sp_jr.add_argument("job_id")

sp_jd = job_sub.add_parser("delete", help="Delete a job from history")
sp_jd.add_argument("job_id")

sp_jlog = job_sub.add_parser("log", help="Fetch job output from tmux")
sp_jlog.add_argument("job_id")
sp_jlog.add_argument("--lines", type=int, default=50)
```

### 검증 기준
- [ ] `opensmi job list` → JSON 출력
- [ ] `opensmi job submit` → job 생성 + TUI에 표시
- [ ] `opensmi job cancel` → tmux 종료
- [ ] `opensmi job log` → tmux capture-pane 결과

---

## 구현 순서 (Sprint 단위)

| Sprint | Phase | 기간 | 핵심 산출물 |
|--------|-------|------|-------------|
| Sprint 1 | Phase 1 | 1주 | Job 모델, store, health check, executeLaunch → job 자동 저장 |
| Sprint 2 | Phase 2 | 1주 | Jobs 탭 UI, detail view, cancel/delete |
| Sprint 3 | Phase 3 | 1-2주 | Queue mode, dispatcher loop, GPU 가용성 판단 |
| Sprint 4 | Phase 4+5 | 1주 | Lifecycle (retry, auto-restart), opensmi job CLI |

---

## 작업 규칙 (Karpathy Guidelines 적용)

1. **Think Before Coding** — 각 Phase 시작 전 데이터 흐름 다이어그램 그리기
2. **Simplicity First** — Job store는 JSON 파일 하나. DB 도입하지 않음.
3. **Surgical Changes** — 기존 executeLaunch()는 최소 수정. Job 생성/저장만 추가.
4. **Goal-Driven Execution** — 각 Sprint의 검증 기준이 곧 Definition of Done.

## Git 커밋 규칙

```
feat(jobs): add Job data model and persistent store
feat(jobs): add tmux session health check
feat(tui): integrate job creation into executeLaunch
feat(tui): add Jobs tab with list and detail views
feat(jobs): add queue mode and auto-dispatcher
feat(jobs): add cancel, retry, and auto-restart lifecycle
feat(cli): add opensmi job subcommands
```

---

## 아키텍처 다이어그램

```
┌──────────────────────────────────────────────────────────┐
│                        TUI (index.ts)                    │
│                                                          │
│   Dashboard ──── Command Runner ──── Jobs Tab            │
│       │              │                   │               │
│       │         executeLaunch()     renderJobsView()     │
│       │              │                   │               │
│       │         Job 생성/저장       Job 목록/상태         │
│       │              │                   │               │
│       ▼              ▼                   ▼               │
│   pollCluster() ─── dispatchQueuedJobs() ─── watchRunningJobs() │
│       │                    │                      │      │
└───────┼────────────────────┼──────────────────────┼──────┘
        │                    │                      │
        ▼                    ▼                      ▼
┌──────────────────────────────────────────────────────────┐
│                     CLI (cli.py)                          │
│                                                          │
│   opensmi poll    opensmi exec    opensmi job             │
│       │               │              │                   │
└───────┼───────────────┼──────────────┼───────────────────┘
        │               │              │
        ▼               ▼              ▼
┌──────────────────────────────────────────────────────────┐
│                  Backend (Python)                         │
│                                                          │
│   collector.py  executor.py   jobs.py                    │
│       │             │            │                        │
│   SSH poll      SSH exec     jobs.json                   │
│       │             │            │                        │
└───────┼─────────────┼────────────┼───────────────────────┘
        │             │            │
        ▼             ▼            ▼
   Remote Nodes    tmux sessions  ~/.opensmi/jobs.json
```

---

## 향후 확장 (Phase 3 이후)

- **GPU Topology-aware Placement:** NVLink 그룹 자동 감지 → DDP 최적 배치
- **Checkpoint Watchdog:** 학습 체크포인트 감지 → resume 명령 자동 생성
- **Job Templates:** 자주 쓰는 명령어 프리셋 저장/재사용
- **Collaborative Queue:** 다중 사용자 queue + 우선순위 관리
