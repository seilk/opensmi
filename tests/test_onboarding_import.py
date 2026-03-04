import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from opensmi.cli import (
    _discover_ssh_config_hosts,
    _ob_filter_ssh_hosts,
    _ob_find_local_pubkey,
    _ob_is_auth_failure,
    _parse_selection_input,
    _parse_ssh_g_output,
    _parse_ssh_host_aliases,
    _print_verify_summary,
    _summarize_verify_results,
    _verify_nodes,
)


def test_parse_ssh_host_aliases_filters_wildcards_negations_and_invalid_tokens():
    text = """
Host *.corp !blocked gpu-a gpu-b
Host gpu-a
Host -bad
Host good_01
Include ~/.ssh/conf.d/*.conf
"""
    aliases = _parse_ssh_host_aliases(text)
    assert aliases == ["gpu-a", "gpu-b", "good_01"]


def test_parse_ssh_g_output_extracts_effective_fields():
    out = _parse_ssh_g_output(
        "\n".join(
            [
                "user ubuntu",
                "hostname 10.10.0.21",
                "port 2202",
                "identityfile ~/.ssh/id_ed25519",
                "proxyjump bastion.internal",
            ]
        )
    )
    assert out["address"] == "10.10.0.21"
    assert out["user"] == "ubuntu"
    assert out["port"] == 2202
    assert out["identityfile"] == "~/.ssh/id_ed25519"
    assert out["proxyjump"] == "bastion.internal"


