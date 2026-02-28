<p align="center">
  <h1 align="center">opensmi</h1>
  <p align="center">에이전트·데몬 없이 동작하는 멀티노드 GPU 할당 관리자 (SSH + nvidia-smi only)</p>
  <p align="center">
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <img alt="Python" src="https://img.shields.io/badge/python-3.9%2B-blue.svg">
    <img alt="Dependencies" src="https://img.shields.io/badge/deps-zero-brightgreen.svg">
    <img alt="Version" src="https://img.shields.io/badge/version-0.2.5-informational.svg">
  </p>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="assets/intro_A.png" width="31%" />
  <img src="assets/intro_B.png" width="31%" />
  <img src="assets/intro_C.png" width="31%" />
</p>
<p align="center"><sub><em>스크린샷은 실제 환경에서 촬영되었으며, 민감한 정보(노드명, 사용자명, 파일 경로)는 Nano Banana로 마스킹 처리했습니다.</em></sub></p>

---

`opensmi`는 **GPU 노드에 아무것도 설치하지 않고** 클러스터 GPU 사용을 모니터링하고 할당 정책을 적용합니다.  
관리자 터미널에서 SSH로 연결해 `nvidia-smi`를 읽는 것이 전부입니다.

---

## 제공 기능

- **인터랙티브 TUI** — 실시간 대시보드, 노드 상세, GPU 실행기, 작업 추적기
- **멀티클러스터 탭바** — SSH 클러스터와 Slurm 클러스터를 탭으로 전환하며 한 화면에서 관리
- **Slurm GPU 모니터링** — Slurm API를 통한 노드별 GPU 사용 현황 조회 (읽기 전용, compute 노드 SSH 불필요)
- **CLI** — poll, 할당 관리, 위반 감지, 감시, kill, exec
- **정책 강제** — 할당되지 않은 GPU 사용은 위반으로 처리; `*` = 모두에게 오픈
- **GPU 노드 무설치** — 에이전트·데몬 불필요
- **Python 표준 라이브러리만 사용** — CLI는 외부 의존성 없음

---

## 설치

권장 방법 — CLI + TUI 함께 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/seilk/opensmi/main/scripts/install.sh | bash
```

바이너리는 `~/.local/bin`에 설치됩니다. 인스톨러가 현재 셸(zsh/bash/fish)을 자동 감지해 정확한 PATH 설정 방법을 안내하며, 터미널에서 직접 실행할 경우 자동으로 추가할지 물어봅니다.

**요구사항:** macOS 또는 Linux · Python 3.9+ · GPU 노드에 `nvidia-smi`가 있고 SSH 접속 가능

### 업데이트

```bash
opensmi update
```

CLI, TUI 바이너리, 래퍼 스크립트를 한 번에 교체합니다. 재설치 불필요.  
GitHub API rate limit 발생 시: `export OPENSMI_GITHUB_TOKEN=<token>`

### 제거

```bash
opensmi uninstall             # CLI + TUI 제거
opensmi uninstall --dry-run   # 미리보기
```

state 및 config까지 삭제하려면 (복구 불가):

```bash
opensmi uninstall --purge-state --yes
```

---

## 빠른 시작

```bash
# 1. 설정 파일 생성 (대화형 마법사)
opensmi onboard

# 2. SSH 연결 및 GPU 가시성 확인
opensmi poll

