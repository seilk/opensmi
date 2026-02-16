# Integration Prep (Capybara)

Date: 2026-02-16 (KST)
Base: `origin/main` (`719da26`)
Workspace: `/Users/seil/git-wt/opensmi-dev/capybara`

## Goal
Prepare lion/raven updates for eventual main integration **without merging now**.

## Source branches
- Lion: `ralph/20260216-210652` (tip `923d1db`)
- Raven: `ralph/20260216-193952` (tip `f698fb2`)

## What was prepared
1. Created capybara prep worktree/branch:
   - worktree: `/Users/seil/git-wt/opensmi-dev/capybara`
   - branch: `capybara/integration-prep`
2. Created local staging branches from `origin/main`:
   - `capybara/stage-lion`
   - `capybara/stage-raven`
   - `capybara/stage-combined`
3. Ran cherry-pick feasibility checks against `origin/main`.

## Feasibility check result (direct cherry-pick)
Direct cherry-pick of checkpoint commits is **not cleanly applicable** on `origin/main`.

Checked commits:
- Lion: `923d1db`
- Raven: `8d7b806`, `de94a8b`, `734b361`, `8739e77`, `f698fb2`

Result: all failed with conflicts.

### Main conflict reasons
- `src/opensmi/models.py` conflict for lion telemetry commit.
- Raven commits assume files that do not exist on main (`alerts.py`, `test_alerts.py`, `test_cli_modes.py`).
- Heavy overlapping edits in `src/opensmi/cli.py` and `src/opensmi/collector.py`.

## Integration strategy (prepared)
Because direct cherry-pick is conflict-heavy, use **file-level transplant** (manual minimal extraction) instead of commit-level cherry-pick.

### Stage order
1. `capybara/stage-lion` (minimal telemetry core)
   - candidate files:
     - `src/opensmi/collector.py`
     - `src/opensmi/models.py`
     - `tests/test_collector_parse.py`
     - `.gitignore` (`.ralph/` hygiene line only if needed)

2. `capybara/stage-raven` (slim-safe subset only)
   - candidate scope for first pass:
     - `src/opensmi/sshutil.py` (retry minimal)
     - `src/opensmi/config.py` (`config validate` path)
   - defer broad CLI-gating import until conflict budget is acceptable.

3. `capybara/stage-combined`
   - replay stage-lion + stage-raven selected patches
   - run full verification before PR

## Verification checklist (ready)
- `PYTHONPATH=src pytest -q`
- `PYTHONPATH=src python3 -m opensmi --help`
- targeted tests:
  - `tests/test_collector_parse.py`
  - `tests/test_ssh_retry.py` (if adopted)
  - config validate tests (if adopted)

## Notes
- This prep intentionally does not merge to main.
- Conflict log snapshot: `/tmp/capybara_cherrypick_check.log`
