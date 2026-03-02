/**
 * src/components/Runner.ts
 * Command Runner pane and GPU Assignment panel for the opensmi TUI.
 *
 * Extracted from index.ts (Phase 2D).
 * Contains: renderRunnerPane, launch/execution functions,
 * GPU selection helpers, and the runner top-row layout helper.
 *
 * NOTE: flushSetupChangesToConfig is injected as a replaceable hook (Phase 3 will wire it).
 */

import { Box, Text, Input } from "@opentui/core";
import { spawn } from "bun";
import { S, OPERATOR } from "../state/global";
import type { GPUInfo, NodeSnapshot, Job } from "../types";
import {
  runOpensmi,
  BASE_DIR,
  PYTHON,
  OPENSMI_ENV,
  OPENSMI_CWD,
  loadJobsFromCLI,
  saveJobToStore,
  tuiLog,
} from "../state/api";
import { setStatus, tmuxSafeName } from "../utils/format";

// ── Color theme ────────────────────────────────────────────────────
// Copied from index.ts; exported so future modules can import from here.

export const C = {
  bg: "#1a1b26",
  bgAlt: "#24283b",
  border: "#565f89",
  text: "#c0caf5",
  textDim: "#565f89",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
};

// ── Dependency injection hook ──────────────────────────────────────
// Phase 3 will replace this with the real setup-flushing logic.
// The no-op default is safe: setup edits may not persist before dispatch,
// but the runner won't crash.

export let flushSetupChangesToConfig: () => Promise<void> = async () => {};

/** Call this from index.ts (Phase 3) to wire up the real flush. */
export function setFlushSetupHook(fn: () => Promise<void>): void {
  flushSetupChangesToConfig = fn;
}

// ── Layout helper ──────────────────────────────────────────────────

export function runnerPaneTopRow(): number {
  const termRows = process.stdout.rows || 40;
  const paneRows = S.runnerPaneFolded
    ? 3
    : Math.max(3, Math.floor(termRows * 0.4));
  return Math.max(0, termRows - paneRows);
}

// ── Launch error helper ────────────────────────────────────────────

export function setLaunchError(msg: string): void {
  tuiLog("ERROR", `launch error: ${msg}`);
  S.launchErrorMsg = msg;
  if (S.launchErrorTimeout) clearTimeout(S.launchErrorTimeout);
  S.launchErrorTimeout = setTimeout(() => {
    S.launchErrorMsg = "";
    S.requestRender?.();
  }, 1000);
}

// ── GPU label helpers ──────────────────────────────────────────────

export function getGpuCommandPlaceholder(gpu: { node: string; gpu: number } | undefined): string {
  if (!gpu) return "";
  return ""; // Empty string for storage, display handled in render
}

export function getGpuLabel(gpu: { node: string; gpu: number }): string {
  return `${gpu.node}:GPU${gpu.gpu}`;
}

// ── GPU auto-selection ─────────────────────────────────────────────

