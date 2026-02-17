# [Backend] Remote Execution & Virtual Cluster Orchestration (Enhanced)

## Goal
opensmi에서 사용자가 선택한 GPU가 물리 위치(노드)에 관계없이 정확히 실행되도록 백엔드 실행 엔진을 완성한다.
핵심은 **정확한 타겟 라우팅 + 안전한 원격 실행 + 분산 실행 오케스트레이션 최소 구현**이다.

---
## Product Constraints (must keep)
- slim/light 정책 유지 (mini-slurm 확장 금지)
- 로컬 TUI에서 원격 실행 제어 (no full scheduler)
- 새 top-level CLI 명령 추가 금지 (기존 surface 내 확장)
- shell injection 방지(인자 안전성)
- 실패 시 원인/해결 힌트가 사용자에게 명확히 보여야 함

---
## P0. Planning & contract lock
1) 현재 코드 경로(launch/executor/ssh/model/tui-binding) 매핑
2) data contract 정의:
   - ExecutionTarget(node, gpu_ids, mode)
   - RemoteExecRequest(command, env, cwd, tmux options)
   - RemoteExecResult(status, node, pid/session, stdout/stderr tail, error_code)
3) one-to-one vs single 분기 계약 확정

Acceptance:
- 설계 메모/주석 또는 문서로 계약이 코드와 함께 남아 있어야 함
- 추측 구현 금지, 기존 호출부와 연결점 명시

---
## P1. Targeted Command Routing (must-have)
1) 선택된 Node+GPU로 정확히 라우팅
2) one-to-one에서 각 실행 단위마다 해당 노드 기준 CUDA_VISIBLE_DEVICES 동적 주입
3) 안전한 원격 실행 스크립트 빌더(escape/quote/cwd/env/tmux)

Acceptance:
- 단일 노드/다중 노드/one-to-one 각각에서 타겟 오염 없음
- JSON 출력/에러 구조가 안정적
- shell metachar 포함 명령에서도 injection 없이 동작

---
## P2. Remote Preflight for tmux exec mode
1) 실행 전 타겟 노드 실시간 확인:
   - tmux 존재/접근 가능
   - 명령 문법 검증
   - GPU 가용성/충돌 징후
2) 실패 시 사용자 액션 가능한 1-line hint 제공

Acceptance:
- preflight 실패가 조용히 무시되지 않음
- 실패 타입별 메시지 구분 가능

---
## P3. Virtual Bundle Logic (dist=single)
1) 멀티 노드 GPU를 가상 bundle로 취급하는 추상화
2) DDP 최소 오케스트레이션:
   - rank/world-size/master-addr/master-port 계산/주입
3) 실제 분산 실행의 full scheduler가 아니라 baseline orchestration 수준 유지

Acceptance:
- rank 충돌/누락 없음
- master 선출 규칙이 결정적(deterministic)

---
## P4. Hardening / regression / docs
1) race condition, partial failure, retry-safe 경로 점검
2) 핵심 회귀 테스트 유지/확장
3) 사용/한계/리스크 문서화

Acceptance:
- 기존 poll/alloc/kill 회귀 없음
- backend 추가 기능 테스트가 재현 가능

---
## Mandatory Verification Matrix
각 iteration에서 최소 1개 이상 실행(실행 로그에 흔적 남길 것):
- PYTHONPATH=src pytest -q
- 특정 모듈 집중 테스트 (예: tests/test_remote_execution.py -q)
- 안전성/escape 검증 테스트
- 필요 시 정적 검사(가벼운 수준)

최종 iteration 전에는 최소 한 번 이상 아래를 포함:
- 전체 pytest
- 관련 핵심 테스트 2종 이상

---
## Execution Rules (imported + strict)
- Top-down 계획 먼저, 급코딩 금지
- 작은 단위 checkpoint commit 자주
- max-iterations(10) 이전 완료처럼 보여도 안정화/부작용 제거 반복
- 각 iteration마다 최소 1개 검증(테스트/실행확인)
- completion-promise는 iteration 10 전 금지

추가 강제 규칙:
- iteration마다 "무엇을 안정화했는지" 1개 이상 명시
- 조기 DONE 금지. 10회 채울 때까지 P0~P4 전 범위에서 개선 반복
- tests가 실패하면 다음 iteration은 기능 추가보다 먼저 안정화 우선

---
## Done Condition
아래 모두 충족 시에만 completion promise 출력:
1) P0~P4 체크리스트 실질 완료
2) 타겟 라우팅 / preflight / virtual bundle/DDP baseline 구현
3) 회귀 부재(기존 핵심 기능 유지)
4) 검증 로그 존재
5) iteration 10 도달
