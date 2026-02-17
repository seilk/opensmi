import argparse
import json
from io import StringIO
from contextlib import redirect_stdout
from unittest.mock import AsyncMock, patch

from opensmi.cli import _cmd_exec, _cmd_preflight
from opensmi.models import NodeConfig, PreflightCheck, PreflightCheckType, PreflightResult
from opensmi.sshutil import RemoteExecResult


def _ns(**kwargs):
    return argparse.Namespace(**kwargs)


def test_cmd_preflight_requires_at_least_one_check_json():
    args = _ns(
        state_dir=None,
        config=None,
        node="gpu01",
        gpus=None,
        command=None,
        mode="direct",
        json=True,
    )

    dummy_cfg = object()
    node = NodeConfig(alias="gpu01", address="10.0.0.1", user="u")

    with (
        patch("opensmi.cli.get_state_dir", return_value="/tmp/opensmi-test"),
        patch("opensmi.cli.ensure_state_dir"),
        patch("opensmi.cli.resolve_config_path", return_value="/tmp/opensmi-test/opensmi.json"),
        patch("opensmi.cli.load_config", return_value=dummy_cfg),
        patch("opensmi.cli._find_node", return_value=node),
    ):
        out = StringIO()
        with redirect_stdout(out):
            rc = _cmd_preflight(args)

    assert rc == 2
    payload = json.loads(out.getvalue())
    assert payload["ok"] is False
    assert "No preflight checks requested" in payload["error"]


def test_cmd_exec_injects_cuda_visible_devices_and_runs_preflight():
    args = _ns(
        state_dir=None,
        config=None,
        node="gpu01",
        gpus="0,1",
        command="python train.py",
        mode="direct",
        session=None,
        timeout=120,
        skip_preflight=False,
        json=True,
    )

    dummy_cfg = object()
    node = NodeConfig(alias="gpu01", address="10.0.0.1", user="u")

    preflight_results = [
        PreflightResult(
            check=PreflightCheck(
                check_type=PreflightCheckType.COMMAND_SYNTAX,
                node_alias="gpu01",
                command_to_validate="python train.py",
                node_config=node,
            ),
            passed=True,
            timestamp="2026-01-01T00:00:00Z",
        )
    ]

    route_ret = RemoteExecResult(
        exit_code=0,
        stdout="ok",
        stderr="",
        node_alias="gpu01",
        command="python train.py",
    )

    with (
        patch("opensmi.cli.get_state_dir", return_value="/tmp/opensmi-test"),
        patch("opensmi.cli.ensure_state_dir"),
        patch("opensmi.cli.resolve_config_path", return_value="/tmp/opensmi-test/opensmi.json"),
        patch("opensmi.cli.load_config", return_value=dummy_cfg),
        patch("opensmi.cli._find_node", return_value=node),
        patch("opensmi.cli.run_preflight_checks", new=AsyncMock(return_value=preflight_results)),
        patch("opensmi.cli.route_command_to_target", new=AsyncMock(return_value=route_ret)) as route_mock,
    ):
        out = StringIO()
        with redirect_stdout(out):
            rc = _cmd_exec(args)

    assert rc == 0
    call_ctx = route_mock.call_args.args[0]
    assert call_ctx.env_vars["CUDA_VISIBLE_DEVICES"] == "0,1"

    payload = json.loads(out.getvalue())
    assert payload["ok"] is True
    assert payload["result"]["success"] is True