export async function refreshLaunchGpuSelection(): Promise<void> {
  if (!S.snapshot) {
    S.launchSelectedGpus = [];
    return;
  }

  // In "selected" mode, use manually selected GPUs
  if (S.launchGpuMode === "selected") {
    S.launchSelectedGpus = S.launchManualGpus.slice(0, S.launchNumGpus);
    return;
  }

  // In "auto" mode, rank and select GPUs automatically
  try {
    const tmpFile = `/tmp/opensmi-snap-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(S.snapshot));

    const allocFile = `/tmp/opensmi-alloc-${crypto.randomUUID()}.json`;
    await Bun.write(allocFile, JSON.stringify(S.allocations));

    const operatorFile = `/tmp/opensmi-op-${crypto.randomUUID()}.json`;
    await Bun.write(operatorFile, JSON.stringify({ operator: OPERATOR }));

    const excludedJson = JSON.stringify(S.launchExcludedGpus);
    const numGpus = S.launchNumGpus;

    const rankScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.gpu_ranker import select_top_gpus
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

with open("${operatorFile}", "r") as f:
    current_user = json.loads(f.read())["operator"]

excluded_nodes = set([g["node"] + ":" + str(g["gpu"]) for g in json.loads('${excludedJson}')])
all_ranked_gpus = select_top_gpus(snap, 9999, history, alloc_data, current_user)
gpus = []
for n, g in all_ranked_gpus:
    if n + ":" + str(g) not in excluded_nodes:
        gpus.append((n, g))
        if len(gpus) >= ${numGpus}:
            break
print(json.dumps([{"node": n, "gpu": g} for n, g in gpus]))
`;

    const rankProc = Bun.spawn([PYTHON, "-c", rankScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    const rankStdout = await new Response(rankProc.stdout).text();
    const rankCode = await rankProc.exited;

    if (rankCode === 0) {
      S.launchSelectedGpus = JSON.parse(rankStdout);
    } else {
      S.launchSelectedGpus = [];
    }

    try {
      await Bun.$`rm -f ${tmpFile} ${allocFile} ${operatorFile}`;
    } catch {}
  } catch {
    S.launchSelectedGpus = [];
  }
}


// ── Runner Pane ────────────────────────────────────────────────────

export function renderRunnerPane() {
  // Use a slightly larger percentage or Flex trick to accommodate more GPUs
  const height = S.runnerPaneFolded ? 3 : (S.launchNumGpus > 3 ? "60%" : "40%");

  const foldIcon = S.runnerPaneFolded ? "▸" : "▾";
  const focusIndicator = S.runnerFocused
    ? (S.runnerInputTyping ? "⌨ typing" : "● focused")
    : "○ idle";

  const headerText = Text({
    content: `${foldIcon} Command Runner  ${focusIndicator}`,
    fg: S.runnerInputTyping ? "#9b59d6" : (S.runnerFocused ? C.green : C.cyan)
  });

  const helpText = Text({
    content: S.runnerInputTyping
      ? "[Enter] Execute  [Esc] Cancel"
      : (S.runnerFocused
          ? "[Enter] Edit  [ctrl+x Enter] Execute  [Esc] Unfocus  [Tab/+/-/Q] Options"
          : "[click/ctrl+x ↓] Focus  [ctrl+x f] Fold"),
    fg: C.textDim
  });

  const headerBox = Box(
    {
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: C.bgAlt,
      onMouseDown: (e: any) => {
        e?.stopPropagation?.();
        if (S.runnerInputTyping) return; // Don't toggle while typing
        if (S.runnerFocused) {
          S.runnerFocused = false;
          S.runnerInputTyping = false;
        } else {
          S.runnerFocused = true;
          S.runnerFocusedInputIdx = 0;
          S.runnerInputBuffer = S.launchCommand;
        }
        S.requestRender?.();
      },
    },
    headerText,
    helpText
  );

  if (S.runnerPaneFolded) {
    return Box(
      {
        position: "absolute",
        bottom: 0,
        left: 0,
        width: "100%",
        height: height,
        borderStyle: "rounded",
        borderColor: C.border,
        backgroundColor: C.bgAlt,
        zIndex: 1000,
        onMouseDown: () => {
          S.runnerPaneFolded = false;
          S.requestRender?.();
        },
      },
      headerBox
    );
  }

  const gpuInfo = S.launchSelectedGpus.length > 0
    ? S.launchSelectedGpus.map(g => `${g.node}:${g.gpu}`).join(", ")
    : "none";

  // statusLine contains mode + GPU info (replaces the undefined modeInfo/gpuText in index.ts)
  const statusLine = Box(
    { flexDirection: "row", paddingBottom: 1 },
    Text({ content: `Mode: `, fg: C.textDim }),
    Text({ content: `${S.launchMode} `, fg: C.cyan }),
    Text({ content: `| Dist: `, fg: C.textDim }),
    Text({ content: `${S.launchDistMode} `, fg: C.cyan }),
    Text({ content: `| Queue: `, fg: C.textDim }),
    Text({ content: `${S.launchQueueMode} `, fg: C.cyan }),
    Text({ content: `| GPUs (${S.launchNumGpus}): `, fg: C.textDim }),
    Text({ content: gpuInfo, fg: S.runnerInputTyping ? "#9b59d6" : (S.launchSelectedGpus.length > 0 ? C.green : C.yellow) })
  );

  const errorText = S.launchErrorMsg
    ? Text({ content: `Error: ${S.launchErrorMsg}`, fg: C.red })
    : null;

  const commandNodes: any[] = [];

  // Show hint if no GPUs selected
  if (S.launchSelectedGpus.length === 0) {
    commandNodes.push(Text({ content: " ", fg: C.textDim }));
    commandNodes.push(Text({
      content: "No GPUs selected. Press [+] or click GPU cells to add.",
      fg: C.yellow
    }));
  } else if (S.launchDistMode === "single") {
    commandNodes.push(Text({ content: "Command:", fg: C.textDim }));

    const isCmdFocused = S.runnerFocused && S.runnerFocusedInputIdx === 0;

    if (S.runnerInputTyping && isCmdFocused) {
      commandNodes.push(Input({
        id: "runner-cmd-input",
        width: "100%",
        value: S.runnerInputBuffer,
        placeholder: "type command and press Enter...",
        backgroundColor: C.bgAlt,
        focusedBackgroundColor: "#3b4261",
        textColor: "#ffffff",
        cursorColor: C.green,
      }));
    } else {
      commandNodes.push(
        Box(
          { width: "100%", height: 1, position: "relative" },
          Text({
            content: `> ${S.launchCommand || "(click to edit)"}`,
            fg: (S.runnerInputTyping && isCmdFocused) ? "#9b59d6" : (isCmdFocused ? C.green : C.textDim),
          }),
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1, // Low zIndex to allow text selection
            onMouseDown: (e: any) => {
              e?.stopPropagation?.();
              S.runnerMouseDownTime = Date.now();
              S.runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
            },
            onMouseUp: (e: any) => {
              e?.stopPropagation?.();
              const elapsed = Date.now() - S.runnerMouseDownTime;
              const moved = S.runnerMouseDownPos && (
                Math.abs((e?.clientX ?? 0) - S.runnerMouseDownPos.x) > 5 ||
                Math.abs((e?.clientY ?? 0) - S.runnerMouseDownPos.y) > 5
              );

              if (moved || elapsed > 300) {
                return; // Was a drag, don't trigger click
              }

              if (!S.runnerFocused) {
                S.runnerFocused = true;
                S.runnerInputBuffer = S.launchCommand;
                S.runnerFocusedInputIdx = 0;
              } else if (S.runnerFocusedInputIdx === 0 && !S.runnerInputTyping) {
                // Second click on same line → typing mode
                S.runnerInputTyping = true;
                S.runnerInputBuffer = S.launchCommand;
              }
              S.requestRender?.();
            },
          })
        )
      );
    }
  } else {
    // one-to-one mode
    commandNodes.push(Text({
      content: `Commands (${S.launchNumGpus} lines, one per GPU):`,
      fg: C.textDim
    }));

    if (S.runnerFocused && S.runnerInputTyping) {
      for (let i = 0; i < S.launchNumGpus; i++) {
        const value = S.launchCommands[i] || "";
        const gpu = S.launchSelectedGpus[i];
        const label = gpu ? `${gpu.node}:GPU${gpu.gpu}` : `GPU ${i}`;
        commandNodes.push(Input({
          id: `runner-cmd-input-${i}`,
          value,
          width: "100%",
          backgroundColor: C.bgAlt,
          focusedBackgroundColor: "#3b4261",
          textColor: "#ffffff",
          cursorColor: C.green,
          placeholder: `${label} command...`,
        }));
      }
    } else {
      for (let i = 0; i < S.launchNumGpus; i++) {
        const cmd = S.launchCommands[i] || "";
        const gpu = S.launchSelectedGpus[i];
        const label = gpu ? `${gpu.node}:GPU${gpu.gpu}` : `GPU ${i}`;
        const isFocusedLine = S.runnerFocused && i === S.runnerFocusedInputIdx;
        commandNodes.push(
          Box(
            { width: "100%", height: 1, position: "relative" },
            Text({
              content: `${label}: ${cmd || "(click to edit)"}`,
              fg: (S.runnerInputTyping && isFocusedLine) ? "#9b59d6" : (isFocusedLine ? C.green : (cmd.trim() ? C.textDim : C.red)),
            }),
            Box({
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 1, // Low zIndex to allow text selection
              onMouseDown: (e: any) => {
                e?.stopPropagation?.();
                // Track mousedown for drag detection
                S.runnerMouseDownTime = Date.now();
                S.runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
              },
              onMouseUp: (e: any) => {
                e?.stopPropagation?.();
                // Check if this was a drag (long press or moved)
                const elapsed = Date.now() - S.runnerMouseDownTime;
                const moved = S.runnerMouseDownPos && (
                  Math.abs((e?.clientX ?? 0) - S.runnerMouseDownPos.x) > 5 ||
                  Math.abs((e?.clientY ?? 0) - S.runnerMouseDownPos.y) > 5
                );

                // If dragged, don't trigger click behavior (allow copy)
                if (moved || elapsed > 300) {
                  return;
                }

                // This was a click, not a drag
                if (!S.runnerFocused) {
                  S.runnerFocused = true;
                  S.runnerFocusedInputIdx = i;
                } else if (S.runnerFocusedInputIdx === i && !S.runnerInputTyping) {
                  // Second click on same line → typing mode
                  S.runnerInputTyping = true;
                } else {
                  S.runnerFocusedInputIdx = i;
                }
                S.requestRender?.();
              },
            })
          )
        );
      }
    }
  }

  const tmuxNodes: any[] = [];
  if (S.launchMode === "tmux") {
    tmuxNodes.push(Text({ content: " " }));
    tmuxNodes.push(Text({ content: "Tmux session (empty = auto):", fg: C.textDim }));

    const isTmuxFocused = S.runnerFocused && S.runnerFocusedInputIdx === -1;

    if (S.runnerInputTyping && isTmuxFocused) {
      tmuxNodes.push(Input({
        id: "runner-tmux-session-input",
        value: S.launchTmuxSession,
        width: "100%",
        backgroundColor: C.bgAlt,
        focusedBackgroundColor: "#3b4261",
        textColor: "#ffffff",
        cursorColor: C.green,
        placeholder: "session name (optional)...",
      }));
    } else {
      tmuxNodes.push(
        Box(
          { width: "100%", height: 1, position: "relative" },
          Text({
            content: `> ${S.launchTmuxSession || "(click to edit)"}`,
            fg: (S.runnerInputTyping && isTmuxFocused) ? "#9b59d6" : (isTmuxFocused ? C.green : C.textDim),
          }),
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1, // Low zIndex to allow text selection
            onMouseDown: (e: any) => {
              e?.stopPropagation?.();
              S.runnerMouseDownTime = Date.now();
              S.runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
            },
            onMouseUp: (e: any) => {
              e?.stopPropagation?.();
              const elapsed = Date.now() - S.runnerMouseDownTime;
              const moved = S.runnerMouseDownPos && (
                Math.abs((e?.clientX ?? 0) - S.runnerMouseDownPos.x) > 5 ||
                Math.abs((e?.clientY ?? 0) - S.runnerMouseDownPos.y) > 5
              );

              if (moved || elapsed > 300) {
                return; // Was a drag, don't trigger click
              }

              if (!S.runnerFocused) {
                S.runnerFocused = true;
                S.runnerFocusedInputIdx = -1;
              } else if (S.runnerFocusedInputIdx === -1 && !S.runnerInputTyping) {
                // Second click on tmux session → typing mode
                S.runnerInputTyping = true;
              } else {
                S.runnerFocusedInputIdx = -1;
              }
              S.requestRender?.();
            },
          })
        )
      );
    }
  }

  const contentNodes = [
    headerBox,
    statusLine,  // modeInfo/gpuText from index.ts were undefined; statusLine is the correct variable
    Text({ content: " " }),
    Text({ content: " " }),
    ...commandNodes,
    ...tmuxNodes,
  ];

  const errorBox = errorText ? Box(
    {
      position: "absolute",
      bottom: 1,
      right: 2,
      backgroundColor: C.bgAlt,
      padding: 0,
      zIndex: 1001,
    },
    errorText
  ) : null;

  return Box(
    {
      position: "absolute",
      bottom: 0,
      left: 0,
      width: "100%",
      height: height,
      borderStyle: "rounded",
      borderColor: S.runnerInputTyping ? "#9b59d6" : (S.runnerFocused ? C.green : C.border),
      backgroundColor: C.bgAlt,
      padding: 1,
      flexDirection: "column",
      gap: 0,
      zIndex: 1000,
      onMouseDown: (e: any) => {
        e?.stopPropagation?.();
        if (S.runnerInputTyping) return;
        if (S.runnerFocused) {
          S.runnerFocused = false;
          S.runnerInputTyping = false;
          S.requestRender?.();
          return;
        }
        if (!S.runnerFocused) {
          e?.preventDefault?.();
          S.runnerFocused = true;
          S.runnerInputBuffer = S.launchCommand;
          S.runnerInputTyping = false;
          S.requestRender?.();
        }
      },
    },
    ...contentNodes,
    ...(errorBox ? [errorBox] : [])
  );
}

