/**
 * src/views/Jobs.ts
 * Jobs view, job execution pipeline, and job action functions for the opensmi TUI.
 *
 * Extracted from index.ts — DO NOT modify index.ts.
 */

import { Box, Text, t, bold, fg } from "@opentui/core";
import { existsSync } from "node:fs";
import { S, OPERATOR } from "../state/global";
import type { Job } from "../types";
import {
  runOpensmi,
  loadJobsFromCLI,
  updateJobInStore,
  PYTHON,
  OPENSMI_ENV,
  OPENSMI_CWD,
  BASE_DIR,
  tuiLog,
  getStateDir,
} from "../state/api";
import { setStatus, tmuxSafeName } from "../utils/format";
import { C } from "../theme";
import { flushSetupChangesToConfig } from "./Setup";

// ── Module-level caches / constants ──────────────────────────────

// Per-GPU liveness cache: jobId → { "node:gpu": alive }
const gpuLivenessCache: Map<string, Record<string, boolean>> = new Map();
// Consecutive "all dead" counter per job - only act after threshold
const watchdogDeadCount: Map<string, number> = new Map();
const WATCHDOG_DEAD_THRESHOLD = 3;  // Must see "all dead" 3 times in a row before acting
const WATCHDOG_GRACE_MS = 20_000;   // 20s grace after job start

// ── Private helpers ───────────────────────────────────────────────

async function executeRemoteExec(params: {
  node: string;
  gpusCsv: string;
  mode: "direct" | "tmux";
  command: string;
  session?: string;
}): Promise<{ ok: boolean; preflight: any[]; result: any | null; rawStdout: string; rawStderr: string; code: number }> {
  const args: string[] = [
    "exec",
    params.node,
    "--gpus",
    params.gpusCsv,
    "--mode",
    params.mode,
    "--command",
    params.command,
    "--skip-preflight",
    "--json",
  ];
  if (params.mode === "tmux") {
    if (params.session) {
      args.push("--session", params.session);
    }
  }

  tuiLog("DEBUG", `executeRemoteExec: opensmi ${args.join(" ")}`);
  const { code, stdout, stderr } = await runOpensmi(args);

  let payload: any = null;
  try {
    payload = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    payload = null;
  }

  const ok = !!payload?.ok;
  if (!ok) {
    tuiLog("ERROR", `executeRemoteExec failed: code=${code} stderr=${stderr.slice(0, 300)} stdout=${stdout.slice(0, 300)}`);
    const preflight = Array.isArray(payload?.preflight) ? payload.preflight : [];
    for (const pf of preflight) {
      if (!pf.passed) {
        tuiLog("ERROR", `  preflight FAIL: ${pf.check_type} on ${pf.node_alias}: ${pf.error_message}`);
      }
    }
  }

  return {
    ok,
    preflight: Array.isArray(payload?.preflight) ? payload.preflight : [],
    result: payload?.result ?? null,
    rawStdout: stdout,
    rawStderr: stderr,
    code,
  };
}

// ── Job helper formatters ─────────────────────────────────────────

export function getJobStatusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case "queued":
      return { icon: "○", color: C.textDim };
    case "running":
      return { icon: "●", color: C.green };
    case "done":
      return { icon: "✓", color: C.cyan };
    case "failed":
      return { icon: "✗", color: C.red };
    case "cancelled":
      return { icon: "⊘", color: C.textDim };
    default:
      return { icon: "?", color: C.textDim };
  }
}

export function formatJobTimestamp(isoString: string | null): string {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  } catch {
    return "-";
  }
}

export function formatJobDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const durationMs = end - start;
  const durationS = Math.floor(durationMs / 1000);

  if (durationS < 60) return `${durationS}s`;
  const minutes = Math.floor(durationS / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins}m`;
}

export function formatJobGpus(job: Job): string {
  if (job.gpus.length === 0) {
    if (job.requested_gpu_count > 0) {
      return `(auto×${job.requested_gpu_count})`;
    }
    return "-";
  }

  return job.gpus.map(([node, gpu]) => `${node}:${gpu}`).join(",");
}

// ── tmux helpers ──────────────────────────────────────────────────

export async function captureTmuxPane(sessionName: string, lines = 500): Promise<string> {
  try {
    const tmuxBin = existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux"
      : existsSync("/usr/local/bin/tmux") ? "/usr/local/bin/tmux" : "tmux";
    const proc = Bun.spawn([tmuxBin, "capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return `(tmux session '${sessionName}' not accessible)`;
    return stdout;
  } catch (e: any) {
    return `(error: ${e?.message || String(e)})`;
  }
}

export async function killTmuxSessions(sessions: string[]): Promise<void> {
  for (const s of sessions) {
    try {
      await Bun.$`tmux kill-session -t ${s} 2>/dev/null || true`;
    } catch {}
  }
}

// ── GPU finder ────────────────────────────────────────────────────

export async function findAvailableGpus(count: number): Promise<Array<{ node: string; gpu: number }>> {
  /**
   * Find available idle GPUs using the existing rank_gpus logic.
   *
   * "Available" means:
   *   - No active processes on the GPU
   *   - GPU utilization is 0%
   *   - Not already reserved by another queued job
   */
  if (!S.snapshot || count <= 0) {
    return [];
  }

  try {
    const tmpFile = `/tmp/opensmi-snap-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(S.snapshot));

    const allocFile = `/tmp/opensmi-alloc-${crypto.randomUUID()}.json`;
    await Bun.write(allocFile, JSON.stringify(S.allocations));

    const operatorFile2 = `/tmp/opensmi-op-${crypto.randomUUID()}.json`;
    await Bun.write(operatorFile2, JSON.stringify({ operator: OPERATOR }));

    // Build set of GPUs already assigned to queued jobs (to avoid double-booking)
    const queuedJobs = S.jobList.filter(j => j.status === "queued");
    const reservedGpuKeys = new Set<string>();
    for (const job of queuedJobs) {
      for (const [node, gpu_idx] of job.gpus) {
        reservedGpuKeys.add(`${node}:${gpu_idx}`);
      }
    }
    const reservedGpusJson = JSON.stringify(Array.from(reservedGpuKeys));

    const findScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.gpu_ranker import rank_gpus
