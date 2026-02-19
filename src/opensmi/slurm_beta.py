from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Mapping, Optional


E_NO_SLURM_ALLOC = "E_NO_SLURM_ALLOC"
E_PARSE_CVD = "E_PARSE_CVD"
E_GPU_OUT_OF_SCOPE = "E_GPU_OUT_OF_SCOPE"


class SlurmBetaError(RuntimeError):
    def __init__(self, code: str, message: str, *, diagnostics: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or {}


@dataclass(frozen=True)
class ResolvedMode:
    mode: str
    source: str


def resolve_mode(*, cli_experimental_slurm: bool, env: Mapping[str, str], config_mode: Optional[str]) -> ResolvedMode:
    """Resolve runtime mode with strict precedence: CLI > env > config > stable."""
    if cli_experimental_slurm:
        return ResolvedMode(mode="slurm-beta", source="cli")

    env_mode = (env.get("OPENSMI_MODE") or "").strip()
    if env_mode:
        return ResolvedMode(mode=env_mode, source="env")

    cfg_mode = (config_mode or "").strip()
    if cfg_mode:
        return ResolvedMode(mode=cfg_mode, source="config")

    return ResolvedMode(mode="stable", source="default")


def is_slurm_beta_enabled(*, cli_experimental_slurm: bool, env: Mapping[str, str], config_mode: Optional[str]) -> bool:
    return resolve_mode(
        cli_experimental_slurm=cli_experimental_slurm,
        env=env,
        config_mode=config_mode,
    ).mode == "slurm-beta"


def parse_cuda_visible_devices(raw_cvd: str) -> list[int]:
    raw = (raw_cvd or "").strip()
    if not raw:
        raise ValueError("CUDA_VISIBLE_DEVICES is empty")

    out: list[int] = []
    for part in raw.split(","):
        token = part.strip()
        if not token:
            raise ValueError(f"invalid CUDA_VISIBLE_DEVICES token: {part!r}")
        if not token.isdigit():
            raise ValueError(f"non-numeric CUDA_VISIBLE_DEVICES token: {token!r}")
        out.append(int(token))

    if not out:
        raise ValueError("CUDA_VISIBLE_DEVICES resolved to empty list")
    return out


def require_slurm_beta_context(env: Mapping[str, str]) -> list[int]:
    """Fail-closed checks for slurm-beta entry.

    - E_NO_SLURM_ALLOC: SLURM_JOB_ID missing
    - E_PARSE_CVD: CUDA_VISIBLE_DEVICES missing/empty/unparseable
    """
    job_id = (env.get("SLURM_JOB_ID") or "").strip()
    if not job_id:
        raise SlurmBetaError(
            E_NO_SLURM_ALLOC,
            "Slurm beta mode requires an active allocation (SLURM_JOB_ID missing).",
            diagnostics={"has_slurm_job_id": False},
        )

    raw_cvd = env.get("CUDA_VISIBLE_DEVICES", "")
    try:
        return parse_cuda_visible_devices(raw_cvd)
    except ValueError as e:
        raw_trimmed = raw_cvd.strip()
        raise SlurmBetaError(
            E_PARSE_CVD,
            "Invalid CUDA_VISIBLE_DEVICES. Run inside an srun step.",
            diagnostics={
                "has_slurm_job_id": True,
                "cvd_raw": raw_trimmed[:80],
            },
        ) from e


def beta_resolved_mode_log_line(resolved: ResolvedMode) -> Optional[str]:
    if resolved.mode != "slurm-beta":
        return None
    return f"resolved_mode=slurm-beta (source={resolved.source})"


@dataclass(frozen=True)
class EntitlementSnapshot:
    """Immutable record of allowed GPUs captured at submit time."""
    allowed_gpus: tuple[int, ...]
    slurm_job_id: str
    captured_at: str  # ISO-8601 UTC


def capture_entitlement_snapshot(env: Mapping[str, str]) -> EntitlementSnapshot:
    """Call require_slurm_beta_context and freeze the result as a snapshot."""
    allowed = require_slurm_beta_context(env)
    return EntitlementSnapshot(
        allowed_gpus=tuple(allowed),
        slurm_job_id=(env.get("SLURM_JOB_ID") or "").strip(),
        captured_at=datetime.now(timezone.utc).isoformat(),
    )


def assert_gpu_in_scope(gpu_index: int, snapshot: EntitlementSnapshot) -> None:
    """Hard block: raise if requested GPU is outside the entitlement snapshot."""
    if gpu_index not in snapshot.allowed_gpus:
        raise SlurmBetaError(
            E_GPU_OUT_OF_SCOPE,
            f"GPU {gpu_index} is not in your Slurm allocation "
            f"(allowed: {list(snapshot.allowed_gpus)}).",
            diagnostics={
                "requested_gpu": gpu_index,
                "allowed_gpus": list(snapshot.allowed_gpus),
                "slurm_job_id": snapshot.slurm_job_id,
            },
        )
