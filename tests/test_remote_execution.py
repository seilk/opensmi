import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from opensmi.executor import inject_cuda_visible_devices, route_command_to_target
from opensmi.models import NodeConfig, NodeTarget, RemoteExecutionContext
from opensmi.sshutil import RemoteExecResult, ssh_exec_remote


class TestInjectCudaVisibleDevices(unittest.TestCase):
    """Test suite for inject_cuda_visible_devices() function."""

    def test_inject_basic(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1, 2],
        )
        config = inject_cuda_visible_devices(target)

        self.assertEqual(config.cuda_visible_devices, "0,1,2")
        self.assertEqual(config.gpu_indices, [0, 1, 2])
        self.assertEqual(config.to_env_dict(), {"CUDA_VISIBLE_DEVICES": "0,1,2"})

    def test_inject_single_gpu(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[3],
        )
        config = inject_cuda_visible_devices(target)

        self.assertEqual(config.cuda_visible_devices, "3")
        self.assertEqual(config.to_env_dict(), {"CUDA_VISIBLE_DEVICES": "3"})

    def test_inject_empty_gpu_list(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[],
        )
        config = inject_cuda_visible_devices(target)

        self.assertIsNone(config.cuda_visible_devices)
        self.assertEqual(config.to_env_dict(), {})

    def test_inject_with_additional_env(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1],
        )
        config = inject_cuda_visible_devices(
            target, additional_env={"OMP_NUM_THREADS": "8", "DEBUG": "1"}
        )

        env_dict = config.to_env_dict()
        self.assertEqual(env_dict["CUDA_VISIBLE_DEVICES"], "0,1")
        self.assertEqual(env_dict["OMP_NUM_THREADS"], "8")
        self.assertEqual(env_dict["DEBUG"], "1")
        self.assertEqual(len(env_dict), 3)

    def test_inject_rejects_negative_indices(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, -1, 2],
        )

        with self.assertRaises(ValueError) as cm:
            inject_cuda_visible_devices(target)

        self.assertIn("negative", str(cm.exception).lower())
        self.assertIn("-1", str(cm.exception))

    def test_inject_rejects_all_negative_indices(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[-1, -2, -3],
        )

        with self.assertRaises(ValueError) as cm:
            inject_cuda_visible_devices(target)

        error_msg = str(cm.exception)
        self.assertIn("-1", error_msg)
        self.assertIn("-2", error_msg)
        self.assertIn("-3", error_msg)

    def test_inject_preserves_gpu_order(self):
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[7, 3, 5, 1],
        )
        config = inject_cuda_visible_devices(target)

        self.assertEqual(config.cuda_visible_devices, "7,3,5,1")

    def test_inject_with_node_config(self):
        node_config = NodeConfig(alias="gpu01", address="10.0.0.1", user="test")
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1],
            node_config=node_config,
        )
        config = inject_cuda_visible_devices(target)

        self.assertEqual(config.cuda_visible_devices, "0,1")
        self.assertEqual(config.to_env_dict(), {"CUDA_VISIBLE_DEVICES": "0,1"})