from opensmi.launch_history import load_history
from opensmi.state import get_state_dir

with open("${tmpFile}", "r") as f:
    snap_data = json.loads(f.read())

class SimpleGPU:
    def __init__(self, d):
        self.index = d['index']
        self.uuid = d['uuid']
        self.name = d['name']
        self.memory_total_mib = d.get('memory_total_mib')
        self.memory_used_mib = d.get('memory_used_mib')
        self.memory_free_mib = d.get('memory_free_mib')
        self.utilization_gpu_percent = d.get('utilization_gpu_percent')
        self.temperature_c = d.get('temperature_c')
        self.power_draw_w = d.get('power_draw_w')

class SimpleProc:
    def __init__(self, d):
        self.gpu_uuid = d['gpu_uuid']
        self.pid = d['pid']
        self.process_name = d['process_name']
        self.used_memory_mib = d.get('used_memory_mib')
        self.user = d.get('user', 'unknown')
        self.runtime_s = d.get('runtime_s')

class SimpleNode:
    def __init__(self, d):
        self.node_alias = d['node_alias']
        self.address = d['address']
        self.hostname = d.get('hostname')
        self.os = d.get('os')
        self.timestamp = d.get('timestamp')
        self.gpus = [SimpleGPU(g) for g in d.get('gpus', [])]
        self.processes = [SimpleProc(p) for p in d.get('processes', [])]
        self.error = d.get('error')

class SimpleSnap:
    def __init__(self, d):
        self.cluster_name = d['cluster_name']
        self.timestamp = d['timestamp']
        self.nodes = [SimpleNode(n) for n in d['nodes']]

snap = SimpleSnap(snap_data)
state_dir = get_state_dir()
history = load_history(state_dir)

with open("${allocFile}", "r") as f:
    alloc_data = json.loads(f.read())

with open("${operatorFile2}", "r") as f:
    current_user = json.loads(f.read())["operator"]
reserved = set(${reservedGpusJson})

# Rank all GPUs
ranked = rank_gpus(snap, history, alloc_data, current_user)

# Filter for idle GPUs not reserved by queued jobs
available = []
for node_alias, gpu_idx, gpu_info in ranked:
    gpu_key = f"{node_alias}:{gpu_idx}"
    if gpu_key in reserved:
        continue

    # Check if GPU is idle (no processes, 0% utilization)
    node = next((n for n in snap.nodes if n.node_alias == node_alias), None)
    if not node:
        continue

    gpu_uuid = gpu_info.uuid
    has_processes = any(p.gpu_uuid == gpu_uuid for p in node.processes)
    utilization = gpu_info.utilization_gpu_percent or 0

    if not has_processes and utilization == 0:
        available.append({"node": node_alias, "gpu": gpu_idx})
        if len(available) >= ${count}:
            break

