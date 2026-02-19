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
