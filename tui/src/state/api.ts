/**
 * src/state/api.ts
 * CLI bridge and backend communication for the opensmi TUI.
 * Handles all interaction with the opensmi Python CLI and the filesystem state.
 *
 * Extracted from index.ts — DO NOT modify index.ts yet (Phase 3 handles that).
 */

import { spawn } from "bun";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ClusterSnapshot, Allocation, Job } from "../types";
import { S, OPERATOR } from "./global";

// ── Logger ─────────────────────────────────────────────────────────

export const LOG_DIR = path.join(
  process.env.OPENSMI_LOG_DIR ||
    path.join(process.env.HOME || "~", ".opensmi", "logs")
);
export const LOG_FILE = path.join(LOG_DIR, "tui.log");
export const LOG_LEVEL = (process.env.OPENSMI_LOG_LEVEL || "INFO").toUpperCase();
export const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };
export const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 1;
export const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

export function tuiLog(
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR",
  msg: string
): void {
  if ((LOG_LEVELS[level] ?? 1) < LOG_THRESHOLD) return;
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  const line = `${ts} [${level}] tui: ${msg}\n`;
  try {
    const stat = Bun.file(LOG_FILE);
    if (stat.size > LOG_MAX_SIZE) {
      Bun.write(LOG_FILE, line);
    } else {
      appendFileSync(LOG_FILE, line);
    }
  } catch {
    try {
      appendFileSync(LOG_FILE, line);
    } catch {}
  }
}

// ── CLI resolution ─────────────────────────────────────────────────

export const PYTHON = process.env.OPENSMI_PYTHON || "python3";

const DEFAULT_BASE_DIR = new URL("../..", import.meta.url).pathname;
const EXEC_DIR = path.dirname(process.execPath);

function _isRepoRoot(p: string): boolean {
  return (
    existsSync(`${p}/pyproject.toml`) &&
    existsSync(`${p}/src/opensmi/__init__.py`)
  );
}

const BASE_DIR_CANDIDATES = [
  process.env.OPENSMI_BASE_DIR,
  DEFAULT_BASE_DIR,
  path.resolve(EXEC_DIR, "..", ".."),
  process.cwd(),
].filter(Boolean) as string[];

export const BASE_DIR = BASE_DIR_CANDIDATES.find(_isRepoRoot) || "";

export function _resolveCliCommand(): { cmd: string[]; cwd: string | undefined } {
  const explicit = process.env.OPENSMI_CLI;
  if (explicit) return { cmd: [explicit], cwd: undefined };
  if (BASE_DIR) return { cmd: [PYTHON, "-m", "opensmi"], cwd: BASE_DIR };
  return { cmd: ["opensmi"], cwd: undefined };
}

const { cmd: OPENSMI, cwd: OPENSMI_CWD } = _resolveCliCommand();
export { OPENSMI, OPENSMI_CWD };

export function _spawnEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as any;
  if (BASE_DIR && OPENSMI[0] === PYTHON) {
    const add = `${BASE_DIR}/src`;
    const cur = env.PYTHONPATH || "";
    env.PYTHONPATH = cur ? `${add}:${cur}` : add;
  }
  return env;
}

export const OPENSMI_ENV = _spawnEnv();

// ── Core CLI runner ────────────────────────────────────────────────