print(json.dumps(available))
`;

    const proc = Bun.spawn([PYTHON, "-c", findScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Cleanup temp files
    try {
      await Bun.$`rm -f ${tmpFile} ${allocFile} ${operatorFile2}`;
    } catch {}

    if (exitCode !== 0) {
      tuiLog("ERROR", `findAvailableGpus failed: ${stderr}`);
      return [];
    }

    return JSON.parse(stdout.trim());
  } catch (e) {
    tuiLog("ERROR", `findAvailableGpus error: ${e}`);
    return [];
  }
}

// ── Job dispatch pipeline ─────────────────────────────────────────

export async function dispatchQueuedJobs(): Promise<void> {
  if (!S.snapshot || S.isDispatching) {
    return;
  }
  S.isDispatching = true;
  try {
    // Hotfix: always persist latest setup before dispatching jobs.
    await flushSetupChangesToConfig();
    await _dispatchQueuedJobsInner();
  } catch (e: any) {
    const msg = e?.message || String(e);
    tuiLog("ERROR", `dispatch precheck failed: ${msg}`);
    setStatus(`✗ Setup save failed: ${msg.slice(0, 80)}`, 4000);
  } finally {
    S.isDispatching = false;
  }
}

async function _dispatchQueuedJobsInner(): Promise<void> {
  // Get queued jobs in FIFO order (sorted by submission time)
  const queuedJobs = S.jobList
    .filter(j => j.status === "queued")
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));

  if (queuedJobs.length === 0) {
    return;
  }

  for (let i = 0; i < queuedJobs.length; i++) {
    const job = queuedJobs[i];
    const hasExplicitGpus = job.gpus.length > 0;
    const needed = job.requested_gpu_count || job.gpus.length;

    if (needed === 0) {
      continue;
    }

    const origGpus = job.gpus.slice();
    try {
      if (!hasExplicitGpus) {
        const available = await findAvailableGpus(needed);

        if (available.length < needed) {
          if (i === 0) {
            const cmdPreview = job.command || (job.commands.length > 0 ? job.commands[0] : "");
            setStatus(`Queue: Job ${job.id} waiting for ${needed} GPU(s) - ${cmdPreview.slice(0, 30)}...`, 2000);
          }
          continue;
        }

        job.gpus = available.slice(0, needed).map(g => [g.node, g.gpu] as [string, number]);
      }

      const gpuList = job.gpus
        .map(([n, g]) => `${n}:${g}`)
        .join(", ");

      job.status = "running";
      job.started_at = new Date().toISOString();

      const cmdPreview = job.command || (job.commands.length > 0 ? job.commands[0] : "");
      setStatus(`Auto-dispatching job ${job.id} → [${gpuList}]`, 2000);

      await executeJobRemote(job);
      await updateJobInStore(job);
      await loadJobsFromCLI();

      setStatus(`✓ Auto-dispatched job ${job.id}: ${cmdPreview.slice(0, 40)}...`, 3000);

      S.requestRender?.();

    } catch (e: any) {
      tuiLog("ERROR", `dispatch failed job=${job.id}: ${e?.message || String(e)}`);

      job.gpus = origGpus;
      job.status = "failed";
      job.finished_at = new Date().toISOString();
      job.error = `Dispatch failed: ${e?.message || String(e)}`;

      const errorMsg = e?.message || String(e);
      const cmdPreview = job.command || (job.commands.length > 0 ? job.commands[0] : "");
      setStatus(`✗ Auto-dispatch failed for job ${job.id}: ${errorMsg.slice(0, 40)}`, 4000);

      try {
        await updateJobInStore(job);
        await loadJobsFromCLI();
      } catch (updateErr) {
        tuiLog("ERROR", `job store update failed job=${job.id}: ${updateErr}`);
      }

      S.requestRender?.();
    }
  }
}

// ── GPU liveness watchdog ─────────────────────────────────────────

export async function checkGpuLiveness(job: Job): Promise<Record<string, boolean> | null> {
  const tmpFile = `/tmp/opensmi-check-${crypto.randomUUID()}.json`;
  await Bun.write(tmpFile, JSON.stringify(job));

  const checkScript = `
import sys, json, os
# Try multiple paths for opensmi module
for p in [os.path.join("${BASE_DIR}", "src") if "${BASE_DIR}" else "", os.path.expanduser("~/opensmi-dev/src")]:
    if p and os.path.isdir(p):
        sys.path.insert(0, p)
        break
from opensmi.jobs import Job, check_gpu_liveness
from opensmi.config import load_config
from opensmi.state import resolve_config_path, get_state_dir
import asyncio

with open("${tmpFile}", "r") as f:
    job_data = json.load(f)

job = Job(
    id=job_data["id"],
    command=job_data["command"],
    commands=job_data["commands"],
    gpus=[tuple(g) for g in job_data["gpus"]],
    requested_gpu_count=job_data["requested_gpu_count"],
    dist_mode=job_data["dist_mode"],
    exec_mode=job_data["exec_mode"],
    tmux_sessions=job_data["tmux_sessions"],
    status=job_data["status"],
    submitted_at=job_data["submitted_at"],
    started_at=job_data.get("started_at"),
    finished_at=job_data.get("finished_at"),
    exit_codes=job_data["exit_codes"],
    error=job_data.get("error"),
    user=job_data["user"],
    restart_policy=job_data["restart_policy"],
    retry_count=job_data["retry_count"],
    max_retries=job_data["max_retries"],
    tags=job_data["tags"],
    queue_mode=job_data["queue_mode"],
)

cfg_path = resolve_config_path(state_dir=get_state_dir())
cfg = load_config(cfg_path)

