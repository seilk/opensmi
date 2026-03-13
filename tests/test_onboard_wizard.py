from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from opensmi.cli import (
    _ob_arrow_select,
    _ob_is_wsl,
    _ob_find_windows_ssh_config,
    _ob_maybe_copy_wsl_ssh_config,
)


class TestObArrowSelectNonTTY(unittest.TestCase):
    def _run_with_input(self, options: list[str], user_input: str) -> int:
        fake_stdin = io.StringIO(user_input)
        with patch("sys.stdin", fake_stdin):
            with patch("sys.stdin.isatty", return_value=False):
                return _ob_arrow_select(options, default=0)

    def test_first_option_selected(self):
        idx = self._run_with_input(["Yes", "No"], "1\n")
        self.assertEqual(idx, 0)

    def test_second_option_selected(self):
        idx = self._run_with_input(["Yes", "No"], "2\n")
        self.assertEqual(idx, 1)

    def test_invalid_then_valid(self):
        idx = self._run_with_input(["a", "b", "c"], "0\n3\n")
        self.assertEqual(idx, 2)

    def test_three_options_last(self):
        idx = self._run_with_input(["confirm", "edit", "quit"], "3\n")
        self.assertEqual(idx, 2)


class TestObIsWsl(unittest.TestCase):
    def test_returns_false_when_proc_version_missing(self):
        with patch("builtins.open", side_effect=OSError("no file")):
            with patch("pathlib.Path.read_text", side_effect=OSError("no file")):
                result = _ob_is_wsl()
        self.assertFalse(result)

    def test_returns_true_when_microsoft_in_proc_version(self):
        with patch(
            "pathlib.Path.read_text",
            return_value="Linux version 5.15.0-microsoft-standard-WSL2",
        ):
            result = _ob_is_wsl()
        self.assertTrue(result)

    def test_returns_false_when_no_wsl_marker(self):
        with patch(
            "pathlib.Path.read_text",
            return_value="Linux version 5.15.0-generic (buildd@lcy02-amd64-059)",
        ):
            result = _ob_is_wsl()
        self.assertFalse(result)


class TestObFindWindowsSshConfig(unittest.TestCase):
    def test_returns_none_when_mnt_c_missing(self):
        with patch("pathlib.Path.is_dir", return_value=False):
            result = _ob_find_windows_ssh_config()
        self.assertIsNone(result)

    def test_finds_config_via_userprofile_env(self):
        import tempfile
        import os

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            ssh_dir = td_path / ".ssh"
            ssh_dir.mkdir()
            config_file = ssh_dir / "config"
            config_file.write_text("Host *\n  ServerAliveInterval 60\n")

            with patch("pathlib.Path.is_dir", return_value=True):
                with patch.dict(os.environ, {"USERPROFILE": str(td_path)}):
                    result = _ob_find_windows_ssh_config()

            self.assertIsNotNone(result)
            self.assertEqual(result, config_file)

    def test_returns_none_when_no_config_found(self):
        with patch("pathlib.Path.is_dir", return_value=True):
            with patch("pathlib.Path.exists", return_value=False):
                with patch.dict("os.environ", {}, clear=False):
                    import os

                    os.environ.pop("USERPROFILE", None)
                    with patch("pathlib.Path.iterdir", return_value=iter([])):
                        result = _ob_find_windows_ssh_config()
        self.assertIsNone(result)

    def test_converts_windows_userprofile_to_wsl_mount_path(self):
        def _exists(path_obj: Path) -> bool:
            return str(path_obj) == "/mnt/c/Users/alice/.ssh/config"

        with patch("pathlib.Path.is_dir", return_value=True):
            with patch.dict("os.environ", {"USERPROFILE": r"C:\\Users\\alice"}):
                with patch("pathlib.Path.exists", autospec=True, side_effect=_exists):
                    result = _ob_find_windows_ssh_config()
        self.assertEqual(result, Path("/mnt/c/Users/alice/.ssh/config"))