def test_discover_ssh_config_hosts_uses_ssh_g_effective_resolution(tmp_path: Path):
    ssh_cfg = tmp_path / "config"
    ssh_cfg.write_text(
        "\n".join(
            [
                "Host *.corp !skip gpu-a",
                "  User ignored",
                "Host gpu-b",
                "  User ignored2",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    def _fake_run(cmd, capture_output, text, timeout):
        alias = cmd[-1]
        if alias == "gpu-a":
            return subprocess.CompletedProcess(
                args=cmd,
                returncode=0,
                stdout="\n".join(
                    [
                        "hostname 10.0.0.10",
                        "user alice",
                        "port 2222",
                        "identityfile ~/.ssh/id_a",
                        "proxyjump jump-a",
                    ]
                ),
                stderr="",
            )
        if alias == "gpu-b":
            return subprocess.CompletedProcess(
                args=cmd,
                returncode=0,
                stdout="\n".join(
                    [
                        "hostname gpu-b.internal",
                        "user bob",
                        "port 22",
                    ]
                ),
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=cmd, returncode=1, stdout="", stderr="bad"
        )

    with patch("opensmi.cli.subprocess.run", side_effect=_fake_run) as run_mock:
        resolved_path, hosts = _discover_ssh_config_hosts(str(ssh_cfg))

    assert resolved_path == ssh_cfg.resolve()
    assert [h["alias"] for h in hosts] == ["gpu-a", "gpu-b"]
    assert hosts[0]["address"] == "10.0.0.10"
    assert hosts[0]["port"] == 2222
    assert hosts[0]["identityfile"] == "~/.ssh/id_a"
    assert hosts[0]["proxyjump"] == "jump-a"
    assert hosts[1]["address"] == "gpu-b.internal"
    assert hosts[1]["port"] == 22
    assert run_mock.call_count == 2


def test_parse_selection_input_supports_all_indices_and_ranges():
    assert _parse_selection_input("", 5) == [1, 2, 3, 4, 5]
    assert _parse_selection_input("all", 4) == [1, 2, 3, 4]
    assert _parse_selection_input("1,3-5,2", 5) == [1, 2, 3, 4, 5]


def test_parse_selection_input_rejects_invalid_tokens_and_bounds():
    with pytest.raises(ValueError):
        _parse_selection_input("0", 3)
    with pytest.raises(ValueError):
        _parse_selection_input("3-1", 3)
    with pytest.raises(ValueError):
        _parse_selection_input("1,x", 3)
    with pytest.raises(ValueError):
        _parse_selection_input("1,9", 3)


def test_verify_summary_behavior_with_mocked_ssh_checks(capsys):
    nodes = [
        {"alias": "gpu-a", "address": "10.0.0.10", "user": "alice", "port": 22},
        {"alias": "gpu-b", "address": "10.0.0.20", "user": "bob", "port": 2222},
    ]

    with patch(
        "opensmi.cli._ob_ssh_test",
        side_effect=[(True, ""), (False, "Permission denied")],
    ):
        results = _verify_nodes(nodes)

    summary = _summarize_verify_results(results)
    assert summary == {"total": 2, "ok": 1, "failed": 1}

    _print_verify_summary(results)
    out = capsys.readouterr().out
    assert "Connectivity verify summary" in out
    assert "gpu-a" in out
    assert "gpu-b" in out
    assert "Permission denied" in out
    assert "1/2 reachable, 1 failed" in out


def test_ob_is_auth_failure_detects_auth_errors():
    assert _ob_is_auth_failure("Permission denied (publickey,password).")
    assert _ob_is_auth_failure("debug1: authentication failed")
    assert _ob_is_auth_failure("ssh: connect to host: publickey")
    assert not _ob_is_auth_failure("Connection refused")
    assert not _ob_is_auth_failure("No route to host")
    assert not _ob_is_auth_failure("Timeout connecting to host")
    assert not _ob_is_auth_failure("")


def test_ob_find_local_pubkey_returns_first_existing(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    # No keys yet
    assert _ob_find_local_pubkey() is None
    # Create id_rsa.pub only
    (ssh_dir / "id_rsa.pub").write_text("ssh-rsa AAAA...", encoding="utf-8")
    result = _ob_find_local_pubkey()
    assert result is not None
    assert result.endswith("id_rsa.pub")
    # Create id_ed25519.pub — should take priority
    (ssh_dir / "id_ed25519.pub").write_text("ssh-ed25519 AAAA...", encoding="utf-8")
    result2 = _ob_find_local_pubkey()
    assert result2 is not None
    assert result2.endswith("id_ed25519.pub")


def test_ob_filter_ssh_hosts_static_blacklist():
    hosts = [
        {"alias": "gpu-01", "address": "10.0.0.1", "user": "ubuntu", "port": 22},
        {"alias": "github", "address": "github.com", "user": "git", "port": 22},
        {"alias": "gitlab", "address": "gitlab.com", "user": "git", "port": 22},
        {"alias": "sub-github", "address": "sub.github.com", "user": "git", "port": 22},
    ]
    # Patch asyncio.run to avoid network calls — pass2 returns keep for gpu-01
    gpu01 = {"alias": "gpu-01", "address": "10.0.0.1", "user": "ubuntu", "port": 22}
    with patch("asyncio.run", return_value=[(gpu01, "keep")]):
        kept, filtered_out = _ob_filter_ssh_hosts(hosts)

    # github.com, gitlab.com, sub.github.com all filtered by static blacklist
    filtered_aliases = [h["alias"] for h in filtered_out]
    assert "github" in filtered_aliases
    assert "gitlab" in filtered_aliases
    assert "sub-github" in filtered_aliases
    # gpu-01 kept
    kept_aliases = [h["alias"] for h in kept]
    assert "gpu-01" in kept_aliases


def test_ob_filter_ssh_hosts_no_shell_stderr():
    """Pass-2 filter:no shell access pattern is surfaced correctly."""
    host = {"alias": "myserver", "address": "10.0.0.5", "user": "ubuntu", "port": 22}

    with patch("asyncio.run", return_value=[(host, "filter:no shell access")]):
        kept, filtered_out = _ob_filter_ssh_hosts([host])

    assert len(kept) == 0
    assert len(filtered_out) == 1
    assert filtered_out[0]["_filter_reason"] == "no shell access"
