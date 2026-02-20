"""
Integration test for queued mode auto-dispatch functionality.

Tests the complete workflow:
1. Submit job in queued mode when GPUs are busy
2. Verify job stays in "queued" status
3. Free up GPU resources
4. Verify dispatcher auto-starts the job

This verifies QUEUE-J completion.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest

# Test requires actual GPU nodes configured in opensmi.json
pytestmark = [pytest.mark.integration, pytest.mark.skip(reason="Requires live GPU cluster")]


def run_cli_command(args: list[str]) -> tuple[int, str, str]:
    """Run opensmi CLI command and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        ["python3", "-m", "src.opensmi"] + args,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.returncode, result.stdout, result.stderr


def get_job_status(job_id: str) -> dict | None:
    """Get job status as dict from CLI JSON output."""
    rc, stdout, _ = run_cli_command(["job", "status", job_id, "--json"])
    if rc != 0:
        return None
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return None


def list_jobs(status_filter: str | None = None) -> list[dict]:
    """List all jobs, optionally filtered by status."""
    args = ["job", "list", "--json"]
    if status_filter:
        args.extend(["--status", status_filter])

    rc, stdout, _ = run_cli_command(args)
    if rc != 0:
        return []
    try:
        data = json.loads(stdout)
        return data.get("jobs", [])
    except json.JSONDecodeError:
        return []


def cleanup_test_jobs():
    """Delete all test jobs from the store."""
    jobs = list_jobs()
    for job in jobs:
        if job.get("command", "").startswith("echo 'TEST_QUEUE"):
            run_cli_command(["job", "delete", job["id"]])


@pytest.fixture(autouse=True)
def clean_jobs():
    """Clean up test jobs before and after each test."""
    cleanup_test_jobs()
    yield
    cleanup_test_jobs()


def test_queued_mode_autodispatch():
    """
    Test QUEUE-J: Submit job in queued mode, wait for GPU free, verify auto-start.

    This test simulates the complete queue workflow:
    1. Submit a short-lived "blocker" job to occupy GPUs
    2. Submit a queued job that should wait
    3. Wait for blocker to finish
    4. Verify queued job auto-starts via dispatcher
    """

    # Step 1: Submit a blocker job (immediate mode) to occupy GPUs
    # This job sleeps for 5 seconds then exits
    blocker_command = "echo 'TEST_QUEUE_BLOCKER: Starting' && sleep 5 && echo 'TEST_QUEUE_BLOCKER: Done'"

    rc, stdout, stderr = run_cli_command(
        [
            "job",
            "submit",
            "--command",
            blocker_command,
            "--auto-gpus",
            "1",
            "--tmux",
            "--json",
        ]
    )

    assert rc == 0, f"Blocker job submission failed: {stderr}"
    blocker_data = json.loads(stdout)
    blocker_id = blocker_data["job_id"]

    print(f"Blocker job {blocker_id} submitted")

    # Wait a moment for blocker to start
    time.sleep(2)

    # Verify blocker is running
    blocker_status = get_job_status(blocker_id)
    assert blocker_status is not None
    assert blocker_status["status"] == "running", (
        f"Blocker should be running but is {blocker_status['status']}"
    )

    # Step 2: Submit a queued job that requests 1 GPU
    queued_command = (
        "echo 'TEST_QUEUE_TARGET: Starting' && echo 'TEST_QUEUE_TARGET: Done'"
    )

    rc, stdout, stderr = run_cli_command(
        [
            "job",
            "submit",
            "--command",
            queued_command,
            "--auto-gpus",
            "1",
            "--queue",  # This is the key flag for queued mode
            "--tmux",
            "--json",
        ]
    )

    assert rc == 0, f"Queued job submission failed: {stderr}"
    queued_data = json.loads(stdout)
    queued_id = queued_data["job_id"]

    print(f"Queued job {queued_id} submitted")

    queued_status = get_job_status(queued_id)
    assert queued_status is not None, "Could not get queued job status"
    assert queued_status["status"] == "queued", (
        f"Job should be queued but is {queued_status['status']}"
    )
    assert queued_status["queue_mode"] == "queued"

    print(f"Queued job {queued_id} is in 'queued' status (correct)")

    # Step 4: Wait for blocker to finish (5 second sleep + margin)
    print("Waiting for blocker job to complete...")
    max_wait = 15  # seconds
    start_wait = time.time()

    while time.time() - start_wait < max_wait:
        blocker_status = get_job_status(blocker_id)
        if blocker_status and blocker_status["status"] in ("done", "failed"):
            print(
                f"Blocker job {blocker_id} finished with status: {blocker_status['status']}"
            )
            break
        time.sleep(1)
    else:
        pytest.fail("Blocker job did not finish within timeout")

    # Step 5: Wait for dispatcher to pick up and start the queued job
    # The dispatcher runs in pollCluster cycle, so we need to give it time
    print("Waiting for dispatcher to auto-start queued job...")
    max_dispatch_wait = 20  # seconds (poll interval + execution time)
    start_dispatch = time.time()

    dispatched = False
    while time.time() - start_dispatch < max_dispatch_wait:
        queued_status = get_job_status(queued_id)
        if queued_status and queued_status["status"] == "running":
            print(
                f"SUCCESS: Queued job {queued_id} was auto-dispatched and is now running!"
            )
            dispatched = True
            break
        time.sleep(2)  # Poll every 2 seconds

    assert dispatched, (
        f"Queued job {queued_id} was not auto-dispatched within {max_dispatch_wait}s. "
        f"Final status: {get_job_status(queued_id)}"
    )

    final_status = get_job_status(queued_id)
    assert final_status is not None, "Could not get final job status"
    assert final_status["gpus"], "Dispatched job should have GPUs assigned"
    assert final_status["started_at"], "Dispatched job should have started_at timestamp"

    print(f"Job {queued_id} assigned to GPUs: {final_status['gpus']}")
    print(f"Job {queued_id} started at: {final_status['started_at']}")

    # Cleanup
    run_cli_command(["job", "cancel", queued_id])
    run_cli_command(["job", "delete", blocker_id])
    run_cli_command(["job", "delete", queued_id])

    print("Test QUEUE-J: PASSED")


