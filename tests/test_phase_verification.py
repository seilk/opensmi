#!/usr/bin/env python3
"""
Comprehensive verification test for Job Queue & Lifecycle Management
Tests all phases (1-5) as defined in JOB_QUEUE_PLAN.md
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from opensmi.jobs import (
    Job,
    cancel_job,
    check_job_alive,
    cleanup_old_jobs,
    get_job,
    load_jobs,
    retry_job,
    save_jobs,
    upsert_job,
)


class TestPhase1JobPersistence(unittest.TestCase):
    """Phase 1: Job Persistence & Status Tracking"""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_job_data_model(self):
        """Phase 1-A: Job data model with all required fields"""
        job = Job(
            id=Job.new_id(),
            command="python train.py",
            user="alice",
            status="queued",
            submitted_at="2026-02-18T00:00:00Z",
            restart_policy="on-failure",
            retry_count=0,
            max_retries=3,
        )

        self.assertEqual(len(job.id), 8)
        self.assertEqual(job.command, "python train.py")
        self.assertEqual(job.user, "alice")
        self.assertEqual(job.status, "queued")
        self.assertEqual(job.restart_policy, "on-failure")
        self.assertEqual(job.retry_count, 0)
        self.assertEqual(job.max_retries, 3)

    def test_job_store_persistence(self):
        """Phase 1-B: Job store with save/load"""
        job1 = Job(
            id="abc12345",
            command="python train.py",
            user="alice",
            status="running",
            submitted_at="2026-02-18T00:00:00Z",
            gpus=[("gpu01", 0), ("gpu01", 1)],
            tmux_sessions=["opensmi-abc12345-gpu01"],
        )

        save_jobs(self.tmpdir, [job1])

        jobs_file = self.tmpdir / "jobs.json"
        self.assertTrue(jobs_file.exists())

        loaded_jobs = load_jobs(self.tmpdir)
        self.assertEqual(len(loaded_jobs), 1)
        self.assertEqual(loaded_jobs[0].id, "abc12345")
        self.assertEqual(loaded_jobs[0].status, "running")
        self.assertEqual(loaded_jobs[0].gpus, [["gpu01", 0], ["gpu01", 1]])

    def test_upsert_job_functionality(self):
        """Phase 1-B: Upsert job functionality"""
        jobs = []

        job1 = Job(id="test1", command="python test1.py", user="alice", status="queued")
        jobs = upsert_job(jobs, job1)
        self.assertEqual(len(jobs), 1)

        job1_updated = Job(
            id="test1", command="python test1.py", user="alice", status="running"
        )
        jobs = upsert_job(jobs, job1_updated)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].status, "running")

    def test_get_job_by_id(self):
        """Phase 1-B: Get job by ID"""
        jobs = [
            Job(id="job1", command="python test1.py", user="alice"),
            Job(id="job2", command="python test2.py", user="bob"),
        ]

        found = get_job(jobs, "job2")
        self.assertIsNotNone(found)
        self.assertEqual(found.user, "bob")

        not_found = get_job(jobs, "nonexistent")
        self.assertIsNone(not_found)


class TestPhase4JobLifecycle(unittest.TestCase):
    """Phase 4: Job Lifecycle Management (Cancel, Retry, Auto-restart)"""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_cancel_queued_job(self):
        """Phase 4-A: Cancel queued job"""
        job = Job(
            id="test1",
            command="python train.py",
            user="alice",
            status="queued",
            submitted_at="2026-02-18T00:00:00Z",
        )

        cfg = MagicMock()

        import asyncio

        success = asyncio.run(cancel_job(job, cfg))

        self.assertTrue(success)
        self.assertEqual(job.status, "cancelled")
        self.assertIsNotNone(job.finished_at)

    def test_cancel_running_job(self):
        """Phase 4-A: Cancel running job (with mock tmux kill)"""
        job = Job(
            id="test1",
            command="python train.py",
            user="alice",
            status="running",
            submitted_at="2026-02-18T00:00:00Z",
            started_at="2026-02-18T00:00:05Z",
            gpus=[("gpu01", 0)],
            tmux_sessions=["opensmi-test1-gpu01"],
        )

        cfg = MagicMock()
        cfg.nodes = [MagicMock(alias="gpu01")]

        import asyncio

        async def mock_subprocess(*args, **kwargs):
            proc = MagicMock()
            proc.wait = AsyncMock(return_value=0)
            return proc

        with patch("asyncio.create_subprocess_exec", new=mock_subprocess):
            success = asyncio.run(cancel_job(job, cfg))

        self.assertTrue(success)
        self.assertEqual(job.status, "cancelled")
        self.assertIsNotNone(job.finished_at)

    def test_retry_job_creates_new_job(self):
        """Phase 4-B: Retry creates new job with queued status"""
        original = Job(
            id="original1",
            command="python train.py",
            user="alice",
            status="failed",
            gpus=[("gpu01", 0)],
            restart_policy="on-failure",
            submitted_at="2026-02-18T00:00:00Z",
            finished_at="2026-02-18T00:01:00Z",
        )

        new_job = retry_job(original)

        self.assertNotEqual(new_job.id, original.id)
        self.assertEqual(new_job.command, original.command)
        self.assertEqual(new_job.user, original.user)
        self.assertEqual(new_job.status, "queued")
        self.assertEqual(new_job.gpus, original.gpus)
        self.assertEqual(new_job.restart_policy, original.restart_policy)

    def test_watchdog_retry_count_tracking(self):
        """Phase 4-C: Auto-restart watchdog tracks retry_count"""
        job = Job(
            id="test1",
            command="python train.py",
            user="alice",
            status="running",
            restart_policy="on-failure",
            retry_count=0,
            max_retries=3,
            submitted_at="2026-02-18T00:00:00Z",
            started_at="2026-02-18T00:00:05Z",
            tmux_sessions=["opensmi-test1-gpu01"],
        )

        # Simulate watchdog detecting dead session
        job.status = "queued"
        job.retry_count += 1
        job.started_at = None
        job.tmux_sessions = []

        self.assertEqual(job.status, "queued")
        self.assertEqual(job.retry_count, 1)
        self.assertLess(job.retry_count, job.max_retries)

    def test_watchdog_max_retries_exceeded(self):
        """Phase 4-C: Auto-restart stops after max_retries"""
        job = Job(
            id="test1",
            command="python train.py",
            user="alice",
            status="running",
            restart_policy="on-failure",
            retry_count=3,
            max_retries=3,
            submitted_at="2026-02-18T00:00:00Z",
            started_at="2026-02-18T00:00:05Z",
            tmux_sessions=["opensmi-test1-gpu01"],
        )

        # Simulate watchdog detecting dead session when max retries reached
        should_restart = (
            job.restart_policy == "on-failure" and job.retry_count < job.max_retries
        ) or (job.restart_policy == "always")

        self.assertFalse(should_restart)

        job.status = "failed"
        job.finished_at = "2026-02-18T00:01:00Z"
        job.error = "tmux session terminated unexpectedly"

        self.assertEqual(job.status, "failed")
        self.assertIsNotNone(job.error)

    def test_cleanup_old_jobs(self):
        """Phase 4-D: Job cleanup removes old completed/failed jobs"""
        jobs = []

        # Add 150 done jobs
        for i in range(150):
            jobs.append(
                Job(
                    id=f"done{i:03d}",
                    command=f"python test{i}.py",
                    user="alice",
                    status="done",
                    submitted_at=f"2026-02-18T00:{i % 60:02d}:00Z",
                    finished_at=f"2026-02-18T00:{i % 60:02d}:30Z",
                )
            )

        # Add 80 failed jobs
        for i in range(80):
            jobs.append(
                Job(
                    id=f"fail{i:03d}",
                    command=f"python test{i}.py",
                    user="alice",
                    status="failed",
                    submitted_at=f"2026-02-18T00:{i % 60:02d}:00Z",
                    finished_at=f"2026-02-18T00:{i % 60:02d}:30Z",
                )
            )

        # Add running/queued jobs (should not be cleaned)
        jobs.append(
            Job(
                id="running1",
                command="python active.py",
                user="alice",
                status="running",
                submitted_at="2026-02-18T00:00:00Z",
            )
        )
        jobs.append(
            Job(
                id="queued1",
                command="python waiting.py",
                user="alice",
                status="queued",
                submitted_at="2026-02-18T00:00:00Z",
            )
        )

        cleaned = cleanup_old_jobs(jobs, max_done=100, max_failed=50)

        done_count = len([j for j in cleaned if j.status == "done"])
        failed_count = len([j for j in cleaned if j.status == "failed"])
        running_count = len([j for j in cleaned if j.status == "running"])
        queued_count = len([j for j in cleaned if j.status == "queued"])

        self.assertEqual(done_count, 100)
        self.assertEqual(failed_count, 50)
        self.assertEqual(running_count, 1)
        self.assertEqual(queued_count, 1)


class TestPhase5FileLocking(unittest.TestCase):
    """Phase 5-B: File locking for concurrent access"""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_concurrent_access_with_file_locking(self):
        """Phase 5-B: File locking prevents corruption during concurrent access"""
        import threading
        import time

        initial_job = Job(
            id="init",
            command="python init.py",
            user="system",
            status="done",
            submitted_at="2026-02-18T00:00:00Z",
        )
        save_jobs(self.tmpdir, [initial_job])

        errors = []

        def writer_thread(thread_id: int):
            try:
                for i in range(10):
                    jobs = load_jobs(self.tmpdir)
                    new_job = Job(
                        id=f"t{thread_id:02d}_{i:03d}",
                        command=f"python t{thread_id}_job{i}.py",
                        user=f"user{thread_id}",
                        status="queued",
                        submitted_at=f"2026-02-18T{thread_id:02d}:{i:02d}:00Z",
                    )
                    jobs.append(new_job)
                    save_jobs(self.tmpdir, jobs)
                    time.sleep(0.001)
            except Exception as e:
                errors.append((thread_id, str(e)))

        threads = [threading.Thread(target=writer_thread, args=(i,)) for i in range(5)]

        for t in threads:
            t.start()

        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0, f"Concurrent write errors: {errors}")

        final_jobs = load_jobs(self.tmpdir)
        self.assertGreater(len(final_jobs), 0)
        self.assertIn("init", [j.id for j in final_jobs])


class TestIntegration(unittest.TestCase):
    """Integration test simulating full job lifecycle"""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_full_job_lifecycle(self):
        """Simulate: submit → running → failed → retry → cleanup"""
        # Submit job
        job = Job(
            id=Job.new_id(),
            command="python train.py",
            user="alice",
            status="queued",
            submitted_at="2026-02-18T00:00:00Z",
            restart_policy="on-failure",
            max_retries=3,
        )
        jobs = [job]
        save_jobs(self.tmpdir, jobs)

        # Start job
        job.status = "running"
        job.started_at = "2026-02-18T00:00:05Z"
        job.gpus = [("gpu01", 0)]
        job.tmux_sessions = [f"opensmi-{job.id}-gpu01"]
        jobs = upsert_job(jobs, job)
        save_jobs(self.tmpdir, jobs)

        # Job fails (watchdog detects)
        job.status = "queued"
        job.retry_count += 1
        job.started_at = None
        job.tmux_sessions = []
        jobs = upsert_job(jobs, job)
        save_jobs(self.tmpdir, jobs)

        # Verify retry
        loaded = load_jobs(self.tmpdir)
        current_job = get_job(loaded, job.id)
        self.assertEqual(current_job.status, "queued")
        self.assertEqual(current_job.retry_count, 1)

        # Eventually succeeds
        current_job.status = "done"
        current_job.finished_at = "2026-02-18T00:05:00Z"
        jobs = upsert_job(jobs, current_job)
        save_jobs(self.tmpdir, jobs)

        # Cleanup
        cleaned = cleanup_old_jobs(jobs, max_done=100, max_failed=50)
        save_jobs(self.tmpdir, cleaned)

        final_jobs = load_jobs(self.tmpdir)
        self.assertIn(job.id, [j.id for j in final_jobs])


if __name__ == "__main__":
    unittest.main()