# 3. TUI 실행
opensmi
```

설정 파일은 기본적으로 `~/.opensmi/opensmi.json`에 저장됩니다.  
`--config <경로>` 또는 `OPENSMI_CONFIG` 환경변수로 경로를 지정할 수 있습니다.

---

## TUI

실행:

```bash
opensmi
```

상단 바에는 **클러스터명 · user@hostname · GPU 사용/전체 · 위반 수 · 폴링 시각**이 표시됩니다.

### 클러스터 탭바

TUI 최상단에 설정된 모든 클러스터가 탭으로 표시됩니다. **`Tab`** / **`Shift+Tab`**으로 순환하거나 **클릭**으로 바로 전환할 수 있습니다.

- **SSH 클러스터** — `clusters[]`에 정의된 클러스터, SSH + nvidia-smi로 폴링
- **Slurm 클러스터** — `slurm_clusters[]`에 정의된 클러스터, Slurm API로 노드별 GPU 사용 현황 표시 (읽기 전용, compute 노드 SSH 불필요)

새 버전이 출시되면 탭바 우측의 버전 표시가 노란색으로 바뀝니다: `opensmi@0.2.5 → 0.2.6 ↑`

### 탭 이동

**`Ctrl+X T`**로 탭 스위처를 열고 단축키 또는 방향키로 이동합니다.

| 단축키 | 탭 | 설명 |
|--------|-----|------|
| `d` | 대시보드 | 실시간 GPU 그리드 — 노드별 사용 현황 |
| `n` | 노드 상세 | GPU별 메모리, 사용률, 프로세스 목록 (대시보드에서 `Enter`로 진입) |
| `g` | My GPUs | 현재 오퍼레이터 기준 개인 GPU 뷰 |
| `j` | 작업(Jobs) | 대기·실행·완료 작업 추적 |
| `s` | 설정(Setup) | 노드별 환경 설정 (conda, venv, 작업 디렉토리) |
| `h` | 도움말(Help) | 키보드 단축키 참조 |

> **참고:** 노드 상세(Node Detail)는 숨김 탭입니다 — 대시보드에서 노드를 선택하고 `Enter`를 눌러 진입합니다.  
> **할당 관리** (`a` 할당, `x` 해제, `Shift+K` kill)는 별도 탭이 아닌 **대시보드에서** 직접 수행합니다.

**전역 단축키 (모든 탭에서 동작):**

| 키 | 동작 |
|----|------|
| `Ctrl+X T` | 탭 스위처 열기 |
| `Ctrl+X ↓` | 실행기 pane 포커스 |
| `Ctrl+X F` | 실행기 pane 접기 / 펼치기 |
| `Ctrl+X Q` | 종료 |

### 실행기 (Command Runner)

화면 하단에 항상 표시되는 pane입니다. `Ctrl+X ↓`로 포커스하고, 명령어를 입력한 뒤 `Ctrl+X Enter`로 실행합니다. `Esc`로 포커스를 해제합니다.

**실행 모드** (`Tab`으로 전환):
- `direct` — 백그라운드 프로세스로 실행, 출력 캡처
- `tmux` — tmux 세션 생성 (나중에 `tmux attach`로 접속 가능)

**분배 모드** (`Shift+Tab`으로 전환):
- `single` — 여러 GPU에 하나의 명령 실행 (`CUDA_VISIBLE_DEVICES=0,1,2`)
- `one-to-one` — GPU마다 다른 명령 실행 (예: cross-validation fold별 학습)

**GPU 선택** (`g`로 전환):
- `auto` — 유휴 상태, 마지막 사용 시각, 사용률 기준으로 자동 랭킹
- `manual` — 패널에서 직접 클릭하여 선택

**큐 모드** (`q`로 전환):
- `immediate` — 즉시 실행
- `queued` — 작업 큐에 저장, GPU 여유 시 자동 디스패치

실행 전 사전 점검(preflight)을 자동으로 수행합니다: tmux 가용성, 명령어 문법, GPU 상태.

### 작업(Jobs) 탭

즉시 실행 및 큐 작업 모두 추적합니다. 상세 화면에서 다음 작업이 가능합니다:
- tmux 세션에서 실시간 출력 확인
- 세션에서 마지막 명령어 재실행 (retry)
- 작업 취소 또는 기록 삭제
- 완료된 tmux 세션 정리

---

## CLI 주요 명령어

```bash
opensmi poll                        # 클러스터 GPU 상태 스냅샷
opensmi violations                  # 할당 위반 목록 조회 (실시간)
opensmi alloc list                  # 전체 할당 목록 조회
opensmi job list                    # 작업 목록 조회
opensmi job list --status running   # 상태별 필터
opensmi log                         # opensmi 디버그 로그 확인
opensmi log --follow                # 실시간 로그 스트림
opensmi --help                      # 전체 명령어 목록
```

해당하는 명령에는 `--json` 옵션으로 기계가 읽기 쉬운 출력을 사용할 수 있습니다.

---

## 관리자 기능

> 관리자 명령은 `opensmi.json`의 `admins.master` 또는 `admins.members`에 등록된 사용자만 실행할 수 있으며, 대상 노드에서 원격 sudo 그룹 멤버십도 필요합니다.

### 할당 관리

할당(Allocation)은 어떤 사용자가 어떤 GPU를 사용할 수 있는지 정의합니다. 할당이 없으면 GPU 사용은 위반으로 처리됩니다.

```bash
opensmi alloc list                        # 전체 할당 목록 조회
opensmi alloc set GPU-01 0 alice          # GPU-01의 GPU 0을 alice에게 할당
opensmi alloc set GPU-01 1 '*'            # GPU 1을 모두에게 오픈
opensmi alloc clear GPU-01 0              # 할당 해제
opensmi alloc seed                        # 현재 사용 중인 GPU 기준으로 자동 할당
opensmi alloc seed --force                # 기존 할당 덮어쓰기
```

`*`는 해당 GPU를 누구나 사용할 수 있음을 의미합니다.

### 위반 감지 및 감시

```bash
opensmi violations                        # 위반 일회성 확인 (위반 있으면 exit 1)
opensmi watch                             # 60초 간격으로 폴링, 새 위반 출력
opensmi watch --interval 30               # 폴링 간격 설정 (초)
opensmi watch --slack-webhook <url>       # Slack 알림 발송
```

`violations`는 위반 없으면 `0`, 위반 있으면 `1`로 종료해 CI/cron에 적합합니다.

### 프로세스 종료 (Kill)

원격 노드의 특정 PID에 시그널을 보냅니다:

```bash
opensmi kill GPU-01 <pid> [<pid> ...]
opensmi kill GPU-01 1234 5678 --signal KILL
opensmi kill GPU-01 1234 --no-sudo        # sudo 없이 자신 소유 프로세스만
```

지원 시그널: `TERM` (기본값), `KILL`, `INT`, `HUP`

### 원격 실행

```bash
# 특정 GPU를 지정해 명령 실행
opensmi exec GPU-01 --gpus 0,1 --command "python train.py"

