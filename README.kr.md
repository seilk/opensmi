# opensmi

에이전트/데몬 없이(=GPU 노드에 아무것도 설치하지 않고) **SSH + `nvidia-smi`만**으로
멀티노드 GPU 사용 현황을 모니터링하고 할당(Allocation) 정책을 적용하는 터미널 기반 도구입니다.

<p>
  <img src="assets/intro_A.png" width="31%" />
  <img src="assets/intro_B.png" width="31%" />
  <img src="assets/intro_C.png" width="31%" />
</p>
<p align="center"><sub><em>스크린샷은 실제 환경에서 촬영되었으며, 민감한 정보(노드명, 사용자명, 파일 경로)는 Nano Banana로 마스킹 처리했습니다.</em></sub></p>

## 핵심 기능

- **TUI**: 대시보드/노드 상세/할당·해제/위반자 kill
- **CLI**: poll, allocations, violations, watch (Slack 알림)
- **정책**: 할당되지 않은 GPU 사용 = 위반, `*` = 모두에게 오픈
- **GPU 노드 무설치** (agentless)
- **CLI는 Python 표준 라이브러리만 사용** (zero dependencies)

---

## 설치

권장 (CLI + TUI 함께 설치):

```bash
curl -fsSL https://raw.githubusercontent.com/seil/opensmi/main/scripts/install.sh | bash
```

기본으로 `~/.local/bin`에 설치됩니다.

### 업데이트

```bash
opensmi update
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
```

---

## 설정 (JSON)

템플릿에서 시작하세요:

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

## 보안 노트

`opensmi`는 SSH로 원격 명령(프로세스 signal 포함)을 실행할 수 있습니다.
관리자 워크스테이션으로 취급하고 키/권한 설정을 주의하세요.
자세한 내용: [`SECURITY.md`](SECURITY.md)

---

## License

MIT — [`LICENSE`](LICENSE)
