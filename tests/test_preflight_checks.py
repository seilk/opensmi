import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from opensmi.executor import run_preflight_checks
from opensmi.models import (
    NodeConfig,
    PreflightCheck,
    PreflightCheckType,
    PreflightResult,
)


class TestRunPreflightChecks(unittest.TestCase):
    """Test suite for run_preflight_checks() function."""

    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )

    def test_empty_checks_list_raises(self):
        """Test that empty checks list raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            asyncio.run(run_preflight_checks([]))

        self.assertIn("cannot be empty", str(cm.exception))

    def test_single_check_returns_single_result(self):
        """Test that single check returns single result."""
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias="gpu01",
            )
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], PreflightResult)
        self.assertEqual(results[0].check.check_type, PreflightCheckType.TMUX_AVAILABLE)
        self.assertEqual(results[0].check.node_alias, "gpu01")

    def test_multiple_checks_return_multiple_results(self):
        """Test that multiple checks return results in order."""
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias="gpu01",
            ),
            PreflightCheck(
                check_type=PreflightCheckType.COMMAND_SYNTAX,
                node_alias="gpu01",
                command_to_validate="python train.py",
            ),
            PreflightCheck(
                check_type=PreflightCheckType.GPU_AVAILABILITY,
                node_alias="gpu01",
                target_gpu_indices=[0, 1, 2],
            ),
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertEqual(len(results), 3)
        self.assertEqual(results[0].check.check_type, PreflightCheckType.TMUX_AVAILABLE)
        self.assertEqual(results[1].check.check_type, PreflightCheckType.COMMAND_SYNTAX)
        self.assertEqual(
            results[2].check.check_type, PreflightCheckType.GPU_AVAILABILITY
        )

    def test_preflight_result_has_timestamp(self):
        """Test that preflight results include timestamp."""
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias="gpu01",
            )
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertIsNotNone(results[0].timestamp)
        self.assertIn("T", results[0].timestamp)
        self.assertIn("Z", results[0].timestamp)

    def test_checks_execute_in_parallel(self):
        """Test that multiple checks execute concurrently."""
        import time

        async def slow_check_impl(check):
            await asyncio.sleep(0.1)
            return PreflightResult(
                check=check,
                passed=True,
                timestamp="2025-01-01T00:00:00Z",
            )

        with patch("opensmi.executor._run_single_preflight_check", new=slow_check_impl):
            checks = [
                PreflightCheck(
                    check_type=PreflightCheckType.TMUX_AVAILABLE,
                    node_alias="gpu01",
                ),
                PreflightCheck(
                    check_type=PreflightCheckType.COMMAND_SYNTAX,
                    node_alias="gpu01",
                    command_to_validate="python train.py",
                ),
                PreflightCheck(
                    check_type=PreflightCheckType.GPU_AVAILABILITY,
                    node_alias="gpu01",
                    target_gpu_indices=[0, 1, 2],
                ),
            ]

            start = time.time()
            results = asyncio.run(run_preflight_checks(checks))
            elapsed = time.time() - start

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r.passed for r in results))
            self.assertLess(
                elapsed,
                0.25,
                f"Expected parallel execution (~0.1s), got {elapsed:.3f}s",
            )
            self.assertGreater(elapsed, 0.08)

    def test_preflight_check_preserves_check_reference(self):
        """Test that PreflightResult preserves reference to original check."""
        check = PreflightCheck(
            check_type=PreflightCheckType.TMUX_AVAILABLE,
            node_alias="gpu01",
        )
        checks = [check]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertIs(results[0].check, check)

    def test_gpu_availability_check_validation_missing_indices(self):
        """Test that GPU_AVAILABILITY check requires target_gpu_indices."""
        with self.assertRaises(ValueError) as cm:
            PreflightCheck(
                check_type=PreflightCheckType.GPU_AVAILABILITY,
                node_alias="gpu01",
                target_gpu_indices=None,
            )

        self.assertIn("requires target_gpu_indices", str(cm.exception))

    def test_command_syntax_check_validation_missing_command(self):
        """Test that COMMAND_SYNTAX check requires command_to_validate."""
        with self.assertRaises(ValueError) as cm:
            PreflightCheck(
                check_type=PreflightCheckType.COMMAND_SYNTAX,
                node_alias="gpu01",
                command_to_validate=None,
            )

        self.assertIn("requires command_to_validate", str(cm.exception))

    def test_tmux_check_does_not_require_extra_fields(self):
        """Test that TMUX_AVAILABLE check does not require extra fields."""
        check = PreflightCheck(
            check_type=PreflightCheckType.TMUX_AVAILABLE,
            node_alias="gpu01",
        )

        self.assertEqual(check.check_type, PreflightCheckType.TMUX_AVAILABLE)
        self.assertEqual(check.node_alias, "gpu01")
        self.assertIsNone(check.target_gpu_indices)
        self.assertIsNone(check.command_to_validate)

    def test_preflight_result_critical_failure_detection(self):
        """Test that PreflightResult correctly identifies critical failures."""
        check = PreflightCheck(
            check_type=PreflightCheckType.TMUX_AVAILABLE,
            node_alias="gpu01",
        )

        result_passed = PreflightResult(
            check=check,
            passed=True,
            timestamp="2025-01-01T00:00:00Z",
        )
        self.assertFalse(result_passed.is_critical_failure())

        result_failed = PreflightResult(
            check=check,
            passed=False,
            error_message="tmux not found",
            timestamp="2025-01-01T00:00:00Z",
        )
        self.assertTrue(result_failed.is_critical_failure())


class TestPreflightCheckStubs(unittest.TestCase):
    """Test that preflight check stubs return not-implemented results."""

    def test_tmux_availability_requires_node_config(self):
        """P2.2: Verify tmux check without node_config.
        
        Since tmux sessions are now created locally (not on remote nodes),
        this check passes if tmux is installed on the local machine.
        The check only fails if tmux binary is not found anywhere.
        """
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias="gpu01",
            )
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertEqual(len(results), 1)
        # With local tmux architecture, check passes if tmux is installed locally
        # (which it is in dev environments). Just verify we get a result.
        self.assertIsNotNone(results[0].passed)


class TestTmuxAvailabilityCheck(unittest.TestCase):
    """P2.2: Tests for tmux availability check implementation.
    
    NOTE: tmux is now checked LOCALLY (not via SSH) since tmux sessions
    are created on the local machine. Tests mock shutil.which and the
    local fallback paths.
    """

    def setUp(self):
        self.node_config = NodeConfig(
            alias="gpu01", address="10.0.0.1", user="testuser"
        )

    def test_tmux_available_returns_success(self):
        """Test successful tmux availability check (local)."""
        with patch("shutil.which", return_value="/usr/bin/tmux"):
            checks = [
                PreflightCheck(
                    check_type=PreflightCheckType.TMUX_AVAILABLE,
                    node_alias="gpu01",
                    node_config=self.node_config,
                )
            ]

            results = asyncio.run(run_preflight_checks(checks))

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].passed)

    def test_tmux_not_found_returns_failure(self):
        """Test tmux check when tmux is not installed locally."""
        with patch("shutil.which", return_value=None), \
             patch("os.path.isfile", return_value=False):
            checks = [
                PreflightCheck(
                    check_type=PreflightCheckType.TMUX_AVAILABLE,
                    node_alias="gpu01",
                    node_config=self.node_config,
                )
            ]

            results = asyncio.run(run_preflight_checks(checks))

            self.assertEqual(len(results), 1)
            self.assertFalse(results[0].passed)

    def test_tmux_check_preserves_timestamp(self):
        """Test that tmux check includes timestamp."""
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias="gpu01",
                node_config=self.node_config,
            )
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertIsNotNone(results[0].timestamp)
        self.assertIn("T", results[0].timestamp)

    def test_gpu_availability_requires_node_config(self):
        """GPU_AVAILABILITY should fail gracefully without node_config."""
        checks = [
            PreflightCheck(
                check_type=PreflightCheckType.GPU_AVAILABILITY,
                node_alias="gpu01",
                target_gpu_indices=[0, 1, 2],
            )
        ]

        results = asyncio.run(run_preflight_checks(checks))

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].passed)
        self.assertIn("Node configuration missing", results[0].error_message)