# 장시간 작업은 tmux 모드 사용
opensmi exec GPU-01 --gpus 0 --command "python train.py" --mode tmux

# 작업 큐에 제출 (GPU 여유 시 자동 실행)
opensmi job submit --auto-gpus 2 --command "python train.py"
```

### 노드 환경 설정

노드별 가상환경(conda/venv) 및 작업 디렉토리를 설정합니다:

```bash
opensmi node-env GPU-01                                   # 현재 설정 확인
opensmi node-env GPU-01 --env-manager conda --env-name ml # conda 환경 지정
opensmi node-env GPU-01 --work-dir ~/projects             # 작업 디렉토리 설정
opensmi node-env GPU-01 --env-manager venv --env-name .venv
```

이 설정은 해당 노드에 작업 디스패치 시 자동으로 적용됩니다.

### Sudo 권한 확인

SSH 사용자가 대상 노드에서 필요한 sudo 그룹 멤버십을 갖고 있는지 확인합니다:

```bash
opensmi sudo-check GPU-01
opensmi sudo-check GPU-01 --json
```

### 관리자 설정

관리자 권한과 원격 sudo 그룹 요건은 `opensmi.json`에 설정합니다:

```json
{
  "admins": {
    "master": "alice",
    "members": ["alice", "bob"],
    "remote_sudo_groups": ["sudo", "wheel"]
  }
}
```

- `master` / `members`: 관리자 명령 실행이 허용된 로컬 사용자명
- `remote_sudo_groups`: `alloc`, `kill`, `exec` 명령 실행 시 SSH 사용자가 대상 노드에서 속해야 하는 그룹

---

## 설정

설정은 plain JSON 형식입니다:

```bash
opensmi onboard     # 대화형 마법사로 생성
opensmi init        # 기본 템플릿 생성
```

참고 템플릿: [`opensmi.example.json`](opensmi.example.json)  
실제 `opensmi.json`은 기본적으로 `.gitignore`에 포함되어 공개 저장소에 올라가지 않습니다.

### 멀티클러스터 설정

여러 SSH 클러스터를 탭으로 관리하려면 `clusters` 배열을 사용합니다:

```json
{
  "clusters": [
    {
      "cluster_name": "Lab-A",
      "nodes": [{ "alias": "GPU-01", "address": "10.0.0.1", "user": "ubuntu" }]
    },
    {
      "cluster_name": "Lab-B",
      "nodes": [{ "alias": "GPU-05", "address": "10.0.1.1", "user": "admin" }]
    }
  ]
}
```

기존 단일 클러스터 설정(루트 레벨 `cluster_name` + `nodes`)은 변경 없이 그대로 동작합니다.

### Slurm 모니터링 설정

읽기 전용 Slurm 클러스터 탭을 추가하려면 `slurm_clusters`를 설정합니다:

```json
{
  "slurm_clusters": [
    {
      "name": "HPC 클러스터",
      "login_node": "hpc-login",
      "user": "myuser"
    }
  ]
}
```

로그인 노드에만 SSH로 접속해 `sinfo`/`squeue`/`scontrol`을 조회합니다 — compute 노드 접근 불필요.

**주요 환경변수:**

| 변수 | 용도 |
|------|------|
| `OPENSMI_CONFIG` | 설정 파일 경로 지정 |
| `OPENSMI_STATE_DIR` | state 디렉토리 경로 지정 (NFS/공유 홈 디렉토리 등) |
| `OPENSMI_PYTHON` | Python 인터프리터 경로 지정 |
| `OPENSMI_GITHUB_TOKEN` | 업데이트 시 GitHub API rate limit 방지 |

---

## 지원 범위 및 환경

opensmi는 두 가지 클러스터 환경을 지원합니다:

### 1. 자체 운영 클러스터 (스케줄러 없음)
전체 기능 사용 가능 — 할당, 정책 강제, 작업 디스패치, kill.  
각 GPU 노드에 직접 SSH해 `nvidia-smi`로 실시간 GPU 상태를 수집합니다.

Slurm이 이미 운영 중인 클러스터에서 opensmi **작업 디스패치**(tmux/direct 실행)를 함께 사용하는 것은 **권장하지 않습니다**:
- **`CUDA_VISIBLE_DEVICES`**: Slurm은 GPU 인덱스를 0-based로 remapping하지만 opensmi는 물리 인덱스를 사용해 충돌합니다.
- **프로세스 생명주기**: opensmi의 tmux 세션은 Slurm cgroup 외부에서 실행되어 Slurm의 자원 회계를 우회합니다.

### 2. Slurm 관리 클러스터 (읽기 전용 모니터링)
opensmi는 TUI에서 **읽기 전용 탭**으로 Slurm 클러스터를 모니터링할 수 있습니다.  
노드별 GPU 할당 현황, 작업 소유자, 파티션 정보, GPU 인덱스를 `scontrol`을 통해 표시합니다.  
`opensmi.json`의 `slurm_clusters`로 설정하며, compute 노드 접근은 필요하지 않습니다.

**로컬 노드**: opensmi가 GPU 노드 위에서 직접 실행될 경우, SSH를 자동으로 우회해 루프백 연결 없이 동작합니다.

---

## 보안

`opensmi`는 SSH를 통해 원격 명령(프로세스 시그널 포함)을 실행할 수 있습니다.  
실행 머신은 관리자 워크스테이션으로 취급하고 키·권한 설정에 주의하세요.  
자세한 내용: [`SECURITY.md`](SECURITY.md)

---

## 문서

- 아키텍처: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 릴리즈: [`docs/RELEASING.md`](docs/RELEASING.md)
- 변경 내역: [`CHANGELOG.md`](CHANGELOG.md)

---

## License

MIT — [`LICENSE`](LICENSE)