async def main():
    result = await check_gpu_liveness(job, cfg)
    print(json.dumps(result))

asyncio.run(main())
`;

  try {
    const proc = Bun.spawn([PYTHON, "-c", checkScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    if (code !== 0) {
      tuiLog("WARNING", `checkGpuLiveness: python exited ${code} for job=${job.id}: ${stderr.slice(0, 500)}`);
      return null;
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      tuiLog("WARNING", `checkGpuLiveness: empty stdout for job=${job.id}`);
      return null;
    }

    const parsed = JSON.parse(trimmed);
    gpuLivenessCache.set(job.id, parsed);
    return parsed;
  } catch (e) {
    tuiLog("ERROR", `checkGpuLiveness failed job=${job.id}: ${(e as any)?.message || String(e)}`);
    return null;
  }
}

export async function watchRunningJobs(): Promise<void> {
  const runningJobs = S.jobList.filter(j => j.status === "running");

  if (runningJobs.length === 0) {
    return;
  }

  for (const job of runningJobs) {
    try {
      // Grace period: skip health check for first 20s after job started.
      if (job.started_at) {
        const elapsed = Date.now() - new Date(job.started_at).getTime();
        if (elapsed < WATCHDOG_GRACE_MS) {
          continue;
        }
      }

      const liveness = await checkGpuLiveness(job);

      if (liveness === null) {
        tuiLog("DEBUG", `watchdog: job=${job.id} liveness check returned null (error/timeout), skipping`);
        continue;
      }

      if (Object.keys(liveness).length === 0) {
        tuiLog("DEBUG", `watchdog: job=${job.id} empty liveness result, skipping`);
        continue;
      }

      const anyAlive = Object.values(liveness).some(v => v);
      const aliveCount = Object.values(liveness).filter(v => v).length;
      const totalCount = Object.keys(liveness).length;

      if (anyAlive) {
        watchdogDeadCount.delete(job.id);

        if (aliveCount < totalCount) {
          tuiLog("WARNING", `watchdog: job=${job.id} partial: ${aliveCount}/${totalCount} GPUs alive`);
        }
        continue;
      }

      const deadCount = (watchdogDeadCount.get(job.id) || 0) + 1;
      watchdogDeadCount.set(job.id, deadCount);

      const gpuSummary = Object.entries(liveness).map(([k, v]) => `${k}:${v ? "✓" : "✗"}`).join(" ");
      tuiLog("WARNING", `watchdog: job=${job.id} all dead (${deadCount}/${WATCHDOG_DEAD_THRESHOLD}) [${gpuSummary}]`);

      if (deadCount < WATCHDOG_DEAD_THRESHOLD) {
        continue;
      }

      const cmdPreview = job.command || (job.commands.length > 0 ? job.commands[0] : "");
      tuiLog("ERROR", `watchdog: job=${job.id} CONFIRMED dead after ${deadCount} checks. cmd=${cmdPreview.slice(0, 80)}`);
      watchdogDeadCount.delete(job.id);

      const shouldRestart =
        (job.restart_policy === "on-failure" && job.retry_count < job.max_retries) ||
        (job.restart_policy === "always");

      if (shouldRestart) {
        job.status = "queued";
        job.retry_count++;
        job.started_at = null;
        job.tmux_sessions = [];

        const retryInfo = job.restart_policy === "always"
          ? `(retry ${job.retry_count})`
          : `(retry ${job.retry_count}/${job.max_retries})`;

        tuiLog("INFO", `watchdog: re-queuing job=${job.id} ${retryInfo}`);
        setStatus(`Job ${job.id} died, re-queuing ${retryInfo}`, 3000);
      } else {
        job.status = "failed";
        job.finished_at = new Date().toISOString();
        job.error = `All GPU processes terminated after ${WATCHDOG_DEAD_THRESHOLD} consecutive checks`;

        tuiLog("ERROR", `watchdog: job=${job.id} failed - confirmed dead (policy=${job.restart_policy} retries=${job.retry_count}/${job.max_retries})`);
        setStatus(`Job ${job.id} failed: GPU processes terminated`, 3000);
      }

      gpuLivenessCache.delete(job.id);

      await updateJobInStore(job);
      await loadJobsFromCLI();
      S.requestRender?.();
    } catch (e: any) {
      tuiLog("ERROR", `watchdog failed job=${job.id}: ${e?.message || String(e)}`);
    }
  }
}

export async function cleanupOldJobs(): Promise<void> {
  const cleanupScript = `
import sys
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import load_jobs, save_jobs, cleanup_old_jobs
from opensmi.state import get_state_dir

state_dir = get_state_dir()
jobs = load_jobs(state_dir)
cleaned_jobs = cleanup_old_jobs(jobs, max_done=100, max_failed=50)
if len(cleaned_jobs) != len(jobs):
    save_jobs(state_dir, cleaned_jobs)
    print(f"Cleaned up {len(jobs) - len(cleaned_jobs)} old jobs")