// ── Job management ─────────────────────────────────────────────────
// saveJobToStore is already in src/state/api.ts — re-exported for convenience.
export { saveJobToStore } from "../state/api";

/**
 * Create job record from current launch configuration for immediate mode.
 * Returns job_id if successful, null otherwise.
 */
export async function createImmediateJob(): Promise<string | null> {
  try {
    const jobData: Partial<Job> = {
      command: S.launchDistMode === "single" ? S.launchCommand : "",
      commands: S.launchDistMode === "one-to-one" ? S.launchCommands.filter(c => c.trim()) : [],
      gpus: S.launchSelectedGpus.map(g => [g.node, g.gpu] as [string, number]),
      requested_gpu_count: 0,
      dist_mode: S.launchDistMode,
      exec_mode: S.launchMode,
      queue_mode: "immediate",
      tmux_sessions: [],
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
    started_at=datetime.now(timezone.utc).isoformat(),
    user=job_data["user"],
    restart_policy="never",
    queue_mode=job_data["queue_mode"],
    tmux_sessions=job_data["tmux_sessions"],
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
    await proc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    if (proc.exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      tuiLog("ERROR", `Failed to create job: ${stderrText}`);
      return null;
    }

    return stdout.trim() || null;
  } catch (e: any) {
    tuiLog("ERROR", `Failed to create immediate job: ${e?.message || String(e)}`);
    return null;
  }
}

/**
 * Update job status and tmux sessions after immediate execution.
 */
export async function updateImmediateJob(
  jobId: string,
  status: "running" | "done" | "failed",
  tmuxSessions: string[],
  error: string | null = null
): Promise<void> {
  try {
    const updateData = {
      job_id: jobId,
      status: status,
      tmux_sessions: tmuxSessions,
      error: error,
    };

    const tmpFile = `/tmp/opensmi-update-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(updateData));

    const updateScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import load_jobs, save_jobs, get_job, upsert_job, cleanup_tmux_artifacts_for_sessions
from opensmi.state import get_state_dir
from datetime import datetime, timezone

with open("${tmpFile}", "r") as f:
    update_data = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)
job = get_job(jobs, update_data["job_id"])

if job:
    previous_sessions = list(job.tmux_sessions or [])
    job.status = update_data["status"]
    job.tmux_sessions = update_data["tmux_sessions"]
    removed_sessions = [s for s in previous_sessions if s not in set(job.tmux_sessions)]
    if removed_sessions:
        cleanup_tmux_artifacts_for_sessions(removed_sessions)
    if job.status in ("done", "failed", "cancelled") and job.tmux_sessions:
        cleanup_tmux_artifacts_for_sessions(job.tmux_sessions)
        job.tmux_sessions = []
    if update_data["status"] in ("done", "failed"):
        job.finished_at = datetime.now(timezone.utc).isoformat()
    if update_data["error"]:
        job.error = update_data["error"]
    jobs = upsert_job(jobs, job)
    save_jobs(state_dir, jobs)
else:
    sys.exit(1)
`;

    const proc = Bun.spawn([PYTHON, "-c", updateScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    await proc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    if (proc.exitCode !== 0) {
      tuiLog("ERROR", `Failed to update job ${jobId}`);
    }
  } catch (e: any) {
    tuiLog("ERROR", `Failed to update job ${jobId}: ${e?.message || String(e)}`);
  }
}

// ── Execution functions ────────────────────────────────────────────

export async function executeLaunch(): Promise<void> {
  tuiLog("INFO", `executeLaunch - mode=${S.launchMode} dist=${S.launchDistMode} queue=${S.launchQueueMode} gpus=${S.launchSelectedGpus.length} cmd="${S.launchCommand.slice(0, 80)}"`);
  S.runnerState = "queued";
  S.runnerStderr = [];
  S.runnerAttachCmd = "";
  S.runnerStartTime = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" });

  if (!S.snapshot) {
    setLaunchError("No snapshot available");
    S.runnerState = "failed";
    return;
  }

  if (S.launchSelectedGpus.length === 0) {
    setLaunchError("No GPUs available");
    S.runnerState = "failed";
    return;
  }

  if (S.launchDistMode === "single") {
    if (!S.launchCommand.trim()) {
      setLaunchError("Command cannot be empty");
      S.runnerState = "failed";
      return;
    }
  } else {
    const nonEmpty = S.launchCommands.filter(c => c.trim()).length;
    if (nonEmpty === 0) {
      setLaunchError("At least one command must be provided");
      S.runnerState = "failed";
      return;
    }

    if (nonEmpty !== S.launchNumGpus) {
      S.launchErrorMsg = `Expected ${S.launchNumGpus} commands, got ${nonEmpty}`;
      S.runnerState = "failed";
      return;
    }
  }

  S.launchErrorMsg = "";
  S.launchOutput = "";
  S.runnerState = "preparing";

  try {
    // Hotfix: ensure latest setup edits are persisted before any submit/execute.
    await flushSetupChangesToConfig();

    // If queue mode is "queued", save to job store instead of executing immediately
    if (S.launchQueueMode === "queued") {
      await saveJobToStore();
      return;
    }

    // Immediate mode: execute now and track in job store

    // Create job record before execution
    const currentJobId = await createImmediateJob();
    if (!currentJobId) {
      setLaunchError("Failed to create job record");
      S.runnerState = "failed";
      return;
    }

    // Update launch history
    const tmpFile = `/tmp/opensmi-gpus-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(S.launchSelectedGpus));

    const updateScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.launch_history import update_history
from opensmi.state import get_state_dir

with open("${tmpFile}", "r") as f:
    gpus_data = json.loads(f.read())
gpus = [(g["node"], g["gpu"]) for g in gpus_data]
update_history(get_state_dir(), gpus)
print("OK")
`;

    const updateProc = Bun.spawn([PYTHON, "-c", updateScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: OPENSMI_ENV,
      cwd: OPENSMI_CWD,
    });

    await updateProc.exited;

    try {
      await Bun.$`rm -f ${tmpFile}`;
    } catch {}

    S.runnerState = "sent";

    // Execute and collect tmux session names
    const tmuxSessions: string[] = [];

    if (S.launchDistMode === "single") {
      const gpuIndices = S.launchSelectedGpus.map(g => g.gpu).join(",");
      if (S.launchMode === "tmux") {
        const nodes = Array.from(new Set(S.launchSelectedGpus.map(g => g.node)));
        const sessionName = S.launchTmuxSession.trim() || `opensmi-${currentJobId}-${tmuxSafeName(nodes[0]!)}`;
        tmuxSessions.push(sessionName);
        // Set S.launchTmuxSession so executeLaunchTmux uses it
        if (!S.launchTmuxSession.trim()) {
          S.launchTmuxSession = sessionName;
        }
        await executeLaunchTmux(S.launchCommand, gpuIndices);
      } else {
        await executeLaunchDirect(S.launchCommand, gpuIndices);
      }
    } else {
      // One-to-one mode
      if (S.launchMode === "tmux") {
        for (let i = 0; i < S.launchNumGpus; i++) {
          const cmd = S.launchCommands[i]?.trim();
          if (!cmd) continue;
          const gpu = S.launchSelectedGpus[i];
          if (!gpu) continue;
          const sessionName = S.launchTmuxSession.trim()
            ? `${S.launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
            : `opensmi-${currentJobId}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`;
          tmuxSessions.push(sessionName);
        }
      }
      await executeLaunchOneToOne();
    }

    // Update job status after execution
    const finalStatus = S.launchErrorMsg ? "failed" : (S.launchMode === "tmux" ? "running" : "done");
    await updateImmediateJob(currentJobId, finalStatus, tmuxSessions, S.launchErrorMsg || null);
    await loadJobsFromCLI();

    if (S.launchErrorMsg === "") {
      S.runnerState = "running";
    } else {
      S.runnerState = "failed";
    }
  } catch (e: any) {
    S.launchErrorMsg = e?.message || String(e);
    S.runnerState = "failed";
  }
}

export async function executeRemoteExec(params: {
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
    // Log preflight failures individually
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

export async function executeLaunchDirect(command: string, gpuIndices: string): Promise<void> {
  // Remote exec: only supported when all selected GPUs are on one node.
  const nodes = Array.from(new Set(S.launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    S.runnerState = "failed";
    return;
  }
  const node = nodes[0]!;

  const payload = await executeRemoteExec({
    node,
    gpusCsv: gpuIndices,
    mode: "direct",
    command,
  });

  const preflightLines = payload.preflight
    .map((r: any) => `${r.node_alias} ${r.check_type}: ${r.passed ? "PASS" : "FAIL"}${r.error_message ? ` - ${r.error_message}` : ""}`)
    .join("\n");

  const res = payload.result;
  const execCode = res?.exit_code;
  const execStdout = res?.stdout || "";
  const execStderr = res?.stderr || "";

  const fullOutput = [
    preflightLines ? `Preflight:\n${preflightLines}` : "",
    typeof execCode === "number" ? `Exit code: ${execCode}` : `Exit code: ${payload.code}`,
    execStdout ? `stdout:\n${execStdout}` : "",
    execStderr ? `stderr:\n${execStderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  S.launchOutput = fullOutput.slice(0, 500);

  if (execStderr) {
    const stderrLines = execStderr.split("\n").filter((l: string) => l.trim());
    S.runnerStderr = stderrLines.slice(-2).map((l: string) => l.slice(0, 100));
  }

  if (!payload.ok) {
    setLaunchError(
      execStderr.trim() ||
        payload.rawStderr.trim() ||
        "Remote command failed (see Output)"
    );
    S.runnerState = "failed";
    return;
  }

  setStatus(
    `Launched (remote): ${command.slice(0, 40)}${command.length > 40 ? "..." : ""} on ${S.launchSelectedGpus.length} GPU(s)`
  );
}

export async function executeLaunchOneToOne(): Promise<void> {
  const results: string[] = [];

  for (let i = 0; i < S.launchNumGpus; i++) {
    const cmd = S.launchCommands[i]?.trim();
    if (!cmd) continue;

    const gpu = S.launchSelectedGpus[i];
    if (!gpu) continue;

    const gpuIndex = String(gpu.gpu);

    if (S.launchMode === "tmux") {
      const sessionName = S.launchTmuxSession.trim()
        ? `${S.launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
        : `opensmi-${Date.now()}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`;

      const payload = await executeRemoteExec({
        node: gpu.node,
        gpusCsv: gpuIndex,
        mode: "tmux",
        command: cmd,
        session: sessionName,
      });

      if (!payload.ok) {
        const why = payload.rawStderr.trim() || "exec failed";
        results.push(`${gpu.node}:GPU${gpu.gpu}: FAILED - ${why.slice(0, 80)}`);
      } else {
        results.push(`${gpu.node}:GPU${gpu.gpu}: tmux session ${sessionName}`);
      }
    } else {
      const payload = await executeRemoteExec({
        node: gpu.node,
        gpusCsv: gpuIndex,
        mode: "direct",
        command: cmd,
      });

      const res = payload.result;
      const output = (res?.stdout || res?.stderr || "").trim();
      const preview = output.slice(0, 30).replace(/\n/g, " ");

      if (!payload.ok) {
        results.push(`${gpu.node}:GPU${gpu.gpu}: FAIL ${preview}${output.length > 30 ? "..." : ""}`);
      } else {
        results.push(`${gpu.node}:GPU${gpu.gpu}: OK ${preview}${output.length > 30 ? "..." : ""}`);
      }
    }
  }

  S.launchOutput = results.join("\n");

  if (S.launchMode === "tmux") {
    const sessions = results
      .map((r) => {
        const match = r.match(/tmux session (.+)$/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    if (sessions.length > 0) {
      setStatus(`Launched ${sessions.length} remote tmux sessions`);
    }
  } else {
    setStatus(`Executed ${results.length} remote commands`);
  }
}

export async function executeLaunchTmux(command: string, gpuIndices: string): Promise<void> {
  const nodes = Array.from(new Set(S.launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    S.runnerState = "failed";
    return;
  }
  const node = nodes[0]!;

  const sessionName = S.launchTmuxSession.trim() || `opensmi-${Date.now()}-${tmuxSafeName(node)}`;

  const payload = await executeRemoteExec({
    node,
    gpusCsv: gpuIndices,
    mode: "tmux",
    command,
    session: sessionName,
  });

  const preflightLines = payload.preflight
    .map((r: any) => `${r.node_alias} ${r.check_type}: ${r.passed ? "PASS" : "FAIL"}${r.error_message ? ` - ${r.error_message}` : ""}`)
    .join("\n");

  if (!payload.ok) {
    const errDetail = payload.rawStderr.trim() || "Tmux launch failed (see Output)";
    S.launchOutput = preflightLines ? `Preflight:\n${preflightLines}` : payload.rawStdout.slice(0, 500);
    setLaunchError(errDetail);
    tuiLog("ERROR", `executeLaunchTmux failed: node=${node} session=${sessionName} err=${errDetail}`);
    S.runnerState = "failed";
    return;
  }

  const attachHint = `tmux attach -t ${sessionName}`;
  S.launchOutput = [
    preflightLines ? `Preflight:\n${preflightLines}` : "",
    `Local tmux session: ${sessionName} → SSH to ${node}`,
    "",
    "Attach with:",
    `  ${attachHint}`,
  ]
    .filter(Boolean)
    .join("\n");

  S.runnerAttachCmd = attachHint;
  S.runnerTmuxSession = sessionName;
  tuiLog("INFO", `executeLaunchTmux ok: node=${node} session=${sessionName}`);
  setStatus(`Launched (tmux → ${node}): ${sessionName}`);
}
