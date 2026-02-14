from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from .models import ClusterConfig, NodeConfig


def default_config_data() -> Dict[str, Any]:
    """Default config template.

    NOTE: This is intentionally generic for open-source distribution.
    Use `opensmi init --wizard` or `opensmi init --from-ssh-config ~/.ssh/config`
    to generate a config for your environment.
    """

    return {
        "cluster_name": "GPU-Cluster",
        "nodes": [
            {"alias": "GPU-01", "address": "10.0.0.1", "user": "ubuntu"},
            {"alias": "GPU-02", "address": "10.0.0.2", "user": "ubuntu"},
        ],
        "admins": {
            "master": "ubuntu",
            "members": ["ubuntu"],
            # Additional admin hardening: require the SSH user to be in one of these groups on the node.
            # This is checked on-demand for alloc/kill actions.
            "remote_sudo_groups": ["sudo", "wheel"],
        },
        # Optional: known user list (can stay empty; we can infer from live processes)
        "users": [],
        "policy": {
            # If true: any GPU in use without an allocation is a violation.
            "require_allocation": True,
            # Special allocation target meaning "everyone is allowed"
            "all_users_token": "*",
            # Future: detect_only | warn_then_kill | hard_enforce
            "enforcement": "detect_only",
        },
    }


def load_config(path: Path) -> ClusterConfig:
    data = json.loads(path.read_text(encoding="utf-8"))

    nodes = []
    for raw in data.get("nodes", []):
        nodes.append(
            NodeConfig(
                alias=str(raw["alias"]),
                address=str(raw["address"]),
                user=str(raw.get("user") or data.get("default_user") or "ubuntu"),
                port=int(raw.get("port", 22)),
                connect_timeout_s=int(raw.get("connect_timeout_s", 6)),
            )
        )

    if not nodes:
        raise ValueError(f"No nodes found in config: {path}")

    return ClusterConfig(
        cluster_name=str(data.get("cluster_name", "GPU-Cluster")),
        nodes=nodes,
        admins=dict(data.get("admins", {})),
        users=list(data.get("users", [])),
        policy=dict(data.get("policy", {})),
    )


def save_default_config(path: Path, *, force: bool = False) -> None:
    if path.exists() and not force:
        return

    path.write_text(
        json.dumps(default_config_data(), indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