else:
    print("No cleanup needed")
`;

  try {
    const proc = Bun.spawn([PYTHON, "-c", cleanupScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    await proc.exited;
  } catch (e: any) {
    tuiLog("ERROR", `cleanup failed: ${e}`);
  }
}

// ── Job execution ─────────────────────────────────────────────────

export async function executeJobRemote(job: Job): Promise<void> {
  const tmuxSessions: string[] = [];

  try {
    if (job.dist_mode === "single") {
      const nodesByGpu = new Map<string, number[]>();

      for (const [node, gpu] of job.gpus) {
        if (!nodesByGpu.has(node)) {
          nodesByGpu.set(node, []);
        }
        nodesByGpu.get(node)!.push(gpu);
      }

      for (const [node, gpus] of Array.from(nodesByGpu.entries())) {
        const gpusCsv = gpus.join(",");
        const sessionName = job.exec_mode === "tmux"
          ? `opensmi-${job.id}-${tmuxSafeName(node)}`
          : undefined;

        const payload = await executeRemoteExec({
          node,
          gpusCsv,
          mode: job.exec_mode,
          command: job.command,
          session: sessionName,
        });

        if (!payload.ok) {
          throw new Error(`Failed to execute on ${node}: ${payload.rawStderr.trim()}`);
        }

        if (sessionName) {
          tmuxSessions.push(sessionName);
        }
      }
    } else {
      for (let i = 0; i < job.commands.length; i++) {
        const cmd = job.commands[i];
        const [node, gpu] = job.gpus[i];

        if (!cmd || !node || gpu === undefined) {
          continue;
        }

        const gpuIndex = String(gpu);
        const sessionName = job.exec_mode === "tmux"
          ? `opensmi-${job.id}-${tmuxSafeName(node)}-gpu${gpu}`
          : undefined;

        const payload = await executeRemoteExec({
          node,
          gpusCsv: gpuIndex,
          mode: job.exec_mode,
          command: cmd,
          session: sessionName,
        });

        if (!payload.ok) {
          throw new Error(`Failed to execute on ${node}:GPU${gpu}: ${payload.rawStderr.trim()}`);
        }

        if (sessionName) {
          tmuxSessions.push(sessionName);
        }
      }
    }
  } catch (err) {
    // On partial failure, kill any already-launched sessions to prevent orphaned GPU usage
    if (tmuxSessions.length > 0) {
      await killTmuxSessions(tmuxSessions);
    }
    throw err;
  }

  job.tmux_sessions = tmuxSessions;
}

// ── Job action functions ──────────────────────────────────────────

export async function cancelJobAction(job: Job): Promise<void> {
  try {
    setStatus(`Cancelling job ${job.id}...`);
    const proc = Bun.spawn([PYTHON, "-m", "opensmi", "job", "cancel", job.id], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    await proc.exited;

    if (proc.exitCode === 0) {
      tuiLog("INFO", `cancelJobAction: job=${job.id} cancelled`);
      setStatus(`Job ${job.id} cancelled`, 2000);
      await loadJobsFromCLI();
      S.jobDetailView = null;
      S.requestRender?.();
    } else {
      const stderr = await new Response(proc.stderr).text();
      tuiLog("ERROR", `cancelJobAction failed: ${stderr.trim()}`);
      setStatus(`Failed to cancel job: ${stderr.trim().slice(0, 50)}`, 3000);
    }
  } catch (e: any) {
    tuiLog("ERROR", `cancelJobAction error: ${e?.message || String(e)}`);
    setStatus(`Error cancelling job: ${e?.message || String(e)}`, 3000);
  }
}

export async function retryJobAction(job: Job): Promise<void> {
  try {
    setStatus(`Retrying job ${job.id}...`);
    const proc = Bun.spawn([PYTHON, "-m", "opensmi", "job", "retry", job.id], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode === 0) {
      const match = output.match(/retried as ([a-f0-9]+)/) || output.match(/New job ID: ([a-f0-9]+)/);
      const newId = match ? match[1] : "created";
      tuiLog("INFO", `retryJobAction: old=${job.id} new=${newId}`);
      setStatus(`Job retried → ${newId}, dispatching...`, 2000);
      await loadJobsFromCLI();
      S.jobDetailView = null;

      // Hotfix: persist setup edits before retry dispatch.
      await flushSetupChangesToConfig();

      // Immediately dispatch the new queued job instead of waiting 15s
      await dispatchQueuedJobs();
      await loadJobsFromCLI();
      S.requestRender?.();
    } else {
      const stderr = await new Response(proc.stderr).text();
      tuiLog("ERROR", `retryJobAction failed: ${stderr.trim()}`);
      setStatus(`Failed to retry job: ${stderr.trim().slice(0, 50)}`, 3000);
    }
  } catch (e: any) {
    tuiLog("ERROR", `retryJobAction error: ${e?.message || String(e)}`);
    setStatus(`Error retrying job: ${e?.message || String(e)}`, 3000);
  }
}

export async function retrySelectedSessionAction(job: Job, selectedIdx: number): Promise<void> {
  try {
    const [node, gpu] = job.gpus[selectedIdx] || [];
    if (!node || gpu === undefined) {
      setStatus("Cannot retry: selected session has no GPU mapping", 3000);
      return;
    }

    const command = job.dist_mode === "one-to-one"
      ? (job.commands[selectedIdx] || "")
      : (job.command || "");

    if (!command.trim()) {
      setStatus("Cannot retry: selected session command is empty", 3000);
      return;
    }

    setStatus(`Retrying selected session ${node}:GPU${gpu}...`, 2000);

    const payload = {
      node,
      gpu,
      command,
      exec_mode: job.exec_mode,
      user: OPERATOR,
      restart_policy: job.restart_policy || "never",
    };

    const tmpFile = `/tmp/opensmi-retry-session-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(payload));

    const submitScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import Job, load_jobs, save_jobs, upsert_job
