import json
import tempfile
import unittest
from pathlib import Path

from opensmi.jobs import (
    Job,
    get_job,
    load_jobs,
    retry_job,
    save_jobs,
    upsert_job,
)


class TestJobModel(unittest.TestCase):
    def test_job_new_id_generates_8_char_id(self):
        job_id = Job.new_id()
        self.assertEqual(len(job_id), 8)
        self.assertTrue(all(c in "0123456789abcdef" for c in job_id))

    def test_job_defaults(self):
        job = Job(id="test1234", command="python train.py", user="alice")
        self.assertEqual(job.id, "test1234")
        self.assertEqual(job.command, "python train.py")
        self.assertEqual(job.user, "alice")
        self.assertEqual(job.status, "queued")
        self.assertEqual(job.dist_mode, "single")
        self.assertEqual(job.exec_mode, "tmux")
        self.assertEqual(job.restart_policy, "never")
        self.assertEqual(job.queue_mode, "immediate")
        self.assertEqual(job.retry_count, 0)
        self.assertEqual(job.max_retries, 3)
        self.assertEqual(len(job.commands), 0)
        self.assertEqual(len(job.gpus), 0)
        self.assertEqual(len(job.tmux_sessions), 0)


class TestJobStore(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_load_jobs_empty_file(self):
        jobs = load_jobs(self.tmpdir)
        self.assertEqual(len(jobs), 0)

    def test_save_and_load_jobs(self):
        job1 = Job(
            id="abc12345",
            command="python train.py",
            user="alice",
            status="queued",
            submitted_at="2026-02-18T00:00:00Z",
        )
        job2 = Job(
            id="def67890",
            command="python eval.py",
            user="bob",
            status="running",
            submitted_at="2026-02-18T00:01:00Z",
            gpus=[("gpu01", 0), ("gpu01", 1)],
        )

        save_jobs(self.tmpdir, [job1, job2])

        loaded = load_jobs(self.tmpdir)
        self.assertEqual(len(loaded), 2)

        j1 = next((j for j in loaded if j.id == "abc12345"), None)
        self.assertIsNotNone(j1)
        self.assertEqual(j1.command, "python train.py")
        self.assertEqual(j1.user, "alice")
        self.assertEqual(j1.status, "queued")

        j2 = next((j for j in loaded if j.id == "def67890"), None)
        self.assertIsNotNone(j2)
        self.assertEqual(j2.command, "python eval.py")
        self.assertEqual(j2.user, "bob")
        self.assertEqual(j2.status, "running")
        self.assertEqual(j2.gpus, [["gpu01", 0], ["gpu01", 1]])

    def test_upsert_job_insert(self):
        jobs = []
        job = Job(id="test1234", command="python test.py", user="alice")
        jobs = upsert_job(jobs, job)

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].id, "test1234")

    def test_upsert_job_update(self):
        job1 = Job(
            id="test1234", command="python test.py", user="alice", status="queued"
        )
        jobs = [job1]

        job2 = Job(
            id="test1234",
            command="python test.py",
            user="alice",
            status="running",
            started_at="2026-02-18T00:00:00Z",
        )
        jobs = upsert_job(jobs, job2)

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].status, "running")
        self.assertEqual(jobs[0].started_at, "2026-02-18T00:00:00Z")

    def test_get_job_found(self):
        job1 = Job(id="abc12345", command="python test1.py", user="alice")
        job2 = Job(id="def67890", command="python test2.py", user="bob")
        jobs = [job1, job2]

        found = get_job(jobs, "def67890")
        self.assertIsNotNone(found)
        self.assertEqual(found.command, "python test2.py")

    def test_get_job_not_found(self):
        job1 = Job(id="abc12345", command="python test1.py", user="alice")
        jobs = [job1]

        found = get_job(jobs, "notfound")
        self.assertIsNone(found)

    def test_load_jobs_corrupted_json(self):
        jobs_file = self.tmpdir / "jobs.json"
        jobs_file.write_text("{ invalid json }", encoding="utf-8")

        jobs = load_jobs(self.tmpdir)
        self.assertEqual(len(jobs), 0)

    def test_save_jobs_creates_state_dir(self):
        nested = self.tmpdir / "nested" / "state"
        job = Job(id="test1234", command="python test.py", user="alice")

        save_jobs(nested, [job])

        self.assertTrue(nested.exists())
        self.assertTrue((nested / "jobs.json").exists())


class TestJobRetry(unittest.TestCase):
    def test_retry_job_creates_new_job(self):
        original = Job(
            id="original1",
            command="python train.py",
            user="alice",
            status="failed",
            gpus=[("gpu01", 0)],
            dist_mode="single",
            exec_mode="tmux",
            restart_policy="on-failure",
            tags=["experiment-1"],
        )

        retried = retry_job(original)

        self.assertNotEqual(retried.id, original.id)
        self.assertEqual(retried.command, original.command)
        self.assertEqual(retried.user, original.user)
        self.assertEqual(retried.status, "queued")
        self.assertEqual(retried.gpus, original.gpus)
        self.assertEqual(retried.dist_mode, original.dist_mode)
        self.assertEqual(retried.exec_mode, original.exec_mode)
        self.assertEqual(retried.restart_policy, original.restart_policy)
        self.assertEqual(retried.tags, original.tags)
        self.assertIsNotNone(retried.submitted_at)

    def test_retry_job_preserves_commands_list(self):
        original = Job(
            id="original1",
            command="",
            commands=["python train.py --fold 0", "python train.py --fold 1"],
            user="alice",
            status="failed",
        )

        retried = retry_job(original)

        self.assertEqual(retried.commands, original.commands)


if __name__ == "__main__":
    unittest.main()
