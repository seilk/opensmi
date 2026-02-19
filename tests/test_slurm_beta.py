from __future__ import annotations

import pytest

from opensmi.slurm_beta import (
    E_NO_SLURM_ALLOC,
    E_PARSE_CVD,
    SlurmBetaError,
    beta_resolved_mode_log_line,
    is_slurm_beta_enabled,
    require_slurm_beta_context,
    resolve_mode,
)


def test_stable_mode_does_not_enable_slurm_beta_by_default():
    assert (
        is_slurm_beta_enabled(
            cli_experimental_slurm=False,
            env={},
            config_mode=None,
        )
        is False
    )


def test_mode_precedence_cli_over_env_over_config():
    resolved = resolve_mode(
        cli_experimental_slurm=True,
        env={"OPENSMI_MODE": "stable"},
        config_mode="slurm-beta",
    )
    assert resolved.mode == "slurm-beta"
    assert resolved.source == "cli"

    resolved = resolve_mode(
        cli_experimental_slurm=False,
        env={"OPENSMI_MODE": "slurm-beta"},
        config_mode="stable",
    )
    assert resolved.mode == "slurm-beta"
    assert resolved.source == "env"

    resolved = resolve_mode(
        cli_experimental_slurm=False,
        env={},
        config_mode="slurm-beta",
    )
    assert resolved.mode == "slurm-beta"
    assert resolved.source == "config"


def test_no_slurm_alloc_fails_closed():
    with pytest.raises(SlurmBetaError) as exc:
        require_slurm_beta_context({"CUDA_VISIBLE_DEVICES": "0,1"})
    assert exc.value.code == E_NO_SLURM_ALLOC


def test_parse_cvd_failure_fails_closed_with_diagnostics():
    with pytest.raises(SlurmBetaError) as exc:
        require_slurm_beta_context({"SLURM_JOB_ID": "123", "CUDA_VISIBLE_DEVICES": "gpu0"})
    assert exc.value.code == E_PARSE_CVD
    assert exc.value.diagnostics["has_slurm_job_id"] is True
    assert exc.value.diagnostics["cvd_raw"] == "gpu0"


def test_beta_resolved_mode_log_line_only_in_beta():
    stable = resolve_mode(cli_experimental_slurm=False, env={}, config_mode=None)
    assert beta_resolved_mode_log_line(stable) is None

    beta = resolve_mode(cli_experimental_slurm=True, env={}, config_mode=None)
    assert beta_resolved_mode_log_line(beta) == "resolved_mode=slurm-beta (source=cli)"


# ── (3/5): wire-up, hard block, entitlement snapshot ────────────────

from opensmi.slurm_beta import (
    E_GPU_OUT_OF_SCOPE,
    E_SET_MISMATCH,
    EntitlementSnapshot,
    assert_gpu_in_scope,
    capture_entitlement_snapshot,
    check_set_mismatch,
)


def test_entitlement_snapshot_captures_allowed_gpus():
    env = {"SLURM_JOB_ID": "9999", "CUDA_VISIBLE_DEVICES": "2,3"}
    snap = capture_entitlement_snapshot(env)
    assert snap.allowed_gpus == (2, 3)
    assert snap.slurm_job_id == "9999"
    assert snap.captured_at  # non-empty ISO string


def test_assert_gpu_in_scope_blocks_out_of_scope():
    snap = EntitlementSnapshot(allowed_gpus=(0, 1), slurm_job_id="42", captured_at="2026-01-01T00:00:00+00:00")
    # In scope — no error
    assert_gpu_in_scope(0, snap)
    assert_gpu_in_scope(1, snap)

    # Out of scope — hard block
    with pytest.raises(SlurmBetaError) as exc:
        assert_gpu_in_scope(2, snap)
    assert exc.value.code == E_GPU_OUT_OF_SCOPE
    assert exc.value.diagnostics["requested_gpu"] == 2
    assert exc.value.diagnostics["allowed_gpus"] == [0, 1]


def test_cli_experimental_slurm_flag_wires_up(tmp_path, monkeypatch):
    """--experimental-slurm flag causes fail-closed when no Slurm env set."""
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    monkeypatch.delenv("OPENSMI_MODE", raising=False)

    from opensmi.cli import main

    with pytest.raises(SystemExit) as exc:
        main(["--experimental-slurm", "--help"])
    # --help exits 0; flag itself without Slurm env → exit 5
    # Here we just verify flag is accepted by argparse (exit 0 for --help)
    assert exc.value.code == 0


# ── (4/5): slurm_meta in job, E_SET_MISMATCH ────────────────────────

def test_slurm_meta_stored_in_job_and_round_trips(tmp_path):
    """EntitlementSnapshot data is stored in job.slurm_meta and survives save/load."""
    import json as _json
    from opensmi.jobs import Job, load_jobs, save_jobs, upsert_job

    snap = capture_entitlement_snapshot({"SLURM_JOB_ID": "777", "CUDA_VISIBLE_DEVICES": "0,2"})
    job = Job(
        id="aabbccdd",
        command="python train.py",
        slurm_meta={
            "allowed_gpus": list(snap.allowed_gpus),
            "slurm_job_id": snap.slurm_job_id,
            "captured_at": snap.captured_at,
        },
    )
    jobs = upsert_job([], job)
    save_jobs(tmp_path, jobs)
    loaded = load_jobs(tmp_path)
    assert loaded[0].slurm_meta is not None
    assert loaded[0].slurm_meta["allowed_gpus"] == [0, 2]
    assert loaded[0].slurm_meta["slurm_job_id"] == "777"


def test_set_mismatch_disjoint_fails_closed():
    with pytest.raises(SlurmBetaError) as exc:
        check_set_mismatch([0, 1], {"SLURM_JOB_GPUS": "2,3"})
    assert exc.value.code == E_SET_MISMATCH
    assert exc.value.diagnostics["cvd_gpus"] == [0, 1]
    assert exc.value.diagnostics["slurm_gpus"] == [2, 3]


def test_set_mismatch_partial_warns_only():
    warn = check_set_mismatch([0, 1], {"SLURM_JOB_GPUS": "0,1,2"})
    assert warn and "WARNING" in warn


def test_set_mismatch_no_slurm_key_returns_none():
    result = check_set_mismatch([0, 1], {})
    assert result is None


def test_cli_experimental_slurm_without_allocation_exits_5(monkeypatch):
    """--experimental-slurm without SLURM_JOB_ID must exit 5."""
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    monkeypatch.delenv("OPENSMI_MODE", raising=False)

    from opensmi.cli import main

    with pytest.raises(SystemExit) as exc:
        main(["--experimental-slurm", "job", "list"])
    assert exc.value.code == 5