from opensmi.state import get_state_dir
from datetime import datetime, timezone

with open("${tmpFile}", "r") as f:
    d = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)

job = Job(
    id=Job.new_id(),
    command=d["command"],
    commands=[],
    gpus=[(d["node"], int(d["gpu"]))],
    requested_gpu_count=0,
    dist_mode="single",
    exec_mode=d["exec_mode"],
    status="queued",
    submitted_at=datetime.now(timezone.utc).isoformat(),
    user=d["user"],
    restart_policy=d["restart_policy"],
    queue_mode="queued",
)

jobs = upsert_job(jobs, job)
save_jobs(state_dir, jobs)
print(job.id)
`;

    const proc = Bun.spawn([PYTHON, "-c", submitScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    if (proc.exitCode !== 0) {
      throw new Error(stderr.trim() || "Failed to create retry job");
    }

    const newId = stdout.trim() || "created";
    tuiLog("INFO", `retrySelectedSessionAction: old=${job.id} idx=${selectedIdx} new=${newId} target=${node}:GPU${gpu}`);
    setStatus(`Session retried → ${newId}, dispatching...`, 2500);

    await loadJobsFromCLI();

    // Ensure setup edits are persisted before dispatch.
    await flushSetupChangesToConfig();

    await dispatchQueuedJobs();
    await loadJobsFromCLI();
    S.requestRender?.();
  } catch (e: any) {
    tuiLog("ERROR", `retrySelectedSessionAction error: ${e?.message || String(e)}`);
    setStatus(`Error retrying session: ${e?.message || String(e)}`, 3500);
  }
}

export async function cleanupTmuxSessionsAction(job: Job): Promise<void> {
  try {
    const sessions = (job.tmux_sessions || []).filter(Boolean);
    if (sessions.length === 0) {
      setStatus("No tmux sessions to clean", 2000);
      return;
    }

    if (job.status === "running") {
      setStatus("Refusing cleanup for running job (cancel first)", 3000);
      return;
    }

    setStatus(`Cleaning ${sessions.length} tmux session(s)...`, 2000);
    await killTmuxSessions(sessions);

    job.tmux_sessions = [];
    await updateJobInStore(job);
    await loadJobsFromCLI();

    if (S.jobDetailView && S.jobDetailView.id === job.id) {
      const fresh = S.jobList.find((j) => j.id === job.id) || null;
      S.jobDetailView = fresh;
      S.jobDetailSelectedCmd = 0;
    }

    setStatus(`✓ Cleaned ${sessions.length} tmux session(s)`, 2500);
    S.requestRender?.();
  } catch (e: any) {
    tuiLog("ERROR", `cleanupTmuxSessionsAction error: ${e?.message || String(e)}`);
    setStatus(`Failed to clean tmux sessions: ${e?.message || String(e)}`, 3500);
  }
}

export async function deleteJobAction(job: Job): Promise<void> {
  try {
    setStatus(`Deleting job ${job.id}...`);
    const proc = Bun.spawn([PYTHON, "-m", "opensmi", "job", "delete", job.id], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    await proc.exited;

    if (proc.exitCode === 0) {
      setStatus(`Job ${job.id} deleted`, 2000);
      await loadJobsFromCLI();
      if (S.selectedJobIdx >= S.jobList.length) {
        S.selectedJobIdx = Math.max(0, S.jobList.length - 1);
      }
      S.jobDetailView = null;
    } else {
      const stderr = await new Response(proc.stderr).text();
      setStatus(`Failed to delete job: ${stderr.trim().slice(0, 50)}`, 3000);
    }
  } catch (e: any) {
    setStatus(`Error deleting job: ${e?.message || String(e)}`, 3000);
  }
}

// ── Render functions ──────────────────────────────────────────────

export function renderJobsView() {
  if (S.jobDetailView) {
    return renderJobDetailView();
  }
  return renderJobsListView();
}

export function renderJobsListView() {
  const header = Box(
    {
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: C.bgAlt,
    },
    Text({
      content: t`${bold(fg(C.blue)("Jobs"))}`,
    }),
    Text({
      content: t`Total: ${S.jobList.length}  ${S.isPolling ? fg(C.yellow)("⟳") : ""}`,
      fg: C.text,
    })
  );

  if (S.jobList.length === 0) {
    return Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
      header,
      Text({ content: "" }),
      Text({ content: "" }),
      Text({ content: "  No jobs yet.", fg: C.textDim }),
      Text({ content: "" }),
      Text({ content: "  How to submit:", fg: C.cyan }),
      Text({ content: "    ctrl+x ↓      Focus runner pane, type command, ctrl+x Enter to run", fg: C.textDim }),
      Text({ content: "    CLI           opensmi job submit <node> --gpus 0 --command \"...\"", fg: C.textDim }),
      Text({ content: "    CLI (queue)   opensmi job submit --auto-gpus 2 --command \"...\" --queue", fg: C.textDim }),
      Text({ content: "" }),
      Text({ content: "  Jobs submitted from any source appear here with live status tracking.", fg: C.textDim }),
      Text({ content: "" }),
      Text({ content: t`  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[Esc]")} Back to dashboard`, fg: C.textDim })
    );
  }

  const termWidth = process.stdout.columns || 80;
  const rows: any[] = [];
  rows.push(
    Text({
      content: t`${fg(C.cyan)("  ID        Status      GPUs              Command           Runtime")}`,
      fg: C.cyan,
    })
  );

  // Dynamic column: command gets remaining space after fixed columns
  const cmdWidth = Math.max(termWidth - 56, 10);

  for (let i = 0; i < S.jobList.length; i++) {
    const job = S.jobList[i];
    const selected = i === S.selectedJobIdx;
    const statusInfo = getJobStatusIcon(job.status);

    const commandDisplay = job.dist_mode === "single"
      ? job.command.slice(0, cmdWidth)
      : `[${job.commands.length} cmds]`;

    const gpuDisplay = formatJobGpus(job).slice(0, 17).padEnd(17);
    const runtime = formatJobDuration(job.started_at, job.status === "running" ? null : job.finished_at);

    const prefix = selected ? "▶ " : "  ";
    const idDisplay = job.id.padEnd(8);
    const statusDisplay = `${statusInfo.icon} ${job.status}`.padEnd(11);

    const line = `${prefix}${idDisplay} ${statusDisplay} ${gpuDisplay} ${commandDisplay.padEnd(cmdWidth)} ${runtime}`;

    rows.push(
      Text({
        content: line,
        fg: selected ? C.yellow : statusInfo.color,
      })
    );
  }

  rows.push(Text({ content: "" }));

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
    header,
    Text({ content: "" }),
    ...rows
  );
}