class TestRemoteExecution(unittest.TestCase):
    def setUp(self):
        self.node = NodeConfig(alias="test-node", address="10.0.0.1", user="test")

    def test_exec_remote_success(self):
        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = (0, "output", "")

            result = asyncio.run(
                ssh_exec_remote(
                    self.node,
                    "echo test",
                    timeout_s=10,
                )
            )

            self.assertIsInstance(result, RemoteExecResult)
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout, "output")
            self.assertEqual(result.stderr, "")
            self.assertEqual(result.node_alias, "test-node")
            self.assertEqual(result.command, "echo test")
            self.assertTrue(result.success)

    def test_exec_remote_with_env_vars(self):
        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = (0, "GPU 0,1", "")

            result = asyncio.run(
                ssh_exec_remote(
                    self.node,
                    "echo $CUDA_VISIBLE_DEVICES",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
                    timeout_s=10,
                )
            )

            self.assertTrue(result.success)
            mock_ssh.assert_called_once()
            call_args = mock_ssh.call_args
            self.assertIn("CUDA_VISIBLE_DEVICES=0,1", call_args[0][1][2])

    def test_exec_remote_failure(self):
        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = (1, "", "error message")

            result = asyncio.run(
                ssh_exec_remote(
                    self.node,
                    "failing_command",
                    timeout_s=10,
                )
            )

            self.assertEqual(result.exit_code, 1)
            self.assertFalse(result.success)
            self.assertEqual(result.stderr, "error message")

    def test_exec_remote_multiple_env_vars(self):
        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = (0, "output", "")

            result = asyncio.run(
                ssh_exec_remote(
                    self.node,
                    "python train.py",
                    env_vars={
                        "CUDA_VISIBLE_DEVICES": "0,1,2",
                        "OMP_NUM_THREADS": "4",
                        "PYTHONPATH": "/opt/lib",
                    },
                    timeout_s=300,
                )
            )

            self.assertTrue(result.success)
            call_args = mock_ssh.call_args
            command_str = call_args[0][1][2]
            self.assertIn("CUDA_VISIBLE_DEVICES=0,1,2", command_str)
            self.assertIn("OMP_NUM_THREADS=4", command_str)
            self.assertIn("PYTHONPATH=/opt/lib", command_str)
            self.assertIn("python train.py", command_str)


