<p align="center">
  <h1 align="center">opensmi</h1>
  <p align="center">에이전트/데몬 없이 동작하는 멀티노드 GPU 할당 관리자 (SSH + nvidia-smi only)</p>
  <p align="center">
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <img alt="Python" src="https://img.shields.io/badge/python-3.8%2B-blue.svg">
    <img alt="Dependencies" src="https://img.shields.io/badge/deps-zero-brightgreen.svg">
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

`opensmi`는 GPU 노드에 아무것도 설치하지 않고, 관리자 터미널에서 SSH로 접속해 `nvidia-smi`를 읽어
클러스터 GPU 사용을 모니터링하고 할당(Allocation) 정책을 적용합니다.

## 제공 기능

- **Interactive TUI**: 대시보드, 노드 상세, 할당/해제, 위반자 kill
- **CLI**: poll, allocations, violations, watch (Slack 알림)
- **정책**: 할당되지 않은 GPU 사용 = 위반, `*` = 모두에게 오픈
- **GPU 노드 무설치** (agentless)
- **Python 표준 라이브러리만 사용** (CLI zero dependencies)

---

## 설치

권장 (CLI + TUI 함께 설치):

```bash
curl -fsSL https://raw.githubusercontent.com/seilk/opensmi/main/scripts/install.sh | bash
```

기본 설치 경로는 `~/.local/bin`이며, 필요 시 PATH 안내를 출력합니다.

**요구사항:** macOS/Linux, **Python 3.8+**, (GPU 노드에) `nvidia-smi`가 있고 SSH로 접근 가능해야 합니다.

### 업데이트

```bash
opensmi update
```

GitHub API rate limit에 걸리면 `OPENSMI_GITHUB_TOKEN`을 설정하세요.

### 제거 (uninstall)

```bash
opensmi uninstall           # CLI + TUI 제거
opensmi uninstall --dry-run # 미리보기
```

state/config까지 삭제하려면(파괴적):

```bash
opensmi uninstall --purge-state --yes
```

---

## 빠른 시작

### 1) 설정 파일 생성

```bash
opensmi onboard
```

기본 설정 파일 위치:

- `~/.opensmi/opensmi.json`

### 2) 실행

- TUI 실행:

```bash
opensmi
```

- CLI 사용:

```bash
opensmi poll
opensmi violations
opensmi alloc list
opensmi --help
```

---

## 설정 (JSON)

설정은 plain JSON 입니다. 템플릿에서 시작하세요:

- [`opensmi.example.json`](opensmi.example.json)

NFS 등 공유 경로를 state로 쓰려면:

```bash
export OPENSMI_STATE_DIR=/nfs/shared/.opensmi
```

---

## 문서

- 아키텍처: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 릴리즈: [`docs/RELEASING.md`](docs/RELEASING.md)
- 변경사항: [`CHANGELOG.md`](CHANGELOG.md)

---

## 적용 범위 / 지원 환경

opensmi는 Slurm의 **보완재가 아닌 대체제**로 설계되었습니다.
Slurm이 활성화된 환경에서 opensmi를 함께 실행하는 것은 **지원하지 않으며**, 자원 관리 충돌이 발생합니다:

- **CUDA_VISIBLE_DEVICES**: Slurm은 GPU를 0-based로 remapping합니다. opensmi는 물리 인덱스를 사용하므로 두 설정이 충돌합니다.
- **프로세스 생명주기**: opensmi의 tmux 세션은 Slurm cgroup 외부에서 실행되어 Slurm의 자원 회계 및 할당 적용을 우회합니다.

**지원 사용 환경**: Slurm·PBS·LSF 등 워크로드 스케줄러가 없는 자체 운영 GPU 클러스터.

---

## 보안 노트

`opensmi`는 SSH로 원격 명령(프로세스 signal 포함)을 실행할 수 있습니다.
관리자 워크스테이션으로 취급하고 키/권한 설정을 주의하세요.
자세한 내용: [`SECURITY.md`](SECURITY.md)

---

## License

MIT — [`LICENSE`](LICENSE)