export function renderJobDetailView() {
  if (!S.jobDetailView) return renderJobsListView();

  // Log view mode: show captured tmux pane output
  if (S.jobDetailLogView !== null) {
    const logLines = S.jobDetailLogView.split("\n");
    const termHeight = process.stdout.rows || 40;
    const termWidth = process.stdout.columns || 80;
    const visibleLines = termHeight - 4;
    const maxScroll = Math.max(0, logLines.length - visibleLines);
    S.jobDetailLogScroll = Math.min(S.jobDetailLogScroll, maxScroll);

    const displayLines = logLines.slice(S.jobDetailLogScroll, S.jobDetailLogScroll + visibleLines);

    const rows: any[] = [];
    rows.push(Text({
      content: t`${bold(fg(C.blue)("Log"))} - ${S.jobDetailLogSession}  ${fg(C.textDim)(`(${S.jobDetailLogScroll + 1}-${S.jobDetailLogScroll + displayLines.length}/${logLines.length} lines)`)}`,
    }));
    rows.push(Text({ content: t`${fg(C.textDim)("─".repeat(Math.max(termWidth - 2, 20)))}` }));

    for (const line of displayLines) {
      rows.push(Text({ content: line, fg: C.text }));
    }

    rows.push(Text({ content: t`${fg(C.textDim)("─".repeat(Math.max(termWidth - 2, 20)))}` }));
    rows.push(Text({
      content: t`${fg(C.textDim)("[↑↓]")} Scroll  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[Esc]")} Back to detail`,
      fg: C.textDim,
    }));

    return Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, paddingLeft: 1, paddingRight: 1 },
      ...rows
    );
  }

  const job = S.jobDetailView;
  const statusInfo = getJobStatusIcon(job.status);
  const liveness = gpuLivenessCache.get(job.id) || {};
  const termWidth = process.stdout.columns || 80;
  const contentWidth = Math.max(termWidth - 6, 30);

  // Build list of sessions for navigation
  const sessionEntries: Array<{ label: string; session: string | null; color: string }> = [];

  if (job.dist_mode === "single") {
    for (let i = 0; i < job.gpus.length; i++) {
      const [node, gpu] = job.gpus[i];
      const key = `${node}:${gpu}`;
      const alive = liveness[key];
      const session = job.tmux_sessions[i] || null;
      let color: string;
      if (job.status !== "running") {
        color = job.status === "done" ? C.green : job.status === "failed" ? C.red : C.textDim;
      } else {
        color = alive === true ? C.green : alive === false ? C.red : C.yellow;
      }
      sessionEntries.push({ label: `${node}:GPU${gpu}`, session, color });
    }
  } else {
    for (let i = 0; i < job.commands.length; i++) {
      const [node, gpu] = job.gpus[i] || ["?", i];
      const key = `${node}:${gpu}`;
      const alive = liveness[key];
      const session = job.tmux_sessions[i] || null;
      let color: string;
      if (job.status !== "running") {
        color = job.status === "done" ? C.green : job.status === "failed" ? C.red : C.textDim;
      } else {
        color = alive === true ? C.green : alive === false ? C.red : C.yellow;
      }
      const cmdPreview = job.commands[i]?.slice(0, Math.max(contentWidth - 30, 20)) || "";
      sessionEntries.push({ label: `${node}:GPU${gpu} → ${cmdPreview}`, session, color });
    }
  }

  // Clamp selection
  if (sessionEntries.length > 0) {
    S.jobDetailSelectedCmd = Math.min(S.jobDetailSelectedCmd, sessionEntries.length - 1);
  }

  const rows: any[] = [];
  rows.push(
    Text({ content: t`${bold(fg(C.blue)(`Job ${job.id}`))} - ${job.command.slice(0, contentWidth - 16)}` })
  );
  rows.push(Text({ content: "" }));
  rows.push(Text({ content: t`Status:    ${fg(statusInfo.color)(statusInfo.icon + " " + job.status)}` }));
  rows.push(Text({ content: t`User:      ${fg(C.cyan)(job.user)}` }));

  if (job.started_at) {
    const runtime = formatJobDuration(job.started_at, job.status === "running" ? null : job.finished_at);
    rows.push(Text({ content: t`Runtime:   ${fg(job.status === "running" ? C.green : C.text)(runtime)}` }));
  }

  rows.push(Text({ content: t`Mode:      ${job.exec_mode} / ${job.dist_mode}  Queue: ${job.queue_mode}` }));
  rows.push(Text({ content: t`Restart:   ${job.restart_policy}${job.retry_count > 0 ? ` (${job.retry_count}/${job.max_retries})` : ""}` }));

  // GPU/Command list with selection cursor
  if (sessionEntries.length > 0) {
    rows.push(Text({ content: "" }));
    const liveCount = Object.values(liveness).filter(v => v).length;
    const totalCount = Object.keys(liveness).length;
    const livenessStr = totalCount > 0 ? ` (${liveCount}/${totalCount} active)` : "";
    rows.push(Text({ content: t`${fg(C.cyan)("Sessions:")}${livenessStr}` }));

    for (let i = 0; i < sessionEntries.length; i++) {
      const entry = sessionEntries[i];
      const selected = i === S.jobDetailSelectedCmd;
      const prefix = selected ? "▸ " : "  ";
      const statusDot = entry.session ? "●" : "○";
      const entryColor = selected ? C.yellow : entry.color;
      const hasLog = entry.session ? "" : fg(C.textDim)(" (no session)");
      rows.push(Text({ content: t`${fg(entryColor)(`${prefix}${statusDot} ${entry.label}`)}${hasLog}` }));
    }
  }

  // Command display
  if (job.dist_mode === "single" && job.command) {
    rows.push(Text({ content: "" }));
    rows.push(Text({ content: t`${fg(C.cyan)("Command:")}` }));
    rows.push(Text({ content: `  ${job.command}`, fg: C.textDim }));
  }

  // Timestamps
  rows.push(Text({ content: "" }));
  rows.push(Text({ content: t`Submitted: ${job.submitted_at}` }));
  if (job.started_at) rows.push(Text({ content: t`Started:   ${job.started_at}` }));
  if (job.finished_at) rows.push(Text({ content: t`Finished:  ${job.finished_at}` }));

  if (job.error) {
    rows.push(Text({ content: "" }));
    rows.push(Text({ content: t`${fg(C.red)("Error:")} ${job.error}`, fg: C.red }));
  }

  rows.push(Text({ content: "" }));
  rows.push(
    Text({
      content: t`${fg(C.textDim)("[↑↓]")} Select  ${fg(C.textDim)("[Enter]")} View log  ${fg(C.textDim)("[c]")} Cancel  ${fg(C.textDim)("[r]")} Retry selected  ${fg(C.textDim)("[Shift+r]")} Retry all  ${fg(C.textDim)("[x]")} Clean tmux  ${fg(C.textDim)("[Esc]")} Back`,
      fg: C.textDim,
    })
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
    ...rows
  );
}