export async function runOpensmi(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn([...OPENSMI, ...args], {
    cwd: OPENSMI_CWD,
    env: OPENSMI_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// ── State dir ─────────────────────────────────────────────────────

export function getStateDir(): string {
  const homedir = process.env.HOME || "~";
  return process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
}

// ── Admin status ──────────────────────────────────────────────────

export async function loadAdminStatus(): Promise<void> {
  try {
    const candidates = [
      process.env.OPENSMI_CONFIG,
      `${getStateDir()}/opensmi.json`,
    ].filter(Boolean) as string[];

    const cfgPath =
      candidates.find((p) => existsSync(p)) || candidates[0]!;
    const raw = await Bun.file(cfgPath).text();
    const data = JSON.parse(raw) as any;

    const admins = (data.admins || {}) as any;
    const master = String(admins.master || "").trim();
    const membersRaw = admins.members;
    const members = Array.isArray(membersRaw)
      ? (membersRaw as any[]).map((x) => String(x))
      : typeof membersRaw === "string"
        ? [String(membersRaw)]
        : [];

    S.isAdmin =
      (!!master && OPERATOR === master) || members.includes(OPERATOR);
    S.adminHint = S.isAdmin
      ? `Admin: ${OPERATOR}`
      : `Read-only (${OPERATOR} not in admins)`;
  } catch {
    S.isAdmin = false;
    S.adminHint = `Read-only (${OPERATOR}); opensmi.json missing`;
  }
}

// ── Cluster polling ───────────────────────────────────────────────

export async function pollCluster(): Promise<void> {
  if (S.isPolling) return;
  S.isPolling = true;
  S.pollError = "";
  tuiLog("DEBUG", "pollCluster start");

  try {
    const proc = spawn([...OPENSMI, "poll", "--json"], {
      cwd: OPENSMI_CWD,
      env: OPENSMI_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    if (code !== 0) {
      S.pollError = stderr.trim() || `exit ${code}`;
      return;
    }

    const prevSelectedAlias =
      S.snapshot?.nodes?.[S.selectedNodeIdx]?.node_alias;

    const next = JSON.parse(stdout) as ClusterSnapshot;
    next.nodes = [...next.nodes].sort((a, b) =>
      a.node_alias.localeCompare(b.node_alias, "en", {
        numeric: true,
        sensitivity: "base",
      })
    );

    S.snapshot = next;

    if (prevSelectedAlias) {
      const i = S.snapshot.nodes.findIndex(
        (n) => n.node_alias === prevSelectedAlias
      );
      if (i >= 0) S.selectedNodeIdx = i;
    }
    if (S.snapshot.nodes.length === 0) {
      S.selectedNodeIdx = 0;
    } else if (S.selectedNodeIdx >= S.snapshot.nodes.length) {
      S.selectedNodeIdx = S.snapshot.nodes.length - 1;
    }

    S.lastPollTime = new Date().toLocaleTimeString("en-GB", {
      hour12: false,
      timeZone: "Asia/Seoul",
    });
    // Update GPU idle tracking using the fresh snapshot
    if (S.snapshot) {
      const now = Date.now();
      for (const node of S.snapshot.nodes) {
        if (node.error) continue;
        for (const gpu of node.gpus) {
          const key = `${node.node_alias}:${gpu.uuid}`;
          const procs = node.processes.filter((p) => p.gpu_uuid === gpu.uuid);
          if (procs.length === 0) {
            if (!S.gpuIdleStart[key]) {
              S.gpuIdleStart[key] = now;
            }
          } else {
            delete S.gpuIdleStart[key];
          }
        }
      }
    }
    recomputeKnownUsers();
  } catch (e: any) {
    S.pollError = e.message || String(e);
  } finally {
    S.isPolling = false;
  }
}

// CANONICAL: do not duplicate in index.ts
export function recomputeKnownUsers(): void {
  const users = new Set<string>();

  for (const u of S.systemUsers) users.add(u);

  // Live users from snapshot
  if (S.snapshot) {
    for (const n of S.snapshot.nodes) {
      if (n.error) continue;
      for (const p of n.processes) {
        if (p.user && p.user !== "unknown") users.add(p.user);
      }
    }
  }

  // Alloc targets (except special tokens)
  for (const a of S.allocations) {
    const t = (a.target || "").trim();
    if (!t || t === "*" || t.toLowerCase() === "none") continue;
    users.add(t);
  }

  S.knownUsers = [...users].sort((a, b) => a.localeCompare(b));
}

export async function pollExtraCluster(idx: number): Promise<void> {
  S.extraPollErrors[idx] = "";
  try {
    const clusterIdx = idx + 1;
    const proc = spawn(
      [...OPENSMI, "poll", "--json", "--cluster-idx", String(clusterIdx)],
      {
        cwd: OPENSMI_CWD,
        env: OPENSMI_ENV,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    if (code !== 0) {
      S.extraPollErrors[idx] = stderr.trim() || `exit ${code}`;
      S.extraSnapshots[idx] = null;
      return;
    }

    const prevSelectedAlias =
      S.extraSnapshots[idx]?.nodes?.[S.extraSelectedNodeIdx[idx] || 0]
        ?.node_alias;
    const next = JSON.parse(stdout) as ClusterSnapshot;
    next.nodes = [...next.nodes].sort((a, b) =>
      a.node_alias.localeCompare(b.node_alias, "en", {
        numeric: true,
        sensitivity: "base",
      })
    );

    S.extraSnapshots[idx] = next;
    const selectedIdx = S.extraSelectedNodeIdx[idx] || 0;
    if (prevSelectedAlias) {
      const i = next.nodes.findIndex(
        (n) => n.node_alias === prevSelectedAlias
      );
      if (i >= 0) S.extraSelectedNodeIdx[idx] = i;
    }
    if (next.nodes.length === 0) {
      S.extraSelectedNodeIdx[idx] = 0;
    } else if (selectedIdx >= next.nodes.length) {
      S.extraSelectedNodeIdx[idx] = next.nodes.length - 1;
    }
  } catch (e: any) {
    S.extraPollErrors[idx] = e?.message || String(e);
    S.extraSnapshots[idx] = null;
  }
}

export async function pollAllClusters(): Promise<void> {
  await Promise.all([
    pollCluster(),
    ...S.extraClusterNames.map((_, i) => pollExtraCluster(i)),
  ]);
}

// ── Allocations ───────────────────────────────────────────────────

export async function loadAllocations(): Promise<void> {
  try {
    const homedir = process.env.HOME || "~";
    const stateDir =
      process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
    const allocPath = `${stateDir}/allocations.json`;
    try {
      const raw = await Bun.file(allocPath).text();
      const data = JSON.parse(raw);
      S.allocations = ((data.allocations || []) as Allocation[]).map(
        (a: Allocation) => {
          const t = String((a as any).target ?? "").trim();
          return {
            ...a,
            target: !t || t.toLowerCase() === "none" ? "*" : t,
          } as Allocation;
        }
      );
    } catch {
      S.allocations = [];
    }
  } catch {
    S.allocations = [];
  }
}

export async function allocSet(
  nodeAlias: string,
  gpuIdx: number,
  user: string
): Promise<void> {
  const by = process.env.USER || "admin";
  const normalized = (() => {
    const t = String(user ?? "").trim();
    if (!t || t.toLowerCase() === "none") return "*";
    return t;
  })();
  const { code, stderr } = await runOpensmi([
    "alloc",
    "set",
    nodeAlias,
    String(gpuIdx),
    normalized,
    "--by",
    by,
  ]);

  if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`);
}

export async function allocClear(
  nodeAlias: string,
  gpuIdx: number
): Promise<void> {
  const { code, stderr } = await runOpensmi([
    "alloc",
    "clear",
    nodeAlias,
    String(gpuIdx),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`);
}

// ── Kill ──────────────────────────────────────────────────────────

export async function killPids(
  nodeAlias: string,
  pids: number[],
  signal: "TERM" | "KILL" = "TERM"
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    "kill",
    nodeAlias,
    ...pids.map((p) => String(p)),
    "--signal",
    signal,
  ];
  return await runOpensmi(args);
}

// ── Cluster tabs ──────────────────────────────────────────────────

export async function loadClusterTabsFromConfig(): Promise<void> {
  try {
    const { code, stdout, stderr } = await runOpensmi([
      "clusters",
      "list",
      "--json",
    ]);
    if (code !== 0) {
      // setStatus is in format.ts — log the error only
      tuiLog("ERROR", `Failed to load clusters: ${stderr.trim() || `exit ${code}`}`);
      S.extraClusterNames = [];
      S.extraSnapshots = [];
      S.extraPollErrors = [];
      S.extraSelectedNodeIdx = [];
      S.activeClusterTabIdx = 0;
    } else {
      const clusters = JSON.parse(stdout) as Array<{
        cluster_name: string;
        node_count: number;
      }>;
      if (clusters.length > 1) {
        S.extraClusterNames = clusters
          .slice(1)
          .map((c) => String(c.cluster_name || "Cluster"));
        S.extraSnapshots = S.extraClusterNames.map(() => null);
        S.extraPollErrors = S.extraClusterNames.map(() => "");
        S.extraSelectedNodeIdx = S.extraClusterNames.map(() => 0);
      } else {
        S.extraClusterNames = [];
        S.extraSnapshots = [];
        S.extraPollErrors = [];
        S.extraSelectedNodeIdx = [];
        S.activeClusterTabIdx = 0;
      }
    }

    try {
      const slurm = await runOpensmi(["slurm", "--names-only"]);
      if (slurm.code === 0) {
        S.slurmClusterConfigNames = JSON.parse(slurm.stdout) as string[];
      }
    } catch {}
  } catch (e: any) {
    tuiLog("ERROR", `Failed to load clusters: ${e?.message || String(e)}`);
    S.extraClusterNames = [];
    S.extraSnapshots = [];
    S.extraPollErrors = [];
    S.extraSelectedNodeIdx = [];
    S.activeClusterTabIdx = 0;
  }
}

// ── Jobs ──────────────────────────────────────────────────────────

export async function loadJobsFromCLI(): Promise<void> {
  try {
    const proc = Bun.spawn([PYTHON, "-m", "opensmi", "job", "list", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      S.jobList = [];
      return;
    }

    const data = JSON.parse(output);
    S.jobList = (data.jobs || []) as Job[];
    S.jobsLastLoadTime = Date.now();
  } catch {
    S.jobList = [];
  }
}

export async function saveJobToStore(): Promise<void> {
  try {
    const jobData: Partial<Job> = {
      command: S.launchDistMode === "single" ? S.launchCommand : "",
      commands:
        S.launchDistMode === "one-to-one"
          ? S.launchCommands.filter((c) => c.trim())
          : [],
      gpus: S.launchSelectedGpus.map(
        (g) => [g.node, g.gpu] as [string, number]
      ),
      requested_gpu_count: S.launchNumGpus,
      dist_mode: S.launchDistMode,
      exec_mode: S.launchMode,
      queue_mode: S.launchQueueMode,
      user: OPERATOR,
    };

    const tmpFile = `/tmp/opensmi-job-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(jobData));

    const submitScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import Job, load_jobs, save_jobs, upsert_job
from opensmi.state import get_state_dir
from datetime import datetime, timezone

with open("${tmpFile}", "r") as f:
    job_data = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)

job = Job(
    id=Job.new_id(),
    command=job_data["command"],
    commands=job_data["commands"],
    gpus=[tuple(g) for g in job_data["gpus"]],
    requested_gpu_count=job_data["requested_gpu_count"],
    dist_mode=job_data["dist_mode"],
    exec_mode=job_data["exec_mode"],
    status="queued",
    submitted_at=datetime.now(timezone.utc).isoformat(),
    user=job_data["user"],
    restart_policy="never",
    queue_mode=job_data["queue_mode"],
)

jobs = upsert_job(jobs, job)
save_jobs(state_dir, jobs)

print(json.dumps({"job_id": job.id, "status": job.status}))
`;

    const submitProc = Bun.spawn([PYTHON, "-c", submitScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const stdout = await new Response(submitProc.stdout).text();
    const stderr = await new Response(submitProc.stderr).text();
    await submitProc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    if (submitProc.exitCode !== 0) {
      tuiLog("ERROR", `Failed to save job: ${stderr}`);
      S.runnerState = "failed";
      return;
    }

    let result: any;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      tuiLog("ERROR", "Failed to parse job submission response");
      S.runnerState = "failed";
      return;
    }

    S.runnerState = "running";
    S.statusMsg = `Job ${result.job_id} queued successfully`;
    S.launchOutput = `Job queued: ${result.job_id}\nStatus: ${result.status}\nGPUs: ${S.launchNumGpus}\nMode: ${S.launchDistMode} / ${S.launchMode}`;

    await loadJobsFromCLI();
  } catch (e: any) {
    tuiLog("ERROR", `Failed to queue job: ${e?.message || String(e)}`);
    S.runnerState = "failed";
  }
}

export async function updateJobInStore(job: Job): Promise<void> {
  const tmpFile = `/tmp/opensmi-job-update-${crypto.randomUUID()}.json`;
  await Bun.write(tmpFile, JSON.stringify(job));

  const updateScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import Job, load_jobs, save_jobs, upsert_job
from opensmi.jobs import cleanup_tmux_artifacts_for_sessions
from opensmi.state import get_state_dir

with open("${tmpFile}", "r") as f:
    job_data = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)
existing = next((j for j in jobs if j.id == job_data["id"]), None)
previous_sessions = list(getattr(existing, "tmux_sessions", []) or [])

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

new_sessions = set(job.tmux_sessions)
removed_sessions = [s for s in previous_sessions if s not in new_sessions]
if removed_sessions:
    cleanup_tmux_artifacts_for_sessions(removed_sessions)

if job.status in ("done", "failed", "cancelled") and job.tmux_sessions:
    cleanup_tmux_artifacts_for_sessions(job.tmux_sessions)
    job.tmux_sessions = []

jobs = upsert_job(jobs, job)
save_jobs(state_dir, jobs)
print("OK")
`;

  const proc = Bun.spawn([PYTHON, "-c", updateScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: OPENSMI_ENV,
    cwd: OPENSMI_CWD,
  });

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  try {
    await Bun.$`rm -f ${tmpFile}`;
  } catch {}

  if (proc.exitCode !== 0) {
    throw new Error(`Failed to update job in store: ${stderr}`);
  }
}

// ── Update notification ───────────────────────────────────────────

export function parseSemver(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isRemoteNewer(current: string, latest: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

export async function maybeShowUpdateNotification(): Promise<void> {
  try {
    const v = await runOpensmi(["--version"]);
    if (v.code !== 0) return;
    const currentMatch = v.stdout.match(/\d+\.\d+\.\d+/);
    if (!currentMatch) return;
    const current = currentMatch[0];

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1800);
    const resp = await fetch(
      "https://api.github.com/repos/seilk/opensmi/releases/latest",
      {
        headers: { accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      }
    );
    clearTimeout(timeout);
    if (!resp.ok) return;
    const data = (await resp.json()) as any;
    const latestRaw = String(data?.tag_name || "");
    const latest = latestRaw.replace(/^v/, "");
    if (!latest) return;

    if (isRemoteNewer(current, latest)) {
      S.latestVersion = latest;
      S.statusMsg = `Update available: v${latest}  → run: opensmi update`;
      S.statusUntil = Date.now() + 3000;
      S.requestRender?.();
    }
  } catch {
    // quiet fail (offline/firewall/etc.)
  }
}