class TestRouteCommandToTarget(unittest.TestCase):
    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )
        self.target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1],
            node_config=self.node_config,
        )

    def test_route_direct_mode(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="Training started",
                stderr="",
                node_alias="gpu01",
                command="python train.py",
            )

            context = RemoteExecutionContext(
                target=self.target,
                command="python train.py",
                env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
                execution_mode="direct",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            self.assertEqual(result.stdout, "Training started")
            mock_exec.assert_called_once_with(
                node=self.node_config,
                command="python train.py",
                env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
                timeout_s=300,
            )

    def test_route_tmux_mode(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="tmux new-session ...",
            )

            context = RemoteExecutionContext(
                target=self.target,
                command="python train.py",
                env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
                execution_mode="tmux",
                tmux_session="session-123",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            mock_exec.assert_called_once()
            call_args = mock_exec.call_args
            actual_command = call_args.kwargs["command"]
            self.assertIn("tmux new-session", actual_command)
            self.assertIn("-d", actual_command)
            self.assertIn("session-123", actual_command)
            self.assertIn("CUDA_VISIBLE_DEVICES=0,1", actual_command)
            self.assertIn("python train.py", actual_command)

    def test_route_missing_node_config(self):
        target_no_config = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1],
            node_config=None,
        )
        context = RemoteExecutionContext(
            target=target_no_config,
            command="python train.py",
        )

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_command_to_target(context))

        self.assertIn("missing node_config", str(cm.exception))

    def test_route_tmux_missing_session_name(self):
        context = RemoteExecutionContext(
            target=self.target,
            command="python train.py",
            execution_mode="tmux",
            tmux_session=None,
        )

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_command_to_target(context))

        self.assertIn("tmux_session name required", str(cm.exception))

    def test_route_unknown_execution_mode(self):
        context = RemoteExecutionContext(
            target=self.target,
            command="python train.py",
            execution_mode="invalid_mode",
        )

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_command_to_target(context))

        self.assertIn("Unknown execution_mode", str(cm.exception))

    def test_route_custom_timeout(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="python train.py",
            )

            context = RemoteExecutionContext(
                target=self.target,
                command="python train.py",
                timeout_s=600,
            )

            asyncio.run(route_command_to_target(context))

            mock_exec.assert_called_once()
            self.assertEqual(mock_exec.call_args.kwargs["timeout_s"], 600)

    def test_route_no_env_vars(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="echo test",
            )

            context = RemoteExecutionContext(
                target=self.target,
                command="echo test",
                env_vars={},
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            mock_exec.assert_called_once_with(
                node=self.node_config,
                command="echo test",
                env_vars={},
                timeout_s=300,
            )


class TestRemoteExecutionIntegration(unittest.TestCase):
    """Integration tests for end-to-end GPU selection → command routing."""

    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )

    def test_route_with_cuda_visible_devices_injection(self):
        """Test CUDA_VISIBLE_DEVICES is properly injected for GPU targeting."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0,1,2",
                stderr="",
                node_alias="gpu01",
                command="echo $CUDA_VISIBLE_DEVICES",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 1, 2],
                node_config=self.node_config,
            )

            context = RemoteExecutionContext(
                target=target,
                command="echo $CUDA_VISIBLE_DEVICES",
                env_vars={"CUDA_VISIBLE_DEVICES": "0,1,2"},
                execution_mode="direct",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            mock_exec.assert_called_once()
            call_kwargs = mock_exec.call_args.kwargs
            self.assertEqual(call_kwargs["env_vars"], {"CUDA_VISIBLE_DEVICES": "0,1,2"})

    def test_route_with_multiple_environment_variables(self):
        """Test multiple environment variables are properly passed through."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="success",
                stderr="",
                node_alias="gpu01",
                command="python train.py",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 1],
                node_config=self.node_config,
            )

            context = RemoteExecutionContext(
                target=target,
                command="python train.py",
                env_vars={
                    "CUDA_VISIBLE_DEVICES": "0,1",
                    "WORLD_SIZE": "2",
                    "RANK": "0",
                    "MASTER_ADDR": "localhost",
                    "MASTER_PORT": "29500",
                },
                execution_mode="direct",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            call_kwargs = mock_exec.call_args.kwargs
            self.assertEqual(len(call_kwargs["env_vars"]), 5)
            self.assertIn("CUDA_VISIBLE_DEVICES", call_kwargs["env_vars"])
            self.assertIn("WORLD_SIZE", call_kwargs["env_vars"])

    def test_tmux_mode_wraps_command_with_env_vars(self):
        """Test tmux mode properly wraps command with environment variables."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="tmux command",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            context = RemoteExecutionContext(
                target=target,
                command="python train.py --epochs 100",
                env_vars={"CUDA_VISIBLE_DEVICES": "0", "DEBUG": "1"},
                execution_mode="tmux",
                tmux_session="training-session",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            call_kwargs = mock_exec.call_args.kwargs
            command = call_kwargs["command"]

            # Verify tmux session creation command structure
            self.assertIn("tmux new-session", command)
            self.assertIn("-d", command)
            self.assertIn("training-session", command)
            self.assertIn("CUDA_VISIBLE_DEVICES=0", command)
            self.assertIn("DEBUG=1", command)
            self.assertIn("python train.py --epochs 100", command)

    def test_tmux_mode_without_env_vars(self):
        """Test tmux mode works correctly without environment variables."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="tmux command",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[],
                node_config=self.node_config,
            )

            context = RemoteExecutionContext(
                target=target,
                command="echo 'hello'",
                execution_mode="tmux",
                tmux_session="simple-session",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            call_kwargs = mock_exec.call_args.kwargs
            command = call_kwargs["command"]

            self.assertIn("tmux new-session", command)
            self.assertIn("simple-session", command)
            self.assertIn("echo 'hello'", command)
            # Should not have env var prefix
            self.assertNotIn("=", command.split("'")[0])

    def test_route_respects_node_config_timeout(self):
        """Test that custom timeout is respected in execution."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="long_running_command",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            context = RemoteExecutionContext(
                target=target,
                command="long_running_command",
                timeout_s=1800,  # 30 minutes
            )

            asyncio.run(route_command_to_target(context))

            call_kwargs = mock_exec.call_args.kwargs
            self.assertEqual(call_kwargs["timeout_s"], 1800)

    def test_execution_result_preserves_node_info(self):
        """Test that execution result correctly preserves node and command info."""
        with patch(
            "opensmi.sshutil.ssh_run_with_retry", new_callable=AsyncMock
        ) as mock_ssh:
            mock_ssh.return_value = (0, "output data", "warning message")

            result = asyncio.run(
                ssh_exec_remote(
                    self.node_config,
                    "test_command --flag",
                    env_vars={"KEY": "value"},
                    timeout_s=60,
                )
            )

            self.assertIsInstance(result, RemoteExecResult)
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout, "output data")
            self.assertEqual(result.stderr, "warning message")
            self.assertEqual(result.node_alias, "gpu01")
            self.assertEqual(result.command, "test_command --flag")
            self.assertTrue(result.success)


if __name__ == "__main__":
    unittest.main()