def test_queue_mode_immediate_vs_queued():
    """
    Test that immediate mode starts instantly while queued mode waits.
    """

    # Submit in immediate mode (should start immediately)
    immediate_cmd = "echo 'TEST_IMMEDIATE'"
    rc, stdout, _ = run_cli_command(
        [
            "job",
            "submit",
            "--command",
            immediate_cmd,
            "--auto-gpus",
            "1",
            "--tmux",
            "--json",
        ]
    )

    assert rc == 0
    immediate_data = json.loads(stdout)
    immediate_id = immediate_data["job_id"]

    time.sleep(1)
    immediate_status = get_job_status(immediate_id)
    assert immediate_status is not None, "Could not get immediate job status"
    assert immediate_status["status"] in ("running", "done"), (
        f"Immediate job should start right away, got: {immediate_status['status']}"
    )
    assert immediate_status["queue_mode"] == "immediate"

    # Submit in queued mode with high GPU count (should stay queued)
    queued_cmd = "echo 'TEST_QUEUED'"
    rc, stdout, _ = run_cli_command(
        [
            "job",
            "submit",
            "--command",
            queued_cmd,
            "--auto-gpus",
            "100",  # Unrealistic GPU count
            "--queue",
            "--tmux",
            "--json",
        ]
    )

    assert rc == 0
    queued_data = json.loads(stdout)
    queued_id = queued_data["job_id"]

    time.sleep(1)
    queued_status = get_job_status(queued_id)
    assert queued_status is not None, "Could not get queued job status"
    assert queued_status["status"] == "queued", (
        f"Queued job with impossible GPU count should stay queued, got: {queued_status['status']}"
    )
    assert queued_status["queue_mode"] == "queued"

    # Cleanup
    run_cli_command(["job", "cancel", immediate_id])
    run_cli_command(["job", "cancel", queued_id])
    run_cli_command(["job", "delete", immediate_id])
    run_cli_command(["job", "delete", queued_id])

    print("Test immediate vs queued mode: PASSED")


if __name__ == "__main__":
    # Allow running this test directly
    print("Running queue auto-dispatch integration test...")
    test_queued_mode_autodispatch()
    test_queue_mode_immediate_vs_queued()
    print("\nAll tests passed!")
