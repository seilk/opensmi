import asyncio
import unittest
from unittest.mock import AsyncMock, mock_open, patch

from opensmi.executor import (
    inject_cuda_visible_devices,
    route_command_to_target,
    route_commands_one_to_one,
    validate_gpu_availability,
    validate_gpu_indices_against_available,
)
from opensmi.models import NodeConfig, NodeTarget, RemoteExecutionContext
from opensmi.sshutil import RemoteExecResult, ssh_exec_remote


def _mock_tmux_subprocess():
    """Helper: mock asyncio.create_subprocess_exec for local tmux tests."""
    mock_proc = AsyncMock()
    mock_proc.communicate = AsyncMock(return_value=(b"", b""))
    mock_proc.returncode = 0
    mock_proc.wait = AsyncMock(return_value=0)
    return mock_proc


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
        """Tmux mode creates a LOCAL tmux session with SSH wrapper script."""
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            context = RemoteExecutionContext(
                target=self.target,
                command="python train.py",
                env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
                execution_mode="tmux",
                tmux_session="session-123",
            )

            result = asyncio.run(route_command_to_target(context))

            self.assertTrue(result.success)
            # Verify tmux was called with correct session name
            mock_subproc.assert_called_once()
            call_args = mock_subproc.call_args[0]
            self.assertIn("new-session", call_args)
            self.assertIn("-d", call_args)
            self.assertIn("session-123", call_args)

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
        """Test tmux mode creates local session with wrapper script."""
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

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
            call_args = mock_subproc.call_args[0]
            self.assertIn("new-session", call_args)
            self.assertIn("-d", call_args)
            self.assertIn("training-session", call_args)

    def test_tmux_mode_without_env_vars(self):
        """Test tmux mode works correctly without environment variables."""
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

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
            call_args = mock_subproc.call_args[0]
            self.assertIn("new-session", call_args)
            self.assertIn("simple-session", call_args)

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