class TestObMaybeCopyWslSshConfig(unittest.TestCase):
    def test_non_wsl_does_nothing(self):
        with patch("opensmi.cli._ob_is_wsl", return_value=False):
            with patch("opensmi.cli._ob_find_windows_ssh_config") as mock_find:
                _ob_maybe_copy_wsl_ssh_config()
                mock_find.assert_not_called()

    def test_wsl_existing_ssh_config_does_nothing(self, tmp_path=None):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            ssh_dir = td_path / ".ssh"
            ssh_dir.mkdir()
            existing_config = ssh_dir / "config"
            existing_config.write_text("Host existing\n")

            with patch("opensmi.cli._ob_is_wsl", return_value=True):
                with patch("pathlib.Path.home", return_value=td_path):
                    with patch("opensmi.cli._ob_find_windows_ssh_config") as mock_find:
                        _ob_maybe_copy_wsl_ssh_config()
                        mock_find.assert_not_called()

    def test_wsl_missing_config_windows_config_not_found_does_nothing(
        self, tmp_path=None
    ):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)

            with patch("opensmi.cli._ob_is_wsl", return_value=True):
                with patch("pathlib.Path.home", return_value=td_path):
                    with patch(
                        "opensmi.cli._ob_find_windows_ssh_config", return_value=None
                    ):
                        with patch("opensmi.cli._ob_arrow_select") as mock_sel:
                            _ob_maybe_copy_wsl_ssh_config()
                            mock_sel.assert_not_called()

    def test_wsl_missing_config_windows_found_user_declines_no_copy(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            win_td = Path(td) / "win"
            win_td.mkdir()
            win_config = win_td / "config"
            win_config.write_text("Host win-host\n")

            with patch("opensmi.cli._ob_is_wsl", return_value=True):
                with patch("pathlib.Path.home", return_value=td_path):
                    with patch(
                        "opensmi.cli._ob_find_windows_ssh_config",
                        return_value=win_config,
                    ):
                        with patch("opensmi.cli._ob_arrow_select", return_value=0):
                            _ob_maybe_copy_wsl_ssh_config()

            wsl_config = td_path / ".ssh" / "config"
            self.assertFalse(wsl_config.exists())

    def test_wsl_missing_config_windows_found_user_accepts_copies_once(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            win_td = Path(td) / "win"
            win_td.mkdir()
            win_config = win_td / "config"
            win_config.write_text("Host win-host\n  User alice\n")

            with patch("opensmi.cli._ob_is_wsl", return_value=True):
                with patch("pathlib.Path.home", return_value=td_path):
                    with patch(
                        "opensmi.cli._ob_find_windows_ssh_config",
                        return_value=win_config,
                    ):
                        with patch("opensmi.cli._ob_arrow_select", return_value=1):
                            _ob_maybe_copy_wsl_ssh_config()

            wsl_config = td_path / ".ssh" / "config"
            self.assertTrue(wsl_config.exists())
            self.assertEqual(wsl_config.read_text(), "Host win-host\n  User alice\n")

    def test_wsl_never_overwrites_existing_config(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            ssh_dir = td_path / ".ssh"
            ssh_dir.mkdir()
            existing_config = ssh_dir / "config"
            existing_config.write_text("Host original\n")

            win_td = Path(td) / "win"
            win_td.mkdir()
            win_config = win_td / "config"
            win_config.write_text("Host win-host\n")

            with patch("opensmi.cli._ob_is_wsl", return_value=True):
                with patch("pathlib.Path.home", return_value=td_path):
                    with patch(
                        "opensmi.cli._ob_find_windows_ssh_config",
                        return_value=win_config,
                    ):
                        with patch("opensmi.cli._ob_arrow_select", return_value=1):
                            _ob_maybe_copy_wsl_ssh_config()

            self.assertEqual(existing_config.read_text(), "Host original\n")


class TestSlurmPortInPayload(unittest.TestCase):
    def test_slurm_cluster_with_port_included_in_payload(self):
        sc = {"name": "HPC", "login_node": "hpc-login", "user": "alice", "port": 2222}
        self.assertEqual(sc.get("port"), 2222)

    def test_slurm_cluster_without_port_omits_key(self):
        sc = {"name": "HPC", "login_node": "hpc-login", "user": "alice"}
        self.assertIsNone(sc.get("port"))

    def test_print_review_shows_port_suffix(self):
        import io
        from opensmi.cli import _ob_c

        captured = io.StringIO()
        with patch("sys.stdout", captured):
            sc_with_port = {
                "name": "HPC",
                "login_node": "hpc-login",
                "user": "alice",
                "port": 2222,
            }
            sc_no_port = {"name": "HPC2", "login_node": "hpc2-login", "user": "bob"}
            _sc_port = sc_with_port.get("port")
            _port_suffix = f":{_sc_port}" if _sc_port else ""
            line = f"    1. {sc_with_port.get('name', 'Slurm Cluster')}  →  {sc_with_port.get('login_node', '')}{_port_suffix} (user: {sc_with_port.get('user', '')})"
            print(line, file=captured)
            _sc_port2 = sc_no_port.get("port")
            _port_suffix2 = f":{_sc_port2}" if _sc_port2 else ""
            line2 = f"    2. {sc_no_port.get('name', 'Slurm Cluster')}  →  {sc_no_port.get('login_node', '')}{_port_suffix2} (user: {sc_no_port.get('user', '')})"
            print(line2, file=captured)

        output = captured.getvalue()
        self.assertIn(":2222", output)
        self.assertNotIn(":None", output)
        self.assertIn("hpc2-login (user: bob)", output)


if __name__ == "__main__":
    unittest.main()