class TestGPUValidation(unittest.TestCase):
    """Test suite for GPU availability validation functions."""

    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )

    def test_validate_gpu_indices_success(self):
        """Test successful validation when all indices are available."""
        requested = [0, 1, 2]
        available = [0, 1, 2, 3, 4, 5, 6, 7]

        validate_gpu_indices_against_available(requested, available, "gpu01")

    def test_validate_gpu_indices_single_invalid(self):
        """Test validation fails with single invalid GPU index."""
        requested = [0, 1, 8]
        available = [0, 1, 2, 3, 4, 5, 6, 7]

        with self.assertRaises(ValueError) as cm:
            validate_gpu_indices_against_available(requested, available, "gpu01")

        error_msg = str(cm.exception)
        self.assertIn("8", error_msg)
        self.assertIn("gpu01", error_msg)
        self.assertIn("Available indices", error_msg)

    def test_validate_gpu_indices_multiple_invalid(self):
        """Test validation fails with multiple invalid GPU indices."""
        requested = [0, 2, 8, 10, 15]
        available = [0, 1, 2, 3]

        with self.assertRaises(ValueError) as cm:
            validate_gpu_indices_against_available(requested, available, "gpu01")

        error_msg = str(cm.exception)
        self.assertIn("8", error_msg)
        self.assertIn("10", error_msg)
        self.assertIn("15", error_msg)
        self.assertIn("[0, 1, 2, 3]", error_msg)

    def test_validate_gpu_indices_all_invalid(self):
        """Test validation fails when all indices are invalid."""
        requested = [5, 6, 7, 8]
        available = [0, 1, 2, 3]

        with self.assertRaises(ValueError) as cm:
            validate_gpu_indices_against_available(requested, available, "gpu01")

        error_msg = str(cm.exception)
        self.assertIn("5", error_msg)
        self.assertIn("6", error_msg)
        self.assertIn("7", error_msg)
        self.assertIn("8", error_msg)

    def test_validate_gpu_indices_empty_requested(self):
        """Test validation succeeds with empty requested list."""
        requested = []
        available = [0, 1, 2, 3]

        validate_gpu_indices_against_available(requested, available, "gpu01")

    def test_validate_gpu_indices_exact_match(self):
        """Test validation succeeds when requested equals available."""
        requested = [0, 1, 2, 3]
        available = [0, 1, 2, 3]

        validate_gpu_indices_against_available(requested, available, "gpu01")

    def test_validate_gpu_availability_success(self):
        """Test successful GPU availability check."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n1\n2\n3\n4\n5\n6\n7\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi --query-gpu=index --format=csv,noheader,nounits",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 1, 2],
                node_config=self.node_config,
            )

            result = asyncio.run(validate_gpu_availability(target))

            self.assertEqual(result, [0, 1, 2, 3, 4, 5, 6, 7])
            mock_exec.assert_called_once()
            call_kwargs = mock_exec.call_args.kwargs
            self.assertIn("nvidia-smi", call_kwargs["command"])
            self.assertIn("--query-gpu=index", call_kwargs["command"])
            self.assertEqual(call_kwargs["timeout_s"], 10)

    def test_validate_gpu_availability_with_whitespace(self):
        """Test GPU availability parsing handles whitespace correctly."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="  0  \n  1  \n  2  \n\n  3  \n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            result = asyncio.run(validate_gpu_availability(target))

            self.assertEqual(result, [0, 1, 2, 3])

    def test_validate_gpu_availability_single_gpu(self):
        """Test GPU availability check with single GPU node."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            result = asyncio.run(validate_gpu_availability(target))

            self.assertEqual(result, [0])

    def test_validate_gpu_availability_missing_node_config(self):
        """Test GPU availability validation fails without node_config."""
        target = NodeTarget(
            node_alias="gpu01",
            gpu_indices=[0, 1],
            node_config=None,
        )

        with self.assertRaises(ValueError) as cm:
            asyncio.run(validate_gpu_availability(target))

        self.assertIn("missing node_config", str(cm.exception))
        self.assertIn("gpu01", str(cm.exception))

    def test_validate_gpu_availability_nvidia_smi_failure(self):
        """Test GPU availability validation fails when nvidia-smi fails."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=127,
                stdout="",
                stderr="nvidia-smi: command not found",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            with self.assertRaises(RuntimeError) as cm:
                asyncio.run(validate_gpu_availability(target))

            error_msg = str(cm.exception)
            self.assertIn("Failed to query GPU availability", error_msg)
            self.assertIn("gpu01", error_msg)

    def test_validate_gpu_availability_no_gpus_detected(self):
        """Test GPU availability validation fails when no GPUs are detected."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            with self.assertRaises(RuntimeError) as cm:
                asyncio.run(validate_gpu_availability(target))

            error_msg = str(cm.exception)
            self.assertIn("No GPUs detected", error_msg)
            self.assertIn("gpu01", error_msg)

    def test_validate_gpu_availability_invalid_output(self):
        """Test GPU availability handles invalid nvidia-smi output gracefully."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n1\ninvalid\n2\n3\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0],
                node_config=self.node_config,
            )

            result = asyncio.run(validate_gpu_availability(target))

            self.assertEqual(result, [0, 1, 2, 3])

    def test_validate_gpu_availability_non_sequential_indices(self):
        """Test GPU availability works with non-sequential GPU indices."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n2\n4\n6\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 2],
                node_config=self.node_config,
            )

            result = asyncio.run(validate_gpu_availability(target))

            self.assertEqual(result, [0, 2, 4, 6])


class TestGPUValidationIntegration(unittest.TestCase):
    """Integration tests for GPU validation workflow."""

    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )

    def test_full_validation_workflow_success(self):
        """Test complete workflow: fetch available GPUs → validate → inject."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n1\n2\n3\n4\n5\n6\n7\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 1, 2],
                node_config=self.node_config,
            )

            available = asyncio.run(validate_gpu_availability(target))

            validate_gpu_indices_against_available(
                target.gpu_indices, available, target.node_alias
            )

            env_config = inject_cuda_visible_devices(target)

            self.assertEqual(env_config.cuda_visible_devices, "0,1,2")

    def test_full_validation_workflow_invalid_indices(self):
        """Test complete workflow fails on invalid GPU indices."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="0\n1\n2\n3\n",
                stderr="",
                node_alias="gpu01",
                command="nvidia-smi",
            )

            target = NodeTarget(
                node_alias="gpu01",
                gpu_indices=[0, 1, 8, 10],
                node_config=self.node_config,
            )

            available = asyncio.run(validate_gpu_availability(target))

            with self.assertRaises(ValueError) as cm:
                validate_gpu_indices_against_available(
                    target.gpu_indices, available, target.node_alias
                )

            error_msg = str(cm.exception)
            self.assertIn("8", error_msg)
            self.assertIn("10", error_msg)
            self.assertIn("Invalid GPU indices", error_msg)


class TestOneToOneExecution(unittest.TestCase):
    def setUp(self):
        self.node_config_01 = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )
        self.node_config_02 = NodeConfig(
            alias="gpu02", address="10.0.0.2", user="testuser"
        )

    def test_one_to_one_three_commands_parallel(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="fold 0 output",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --fold 0",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="fold 1 output",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --fold 1",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="fold 2 output",
                    stderr="",
                    node_alias="gpu02",
                    command="python train.py --fold 2",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --fold 1",
                    env_vars={"CUDA_VISIBLE_DEVICES": "1"},
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python train.py --fold 2",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))
            self.assertEqual(results[0].stdout, "fold 0 output")
            self.assertEqual(results[1].stdout, "fold 1 output")
            self.assertEqual(results[2].stdout, "fold 2 output")
            self.assertEqual(mock_exec.call_count, 3)

    def test_one_to_one_empty_contexts_raises(self):
        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_commands_one_to_one([]))

        self.assertIn("cannot be empty", str(cm.exception))

    def test_one_to_one_missing_node_config_raises(self):
        contexts = [
            RemoteExecutionContext(
                target=NodeTarget("gpu01", [0], None),
                command="python train.py",
                execution_mode="direct",
            )
        ]

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_commands_one_to_one(contexts))

        self.assertIn("missing node_config", str(cm.exception))

    def test_one_to_one_empty_command_raises(self):
        contexts = [
            RemoteExecutionContext(
                target=NodeTarget("gpu01", [0], self.node_config_01),
                command="   ",
                execution_mode="direct",
            )
        ]

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_commands_one_to_one(contexts))

        self.assertIn("command cannot be empty", str(cm.exception))

    def test_one_to_one_validation_multiple_gpus_per_context_raises(self):
        """P1.4: Verify that one-to-one mode rejects contexts with multiple GPUs."""
        contexts = [
            RemoteExecutionContext(
                target=NodeTarget("gpu01", [0, 1], self.node_config_01),
                command="python train.py",
                execution_mode="direct",
            )
        ]

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_commands_one_to_one(contexts))

        self.assertIn("command count to equal GPU count", str(cm.exception))
        self.assertIn("1 command(s) for 2 GPU(s)", str(cm.exception))

    def test_one_to_one_validation_gpu_count_mismatch_raises(self):
        """P1.4: Verify that one-to-one mode rejects mismatched command/GPU counts."""
        contexts = [
            RemoteExecutionContext(
                target=NodeTarget("gpu01", [0], self.node_config_01),
                command="python train.py --fold 0",
                execution_mode="direct",
            ),
            RemoteExecutionContext(
                target=NodeTarget("gpu01", [1], self.node_config_01),
                command="python train.py --fold 1",
                execution_mode="direct",
            ),
            RemoteExecutionContext(
                target=NodeTarget("gpu02", [0, 1], self.node_config_02),
                command="python train.py --fold 2",
                execution_mode="direct",
            ),
        ]

        with self.assertRaises(ValueError) as cm:
            asyncio.run(route_commands_one_to_one(contexts))

        self.assertIn("command count to equal GPU count", str(cm.exception))
        self.assertIn("3 command(s) for 4 GPU(s)", str(cm.exception))

    def test_one_to_one_tmux_mode(self):
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ), patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="tmux",
                    tmux_session="fold-0",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [1], self.node_config_02),
                    command="python train.py --fold 1",
                    env_vars={"CUDA_VISIBLE_DEVICES": "1"},
                    execution_mode="tmux",
                    tmux_session="fold-1",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))

    def test_one_to_one_mixed_nodes_and_modes(self):
        """Mixed direct + tmux: direct uses ssh_exec_remote, tmux uses local subprocess."""
        mock_proc = _mock_tmux_subprocess()
        direct_result = RemoteExecResult(
            exit_code=0,
            stdout="direct output",
            stderr="",
            node_alias="gpu01",
            command="python eval.py",
        )
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock,
            return_value=direct_result,
        ), patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ), patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [2], self.node_config_01),
                    command="python eval.py",
                    env_vars={"CUDA_VISIBLE_DEVICES": "2"},
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python train.py",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="tmux",
                    tmux_session="training",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))

    def test_one_to_one_single_command(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="single output",
                stderr="",
                node_alias="gpu01",
                command="python test.py",
            )

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python test.py",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="direct",
                )
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].success)
            self.assertEqual(results[0].stdout, "single output")

    def test_one_to_one_preserves_order(self):
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output A",
                    stderr="",
                    node_alias="gpu01",
                    command="cmd A",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output B",
                    stderr="",
                    node_alias="gpu01",
                    command="cmd B",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output C",
                    stderr="",
                    node_alias="gpu02",
                    command="cmd C",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="cmd A",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="cmd B",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="cmd C",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(results[0].stdout, "output A")
            self.assertEqual(results[1].stdout, "output B")
            self.assertEqual(results[2].stdout, "output C")

    def test_one_to_one_executes_in_parallel(self):
        """Verify that multi-node commands execute concurrently via asyncio.gather."""
        import time

        async def slow_ssh_exec_remote(node, command, **kwargs):
            """Simulated SSH execution with 0.1s delay per call."""
            await asyncio.sleep(0.1)  # Simulate network/SSH overhead
            return RemoteExecResult(
                exit_code=0,
                stdout=f"output from {node.alias}",
                stderr="",
                node_alias=node.alias,
                command=command,
            )

        with patch("opensmi.executor.ssh_exec_remote", new=slow_ssh_exec_remote):
            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --fold 1",
                    env_vars={"CUDA_VISIBLE_DEVICES": "1"},
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python train.py --fold 2",
                    env_vars={"CUDA_VISIBLE_DEVICES": "0"},
                    execution_mode="direct",
                ),
            ]

            start = time.time()
            results = asyncio.run(route_commands_one_to_one(contexts))
            elapsed = time.time() - start

            # Verify all commands succeeded
            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))

            # Verify parallel execution:
            # - Sequential execution would take >= 0.3s (3 * 0.1s)
            # - Parallel execution should take ~0.1s (all run concurrently)
            # Allow some overhead for asyncio scheduling
            self.assertLess(
                elapsed,
                0.25,
                f"Expected parallel execution (~0.1s), got {elapsed:.3f}s. "
                "Commands may be executing sequentially instead of concurrently.",
            )

            # Verify it didn't execute too fast (sanity check)
            self.assertGreater(
                elapsed,
                0.08,
                f"Execution too fast ({elapsed:.3f}s), may indicate mock not working.",
            )

    def test_one_to_one_auto_injects_cuda_visible_devices(self):
        """Verify that CUDA_VISIBLE_DEVICES is auto-injected from gpu_indices when not present."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 0",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --fold 0",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 1",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --fold 1",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 2",
                    stderr="",
                    node_alias="gpu02",
                    command="python train.py --fold 2",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --fold 1",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [2], self.node_config_02),
                    command="python train.py --fold 2",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))

            self.assertEqual(mock_exec.call_count, 3)

            call_0_kwargs = mock_exec.call_args_list[0][1]
            self.assertEqual(call_0_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], "0")

            call_1_kwargs = mock_exec.call_args_list[1][1]
            self.assertEqual(call_1_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], "1")

            call_2_kwargs = mock_exec.call_args_list[2][1]
            self.assertEqual(call_2_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], "2")

    def test_one_to_one_preserves_explicit_cuda_visible_devices(self):
        """Verify that explicit CUDA_VISIBLE_DEVICES in env_vars is not overridden."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="output",
                stderr="",
                node_alias="gpu01",
                command="python train.py",
            )

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py",
                    env_vars={"CUDA_VISIBLE_DEVICES": "7"},
                    execution_mode="direct",
                )
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].success)

            call_kwargs = mock_exec.call_args_list[0][1]
            self.assertEqual(call_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], "7")

    def test_one_to_one_auto_inject_merges_additional_env_vars(self):
        """Verify that auto-injected CUDA_VISIBLE_DEVICES merges with other env vars."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.return_value = RemoteExecResult(
                exit_code=0,
                stdout="output",
                stderr="",
                node_alias="gpu01",
                command="python train.py",
            )

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [2], self.node_config_01),
                    command="python train.py",
                    env_vars={"DEBUG": "1", "PYTHONPATH": "/custom/path"},
                    execution_mode="direct",
                )
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].success)

            call_kwargs = mock_exec.call_args_list[0][1]
            self.assertEqual(call_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], "2")
            self.assertEqual(call_kwargs["env_vars"]["DEBUG"], "1")
            self.assertEqual(call_kwargs["env_vars"]["PYTHONPATH"], "/custom/path")

    def test_one_to_one_partial_failure_propagates(self):
        """P1.5: Verify that failures in one-to-one mode propagate correctly."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            # First command succeeds, second fails, third succeeds
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="success 0",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --fold 0",
                ),
                RemoteExecResult(
                    exit_code=1,
                    stdout="",
                    stderr="Training failed",
                    node_alias="gpu01",
                    command="python train.py --fold 1",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="success 2",
                    stderr="",
                    node_alias="gpu02",
                    command="python train.py --fold 2",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --fold 1",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python train.py --fold 2",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            # All three results should be returned (no fail-fast)
            self.assertEqual(len(results), 3)
            self.assertTrue(results[0].success)
            self.assertFalse(results[1].success)
            self.assertTrue(results[2].success)
            self.assertEqual(results[1].stderr, "Training failed")


class TestMultiNodeExecution(unittest.TestCase):
    """P1.6: Comprehensive tests for multi-node execution scenarios.

    Tests targeting command routing across multiple nodes with various
    failure modes, network conditions, and GPU configurations.
    """

    def setUp(self):
        self.node_config_01 = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )
        self.node_config_02 = NodeConfig(
            alias="gpu02", address="10.0.0.2", user="testuser"
        )
        self.node_config_03 = NodeConfig(
            alias="gpu03", address="10.0.0.3", user="testuser"
        )

    def test_multi_node_three_nodes_parallel(self):
        """P1.6: Verify parallel execution across three distinct nodes."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="node01 output",
                    stderr="",
                    node_alias="gpu01",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="node02 output",
                    stderr="",
                    node_alias="gpu02",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="node03 output",
                    stderr="",
                    node_alias="gpu03",
                    command="python task.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python task.py",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))
            self.assertEqual(results[0].node_alias, "gpu01")
            self.assertEqual(results[1].node_alias, "gpu02")
            self.assertEqual(results[2].node_alias, "gpu03")
            self.assertEqual(mock_exec.call_count, 3)

    def test_multi_node_mixed_success_and_failure(self):
        """P1.6: Verify that multi-node execution continues despite node failures."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="success",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py",
                ),
                RemoteExecResult(
                    exit_code=1,
                    stdout="",
                    stderr="Connection timeout",
                    node_alias="gpu02",
                    command="python train.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="success",
                    stderr="",
                    node_alias="gpu03",
                    command="python train.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python train.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python train.py",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(results[0].success)
            self.assertFalse(results[1].success)
            self.assertTrue(results[2].success)
            self.assertIn("Connection timeout", results[1].stderr)

    def test_multi_node_tmux_execution(self):
        """P1.6: Verify tmux mode works correctly across multiple nodes."""
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ), patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python task.py",
                    execution_mode="tmux",
                    tmux_session="session-01",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python task.py",
                    execution_mode="tmux",
                    tmux_session="session-02",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python task.py",
                    execution_mode="tmux",
                    tmux_session="session-03",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))

    def test_multi_node_different_gpu_indices_per_node(self):
        """P1.6: Verify CUDA_VISIBLE_DEVICES is set correctly per node."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output",
                    stderr="",
                    node_alias="gpu01",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output",
                    stderr="",
                    node_alias="gpu02",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output",
                    stderr="",
                    node_alias="gpu03",
                    command="python task.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [2], self.node_config_01),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [5], self.node_config_02),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [7], self.node_config_03),
                    command="python task.py",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))

            self.assertEqual(
                mock_exec.call_args_list[0][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "2"
            )
            self.assertEqual(
                mock_exec.call_args_list[1][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "5"
            )
            self.assertEqual(
                mock_exec.call_args_list[2][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "7"
            )

    def test_multi_node_parallel_timing(self):
        """P1.6: Verify commands execute in parallel across nodes (timing test)."""
        import time

        async def slow_ssh_exec_remote(node, command, **kwargs):
            await asyncio.sleep(0.15)
            return RemoteExecResult(
                exit_code=0,
                stdout=f"output from {node.alias}",
                stderr="",
                node_alias=node.alias,
                command=command,
            )

        with patch("opensmi.executor.ssh_exec_remote", new=slow_ssh_exec_remote):
            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python task.py",
                    execution_mode="direct",
                ),
            ]

            start = time.time()
            results = asyncio.run(route_commands_one_to_one(contexts))
            elapsed = time.time() - start

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))

            # Sequential would take 0.45s (3 * 0.15s)
            # Parallel should take ~0.15s
            self.assertLess(
                elapsed,
                0.30,
                f"Expected parallel execution (~0.15s), got {elapsed:.3f}s",
            )
            self.assertGreater(elapsed, 0.12, f"Execution too fast ({elapsed:.3f}s)")

    def test_multi_node_with_additional_env_vars(self):
        """P1.6: Verify additional environment variables are preserved across nodes."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output",
                    stderr="",
                    node_alias="gpu01",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output",
                    stderr="",
                    node_alias="gpu02",
                    command="python task.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python task.py",
                    env_vars={
                        "MASTER_ADDR": "10.0.0.1",
                        "RANK": "0",
                        "WORLD_SIZE": "2",
                    },
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python task.py",
                    env_vars={
                        "MASTER_ADDR": "10.0.0.1",
                        "RANK": "1",
                        "WORLD_SIZE": "2",
                    },
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))

            # Verify node 1 env vars
            env1 = mock_exec.call_args_list[0][1]["env_vars"]
            self.assertEqual(env1["CUDA_VISIBLE_DEVICES"], "0")
            self.assertEqual(env1["MASTER_ADDR"], "10.0.0.1")
            self.assertEqual(env1["RANK"], "0")
            self.assertEqual(env1["WORLD_SIZE"], "2")

            # Verify node 2 env vars
            env2 = mock_exec.call_args_list[1][1]["env_vars"]
            self.assertEqual(env2["CUDA_VISIBLE_DEVICES"], "0")
            self.assertEqual(env2["MASTER_ADDR"], "10.0.0.1")
            self.assertEqual(env2["RANK"], "1")
            self.assertEqual(env2["WORLD_SIZE"], "2")

    def test_multi_node_all_nodes_fail(self):
        """P1.6: Verify behavior when all nodes fail."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=1,
                    stdout="",
                    stderr="SSH connection failed",
                    node_alias="gpu01",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=1,
                    stdout="",
                    stderr="SSH connection failed",
                    node_alias="gpu02",
                    command="python task.py",
                ),
                RemoteExecResult(
                    exit_code=1,
                    stdout="",
                    stderr="SSH connection failed",
                    node_alias="gpu03",
                    command="python task.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python task.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python task.py",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(not r.success for r in results))
            for result in results:
                self.assertIn("SSH connection failed", result.stderr)

    def test_multi_node_heterogeneous_commands(self):
        """P1.6: Verify different commands can be executed on different nodes."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="training complete",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --epochs 10",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="evaluation complete",
                    stderr="",
                    node_alias="gpu02",
                    command="python eval.py --checkpoint best.pt",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="data processing complete",
                    stderr="",
                    node_alias="gpu03",
                    command="python preprocess.py --dataset imagenet",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --epochs 10",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python eval.py --checkpoint best.pt",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu03", [0], self.node_config_03),
                    command="python preprocess.py --dataset imagenet",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))
            self.assertIn("training", results[0].stdout)
            self.assertIn("evaluation", results[1].stdout)
            self.assertIn("data processing", results[2].stdout)

    def test_multi_node_high_gpu_count_per_node(self):
        """P1.6: Verify execution across multiple nodes with many GPUs per node."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            num_gpus_per_node = 8
            num_nodes = 3
            total_commands = num_gpus_per_node * num_nodes

            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout=f"output {i}",
                    stderr="",
                    node_alias=f"gpu{(i // num_gpus_per_node) + 1:02d}",
                    command=f"python task.py --id {i}",
                )
                for i in range(total_commands)
            ]

            contexts = []
            for i in range(total_commands):
                node_idx = i // num_gpus_per_node
                gpu_idx = i % num_gpus_per_node
                if node_idx == 0:
                    node_config = self.node_config_01
                elif node_idx == 1:
                    node_config = self.node_config_02
                else:
                    node_config = self.node_config_03

                contexts.append(
                    RemoteExecutionContext(
                        target=NodeTarget(
                            f"gpu{node_idx + 1:02d}",
                            [gpu_idx],
                            node_config,
                        ),
                        command=f"python task.py --id {i}",
                        execution_mode="direct",
                    )
                )

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), total_commands)
            self.assertTrue(all(r.success for r in results))

            # Verify correct CUDA_VISIBLE_DEVICES per GPU
            for i in range(total_commands):
                gpu_idx = i % num_gpus_per_node
                call_kwargs = mock_exec.call_args_list[i][1]
                self.assertEqual(
                    call_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], str(gpu_idx)
                )

    def test_one_to_one_multiple_gpus_same_node(self):
        """P1.5: Verify one-to-one execution with multiple GPUs on same node."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU0",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --gpu 0",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU1",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --gpu 1",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU2",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --gpu 2",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU3",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py --gpu 3",
                ),
            ]

            # Four commands on same node, different GPUs
            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --gpu 0",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --gpu 1",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [2], self.node_config_01),
                    command="python train.py --gpu 2",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [3], self.node_config_01),
                    command="python train.py --gpu 3",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 4)
            self.assertTrue(all(r.success for r in results))
            # Verify each GPU got the correct CUDA_VISIBLE_DEVICES
            for i in range(4):
                call_kwargs = mock_exec.call_args_list[i][1]
                self.assertEqual(
                    call_kwargs["env_vars"]["CUDA_VISIBLE_DEVICES"], str(i)
                )
                self.assertIn(f"--gpu {i}", call_kwargs["command"])

    def test_one_to_one_large_scale_execution(self):
        """P1.5: Verify one-to-one mode handles large-scale parallel execution (10+ commands)."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            num_commands = 16
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout=f"output {i}",
                    stderr="",
                    node_alias=f"gpu{i // 8 + 1:02d}",
                    command=f"python train.py --idx {i}",
                )
                for i in range(num_commands)
            ]

            # Create 16 contexts (2 nodes x 8 GPUs each)
            contexts = []
            for i in range(num_commands):
                node_idx = i // 8
                gpu_idx = i % 8
                node_config = (
                    self.node_config_01 if node_idx == 0 else self.node_config_02
                )
                contexts.append(
                    RemoteExecutionContext(
                        target=NodeTarget(
                            f"gpu{node_idx + 1:02d}",
                            [gpu_idx],
                            node_config,
                        ),
                        command=f"python train.py --idx {i}",
                        execution_mode="direct",
                    )
                )

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), num_commands)
            self.assertTrue(all(r.success for r in results))
            # Verify outputs are in correct order
            for i in range(num_commands):
                self.assertEqual(results[i].stdout, f"output {i}")

    def test_one_to_one_tmux_with_custom_session_names(self):
        """P1.5: Verify tmux mode respects custom session names for each command."""
        mock_proc = _mock_tmux_subprocess()
        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc
        ) as mock_subproc, patch("builtins.open", mock_open()), \
             patch("os.makedirs"), patch("os.chmod"):

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py --fold 0",
                    execution_mode="tmux",
                    tmux_session="experiment-fold-0",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [1], self.node_config_01),
                    command="python train.py --fold 1",
                    execution_mode="tmux",
                    tmux_session="experiment-fold-1",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))
            # Verify each call used the correct tmux session name
            for i, call_args in enumerate(mock_subproc.call_args_list):
                args = call_args[0]
                self.assertIn(f"experiment-fold-{i}", args)

    def test_one_to_one_with_custom_timeouts(self):
        """P1.5: Verify custom timeout_s is respected for each execution."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 0",
                    stderr="",
                    node_alias="gpu01",
                    command="python quick_task.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 1",
                    stderr="",
                    node_alias="gpu02",
                    command="python long_task.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python quick_task.py",
                    timeout_s=60,
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python long_task.py",
                    timeout_s=3600,
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))
            # Verify timeouts were passed correctly
            self.assertEqual(mock_exec.call_args_list[0][1]["timeout_s"], 60)
            self.assertEqual(mock_exec.call_args_list[1][1]["timeout_s"], 3600)

    def test_one_to_one_non_sequential_gpu_indices(self):
        """P1.5: Verify one-to-one mode works with non-sequential GPU indices."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU2",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU5",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output GPU7",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py",
                ),
            ]

            # Use non-sequential GPU indices (2, 5, 7)
            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [2], self.node_config_01),
                    command="python train.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [5], self.node_config_01),
                    command="python train.py",
                    execution_mode="direct",
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [7], self.node_config_01),
                    command="python train.py",
                    execution_mode="direct",
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.success for r in results))
            # Verify correct GPU indices were injected
            self.assertEqual(
                mock_exec.call_args_list[0][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "2"
            )
            self.assertEqual(
                mock_exec.call_args_list[1][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "5"
            )
            self.assertEqual(
                mock_exec.call_args_list[2][1]["env_vars"]["CUDA_VISIBLE_DEVICES"], "7"
            )

    def test_one_to_one_mixed_env_vars_across_contexts(self):
        """P1.5: Verify each context can have different environment variables."""
        with patch(
            "opensmi.executor.ssh_exec_remote", new_callable=AsyncMock
        ) as mock_exec:
            mock_exec.side_effect = [
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 0",
                    stderr="",
                    node_alias="gpu01",
                    command="python train.py",
                ),
                RemoteExecResult(
                    exit_code=0,
                    stdout="output 1",
                    stderr="",
                    node_alias="gpu02",
                    command="python eval.py",
                ),
            ]

            contexts = [
                RemoteExecutionContext(
                    target=NodeTarget("gpu01", [0], self.node_config_01),
                    command="python train.py",
                    env_vars={"BATCH_SIZE": "32", "LEARNING_RATE": "0.001"},
                ),
                RemoteExecutionContext(
                    target=NodeTarget("gpu02", [0], self.node_config_02),
                    command="python eval.py",
                    env_vars={"EVAL_MODE": "test", "NUM_WORKERS": "4"},
                ),
            ]

            results = asyncio.run(route_commands_one_to_one(contexts))

            self.assertEqual(len(results), 2)
            self.assertTrue(all(r.success for r in results))

            # Verify first context has correct env vars
            call_0_env = mock_exec.call_args_list[0][1]["env_vars"]
            self.assertEqual(call_0_env["CUDA_VISIBLE_DEVICES"], "0")
            self.assertEqual(call_0_env["BATCH_SIZE"], "32")
            self.assertEqual(call_0_env["LEARNING_RATE"], "0.001")
            self.assertNotIn("EVAL_MODE", call_0_env)

            # Verify second context has correct env vars
            call_1_env = mock_exec.call_args_list[1][1]["env_vars"]
            self.assertEqual(call_1_env["CUDA_VISIBLE_DEVICES"], "0")
            self.assertEqual(call_1_env["EVAL_MODE"], "test")
            self.assertEqual(call_1_env["NUM_WORKERS"], "4")
            self.assertNotIn("BATCH_SIZE", call_1_env)


if __name__ == "__main__":
    unittest.main()
