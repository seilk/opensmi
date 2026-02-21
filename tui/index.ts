import {
  createCliRenderer,
  Box,
  Text,
  BoxRenderable,
  Input,
  ScrollBox,
  t,
  bold,
  fg,
  type KeyEvent,
} from "@opentui/core";
import { spawn } from "bun";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { tabRegistry, type Tab } from "./tabRegistry";

// ── TUI Logger ─────────────────────────────────────────────────────

const LOG_DIR = path.join(process.env.OPENSMI_LOG_DIR || path.join(process.env.HOME || "~", ".opensmi", "logs"));
const LOG_FILE = path.join(LOG_DIR, "tui.log");
const LOG_LEVEL = (process.env.OPENSMI_LOG_LEVEL || "INFO").toUpperCase();
const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };

const CURRENT_USER_HOST = (() => {
  try {
    const user = os.userInfo().username || process.env.USER || "?";
    const host = os.hostname().split(".")[0] || "?";
    return `${user}@${host}`;
  } catch {
    return process.env.USER ? `${process.env.USER}@?` : "?";
  }
})();
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 1;
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function tuiLog(level: "DEBUG" | "INFO" | "WARNING" | "ERROR", msg: string) {
  if ((LOG_LEVELS[level] ?? 1) < LOG_THRESHOLD) return;
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}.${String(now.getMilliseconds()).padStart(3,"0")}`;
  const line = `${ts} [${level}] tui: ${msg}\n`;
  try {
    // Simple rotation: truncate if over max size
    const stat = Bun.file(LOG_FILE);
    if (stat.size > LOG_MAX_SIZE) {
      Bun.write(LOG_FILE, line);
    } else {
      appendFileSync(LOG_FILE, line);
    }
  } catch {
    try { appendFileSync(LOG_FILE, line); } catch {}
  }
}

// ── Types ──────────────────────────────────────────────────────────

interface GPUInfo {
  index: number;
  uuid: string;
  name: string;
  memory_total_mib: number | null;
  memory_used_mib?: number | null;
  memory_free_mib?: number | null;
  utilization_gpu_percent?: number | null;
  // Backward compatibility for older snapshots
  utilization_gpu?: number | null;
}

interface GPUProcess {
  gpu_uuid: string;
  pid: number;
  process_name: string;
  used_memory_mib: number | null;
  user: string;
  runtime_s?: number | null;
}

interface NodeSnapshot {
  node_alias: string;
  address: string;
  hostname: string | null;
  os: string | null;
  timestamp: string | null;
  gpus: GPUInfo[];
  processes: GPUProcess[];
  error: string | null;
}

interface ClusterSnapshot {
  cluster_name: string;
  timestamp: string;
  nodes: NodeSnapshot[];
}

interface Allocation {
  node_alias: string;
  gpu_index: number;
  target: string;
  assigned_by: string;
  assigned_at: string;
  expires_at?: string | null;
  notes: string;
}

interface Job {
  id: string;
  command: string;
  commands: string[];
  gpus: [string, number][];  // [(node_alias, gpu_idx), ...]
  requested_gpu_count: number;
  dist_mode: "single" | "one-to-one";
  exec_mode: "direct" | "tmux";
  tmux_sessions: string[];
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_codes: number[];
  error: string | null;
  user: string;
  restart_policy: "never" | "on-failure" | "always";
  retry_count: number;
  max_retries: number;
  tags: string[];
  queue_mode: "immediate" | "queued";
}

// ── State ──────────────────────────────────────────────────────────

let snapshot: ClusterSnapshot | null = null;
let allocations: Allocation[] = [];
let gpuIdleStart: Record<string, number> = {}; // Key: "node:gpuUuid", Value: timestamp
let lastPollTime = "";
let pollError = "";
let selectedNodeIdx = 0;
let selectedGpuIdx = 0;
let screen: "dashboard" | "detail" | "help" | "alloc" | "kill" | "my-gpu-view" | "jobs" | "setup" = "dashboard";
let tabSwitcherOpen = false;
let tabSwitcherIdx = 0;
let lastGpuClickKey = "";
let lastGpuClickAt = 0;
let lastNodeClickKey = "";
let lastNodeClickAt = 0;
let allocCtx: { nodeAlias: string; gpuIdx: number } | null = null;
let allocUserListFocused = false; // True when focus is on user list
let allocUserListIdx = 0; // Selected user index in list

// Command runner pane state
let runnerPaneFolded = false;
let runnerFocused = false;
let runnerInputTyping = false; // True when actively typing text
let runnerInputBuffer = "";
let runnerFocusedInputIdx = 0; // Which input line is focused in one-to-one mode
let runnerMouseDownTime = 0; // Track mousedown time to distinguish click from drag
let runnerMouseDownPos: { x: number; y: number } | null = null;

// Prefix key system (ctrl+x)
let prefixKeyPressed = false;
let prefixKeyTimeout: any = null;
let allocDraftUser = "";
let allocErrorMsg = "";
let allocTypingTimer: any = null;
let allocUserHighlight = "";
let lastAllocUserClickKey = "";
let lastAllocUserClickAt = 0;
let killCtx: { nodeAlias: string; gpuIdx: number; pids: number[]; users: string[] } | null = null;
let killErrorMsg = "";
let killOutput = "";
let killInProgress = false;
let isPolling = false;
let bootLoading = true;

let runnerOpen = false;
let runnerHeight = 15;
const runnerMinHeight = 8;
const runnerMaxHeight = 40;
let runnerMaximized = false;

let launchCommand = "";
let launchNumGpus = 0; // Start with 0, user adds GPUs via + or click
let launchErrorMsg = "";
let launchErrorTimeout: any = null;
let launchOutput = "";
let launchSelectedGpus: Array<{ node: string; gpu: number }> = [];
let launchMode: "direct" | "tmux" = "tmux";
let launchTmuxSession = "";
let launchDistMode: "single" | "one-to-one" = "one-to-one";
let launchCommands: string[] = []; // Empty initially, populated when GPUs added
let launchGpuMode: "auto" | "selected" = "auto";
let launchManualGpus: Array<{ node: string; gpu: number }> = [];
let launchSelectionReasoning = "";
let launchSourceBundle: string | null = null; // Track which bundle opened the runner
let launchQueueMode: "immediate" | "queued" = "immediate"; // Queue mode for job submission

type RunnerState = "idle" | "queued" | "preparing" | "sent" | "running" | "failed";
let runnerState: RunnerState = "idle";
let runnerStartTime = "";
let runnerStderr: string[] = [];
let runnerAttachCmd = "";
let runnerTmuxSession = "";

type PreflightCheck = {
  name: string;
  status: "pending" | "pass" | "fail";
  hint: string;
};
let runnerPreflight: PreflightCheck[] = [];

// Permissions
const OPERATOR = process.env.SUDO_USER || process.env.USER || "unknown";
let isAdmin = false;
let adminHint = "";
let sudoInfoMsg = "";
let sudoOkByNode: Record<string, boolean | null> = {};
let sudoCheckingByNode: Record<string, boolean> = {};

interface GpuBundle {
  id: string;
  label: string;
  type: "allocated" | "active" | "pinned";
  gpus: Array<{ node: string; gpu: number }>;
  shortcut?: string;
}

interface MyGpuViewState {
  selectedBundleIdx: number;
  bundles: GpuBundle[];
  expandedGpuKeys: Set<string>;
  pinnedGpus: Array<{ node: string; gpu: number }>;
}

const myGpuViewState: MyGpuViewState = {
  selectedBundleIdx: 0,
  bundles: [],
  expandedGpuKeys: new Set(),
  pinnedGpus: [],
};

let statusMsg = "";
let statusMsgTimeout: any = null;
let statusUntil = 0;
let systemUsers: string[] = [];
let systemUsersLoadedAt = 0;
let knownUsers: string[] = [];
let requestRender: (() => void) | null = null;

let jobList: Job[] = [];
let selectedJobIdx = 0;
let jobDetailView: Job | null = null;
let jobDetailSelectedCmd = 0;        // Which GPU/command line is selected in detail view
let jobDetailLogView: string | null = null;  // Captured pane output, null = not viewing
let jobDetailLogSession: string = "";        // Which tmux session we're viewing
let jobDetailLogScroll = 0;           // Scroll offset in log view
let jobsLastLoadTime = 0;

function getStateDir(): string {
  const homedir = process.env.HOME || "~";
  return process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
}

async function loadAdminStatus(): Promise<void> {
  try {
    const candidates = [
      process.env.OPENSMI_CONFIG,
      `${getStateDir()}/opensmi.json`,
    ].filter(Boolean) as string[];

    const cfgPath = candidates.find((p) => existsSync(p)) || candidates[0]!;
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

    isAdmin = (!!master && OPERATOR === master) || members.includes(OPERATOR);
    adminHint = isAdmin
      ? `Admin: ${OPERATOR}`
      : `Read-only (${OPERATOR} not in admins)`;
  } catch {
    isAdmin = false;
    adminHint = `Read-only (${OPERATOR}); opensmi.json missing`;
  }
}

const PYTHON = process.env.OPENSMI_PYTHON || "python3";

// For dev (repo checkout), running from tui/ we want to point one level up.
// For a compiled binary, the source tree may not exist; in that case we should NOT force cwd.
const DEFAULT_BASE_DIR = new URL("..", import.meta.url).pathname;
const EXEC_DIR = path.dirname(process.execPath);

function _isRepoRoot(p: string): boolean {
  return existsSync(`${p}/pyproject.toml`) && existsSync(`${p}/src/opensmi/__init__.py`);
}

const BASE_DIR_CANDIDATES = [
  process.env.OPENSMI_BASE_DIR,
  DEFAULT_BASE_DIR,
  path.resolve(EXEC_DIR, "..", ".."),
  process.cwd(),
].filter(Boolean) as string[];

const BASE_DIR = BASE_DIR_CANDIDATES.find(_isRepoRoot) || "";

// Decide how to invoke the CLI:
//  1) In dev (repo checkout): python3 -m opensmi (with cwd = repo root)
//  2) Installed binary:       opensmi (from PATH — works for pip, pyz, any install method)
function _resolveCliCommand(): { cmd: string[]; cwd: string | undefined } {
  // Explicit override
  const explicit = process.env.OPENSMI_CLI;
  if (explicit) return { cmd: [explicit], cwd: undefined };

  // Dev mode: repo root found → use python3 -m
  if (BASE_DIR) return { cmd: [PYTHON, "-m", "opensmi"], cwd: BASE_DIR };

  // Installed: call opensmi command directly (pip entrypoint, pyz wrapper, etc.)
  return { cmd: ["opensmi"], cwd: undefined };
}

const { cmd: OPENSMI, cwd: OPENSMI_CWD } = _resolveCliCommand();

function _spawnEnv(): Record<string, string> {
  // In src-layout dev mode, ensure python can import opensmi.
  const env: Record<string, string> = { ...process.env } as any;
  if (BASE_DIR && OPENSMI[0] === PYTHON) {
    const add = `${BASE_DIR}/src`;
    const cur = env.PYTHONPATH || "";
    env.PYTHONPATH = cur ? `${add}:${cur}` : add;
  }
  return env;
}

const OPENSMI_ENV = _spawnEnv();

async function runOpensmi(
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

function parseSemver(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isRemoteNewer(current: string, latest: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

async function maybeShowUpdateNotification(): Promise<void> {
  try {
    const v = await runOpensmi(["--version"]);
    if (v.code !== 0) return;
    const currentMatch = v.stdout.match(/\d+\.\d+\.\d+/);
    if (!currentMatch) return;
    const current = currentMatch[0];

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1800);
    const resp = await fetch("https://api.github.com/repos/seilk/opensmi/releases/latest", {
      headers: { "accept": "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return;
    const data = await resp.json() as any;
    const latestRaw = String(data?.tag_name || "");
    const latest = latestRaw.replace(/^v/, "");
    if (!latest) return;

    if (isRemoteNewer(current, latest)) {
      setStatus(`Update available: v${latest}  → run: opensmi update`, 3000);
    }
  } catch {
    // quiet fail (offline/firewall/etc.)
  }
}

function setLaunchError(msg: string): void {
  tuiLog("ERROR", `launch error: ${msg}`);
  launchErrorMsg = msg;
  if (launchErrorTimeout) clearTimeout(launchErrorTimeout);
  launchErrorTimeout = setTimeout(() => {
    launchErrorMsg = "";
    requestRender?.();
  }, 1000);
}

function getGpuCommandPlaceholder(gpu: { node: string; gpu: number } | undefined): string {
  if (!gpu) return "";
  return ""; // Empty string for storage, display handled in render
}

function getGpuLabel(gpu: { node: string; gpu: number }): string {
  return `${gpu.node}:GPU${gpu.gpu}`;
}

async function refreshLaunchGpuSelection(): Promise<void> {
  if (!snapshot) {
    launchSelectedGpus = [];
    return;
  }
  
  // In "selected" mode, use manually selected GPUs
  if (launchGpuMode === "selected") {
    launchSelectedGpus = launchManualGpus.slice(0, launchNumGpus);
    return;
  }
  
  // In "auto" mode, rank and select GPUs automatically
  try {
    const tmpFile = `/tmp/opensmi-snap-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(snapshot));
    
    const allocFile = `/tmp/opensmi-alloc-${crypto.randomUUID()}.json`;
    await Bun.write(allocFile, JSON.stringify(allocations));
    
    const operatorFile = `/tmp/opensmi-op-${crypto.randomUUID()}.json`;
    await Bun.write(operatorFile, JSON.stringify({ operator: OPERATOR }));
    
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
gpus = select_top_gpus(snap, ${launchNumGpus}, history, alloc_data, current_user)
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
      launchSelectedGpus = JSON.parse(rankStdout);
    } else {
      launchSelectedGpus = [];
    }
    
    try {
      await Bun.$`rm -f ${tmpFile} ${allocFile} ${operatorFile}`;
    } catch {}
  } catch {
    launchSelectedGpus = [];
  }
}

async function allocSet(
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

async function allocClear(nodeAlias: string, gpuIdx: number): Promise<void> {
  const { code, stderr } = await runOpensmi([
    "alloc",
    "clear",
    nodeAlias,
    String(gpuIdx),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`);
}

async function killPids(
  nodeAlias: string,
  pids: number[],
  signal: "TERM" | "KILL" = "TERM"
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["kill", nodeAlias, ...pids.map((p) => String(p)), "--signal", signal];
  return await runOpensmi(args);
}

// ── Data fetching ──────────────────────────────────────────────────

async function pollCluster(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  pollError = "";
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
      pollError = stderr.trim() || `exit ${code}`;
      return;
    }

    const prevSelectedAlias = snapshot?.nodes?.[selectedNodeIdx]?.node_alias;

    const next = JSON.parse(stdout) as ClusterSnapshot;
    // Keep nodes in a stable A→Z order in the dashboard.
    next.nodes = [...next.nodes].sort((a, b) =>
      a.node_alias.localeCompare(b.node_alias, "en", { numeric: true, sensitivity: "base" })
    );

    snapshot = next;

    // Preserve selection across re-ordering.
    if (prevSelectedAlias) {
      const i = snapshot.nodes.findIndex((n) => n.node_alias === prevSelectedAlias);
      if (i >= 0) selectedNodeIdx = i;
    }
    if (snapshot.nodes.length === 0) {
      selectedNodeIdx = 0;
    } else if (selectedNodeIdx >= snapshot.nodes.length) {
      selectedNodeIdx = snapshot.nodes.length - 1;
    }

    lastPollTime = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" });
    recomputeKnownUsers();
    updateGpuIdleTracking();
  } catch (e: any) {
    pollError = e.message || String(e);
  } finally {
    isPolling = false;
  }
}

function updateGpuIdleTracking(): void {
  if (!snapshot) return;
  
  const now = Date.now();
  
  for (const node of snapshot.nodes) {
    if (node.error) continue;
    
    for (const gpu of node.gpus) {
      const key = `${node.node_alias}:${gpu.uuid}`;
      const procs = node.processes.filter(p => p.gpu_uuid === gpu.uuid);
      
      if (procs.length === 0) {
        // GPU is idle
        if (!gpuIdleStart[key]) {
          gpuIdleStart[key] = now;
        }
      } else {
        // GPU has processes - reset idle tracking
        delete gpuIdleStart[key];
      }
    }
  }
}

async function loadAllocations(): Promise<void> {
  try {
    const homedir = process.env.HOME || "~";
    const stateDir = process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
    const allocPath = `${stateDir}/allocations.json`;
    try {
      const raw = await Bun.file(allocPath).text();
      const data = JSON.parse(raw);
      allocations = ((data.allocations || []) as Allocation[]).map((a: Allocation) => {
        const t = String((a as any).target ?? "").trim();
        return {
          ...a,
          target: !t || t.toLowerCase() === "none" ? "*" : t,
        } as Allocation;
      });
    } catch {
      allocations = [];
    }
  } catch {
    allocations = [];
  } finally {
    recomputeKnownUsers();
  }
}

async function loadJobsFromCLI(): Promise<void> {
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
      jobList = [];
      return;
    }
    
    const data = JSON.parse(output);
    jobList = (data.jobs || []) as Job[];
    jobsLastLoadTime = Date.now();
  } catch {
    jobList = [];
  }
}

async function findAvailableGpus(count: number): Promise<Array<{ node: string; gpu: number }>> {
  /**
   * Find available idle GPUs using the existing rank_gpus logic.
   * 
   * "Available" means:
   *   - No active processes on the GPU
   *   - GPU utilization is 0%
   *   - Not already reserved by another queued job
   * 
   * Reserved GPUs: Queued jobs that have already been assigned specific GPUs
   * (e.g. immediate mode jobs that were converted to queued) should not have
   * their GPUs re-allocated to new jobs.
   * 
   * Returns: Top N available GPUs sorted by priority (rank_gpus order)
   */
  if (!snapshot || count <= 0) {
    return [];
  }
  
  try {
    // Write snapshot and allocations to temp files
    const tmpFile = `/tmp/opensmi-snap-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(snapshot));
    
    const allocFile = `/tmp/opensmi-alloc-${crypto.randomUUID()}.json`;
    await Bun.write(allocFile, JSON.stringify(allocations));
    
    const operatorFile2 = `/tmp/opensmi-op-${crypto.randomUUID()}.json`;
    await Bun.write(operatorFile2, JSON.stringify({ operator: OPERATOR }));
    
    // Build set of GPUs already assigned to queued jobs (to avoid double-booking)
    const queuedJobs = jobList.filter(j => j.status === "queued");
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

let isDispatching = false;

async function dispatchQueuedJobs(): Promise<void> {
  if (!snapshot || isDispatching) {
    return;
  }
  isDispatching = true;
  try {
    // Hotfix: always persist latest setup before dispatching jobs.
    await flushSetupChangesToConfig();
    await _dispatchQueuedJobsInner();
  } catch (e: any) {
    const msg = e?.message || String(e);
    tuiLog("ERROR", `dispatch precheck failed: ${msg}`);
    setStatus(`✗ Setup save failed: ${msg.slice(0, 80)}`, 4000);
  } finally {
    isDispatching = false;
  }
}

async function _dispatchQueuedJobsInner(): Promise<void> {
  
  // Get queued jobs in FIFO order (sorted by submission time)
  // Dispatch ALL queued jobs regardless of queue_mode — a queued job needs execution.
  const queuedJobs = jobList
    .filter(j => j.status === "queued")
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  
  if (queuedJobs.length === 0) {
    return;
  }
  
  // Process each queued job in order (FIFO)
  for (let i = 0; i < queuedJobs.length; i++) {
    const job = queuedJobs[i];
    const hasExplicitGpus = job.gpus.length > 0;
    const needed = job.requested_gpu_count || job.gpus.length;
    
    if (needed === 0) {
      continue;
    }
    
    try {
      if (!hasExplicitGpus) {
        // No GPUs specified — auto-assign from available pool
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
      
      // GPUs are set (explicit or just assigned)
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
      
      requestRender?.();
      
    } catch (e: any) {
      tuiLog("ERROR", `dispatch failed job=${job.id}: ${e?.message || String(e)}`);
      
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
      
      requestRender?.();
    }
  }
}

// Per-GPU liveness cache: jobId → { "node:gpu": alive }
const gpuLivenessCache: Map<string, Record<string, boolean>> = new Map();
// Consecutive "all dead" counter per job — only act after threshold
const watchdogDeadCount: Map<string, number> = new Map();
const WATCHDOG_DEAD_THRESHOLD = 3;  // Must see "all dead" 3 times in a row before acting
const WATCHDOG_GRACE_MS = 20_000;   // 20s grace after job start

async function checkGpuLiveness(job: Job): Promise<Record<string, boolean> | null> {
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
      return null;  // null = unknown, don't act on it
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
    return null;  // null = unknown
  }
}

async function watchRunningJobs(): Promise<void> {
  const runningJobs = jobList.filter(j => j.status === "running");
  
  if (runningJobs.length === 0) {
    return;
  }
  
  for (const job of runningJobs) {
    try {
      // Grace period: skip health check for first 30s after job started.
      if (job.started_at) {
        const elapsed = Date.now() - new Date(job.started_at).getTime();
        if (elapsed < WATCHDOG_GRACE_MS) {
          continue;
        }
      }

      // Remote liveness check via PID file
      const liveness = await checkGpuLiveness(job);
      
      // null = check failed (SSH error, Python error, timeout)
      // Don't act on failures — reset dead counter
      if (liveness === null) {
        tuiLog("DEBUG", `watchdog: job=${job.id} liveness check returned null (error/timeout), skipping`);
        // Don't increment dead count on errors — could be transient
        continue;
      }
      
      // Empty result = no GPUs mapped (misconfiguration)
      if (Object.keys(liveness).length === 0) {
        tuiLog("DEBUG", `watchdog: job=${job.id} empty liveness result, skipping`);
        continue;
      }

      const anyAlive = Object.values(liveness).some(v => v);
      const aliveCount = Object.values(liveness).filter(v => v).length;
      const totalCount = Object.keys(liveness).length;
      
      if (anyAlive) {
        // Reset dead counter on any sign of life
        watchdogDeadCount.delete(job.id);
        
        if (aliveCount < totalCount) {
          tuiLog("WARNING", `watchdog: job=${job.id} partial: ${aliveCount}/${totalCount} GPUs alive`);
        }
        continue;
      }

      // ALL GPUs reported dead — increment consecutive counter
      const deadCount = (watchdogDeadCount.get(job.id) || 0) + 1;
      watchdogDeadCount.set(job.id, deadCount);
      
      const gpuSummary = Object.entries(liveness).map(([k, v]) => `${k}:${v ? "✓" : "✗"}`).join(" ");
      tuiLog("WARNING", `watchdog: job=${job.id} all dead (${deadCount}/${WATCHDOG_DEAD_THRESHOLD}) [${gpuSummary}]`);
      
      // Only act after consecutive threshold
      if (deadCount < WATCHDOG_DEAD_THRESHOLD) {
        continue;
      }
      
      // Confirmed dead — take action
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
        
        tuiLog("ERROR", `watchdog: job=${job.id} failed — confirmed dead (policy=${job.restart_policy} retries=${job.retry_count}/${job.max_retries})`);
        setStatus(`Job ${job.id} failed: GPU processes terminated`, 3000);
      }
      
      // Clear caches
      gpuLivenessCache.delete(job.id);
      
      await updateJobInStore(job);
      await loadJobsFromCLI();
      requestRender?.();
    } catch (e: any) {
      tuiLog("ERROR", `watchdog failed job=${job.id}: ${e?.message || String(e)}`);
    }
  }
}

async function cleanupOldJobs(): Promise<void> {
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

async function killTmuxSessions(sessions: string[]): Promise<void> {
  for (const s of sessions) {
    try {
      await Bun.$`tmux kill-session -t ${s} 2>/dev/null || true`;
    } catch {}
  }
}

async function executeJobRemote(job: Job): Promise<void> {
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
      
      for (const [node, gpus] of nodesByGpu.entries()) {
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

async function updateJobInStore(job: Job): Promise<void> {
  const tmpFile = `/tmp/opensmi-job-update-${crypto.randomUUID()}.json`;
  await Bun.write(tmpFile, JSON.stringify(job));
  
  const updateScript = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src" if "${BASE_DIR}" else "")
from opensmi.jobs import Job, load_jobs, save_jobs, upsert_job
from opensmi.state import get_state_dir

with open("${tmpFile}", "r") as f:
    job_data = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)

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

async function cancelJobAction(job: Job): Promise<void> {
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
      jobDetailView = null;
      requestRender?.();
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

async function retryJobAction(job: Job): Promise<void> {
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
      jobDetailView = null;

      // Hotfix: persist setup edits before retry dispatch.
      await flushSetupChangesToConfig();
      
      // Immediately dispatch the new queued job instead of waiting 15s
      await dispatchQueuedJobs();
      await loadJobsFromCLI();
      requestRender?.();
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

async function retrySelectedSessionAction(job: Job, selectedIdx: number): Promise<void> {
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
    requestRender?.();
  } catch (e: any) {
    tuiLog("ERROR", `retrySelectedSessionAction error: ${e?.message || String(e)}`);
    setStatus(`Error retrying session: ${e?.message || String(e)}`, 3500);
  }
}

async function cleanupTmuxSessionsAction(job: Job): Promise<void> {
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

    if (jobDetailView && jobDetailView.id === job.id) {
      const fresh = jobList.find((j) => j.id === job.id) || null;
      jobDetailView = fresh;
      jobDetailSelectedCmd = 0;
    }

    setStatus(`✓ Cleaned ${sessions.length} tmux session(s)`, 2500);
    requestRender?.();
  } catch (e: any) {
    tuiLog("ERROR", `cleanupTmuxSessionsAction error: ${e?.message || String(e)}`);
    setStatus(`Failed to clean tmux sessions: ${e?.message || String(e)}`, 3500);
  }
}

async function deleteJobAction(job: Job): Promise<void> {
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
      if (selectedJobIdx >= jobList.length) {
        selectedJobIdx = Math.max(0, jobList.length - 1);
      }
      jobDetailView = null;
    } else {
      const stderr = await new Response(proc.stderr).text();
      setStatus(`Failed to delete job: ${stderr.trim().slice(0, 50)}`, 3000);
    }
  } catch (e: any) {
    setStatus(`Error deleting job: ${e?.message || String(e)}`, 3000);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function usersOnGpu(node: NodeSnapshot, gpuUuid: string): string[] {
  const seen = new Set<string>();
  const users: string[] = [];
  for (const p of node.processes) {
    if (p.gpu_uuid !== gpuUuid) continue;
    if (seen.has(p.user)) continue;
    seen.add(p.user);
    users.push(p.user);
  }
  return users;
}

function gpuIndicesForSnapshot(s: ClusterSnapshot | null): number[] {
  if (!s) return [];
  const set = new Set<number>();
  for (const n of s.nodes) {
    if (n.error) continue;
    for (const g of n.gpus) set.add(g.index);
  }
  return [...set].sort((a, b) => a - b);
}

function gpuIndicesForNode(node: NodeSnapshot | null | undefined): number[] {
  if (!node || node.error) return [];
  const set = new Set<number>();
  for (const g of node.gpus) set.add(g.index);
  return [...set].sort((a, b) => a - b);
}

/** Truncate text to fit within `width` chars, appending "…" if needed. */
function truncateText(text: string, width: number): string {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(1, width - 1)) + "…";
}

function getAllocation(nodeAlias: string, gpuIdx: number): Allocation | null {
  const a = allocations.find(
    (a) => a.node_alias === nodeAlias && a.gpu_index === gpuIdx
  );
  return a || null;
}

function getAllocTarget(nodeAlias: string, gpuIdx: number): string | null {
  return getAllocation(nodeAlias, gpuIdx)?.target || null;
}

function _parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function expiresInShort(expiresAt: string | null | undefined): string {
  const d = _parseIso(expiresAt);
  if (!d) return "";

  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "expired";

  const totalMin = Math.floor(diffMs / 60_000);
  const day = Math.floor(totalMin / (60 * 24));
  const hour = Math.floor((totalMin % (60 * 24)) / 60);
  const min = totalMin % 60;

  if (day > 0) return `${day}d${hour}h`;
  if (hour > 0) return `${hour}h${min}m`;
  return `${Math.max(1, min)}m`;
}

function gpuActivityStatus(node: NodeSnapshot, gpuIdx: number, gpuUuid: string): string {
  const procs = node.processes.filter(p => p.gpu_uuid === gpuUuid);
  
  if (procs.length > 0) {
    // GPU is in use
    return "in use";
  }
  
  // GPU is idle - try to determine since when
  
  // 1. Check if there's an allocation (assigned_at is the earliest idle bound)
  const alloc = allocations.find(
    a => a.node_alias === node.node_alias && a.gpu_index === gpuIdx
  );
  
  if (alloc) {
    const assignedAt = _parseIso(alloc.assigned_at);
    if (assignedAt) {
      const idleMs = Date.now() - assignedAt.getTime();
      if (idleMs > 0) {
        const totalMin = Math.floor(idleMs / 60_000);
        const day = Math.floor(totalMin / (60 * 24));
        const hour = Math.floor((totalMin % (60 * 24)) / 60);
        const min = totalMin % 60;
        
        if (day > 0) return `idle ${day}d${hour}h (alloc)`;
        if (hour > 0) return `idle ${hour}h${min}m (alloc)`;
        if (min > 0) return `idle ${min}m (alloc)`;
        return "idle <1m (alloc)";
      }
    }
  }
  
  // 2. Fallback to TUI observation tracking
  const key = `${node.node_alias}:${gpuUuid}`;
  const idleStartTime = gpuIdleStart[key];
  
  if (!idleStartTime) {
    return "idle (unknown)";
  }
  
  const idleMs = Date.now() - idleStartTime;
  if (idleMs < 0) return "idle (unknown)";
  
  const totalMin = Math.floor(idleMs / 60_000);
  const day = Math.floor(totalMin / (60 * 24));
  const hour = Math.floor((totalMin % (60 * 24)) / 60);
  const min = totalMin % 60;
  
  if (day > 0) return `idle ${day}d${hour}h`;
  if (hour > 0) return `idle ${hour}h${min}m`;
  if (min > 0) return `idle ${min}m`;
  return "idle <1m";
}

function countExpiringWithin(hours: number): number {
  const now = Date.now();
  const windowMs = Math.max(1, hours) * 60 * 60 * 1000;
  let count = 0;

  for (const a of allocations) {
    const d = _parseIso(a.expires_at);
    if (!d) continue;
    const diff = d.getTime() - now;
    if (diff > 0 && diff <= windowMs) count += 1;
  }

  return count;
}

function _parseTargets(target: string): string[] {
  // Keep order (do NOT sort) and allow comma-separated multi-user values.
  const parts = target
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function _filteredDraftList(raw: string, universeSet: Set<string>): string[] {
  return _parseTargets(raw).filter((t) => t === "*" || universeSet.has(t));
}

function _toggleDraftUser(raw: string, user: string, universeSet: Set<string>): string {
  const cur = _filteredDraftList(raw, universeSet);
  const idx = cur.indexOf(user);
  if (idx >= 0) {
    cur.splice(idx, 1);
  } else {
    cur.push(user);
  }
  return cur.join(",");
}

function isViolation(nodeAlias: string, gpuIdx: number, user: string): boolean {
  const target = getAllocTarget(nodeAlias, gpuIdx);
  if (target === null) return false; // default-open before explicit admin allocation
  if (target === "*") return false;

  const allowed = new Set(_parseTargets(target));
  return !allowed.has(user);
}

function gpuMemStr(mib: number | null | undefined): string {
  if (mib === null || mib === undefined) return "?";
  return `${Math.round(mib / 1024)}G`;
}

function gpuUtilPct(g: GPUInfo): number | null {
  if (g.utilization_gpu_percent !== null && g.utilization_gpu_percent !== undefined) {
    return g.utilization_gpu_percent;
  }
  if (g.utilization_gpu !== null && g.utilization_gpu !== undefined) {
    return g.utilization_gpu;
  }
  return null;
}

function suggestGpu(node: NodeSnapshot): GPUInfo | null {
  if (!node.gpus.length) return null;

  const byUuidProcCount = new Map<string, number>();
  for (const p of node.processes) {
    byUuidProcCount.set(p.gpu_uuid, (byUuidProcCount.get(p.gpu_uuid) || 0) + 1);
  }

  const sorted = [...node.gpus].sort((a, b) => {
    const aProc = byUuidProcCount.get(a.uuid) || 0;
    const bProc = byUuidProcCount.get(b.uuid) || 0;
    if (aProc !== bProc) return aProc - bProc;

    const aUtil = gpuUtilPct(a) ?? Number.MAX_SAFE_INTEGER;
    const bUtil = gpuUtilPct(b) ?? Number.MAX_SAFE_INTEGER;
    if (aUtil !== bUtil) return aUtil - bUtil;

    const aFree = a.memory_free_mib ?? -1;
    const bFree = b.memory_free_mib ?? -1;
    if (aFree !== bFree) return bFree - aFree;

    return a.index - b.index;
  });

  return sorted[0] || null;
}

function runtimeStr(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const s = Math.max(0, Math.floor(sec));

  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function setStatus(msg: string, ttlMs: number = 1000) {
  statusMsg = msg;
  statusUntil = Date.now() + ttlMs;
  requestRender?.();
}

function openAllocModal(node: NodeSnapshot, gpuIdx: number): void {
  allocCtx = { nodeAlias: node.node_alias, gpuIdx };
  allocErrorMsg = "";
  allocUserHighlight = "";

  const existing = getAllocTarget(node.node_alias, gpuIdx);
  let prefill = existing || "*";
  if (!existing) {
    const gi = node.gpus.find((g) => g.index === gpuIdx);
    if (gi) {
      const live = usersOnGpu(node, gi.uuid);
      if (live.length === 1) prefill = live[0] || "*";
    }
  }

  if (prefill.trim().toLowerCase() === "none") prefill = "*";

  allocDraftUser = prefill;
  screen = "alloc";
  requestRender?.();
}

function recomputeKnownUsers(): void {
  const users = new Set<string>();

  for (const u of systemUsers) users.add(u);

  // Live users from snapshot
  if (snapshot) {
    for (const n of snapshot.nodes) {
      if (n.error) continue;
      for (const p of n.processes) {
        if (p.user && p.user !== "unknown") users.add(p.user);
      }
    }
  }

  // Alloc targets (except special tokens)
  for (const a of allocations) {
    const t = (a.target || "").trim();
    if (!t || t === "*" || t.toLowerCase() === "none") continue;
    users.add(t);
  }

  knownUsers = [...users].sort((a, b) => a.localeCompare(b));
}

function computeGpuBundles(): GpuBundle[] {
  const bundles: GpuBundle[] = [];
  
  const allocatedGpus = allocations
    .filter(a => {
      const targets = _parseTargets(a.target);
      return targets.includes(OPERATOR);
    })
    .map(a => ({ node: a.node_alias, gpu: a.gpu_index }));
  
  if (allocatedGpus.length > 0) {
    bundles.push({
      id: "allocated",
      label: `My Allocated GPUs (${allocatedGpus.length})`,
      type: "allocated",
      gpus: allocatedGpus,
      shortcut: "a",
    });
  }
  
  const activeGpuSet = new Set<string>();
  if (snapshot) {
    for (const node of snapshot.nodes) {
      if (node.error) continue;
      for (const proc of node.processes) {
        if (proc.user === OPERATOR) {
          const gpu = node.gpus.find(g => g.uuid === proc.gpu_uuid);
          if (gpu) {
            activeGpuSet.add(`${node.node_alias}:${gpu.index}`);
          }
        }
      }
    }
  }
  
  const activeGpuList: Array<{ node: string; gpu: number }> = [];
  for (const key of activeGpuSet) {
    const [node, gpuStr] = key.split(":");
    if (node && gpuStr) {
      activeGpuList.push({ node, gpu: parseInt(gpuStr, 10) });
    }
  }
  
  if (activeGpuList.length > 0) {
    bundles.push({
      id: "active",
      label: `My Active Processes (${activeGpuList.length})`,
      type: "active",
      gpus: activeGpuList,
      shortcut: "p",
    });
  }
  
  if (myGpuViewState.pinnedGpus.length > 0) {
    bundles.push({
      id: "pinned",
      label: `Pinned GPUs (${myGpuViewState.pinnedGpus.length})`,
      type: "pinned",
      gpus: myGpuViewState.pinnedGpus,
      shortcut: "+",
    });
  }
  
  return bundles;
}

async function loadMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  try {
    const raw = await Bun.file(stateFile).text();
    const data = JSON.parse(raw);
    myGpuViewState.pinnedGpus = data.pinned_gpus || [];
    const expandedBundles = data.expanded_bundles || [];
    myGpuViewState.expandedGpuKeys = new Set(expandedBundles);
  } catch {
    myGpuViewState.pinnedGpus = [];
    myGpuViewState.expandedGpuKeys = new Set();
  }
}

async function saveMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  const data = {
    pinned_gpus: myGpuViewState.pinnedGpus,
    expanded_bundles: Array.from(myGpuViewState.expandedGpuKeys),
  };
  try {
    await Bun.write(stateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    tuiLog("ERROR", `Failed to save My GPU View state: ${e}`);
  }
}

// ── Colors ─────────────────────────────────────────────────────────

const C = {
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

// ── Rendering ──────────────────────────────────────────────────────

function renderToast() {
  if (!statusMsg) return null;

  return Box(
    {
      position: "absolute",
      right: 2,
      bottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
      backgroundColor: C.bgAlt,
      borderStyle: "rounded",
      borderColor: C.border,
      zIndex: 10_000,
    },
    Text({ content: statusMsg, fg: C.yellow })
  );
}

function renderTabSwitcher() {
  if (!tabSwitcherOpen) return null;

  const tabs = tabRegistry.getAllVisible();
  if (tabs.length === 0) return null;

  const maxWidth = 55;
  // rows: title + blank + N tabs + blank + help = N + 4
  // plus border (2) + padding (2) = N + 8
  const boxHeight = tabs.length + 8;

  const rows: any[] = [];
  rows.push(Text({ content: t`${bold(fg(C.blue)("Select Tab"))}` }));
  rows.push(Text({ content: "" }));

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const isSelected = i === tabSwitcherIdx;
    const isActive = tab.id === tabRegistry.activeTabId;
    const shortcutLabel = tab.shortcut ? `[${tab.shortcut.toUpperCase()}] ` : "    ";
    const activeLabel = isActive ? " ◀ Active" : "";
    const content = `${shortcutLabel}${tab.label}${activeLabel}`;
    
    rows.push(
      Text({
        content: isSelected ? `▸ ${content}` : `  ${content}`,
        fg: isSelected ? C.yellow : (isActive ? C.green : C.text),
      })
    );
  }

  rows.push(Text({ content: "" }));
  rows.push(
    Text({
      content: "[↑↓] Navigate  [Enter] Switch  [Shortcut] Jump  [Esc] Cancel",
      fg: C.textDim,
    })
  );

  return Box(
    {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: maxWidth,
      height: boxHeight,
      marginLeft: -Math.floor(maxWidth / 2),
      marginTop: -Math.floor(boxHeight / 2),
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: C.bgAlt,
      borderStyle: "rounded",
      borderColor: C.blue,
      zIndex: 20_000,
      flexDirection: "column",
    },
    ...rows
  );
}

function requireAdminUI(action: string): boolean {
  if (!isAdmin) {
    setStatus(`Admin only: ${action} (${adminHint})`);
    return false;
  }

  if (screen === "detail") {
    const node = snapshot?.nodes[selectedNodeIdx];
    const alias = node?.node_alias;
    if (alias) {
      const ok = sudoOkByNode[alias];
      if (ok === false) {
        setStatus(`Admin requires sudo-group on ${alias}`);
        return false;
      }
      if (ok === null || ok === undefined) {
        setStatus(`Checking sudo-group on ${alias}…`);
        return false;
      }
    }
  }

  return true;
}

async function checkSudoForNode(nodeAlias: string): Promise<void> {
  if (sudoCheckingByNode[nodeAlias]) return;
  sudoCheckingByNode[nodeAlias] = true;
  sudoOkByNode[nodeAlias] = null;
  requestRender?.();

  try {
    const { code, stdout, stderr } = await runOpensmi([
      "sudo-check",
      nodeAlias,
      "--json",
    ]);
    if (code !== 0) {
      sudoOkByNode[nodeAlias] = false;
      sudoInfoMsg = `sudo-check failed on ${nodeAlias}: ${stderr.trim() || `exit ${code}`}`;
      requestRender?.();
      return;
    }

    const data = JSON.parse(stdout) as any;
    sudoOkByNode[nodeAlias] = !!data.ok;
    if (!data.ok) {
      const groups = Array.isArray(data.groups) ? data.groups.join(" ") : "";
      sudoInfoMsg = `Read-only: SSH user not in sudo group on ${nodeAlias} (groups: ${groups})`;
    } else {
      sudoInfoMsg = "";
    }
  } catch (e: any) {
    sudoOkByNode[nodeAlias] = false;
    sudoInfoMsg = `sudo-check error on ${nodeAlias}: ${e?.message || String(e)}`;
  } finally {
    sudoCheckingByNode[nodeAlias] = false;
    requestRender?.();
  }
}

function renderLoadingBadge() {
  if (!bootLoading && snapshot) return null;

  // Match installer spinner design (Line/Clock: | / - \)
  const spin = ["|", "/", "-", "\\"];
  const frame = spin[Math.floor(Date.now() / 60) % spin.length] || "|";
  const msg = `${frame} opensmi: I'm syncing GPU state...`;

  return Box(
    {
      position: "absolute",
      left: 1,
      top: 0,
      zIndex: 10_000,
    },
    Text({ content: msg, fg: C.textDim })
  );
}

function renderDashboard() {
  if (!snapshot) return Box({ flexDirection: "column" }, Text({ content: "opensmi: I'm syncing GPU state..." }));

  const totalGpus = snapshot.nodes.reduce((s, n) => s + n.gpus.length, 0);
  const usedGpus = snapshot.nodes.reduce((s, n) => {
    return s + n.gpus.filter((g) => usersOnGpu(n, g.uuid).length > 0).length;
  }, 0);

  // Count violations
  let violationCount = 0;
  for (const n of snapshot.nodes) {
    if (n.error) continue;
    for (const g of n.gpus) {
      const users = usersOnGpu(n, g.uuid);
      for (const u of users) {
        if (isViolation(n.node_alias, g.index, u)) violationCount++;
      }
    }
  }

  // Header
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
      content: t`${bold(fg(C.blue)(snapshot.cluster_name))} ${fg(C.textDim)("· opensmi")}`,
    }),
    Text({
      content: t`${fg(C.textDim)(CURRENT_USER_HOST)}  GPUs: ${fg(C.green)(`${usedGpus}`)}/${totalGpus}  Violations: ${violationCount > 0 ? fg(C.red)(`${violationCount}`) : fg(C.green)("0")}  Poll: ${lastPollTime || "—"}  ${isPolling ? fg(C.yellow)("⟳") : ""}`,
    })
  );

  // Table header (dynamic GPU columns)
  const gpuCols = gpuIndicesForSnapshot(snapshot);

  // Dynamic column widths: scale proportionally with terminal width.
  // GPU cells and Free cells are given explicit Box widths to prevent the
  // last column from absorbing leftover flex space.
  const termWidth = process.stdout.columns || 80;
  const minNodeW = 10;
  const minGpuW  = 16;
  const freeW    = 8;
  const padLeft  = 1; // paddingLeft on each row
  const totalMin = padLeft + minNodeW + gpuCols.length * minGpuW + freeW;
  const extra    = Math.max(0, termWidth - totalMin);
  // Node gets up to 14 extra chars (capped; wider names are truncated anyway).
  // GPU columns absorb all remaining extra space to show more username detail.
  const nodeBonus = Math.min(14, Math.floor(extra * 0.25));
  const gpuBonus  = gpuCols.length > 0 ? Math.floor((extra - nodeBonus) / gpuCols.length) : 0;
  const nodeW = minNodeW + nodeBonus;
  const gpuW  = minGpuW + gpuBonus;
  const colW  = [nodeW, ...gpuCols.map(() => gpuW), freeW];
  const errorW = Math.max(10, termWidth - padLeft - colW[0]!);

  const tableHeader = Box(
    {
      flexDirection: "row",
      paddingLeft: 1,
      width: "100%",
      backgroundColor: C.bgAlt,
    },
    Box({ width: colW[0]! }, Text({ content: "Node".padEnd(colW[0]!), fg: C.textDim })),
    ...gpuCols.map((gi, j) =>
      Box({ width: colW[1 + j]! }, Text({ content: `GPU ${gi}`.padEnd(colW[1 + j]!), fg: C.textDim }))
    ),
    Box({ width: colW[colW.length - 1]! }, Text({ content: "Free".padEnd(colW[colW.length - 1]!), fg: C.textDim }))
  );

  // Table rows
  const rows = snapshot.nodes.map((n, ni) => {
    const isSelected = ni === selectedNodeIdx;
    const rowBg = isSelected ? "#33467c" : ni % 2 === 0 ? C.bg : C.bgAlt;

    if (n.error) {
      return Box(
        {
          flexDirection: "row",
          paddingLeft: 1,
          backgroundColor: rowBg,
          width: "100%",
          position: "relative",
        },
        Box({ width: colW[0]! }, Text({ content: truncateText(n.node_alias, colW[0]!).padEnd(colW[0]!), fg: isSelected ? "#ffffff" : C.text })),
        Box({ width: errorW }, Text({ content: truncateText(`ERROR: ${n.error}`, errorW).padEnd(errorW), fg: C.red })),
        // Click anywhere on the row to jump to detail.
        Box({
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 1, // Low zIndex to allow text selection
          onMouseDown: (e: any) => {
            e.preventDefault?.();
            e.stopPropagation?.();

            const now = Date.now();
            const clickKey = `NODE:${n.node_alias}`;
            const isDouble = clickKey === lastNodeClickKey && now - lastNodeClickAt < 350;
            lastNodeClickKey = clickKey;
            lastNodeClickAt = now;

            selectedNodeIdx = ni;
            selectedGpuIdx = 0;

            if (isDouble) {
              screen = "detail";
              void checkSudoForNode(n.node_alias);
            }

            requestRender?.();
          },
        })
      );
    }

    const idxToGpu: Record<number, GPUInfo> = {};
    for (const g of n.gpus) idxToGpu[g.index] = g;

    const gpuCells: any[] = [];
    let free = 0;

    for (const [j, i] of gpuCols.entries()) {
      const w = colW[1 + j]!;
      const g = idxToGpu[i];
      if (!g) {
        gpuCells.push(Text({ content: "—".padEnd(w), fg: C.textDim }));
        continue;
      }

      const isSelected = launchManualGpus.some(
        (x) => x.node === n.node_alias && x.gpu === i
      );
      const dot = isSelected ? "● " : "";

      const users = usersOnGpu(n, g.uuid);
      if (users.length === 0) {
        const alloc = getAllocation(n.node_alias, i);
        const remain = expiresInShort(alloc?.expires_at);
        const label = alloc ? `[${alloc.target}${remain ? ` ${remain}` : ""}]` : "idle";
        const display = (dot + label).length > w - 1 ? (dot + label).slice(0, w - 2) + "…" : (dot + label);
        gpuCells.push(
          Box(
            { width: w, height: 1, position: "relative" },
            Text({ content: display.padEnd(w), fg: isSelected ? C.yellow : C.textDim }),
            runnerFocused ? Box({
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 1000,
              onMouseDown: (e: any) => {
                e.preventDefault?.();
                e.stopPropagation?.();
                
                const gpuKey = { node: n.node_alias, gpu: i };
                const idx = launchManualGpus.findIndex(
                  (x) => x.node === gpuKey.node && x.gpu === gpuKey.gpu
                );
                
                if (idx >= 0) {
                  // Unselect GPU
                  launchManualGpus.splice(idx, 1);
                  // Sync count and commands
                  launchNumGpus = launchManualGpus.length;
                  if (launchDistMode === "one-to-one") {
                    launchCommands = launchCommands.slice(0, launchNumGpus);
                  }
                } else {
                  // Select GPU
                  launchManualGpus.push(gpuKey);
                  // Sync count: increase if selection exceeds current count
                  if (launchManualGpus.length > launchNumGpus) {
                    launchNumGpus = launchManualGpus.length;
                    if (launchDistMode === "one-to-one") {
                      while (launchCommands.length < launchNumGpus) {
                        const cmdIdx = launchCommands.length;
                        const gpu = launchManualGpus[cmdIdx];
                        launchCommands.push(getGpuCommandPlaceholder(gpu));
                      }
                    }
                  }
                }
                
                launchGpuMode = "selected";
                launchSelectedGpus = launchManualGpus.slice(0, launchNumGpus);
                
                requestRender?.();
              },
            }) : undefined
          )
        );
        free++;
      } else {
        const hasViolation = users.some((u) => isViolation(n.node_alias, i, u));
        const cell = users.join("+");
        const utilVal = gpuUtilPct(g);
        const util = utilVal !== null ? ` ${utilVal}%` : "";
        const label = `${cell}${util}`;
        const display = (dot + label).length > w - 1 ? (dot + label).slice(0, w - 2) + "…" : (dot + label);
        gpuCells.push(
          Box(
            { width: w, height: 1, position: "relative" },
            Text({
              content: display.padEnd(w),
              fg: isSelected ? C.yellow : (hasViolation ? C.red : C.green),
            }),
            runnerFocused ? Box({
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 1000,
              onMouseDown: (e: any) => {
                e.preventDefault?.();
                e.stopPropagation?.();
                
                const gpuKey = { node: n.node_alias, gpu: i };
                const idx = launchManualGpus.findIndex(
                  (x) => x.node === gpuKey.node && x.gpu === gpuKey.gpu
                );
                
                if (idx >= 0) {
                  // Unselect GPU
                  launchManualGpus.splice(idx, 1);
                  // Sync count and commands
                  launchNumGpus = launchManualGpus.length;
                  if (launchDistMode === "one-to-one") {
                    launchCommands = launchCommands.slice(0, launchNumGpus);
                  }
                } else {
                  // Select GPU
                  launchManualGpus.push(gpuKey);
                  // Sync count: increase if selection exceeds current count
                  if (launchManualGpus.length > launchNumGpus) {
                    launchNumGpus = launchManualGpus.length;
                    if (launchDistMode === "one-to-one") {
                      while (launchCommands.length < launchNumGpus) {
                        const cmdIdx = launchCommands.length;
                        const gpu = launchManualGpus[cmdIdx];
                        launchCommands.push(getGpuCommandPlaceholder(gpu));
                      }
                    }
                  }
                }
                
                launchGpuMode = "selected";
                launchSelectedGpus = launchManualGpus.slice(0, launchNumGpus);
                
                requestRender?.();
              },
            }) : undefined
          )
        );
      }
    }

    return Box(
      {
        flexDirection: "row",
        paddingLeft: 1,
        backgroundColor: rowBg,
        width: "100%",
        position: "relative",
      },
      Box({ width: colW[0]! },
        Text({
          content: truncateText(n.node_alias, colW[0]!).padEnd(colW[0]!),
          fg: isSelected ? "#ffffff" : C.cyan,
        })
      ),
      ...gpuCells,
      Box({ width: colW[colW.length - 1]! },
        Text({
          content: `${free}/${n.gpus.length}`.padEnd(colW[colW.length - 1]!),
          fg: free > 0 ? C.green : C.yellow,
        })
      ),
      // Click anywhere on the row to jump to detail (only when not runner focused)
      !runnerFocused ? Box({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 1, // Low zIndex to allow text selection
        onMouseDown: (e: any) => {
          e.preventDefault?.();
          e.stopPropagation?.();

          const now = Date.now();
          const clickKey = `NODE:${n.node_alias}`;
          const isDouble = clickKey === lastNodeClickKey && now - lastNodeClickAt < 350;
          lastNodeClickKey = clickKey;
          lastNodeClickAt = now;

          selectedNodeIdx = ni;
          selectedGpuIdx = gpuIndicesForNode(n)[0] ?? 0;

          if (isDouble) {
            screen = "detail";
            void checkSudoForNode(n.node_alias);
          }

          requestRender?.();
        },
      }) : undefined
    );
  });

  // User summary
  const userMap = new Map<string, number>();
  for (const n of snapshot.nodes) {
    if (n.error) continue;
    for (const g of n.gpus) {
      const users = new Set(usersOnGpu(n, g.uuid));
      for (const u of users) {
        userMap.set(u, (userMap.get(u) || 0) + 1);
      }
    }
  }

  const userSummary = [...userMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([u, count]) => `${u}:${count}`)
    .join("  ");

  const footer = Box(
    {
      width: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingTop: 1,
    },
    Text({
      content: t`${fg(C.textDim)("Users:")} ${userSummary}`,
    }),
    Text({
      content: statusMsg ? t`${fg(C.yellow)(statusMsg)}` : " ",
    }),
    Box(
      { flexDirection: "row", paddingTop: 1 },
      Text({
        content: runnerInputTyping
          ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
          : (runnerFocused
              ? t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Esc]")} Unfocus  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+x Enter]")} Execute  ${fg(C.textDim)("[Click GPU]")} Select  ${fg(C.textDim)("[Tab/+/-]")} Options`
              : (runnerPaneFolded
                  ? t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Detail  ${fg(C.textDim)("[ctrl+x ↓]")} Runner  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[ctrl+x q]")} Quit`
                  : t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Detail  ${fg(C.textDim)("[ctrl+x ↓]")} Runner  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[ctrl+x q]")} Quit`)),
      })
    )
  );

  return Box(
    { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
    Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg },
      header,
      tableHeader,
      ...rows,
      footer
    ),
    renderRunnerPane()
  );
}

function renderDetail() {
  if (!snapshot) return Text({ content: "No data" });

  const node = snapshot.nodes[selectedNodeIdx];
  if (!node) return Text({ content: "No node selected" });

  if (node.error) {
    return Box(
      { flexDirection: "column", backgroundColor: C.bg, padding: 1 },
      Text({ content: `${node.node_alias} — ERROR`, fg: C.red }),
      Text({ content: node.error, fg: C.red }),
      Text({ content: "" }),
      Text({ content: "[Esc/Backspace] Back", fg: C.textDim })
    );
  }

  const nodeGpuIdxs = gpuIndicesForNode(node);
  if (nodeGpuIdxs.length && !nodeGpuIdxs.includes(selectedGpuIdx)) {
    selectedGpuIdx = nodeGpuIdxs[0]!;
  }

  const children: any[] = [];

  // Header
  children.push(
    Text({ content: `${node.node_alias} (${node.hostname || node.address}) — ${node.os || ""}`, fg: C.blue }),
    Text({ content: "" })
  );

  // Per-GPU sections
  for (const g of node.gpus) {
    const procs = node.processes.filter((p) => p.gpu_uuid === g.uuid);
    const alloc = getAllocation(node.node_alias, g.index);
    const allocTarget = alloc?.target || "*";
    const remain = expiresInShort(alloc?.expires_at);
    const allocStr = `Alloc: ${allocTarget}${remain ? ` (exp ${remain})` : ""}`;
    const utilVal = gpuUtilPct(g);
    const utilStr = utilVal !== null ? `Load ${utilVal}%` : "Load ?";
    const activityStr = gpuActivityStatus(node, g.index, g.uuid);

    const isSel = g.index === selectedGpuIdx;
    const inLaunchSelection = launchManualGpus.some(
      (x) => x.node === node.node_alias && x.gpu === g.index
    );
    const prefix = isSel ? "▸" : (inLaunchSelection ? "●" : " ");
    children.push(
      Box(
        { 
          width: "100%", 
          height: 1, 
          position: "relative",
        },
        Text({
          content: ` ${prefix} GPU ${g.index}  |  ${g.name}  |  Mem ${gpuMemStr(g.memory_used_mib)}/${gpuMemStr(g.memory_total_mib)}  |  ${utilStr}  |  ${allocStr}  |  ${activityStr}`,
          fg: isSel ? "#ffffff" : (inLaunchSelection ? C.yellow : C.cyan),
        }),
        Box({
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 1, // Low zIndex to allow text selection
          onMouseDown: (e: any) => {
            e.preventDefault?.();
            e.stopPropagation?.();

            selectedGpuIdx = g.index;

            // Double-click to open Allocate modal
            const now = Date.now();
            const clickKey = `${node.node_alias}:GPU${g.index}`;
            const isDouble = clickKey === lastGpuClickKey && now - lastGpuClickAt < 350;
            lastGpuClickKey = clickKey;
            lastGpuClickAt = now;

            if (isDouble) {
              openAllocModal(node, g.index);
              return;
            }

            requestRender?.();
          },
        })
      )
    );

    if (procs.length === 0) {
      children.push(Text({ content: "    (idle)", fg: C.textDim }));
    } else {
      for (const p of procs) {
        const viol = isViolation(node.node_alias, g.index, p.user);
        const mem = p.used_memory_mib !== null ? `${p.used_memory_mib} MiB` : "?";
        const violMark = viol ? " ⚠" : "";
        const rt = runtimeStr(p.runtime_s);
        const rtCol = rt ? rt.padStart(6) : " ".repeat(6);
        children.push(
          Text({
            content: `    PID ${String(p.pid).padEnd(8)} ${p.user.padEnd(14)} ${mem.padStart(10)} ${rtCol}  ${p.process_name}${violMark}`,
            fg: viol ? C.red : C.text,
          })
        );
      }
    }

    children.push(Text({ content: "" }));
  }

  children.push(
    Text({
      content: runnerInputTyping
        ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
        : (runnerFocused
            ? (isAdmin
                ? t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Click GPU]")} Select  ${fg(C.textDim)("[a]")} Allocate  ${fg(C.textDim)("[Shift+K]")} Kill  ${fg(C.textDim)("[Esc]")} Back`
                : t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Click GPU]")} Select  ${fg(C.textDim)("[Esc]")} Back`)
            : (isAdmin
                ? "[↑↓] GPU  [a] Allocate  [*] Open-to-all  [x] Clear  [Shift+K] Kill  [ctrl+x ↓] Runner  [Esc] Back"
                : "[↑↓] GPU  [ctrl+x ↓] Runner  [Esc] Back  [r] Refresh   (read-only)")),
      fg: C.textDim,
    }),
    Text({
      content: adminHint + (sudoInfoMsg ? ` · ${sudoInfoMsg}` : ""),
      fg: C.textDim,
    }),
    Text({ content: statusMsg ? ` ${statusMsg}` : " ", fg: statusMsg ? C.yellow : C.textDim })
  );

  return Box(
    { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
    Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 1 },
      ...children
    ),
  );
}

function renderHelp() {
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      backgroundColor: C.bg,
    },
    Text({ content: t`${bold("Help — Keyboard Shortcuts")}`, fg: C.text }),
    Text({ content: " " }),
    Text({ content: "Navigation:", fg: C.text }),
    Text({ content: "  ↑/↓ or j/k    Move selection", fg: C.textDim }),
    Text({ content: "  Enter         Open detail / action", fg: C.textDim }),
    Text({ content: "  Esc           Back to dashboard", fg: C.textDim }),
    Text({ content: " " }),
    Text({ content: "Tabs (Switcher: Ctrl+X, T):", fg: C.text }),
    Text({ content: "  d             Dashboard", fg: C.textDim }),
    Text({ content: "  n             Node detail (in Dashboard)", fg: C.textDim }),
    Text({ content: "  g             My GPU View", fg: C.textDim }),
    Text({ content: "  j             Jobs", fg: C.textDim }),
    Text({ content: "  h             Help", fg: C.textDim }),
    Text({ content: " " }),
    Text({ content: "Dashboard Actions:", fg: C.text }),
    Text({ content: "  a             Allocate GPU to user", fg: C.textDim }),
    Text({ content: "  x             Clear GPU allocation", fg: C.textDim }),
    Text({ content: "  Shift+K       Kill violator processes", fg: C.textDim }),
    Text({ content: "  r             Refresh cluster data", fg: C.textDim }),
    Text({ content: " " }),
    Text({ content: "Command Runner:", fg: C.text }),
    Text({ content: "  Ctrl+X ↓      Focus runner pane", fg: C.textDim }),
    Text({ content: "  Ctrl+X F      Fold/unfold runner pane", fg: C.textDim }),
    Text({ content: "  Ctrl+X Enter  Execute command", fg: C.textDim }),
    Text({ content: "  Tab/Shift+Tab Toggle mode/distribution", fg: C.textDim }),
    Text({ content: "  Q             Toggle queue mode", fg: C.textDim }),
    Text({ content: " " }),
    Text({ content: "Setup (Ctrl+X T → Setup):", fg: C.text }),
    Text({ content: "  ↑/↓           Select node", fg: C.textDim }),
    Text({ content: "  Enter         Edit node env config", fg: C.textDim }),
    Text({ content: "  Tab           Next field", fg: C.textDim }),
    Text({ content: "  S             Save to opensmi.json", fg: C.textDim }),
    Text({ content: " " }),
    Text({ content: "Quit:  q", fg: C.text }),
  );
}

/** Sanitize a string for use as a tmux session name.
 *  '#' is a tmux special char (session#window separator) and must be replaced. */
function tmuxSafeName(s: string): string {
  return s.replace(/#/g, "-").replace(/[.:]/g, "-");
}

async function captureTmuxPane(sessionName: string, lines = 500): Promise<string> {
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

function getJobStatusIcon(status: string): { icon: string; color: string } {
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

function formatJobTimestamp(isoString: string | null): string {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  } catch {
    return "—";
  }
}

function formatJobDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "—";
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

function formatJobGpus(job: Job): string {
  if (job.gpus.length === 0) {
    if (job.requested_gpu_count > 0) {
      return `(auto×${job.requested_gpu_count})`;
    }
    return "—";
  }
  
  return job.gpus.map(([node, gpu]) => `${node}:${gpu}`).join(",");
}

function renderJobsView() {
  if (jobDetailView) {
    return renderJobDetailView();
  }
  return renderJobsListView();
}

function renderJobsListView() {
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
      content: t`Total: ${jobList.length}  ${isPolling ? fg(C.yellow)("⟳") : ""}`,
      fg: C.text,
    })
  );

  if (jobList.length === 0) {
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
  // Fixed: prefix(2) + id(9) + status(12) + gpus(18) + runtime(10) + spacing(5) = ~56
  const cmdWidth = Math.max(termWidth - 56, 10);

  for (let i = 0; i < jobList.length; i++) {
    const job = jobList[i];
    const selected = i === selectedJobIdx;
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
  rows.push(
    Text({
      content: t`${fg(C.textDim)("[Enter]")} Detail  ${fg(C.textDim)("[c]")} Cancel  ${fg(C.textDim)("[Shift+R]")} Retry  ${fg(C.textDim)("[x]")} Clean tmux  ${fg(C.textDim)("[d]")} Delete  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[↑/↓]")} Navigate  ${fg(C.textDim)("[Esc]")} Back`,
      fg: C.textDim,
    })
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
    header,
    Text({ content: "" }),
    ...rows
  );
}

function renderJobDetailView() {
  if (!jobDetailView) return renderJobsListView();
  
  // Log view mode: show captured tmux pane output
  if (jobDetailLogView !== null) {
    const logLines = jobDetailLogView.split("\n");
    const termHeight = process.stdout.rows || 40;
    const termWidth = process.stdout.columns || 80;
    const visibleLines = termHeight - 4;
    const maxScroll = Math.max(0, logLines.length - visibleLines);
    jobDetailLogScroll = Math.min(jobDetailLogScroll, maxScroll);
    
    const displayLines = logLines.slice(jobDetailLogScroll, jobDetailLogScroll + visibleLines);
    
    const rows: any[] = [];
    rows.push(Text({
      content: t`${bold(fg(C.blue)("Log"))} — ${jobDetailLogSession}  ${fg(C.textDim)(`(${jobDetailLogScroll + 1}-${jobDetailLogScroll + displayLines.length}/${logLines.length} lines)`)}`,
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
  
  const job = jobDetailView;
  const statusInfo = getJobStatusIcon(job.status);
  const liveness = gpuLivenessCache.get(job.id) || {};
  const termWidth = process.stdout.columns || 80;
  const contentWidth = Math.max(termWidth - 6, 30);  // padding=2 each side + some margin
  
  // Build list of sessions for navigation
  const sessionEntries: Array<{ label: string; session: string | null; color: string }> = [];
  
  if (job.dist_mode === "single") {
    // Single command → one or more sessions
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
    // One-to-one: each command has its own session
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
    jobDetailSelectedCmd = Math.min(jobDetailSelectedCmd, sessionEntries.length - 1);
  }
  
  const rows: any[] = [];
  rows.push(
    Text({ content: t`${bold(fg(C.blue)(`Job ${job.id}`))} — ${job.command.slice(0, contentWidth - 16)}` })
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
      const selected = i === jobDetailSelectedCmd;
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
      content: t`${fg(C.textDim)("[↑↓]")} Select  ${fg(C.textDim)("[Enter]")} View log  ${fg(C.textDim)("[c]")} Cancel  ${fg(C.textDim)("[r]")} Retry selected  ${fg(C.textDim)("[Shift+R]")} Retry all  ${fg(C.textDim)("[x]")} Clean tmux  ${fg(C.textDim)("[Esc]")} Back`,
      fg: C.textDim,
    })
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
    ...rows
  );
}

function renderMyGpuView() {
  const bundles = computeGpuBundles();
  myGpuViewState.bundles = bundles;
  
  if (bundles.length === 0) {
    return Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
      Text({ content: t`${bold(fg(C.blue)("My GPUs"))} · Operator: ${fg(C.cyan)(OPERATOR)}`, fg: C.text }),
      Text({ content: "" }),
      Text({ content: "No GPUs found", fg: C.yellow }),
      Text({ content: "" }),
      Text({ content: "• No allocations to you", fg: C.textDim }),
      Text({ content: "• No active processes from you", fg: C.textDim }),
      Text({ content: "• No pinned GPUs", fg: C.textDim }),
      Text({ content: "" }),
      Text({ content: "[+] Pin a GPU from dashboard (not implemented yet)", fg: C.textDim }),
      Text({ content: "[Esc] Back to dashboard", fg: C.textDim })
    );
  }
  
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
      content: t`${bold(fg(C.blue)("My GPUs"))} ${fg(C.textDim)("· Operator:")} ${fg(C.cyan)(OPERATOR)}`,
    }),
    Text({
      content: t`Bundles: ${bundles.length}  Poll: ${lastPollTime || "—"}  ${isPolling ? fg(C.yellow)("⟳") : ""}`,
      fg: C.text,
    })
  );
  
  const bundleRows: any[] = [];
  bundleRows.push(
    Text({
      content: t`${fg(C.cyan)("GPU Bundles")}`,
      fg: C.cyan,
    })
  );
  
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    const isSelected = i === myGpuViewState.selectedBundleIdx;
    const prefix = isSelected ? "▸ " : "  ";
    const shortcutLabel = bundle.shortcut ? ` [${bundle.shortcut}]` : "";
    
    bundleRows.push(
      Text({
        content: `${prefix}${bundle.label}${shortcutLabel}`,
        fg: isSelected ? C.yellow : C.text,
      })
    );
  }
  
  bundleRows.push(Text({ content: "" }));
  
  const selectedBundle = bundles[myGpuViewState.selectedBundleIdx];
  const gpuDetails: any[] = [];
  
  if (selectedBundle && snapshot) {
    gpuDetails.push(
      Text({
        content: t`${bold(fg(C.cyan)(selectedBundle.label))}`,
      })
    );
    gpuDetails.push(Text({ content: "" }));
    
    for (const gpuRef of selectedBundle.gpus) {
      const node = snapshot.nodes.find(n => n.node_alias === gpuRef.node);
      if (!node || node.error) {
        gpuDetails.push(
          Text({
            content: `  ${gpuRef.node}:GPU${gpuRef.gpu} — ERROR`,
            fg: C.red,
          })
        );
        continue;
      }
      
      const gpu = node.gpus.find(g => g.index === gpuRef.gpu);
      if (!gpu) {
        gpuDetails.push(
          Text({
            content: `  ${gpuRef.node}:GPU${gpuRef.gpu} — NOT FOUND`,
            fg: C.red,
          })
        );
        continue;
      }
      
      const procs = node.processes.filter(p => p.gpu_uuid === gpu.uuid);
      const alloc = getAllocation(gpuRef.node, gpuRef.gpu);
      const allocStr = alloc ? alloc.target : "*";
      const utilVal = gpuUtilPct(gpu);
      const utilStr = utilVal !== null ? `${utilVal}%` : "?";
      const activityStr = gpuActivityStatus(node, gpuRef.gpu, gpu.uuid);
      
      gpuDetails.push(
        Text({
          content: `  ${gpuRef.node}:GPU${gpuRef.gpu}  |  ${gpu.name}  |  ${gpuMemStr(gpu.memory_used_mib)}/${gpuMemStr(gpu.memory_total_mib)}  |  Load ${utilStr}  |  ${activityStr}`,
          fg: procs.length > 0 ? C.green : C.textDim,
        })
      );
      
      for (const p of procs) {
        const mem = p.used_memory_mib !== null ? `${p.used_memory_mib} MiB` : "?";
        const rt = runtimeStr(p.runtime_s);
        gpuDetails.push(
          Text({
            content: `    PID ${String(p.pid).padEnd(8)} ${p.user.padEnd(14)} ${mem.padStart(10)} ${rt.padStart(6)}  ${p.process_name}`,
            fg: C.text,
          })
        );
      }
    }
  }
  
  const footer = Box(
    {
      width: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingTop: 1,
    },
    Text({
      content: runnerInputTyping
        ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
        : (runnerFocused
            ? t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Esc]")} Unfocus  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+x Enter]")} Execute  ${fg(C.textDim)("[Tab/+/-]")} Options`
            : t`[↑↓] Navigate Bundles  [ctrl+x r] Run Command  [ctrl+x ↓] Runner  [ctrl+x t] Switch Tab  [Esc] Dashboard`),
      fg: C.textDim,
    }),
    Text({
      content: statusMsg ? t`${fg(C.yellow)(statusMsg)}` : " ",
    })
  );
  
  return Box(
    { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
    Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 1 },
      header,
      ...bundleRows,
      ...gpuDetails,
      footer
    ),
  );
}

function renderAlloc() {
  const ctx = allocCtx;
  if (!ctx) return Text({ content: "No allocation context", fg: C.red });

  const nodeSnap = snapshot?.nodes.find((n) => n.node_alias === ctx.nodeAlias) || null;
  const gpuInfo = nodeSnap?.gpus.find((g) => g.index === ctx.gpuIdx) || null;
  const liveUsers = nodeSnap && gpuInfo ? usersOnGpu(nodeSnap, gpuInfo.uuid) : [];

  const currentAlloc = getAllocTarget(ctx.nodeAlias, ctx.gpuIdx);
  const currentAllocStr = currentAlloc ? currentAlloc : "*";
  const liveStr = liveUsers.length ? liveUsers.join(", ") : "(idle)";

  const universe = knownUsers.length ? knownUsers : liveUsers;
  const universeSet = new Set(universe);

  // For multi-user draft (comma-separated), filter only by the last segment being typed.
  const lastSegRaw = (allocDraftUser.split(",").pop() || "");
  const filterToken = lastSegRaw.trim().toLowerCase();

  const filteredUsers = filterToken
    ? universe.filter((u) => u.toLowerCase().includes(filterToken))
    : universe;

  const input = Input({
    id: "alloc-user-input",
    width: "100%",
    value: allocDraftUser,
    placeholder: "* (default) or username", 
    backgroundColor: C.bgAlt,
    focusedBackgroundColor: "#3b4261",
    textColor: "#ffffff",
    cursorColor: C.green,
  });
  input.focus();

  const errorNode = allocErrorMsg
    ? Text({ content: `Error: ${allocErrorMsg}`, fg: C.red })
    : Text({ content: " ", fg: C.textDim });

  const userRows: any[] = [];
  if (!universe.length) {
    userRows.push(Text({ content: "(no users yet)", fg: C.textDim }));
  } else if (!filteredUsers.length) {
    userRows.push(Text({ content: "(no matches)", fg: C.textDim }));
  } else {
    const currentSet = new Set(_filteredDraftList(allocDraftUser, universeSet));

    for (let idx = 0; idx < filteredUsers.length; idx++) {
      const u = filteredUsers[idx];
      const isSel = currentSet.has(u);
      const isFocused = allocUserListFocused && idx === allocUserListIdx;
      userRows.push(
        Box(
          {
            width: "100%",
            height: 1,
            position: "relative",
            paddingLeft: 1,
            backgroundColor: isFocused ? C.green : (allocUserHighlight === u ? "#33467c" : isSel ? "#3b4261" : C.bg),
          },
          Text({ content: `${isSel ? "▸" : " "} ${u}`, fg: isFocused ? "#000000" : (isSel ? "#ffffff" : C.text) }),
          // Overlay to make the row reliably clickable without triggering text selection.
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1, // Low zIndex to allow text selection
            onMouseDown: (_e: any) => {
              _e.preventDefault?.();
              _e.stopPropagation?.();

              // Single click: highlight and focus list. Double click: select user.
              const now = Date.now();
              const clickKey = `USER:${u}`;
              const isDouble = clickKey === lastAllocUserClickKey && now - lastAllocUserClickAt < 350;
              lastAllocUserClickKey = clickKey;
              lastAllocUserClickAt = now;

              // Set focus to user list and highlight this user
              allocUserListFocused = true;
              allocUserListIdx = idx;
              allocUserHighlight = u;

              if (!isDouble) {
                requestRender?.();
                return;
              }

              // Double-click: select user and return to input
              allocDraftUser = u;
              allocUserListFocused = false;
              allocErrorMsg = "";
              requestRender?.();
            },
          })
        )
      );
    }
  }

  const matchesLine = universe.length
    ? `Filter: ${filterToken || "(empty)"}   Matches: ${filteredUsers.length}/${universe.length}`
    : "Filter: (no users)";

  const leftPanel = Box(
    {
      width: 24,
      height: "100%",
      flexDirection: "column",
      gap: 0,
      backgroundColor: C.bgAlt,
      padding: 1,
      overflow: "hidden",
    },
    Text({ content: "Users (scroll)  Click=highlight  DblClick=toggle", fg: C.textDim }),
    ScrollBox(
      {
        id: "alloc-users-scroll",
        flexGrow: 1,
        width: "100%",
        overflow: "hidden",
        scrollY: true,
        // Force scrollbar visible so it's obvious there are more users.
        verticalScrollbarOptions: {
          visible: true,
          showArrows: false,
        },
      },
      ...userRows
    )
  );

  const selectedUsers = _filteredDraftList(allocDraftUser, universeSet);
  const selectedRows: any[] = selectedUsers.length
    ? selectedUsers.map((u) => Text({ content: `  ${u}`, fg: C.text }))
    : [Text({ content: "  (none)", fg: C.textDim })];

  const rightPanel = Box(
    { flexDirection: "column", flexGrow: 1, height: "100%", gap: 1, overflow: "hidden" },
    Text({
      content: `Target: ${ctx.nodeAlias} GPU${ctx.gpuIdx}${gpuInfo ? ` — ${gpuInfo.name} (${gpuMemStr(gpuInfo.memory_total_mib)})` : ""}`,
      fg: C.cyan,
    }),
    Text({ content: `Current allocation: ${currentAllocStr}`, fg: C.textDim }),
    Text({ content: `Live users: ${liveStr}`, fg: C.textDim }),
    Text({ content: "Selected users:", fg: C.textDim }),
    ScrollBox(
      {
        id: "alloc-selected-scroll",
        height: 6,
        width: "100%",
        overflow: "hidden",
        scrollY: true,
        verticalScrollbarOptions: { visible: true, showArrows: false },
      },
      ...selectedRows
    ),
    Text({ content: "Enter username (default: * for everyone):", fg: C.textDim }),
    input,
    Text({ content: "[Tab] Autocomplete last segment", fg: C.textDim }),
    Text({ content: matchesLine, fg: C.textDim }),
    errorNode,
    Text({ content: "[Enter] Save    [Esc] Cancel", fg: C.textDim })
  );

  const modal = Box(
    {
      width: 92,
      maxHeight: "90%",
      borderStyle: "rounded",
      borderColor: C.border,
      title: "Allocate GPU",
      titleAlignment: "center",
      padding: 1,
      flexDirection: "column",
      gap: 1,
      backgroundColor: C.bg,
      overflow: "hidden",
    },
    Box(
      { flexDirection: "row", gap: 2, flexGrow: 1, width: "100%", overflow: "hidden" },
      leftPanel,
      rightPanel
    ),
    Text({ content: "Tip: click users to toggle. Multi-user saved as comma-separated list.", fg: C.textDim })
  );

  return Box(
    {
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: C.bg,
    },
    modal
  );
}

function renderKill() {
  const ctx = killCtx;
  if (!ctx) return Text({ content: "No kill context", fg: C.red });

  const header = Text({
    content: `Target: ${ctx.nodeAlias} GPU${ctx.gpuIdx}`,
    fg: C.cyan,
  });

  const pidNodes: any[] = [];
  if (!ctx.pids.length) {
    pidNodes.push(Text({ content: "(no violators)", fg: C.textDim }));
  } else {
    for (let i = 0; i < ctx.pids.length; i++) {
      const pid = ctx.pids[i]!;
      const user = ctx.users[i] || "unknown";
      pidNodes.push(Text({ content: `  PID ${pid} (${user})`, fg: C.text }));
    }
  }

  const errorNode = killErrorMsg
    ? Text({ content: `Error: ${killErrorMsg}`, fg: C.red })
    : Text({ content: " ", fg: C.textDim });

  const outPreview = (killOutput || "")
    .split("\n")
    .filter((l) => l.trim() && !l.includes("__OPENSMI_KILL_"))
    .slice(-6)
    .join("\n");

  const outNode = outPreview
    ? Text({ content: outPreview, fg: C.textDim })
    : Text({ content: " ", fg: C.textDim });

  const hint = Text({
    content:
      "Note: killing other users' processes usually requires passwordless sudo on the node (sudo -n).",
    fg: C.textDim,
  });

  const footer = killInProgress
    ? Text({ content: "Killing...", fg: C.yellow })
    : Text({ content: "[Enter] Confirm kill    [Esc] Cancel", fg: C.textDim });

  const modal = Box(
    {
      width: 80,
      borderStyle: "rounded",
      borderColor: C.border,
      title: "Kill violator processes",
      titleAlignment: "center",
      padding: 1,
      flexDirection: "column",
      gap: 1,
      backgroundColor: C.bg,
    },
    header,
    Text({ content: "PIDs to signal (TERM):", fg: C.textDim }),
    ...pidNodes,
    hint,
    errorNode,
    outNode,
    footer
  );

  return Box(
    {
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: C.bg,
    },
    modal
  );
}

function renderGpuAssignmentPanel() {
  if (!snapshot) {
    return Box(
      { flexDirection: "column", width: "100%", gap: 0 },
      Text({ content: "GPU Assignment", fg: C.textDim }),
      Text({ content: "  No snapshot available", fg: C.red })
    );
  }
  
  let modeText = launchGpuMode === "auto" 
    ? "(Auto-ranked)              [click to exclude]  [g] manual"
    : "(Manual selection)         [click to toggle]  [g] auto";
  
  if (launchSourceBundle) {
    modeText = `(From bundle: ${launchSourceBundle})         [g] auto`;
  }
  
  const headerNode = Text({ 
    content: `GPU Assignment  ${modeText}`, 
    fg: C.textDim 
  });
  
  const gpuRows: any[] = [];
  
  if (launchSelectedGpus.length === 0) {
    gpuRows.push(
      Text({ 
        content: "  No GPUs selected. Press [+] to add GPUs.", 
        fg: C.yellow 
      })
    );
  }
  
  const gpuInfoMap = new Map<string, { gpu: GPUInfo; node: NodeSnapshot; allocated: boolean; allocTarget: string }>();
  for (const node of snapshot.nodes) {
    for (const gpu of node.gpus) {
      const key = `${node.node_alias}:${gpu.index}`;
      const alloc = allocations.find(a => a.node_alias === node.node_alias && a.gpu_index === gpu.index);
      gpuInfoMap.set(key, {
        gpu,
        node,
        allocated: !!alloc,
        allocTarget: alloc?.target || ""
      });
    }
  }
  
  if (launchSelectedGpus.length > 0) {
    
    for (let i = 0; i < launchSelectedGpus.length; i++) {
      const selectedGpu = launchSelectedGpus[i]!;
      const key = `${selectedGpu.node}:${selectedGpu.gpu}`;
      const gpuData = gpuInfoMap.get(key);
      
      if (!gpuData) {
        gpuRows.push(
          Text({ 
            content: `  [${i + 1}] ● ${key}  (GPU not found in snapshot)`, 
            fg: C.red 
          })
        );
        continue;
      }
      
      const { gpu, node, allocated, allocTarget } = gpuData;
      
      // Calculate GPU info
      const memFree = gpu.memory_free_mib ?? 0;
      const memTotal = gpu.memory_total_mib ?? 0;
      const memFreeG = Math.floor(memFree / 1024);
      const util = gpu.utilization_gpu_percent ?? gpu.utilization_gpu ?? 0;
      
      // Calculate idle time
      const gpuIdleKey = `${node.node_alias}:${gpu.uuid}`;
      const idleStartTime = gpuIdleStart[gpuIdleKey] || Date.now();
      const idleMs = Date.now() - idleStartTime;
      const idleHours = Math.floor(idleMs / (1000 * 60 * 60));
      const idleMinutes = Math.floor((idleMs % (1000 * 60 * 60)) / (1000 * 60));
      const idleDisplay = idleHours > 0 ? `${idleHours}h` : `${idleMinutes}m`;
      
      // Count processes on this GPU
      const procCount = node.processes.filter(p => p.gpu_uuid === gpu.uuid).length;
      
      // Build status indicators
      const isSelected = true; // All GPUs in launchSelectedGpus are selected
      const selectionIndicator = isSelected ? "●" : "○";
      
      // Build reasoning text (why this GPU was selected)
      let reasoning = "";
      let reasoningColor = C.green; // Default good state
      
      if (launchGpuMode === "auto") {
        if (procCount === 0 && util < 10) {
          reasoning = "✓ idle, unused";
          reasoningColor = C.green;
        } else if (procCount === 0) {
          reasoning = "✓ no processes";
          reasoningColor = C.green;
        } else if (procCount < 3) {
          reasoning = "✓ few processes";
          reasoningColor = C.yellow;
        } else {
          reasoning = "⚠ busy";
          reasoningColor = C.red;
        }
      }
      
      // Allocation warning
      let allocWarning = "";
      let hasAllocConflict = false;
      if (allocated && allocTarget !== OPERATOR && !allocTarget.split(",").includes(OPERATOR)) {
        allocWarning = `  ✗ allocated to ${allocTarget}`;
        reasoning = `${reasoning}  ${allocWarning}`;
        hasAllocConflict = true;
        reasoningColor = C.red; // Override with red for allocation conflict
      }
      
      // Build line content
      const linePrefix = launchDistMode === "one-to-one" 
        ? `Command ${i + 1} → ` 
        : `  `;
      
      const lineContent = `${linePrefix}[${i + 1}] ${selectionIndicator} ${node.node_alias}:GPU${gpu.index}  [${allocTarget || OPERATOR}]  ${memFreeG}G free  idle ${idleDisplay}  ${reasoning}`;
      
      // Color logic: red for conflicts, yellow for warnings, green for good, textDim for neutral
      const lineFg = hasAllocConflict ? C.red : (procCount > 2 ? C.yellow : (procCount === 0 ? C.green : C.textDim));
      
      // Create clickable GPU row
      const gpuRow = Box(
        {
          width: "100%",
          height: 1,
          position: "relative",
        },
        Text({ content: lineContent, fg: lineFg }),
        Box({
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 1,
          onMouseDown: (e: any) => {
            runnerMouseDownTime = Date.now();
            runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
          },
          onMouseUp: (e: any) => {
            const elapsed = Date.now() - runnerMouseDownTime;
            const moved = runnerMouseDownPos && (
              Math.abs((e?.clientX ?? 0) - runnerMouseDownPos.x) > 5 ||
              Math.abs((e?.clientY ?? 0) - runnerMouseDownPos.y) > 5
            );
            
            if (moved || elapsed > 300) {
              return; // Was a drag, don't trigger click
            }
            
            // Handle GPU click based on mode
            if (launchGpuMode === "auto") {
              // In auto mode, clicking excludes GPU (not implemented yet - would need exclusion list)
              setStatus("Auto mode: GPU exclusion not yet implemented. Use [g] for manual mode.");
            } else {
              // In selected mode, clicking removes GPU
              const idx = launchManualGpus.findIndex(
                g => g.node === selectedGpu.node && g.gpu === selectedGpu.gpu
              );
              if (idx !== -1) {
                launchManualGpus.splice(idx, 1);
                launchNumGpus = launchManualGpus.length;
                launchSelectedGpus = launchManualGpus.slice(0, launchNumGpus);
                setStatus(`Removed ${key} from selection`);
              }
            }
            requestRender?.();
          },
        })
      );
      
      gpuRows.push(gpuRow);
    }
  }
  
  const numSelected = launchSelectedGpus.length;
  const numWithConflicts = launchSelectedGpus.filter((gpu, i) => {
    const key = `${gpu.node}:${gpu.gpu}`;
    const gpuData = gpuInfoMap.get(key);
    if (!gpuData) return false;
    const { allocated, allocTarget } = gpuData;
    return allocated && allocTarget !== OPERATOR && !allocTarget.split(",").includes(OPERATOR);
  }).length;
  
  const summaryText = numSelected === 0
    ? Text({ content: `  Selected: 0 GPUs`, fg: C.textDim })
    : (numWithConflicts > 0
      ? Text({ content: `  Selected: ${numSelected} GPUs  (${numWithConflicts} with allocation conflicts)`, fg: C.red })
      : Text({ content: `  Selected: ${numSelected} GPUs  ✓ All available`, fg: C.green }));
  
  const helpText = launchGpuMode === "auto"
    ? Text({ content: "  [click GPU] toggle  [+/-] adjust count  [g] switch to manual", fg: C.textDim })
    : Text({ content: "  [click GPU] remove  [+/-] adjust  [g] switch to auto", fg: C.textDim });
  
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      gap: 0,
      borderStyle: "single",
      borderColor: C.border,
      padding: 0,
      paddingLeft: 1,
      paddingRight: 1,
    },
    headerNode,
    ...gpuRows,
    summaryText,
    helpText
  );
}

// ── Setup Tab ──────────────────────────────────────────────────────

interface NodeEnvConfig {
  alias: string;
  env_manager: string;
  env_name: string;
  work_dir: string;
}

let setupNodes: NodeEnvConfig[] = [];
let setupSelectedIdx = 0;
let setupEditingField: "env_manager" | "env_name" | "work_dir" | null = null;
let setupEditBuffer = "";
let setupMessage = "";
let setupMessageTimeout: ReturnType<typeof setTimeout> | null = null;
let setupDirtyAliases = new Set<string>();

function setSetupMessage(msg: string, ms = 2000) {
  setupMessage = msg;
  if (setupMessageTimeout) clearTimeout(setupMessageTimeout);
  setupMessageTimeout = setTimeout(() => { setupMessage = ""; requestRender?.(); }, ms);
}

async function loadSetupNodes(): Promise<void> {
  // Always read opensmi.json directly — this is config, not runtime state.
  // Never depend on cluster snapshot (which requires SSH poll).
  setupNodes = [];

  const configPaths = [
    process.env.OPENSMI_CONFIG,
    `${getStateDir()}/opensmi.json`,
  ].filter(Boolean) as string[];

  let nodes: Array<{ alias: string; env_manager?: string; env_name?: string; work_dir?: string }> = [];
  let loadedFrom = "(none)";

  for (const cp of configPaths) {
    try {
      const exists = existsSync(cp!);
      tuiLog("DEBUG", `loadSetupNodes: trying ${cp} exists=${exists}`);
      if (!exists) continue;
      const raw = await Bun.file(cp!).text();
      const cfg = JSON.parse(raw);
      if (Array.isArray(cfg.nodes) && cfg.nodes.length > 0) {
        nodes = cfg.nodes;
        loadedFrom = cp!;
        break;
      }
    } catch (e: any) {
      tuiLog("ERROR", `loadSetupNodes: failed reading ${cp}: ${e?.message || e}`);
      continue;
    }
  }

  for (const n of nodes) {
    setupNodes.push({
      alias: String(n.alias || "").replace(/#/g, "-").replace(/:/g, "-"),
      env_manager: String(n.env_manager || ""),
      env_name: String(n.env_name || ""),
      work_dir: String(n.work_dir || ""),
    });
  }

  setupNodes.sort((a, b) => a.alias.localeCompare(b.alias));
  tuiLog("INFO", `loadSetupNodes: ${setupNodes.length} nodes from ${loadedFrom} (candidates: ${configPaths.join(", ")})`);
}

async function saveSetupNode(node: NodeEnvConfig): Promise<boolean> {
  // Write directly to opensmi.json — no CLI dependency.
  const configPaths = [
    process.env.OPENSMI_CONFIG,
    `${getStateDir()}/opensmi.json`,
  ].filter(Boolean) as string[];

  for (const cp of configPaths) {
    try {
      const raw = await Bun.file(cp!).text();
      const cfg = JSON.parse(raw);
      if (!Array.isArray(cfg.nodes)) continue;

      const target = cfg.nodes.find((n: any) => 
        String(n.alias || "").replace(/#/g, "-").replace(/:/g, "-") === node.alias
      );
      if (!target) continue;

      // Set or remove fields (keep config clean)
      if (node.env_manager) target.env_manager = node.env_manager;
      else delete target.env_manager;
      if (node.env_name) target.env_name = node.env_name;
      else delete target.env_name;
      if (node.work_dir) target.work_dir = node.work_dir;
      else delete target.work_dir;

      await Bun.write(cp!, JSON.stringify(cfg, null, 2) + "\n");
      return true;
    } catch { continue; }
  }
  return false;
}

function markSetupNodeDirty(node: NodeEnvConfig | undefined): void {
  if (!node) return;
  setupDirtyAliases.add(node.alias);
}

async function flushSetupChangesToConfig(): Promise<void> {
  // If user is still typing in setup editor, commit the buffer first.
  if (setupEditingField) {
    const node = setupNodes[setupSelectedIdx];
    if (node) {
      node[setupEditingField] = setupEditBuffer.trim();
      markSetupNodeDirty(node);
    }
    setupEditingField = null;
    setupEditBuffer = "";
  }

  if (setupDirtyAliases.size === 0) {
    return;
  }

  const failed: string[] = [];

  for (const alias of Array.from(setupDirtyAliases)) {
    const node = setupNodes.find((n) => n.alias === alias);
    if (!node) {
      setupDirtyAliases.delete(alias);
      continue;
    }

    const ok = await saveSetupNode(node);
    if (ok) {
      setupDirtyAliases.delete(alias);
      tuiLog("INFO", `setup hotfix: persisted node=${alias}`);
    } else {
      failed.push(alias);
      tuiLog("ERROR", `setup hotfix: failed persisting node=${alias}`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`Setup save failed for: ${failed.join(", ")}`);
  }
}

function renderSetupView() {
  tuiLog("INFO", `renderSetupView called: setupNodes.length=${setupNodes.length}, setupSelectedIdx=${setupSelectedIdx}`);
  const rows: any[] = [];

  rows.push(Text({ content: t`${bold("Setup")} — Per-Node Environment Configuration`, fg: C.text }));
  rows.push(Text({ content: t`${fg(C.textDim)("Configure conda/micromamba/venv and work directory per node. Saved to opensmi.json.")}` }));
  rows.push(Text({ content: " " }));

  if (setupNodes.length === 0) {
    rows.push(Text({ content: "  No nodes found in opensmi.json.", fg: C.textDim }));
    rows.push(Text({ content: `  Config search paths:`, fg: C.textDim }));
    const paths = [
      process.env.OPENSMI_CONFIG,
      `${getStateDir()}/opensmi.json`,
    ].filter(Boolean) as string[];
    for (const p of paths) {
      const exists = existsSync(p);
      rows.push(Text({ content: `    ${exists ? "✓" : "✗"} ${p}`, fg: exists ? C.green : C.textDim }));
    }
    rows.push(Text({ content: " " }));
    rows.push(Text({ content: "  Run 'opensmi init' to create a config, or set OPENSMI_CONFIG.", fg: C.textDim }));
  }

  for (let i = 0; i < setupNodes.length; i++) {
    const n = setupNodes[i];
    const selected = i === setupSelectedIdx;
    const prefix = selected ? "▸ " : "  ";
    const color = selected ? C.green : C.text;

    const envStr = n.env_manager && n.env_name
      ? `${n.env_manager}:${n.env_name}`
      : "(none)";
    const dirStr = n.work_dir || "(none)";

    rows.push(Text({
      content: t`${fg(color)(`${prefix}${n.alias.padEnd(14)} env: ${envStr.padEnd(25)} dir: ${dirStr}`)}`,
    }));

    // Show edit fields for selected node
    if (selected && setupEditingField) {
      const fields: Array<{ label: string; key: "env_manager" | "env_name" | "work_dir"; hint: string }> = [
        { label: "Env Manager", key: "env_manager", hint: "conda / miniconda / micromamba / venv" },
        { label: "Env Name   ", key: "env_name", hint: "e.g. ml, torch2" },
        { label: "Work Dir   ", key: "work_dir", hint: "e.g. ~/projects" },
      ];
      for (const f of fields) {
        const editing = setupEditingField === f.key;
        const val = String(editing ? setupEditBuffer : (n[f.key] ?? ""));
        const lineColor = editing ? "#9b59d6" : C.textDim;
        const cursor = editing ? "█" : "";
        const hint = editing ? "" : ` (${f.hint})`;
        rows.push(Text({
          content: `    ${f.label}: ${val}${cursor}${hint}`,
          fg: lineColor,
        }));
      }
    }
  }

  rows.push(Text({ content: " " }));
  rows.push(Text({ content: t`${fg(C.textDim)("↑↓ select  Enter edit  Tab next field  Esc cancel  S save")}` }));
  if (setupMessage) {
    rows.push(Text({ content: t`${fg(C.green)(setupMessage)}` }));
  }

  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      backgroundColor: C.bg,
    },
    ...rows
  );
}

function renderRunnerPane() {
  const height = runnerPaneFolded ? 3 : "40%"; // 40% of terminal height when unfolded
  
  const foldIcon = runnerPaneFolded ? "▸" : "▾";
  const focusIndicator = runnerFocused 
    ? (runnerInputTyping ? "⌨ typing" : "● focused") 
    : "○ idle";
  
  const headerText = Text({ 
    content: `${foldIcon} Command Runner  ${focusIndicator}`, 
    fg: runnerInputTyping ? "#9b59d6" : (runnerFocused ? C.green : C.cyan)
  });
  
  const helpText = Text({ 
    content: runnerInputTyping
      ? "[Enter] Execute  [Esc] Cancel"
      : (runnerFocused
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
      onMouseDown: () => {
        if (runnerInputTyping) return; // Don't toggle while typing
        if (runnerFocused) {
          runnerFocused = false;
          runnerInputTyping = false;
        } else {
          runnerFocused = true;
          runnerFocusedInputIdx = 0;
          runnerInputBuffer = launchCommand;
        }
        requestRender?.();
      },
    },
    headerText,
    helpText
  );
  
  if (runnerPaneFolded) {
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
          runnerPaneFolded = false;
          requestRender?.();
        },
      },
      headerBox
    );
  }
  
  const modeInfo = Text({ 
    content: `Exec: ${launchMode}  Dist: ${launchDistMode}  Queue: ${launchQueueMode}  Count: ${launchNumGpus}`, 
    fg: C.textDim 
  });
  
  const gpuInfo = launchSelectedGpus.length > 0
    ? launchSelectedGpus.map(g => `${g.node}:${g.gpu}`).join(", ")
    : "no GPUs";
  
  const gpuText = Text({ 
    content: `GPUs: ${gpuInfo}`, 
    fg: runnerInputTyping ? "#9b59d6" : (launchSelectedGpus.length > 0 ? C.green : C.yellow)
  });
  
  const errorText = launchErrorMsg
    ? Text({ content: `Error: ${launchErrorMsg}`, fg: C.red })
    : null;
  
  const commandNodes: any[] = [];
  
  // Show hint if no GPUs selected
  if (launchSelectedGpus.length === 0) {
    commandNodes.push(Text({ content: " ", fg: C.textDim }));
    commandNodes.push(Text({ 
      content: "No GPUs selected. Press [+] or click GPU cells to add.", 
      fg: C.yellow 
    }));
  } else if (launchDistMode === "single") {
    commandNodes.push(Text({ content: "Command:", fg: C.textDim }));
    
    const isCmdFocused = runnerFocused && runnerFocusedInputIdx === 0;
    
    if (runnerInputTyping && isCmdFocused) {
      commandNodes.push(Input({
        id: "runner-cmd-input",
        width: "100%",
        value: runnerInputBuffer,
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
            content: `> ${launchCommand || "(click to edit)"}`,
            fg: (runnerInputTyping && isCmdFocused) ? "#9b59d6" : (isCmdFocused ? C.green : C.textDim),
          }),
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1, // Low zIndex to allow text selection
            onMouseDown: (e: any) => {
              runnerMouseDownTime = Date.now();
              runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
            },
            onMouseUp: (e: any) => {
              const elapsed = Date.now() - runnerMouseDownTime;
              const moved = runnerMouseDownPos && (
                Math.abs((e?.clientX ?? 0) - runnerMouseDownPos.x) > 5 ||
                Math.abs((e?.clientY ?? 0) - runnerMouseDownPos.y) > 5
              );
              
              if (moved || elapsed > 300) {
                return; // Was a drag, don't trigger click
              }
              
              if (!runnerFocused) {
                runnerFocused = true;
                runnerInputBuffer = launchCommand;
                runnerFocusedInputIdx = 0;
              } else if (runnerFocusedInputIdx === 0 && !runnerInputTyping) {
                // Second click on same line → typing mode
                runnerInputTyping = true;
                runnerInputBuffer = launchCommand;
              }
              requestRender?.();
            },
          })
        )
      );
    }
  } else {
    // one-to-one mode
    commandNodes.push(Text({ 
      content: `Commands (${launchNumGpus} lines, one per GPU):`, 
      fg: C.textDim 
    }));
    
    if (runnerFocused && runnerInputTyping) {
      for (let i = 0; i < launchNumGpus; i++) {
        const value = launchCommands[i] || "";
        const gpu = launchSelectedGpus[i];
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
      for (let i = 0; i < launchNumGpus; i++) {
        const cmd = launchCommands[i] || "";
        const gpu = launchSelectedGpus[i];
        const label = gpu ? `${gpu.node}:GPU${gpu.gpu}` : `GPU ${i}`;
        const isFocusedLine = runnerFocused && i === runnerFocusedInputIdx;
        commandNodes.push(
          Box(
            { width: "100%", height: 1, position: "relative" },
            Text({
              content: `${label}: ${cmd || "(click to edit)"}`,
              fg: (runnerInputTyping && isFocusedLine) ? "#9b59d6" : (isFocusedLine ? C.green : (cmd.trim() ? C.textDim : C.red)),
            }),
            Box({
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 1, // Low zIndex to allow text selection
              onMouseDown: (e: any) => {
                // Track mousedown for drag detection
                runnerMouseDownTime = Date.now();
                runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
              },
              onMouseUp: (e: any) => {
                // Check if this was a drag (long press or moved)
                const elapsed = Date.now() - runnerMouseDownTime;
                const moved = runnerMouseDownPos && (
                  Math.abs((e?.clientX ?? 0) - runnerMouseDownPos.x) > 5 ||
                  Math.abs((e?.clientY ?? 0) - runnerMouseDownPos.y) > 5
                );
                
                // If dragged, don't trigger click behavior (allow copy)
                if (moved || elapsed > 300) {
                  return;
                }
                
                // This was a click, not a drag
                if (!runnerFocused) {
                  runnerFocused = true;
                  runnerFocusedInputIdx = i;
                } else if (runnerFocusedInputIdx === i && !runnerInputTyping) {
                  // Second click on same line → typing mode
                  runnerInputTyping = true;
                } else {
                  runnerFocusedInputIdx = i;
                }
                requestRender?.();
              },
            })
          )
        );
      }
    }
  }

  const tmuxNodes: any[] = [];
  if (launchMode === "tmux") {
    tmuxNodes.push(Text({ content: " " }));
    tmuxNodes.push(Text({ content: "Tmux session (empty = auto):", fg: C.textDim }));
    
    const isTmuxFocused = runnerFocused && runnerFocusedInputIdx === -1;
    
    if (runnerInputTyping && isTmuxFocused) {
      tmuxNodes.push(Input({
        id: "runner-tmux-session-input",
        value: launchTmuxSession,
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
            content: `> ${launchTmuxSession || "(click to edit)"}`,
            fg: (runnerInputTyping && isTmuxFocused) ? "#9b59d6" : (isTmuxFocused ? C.green : C.textDim),
          }),
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1, // Low zIndex to allow text selection
            onMouseDown: (e: any) => {
              runnerMouseDownTime = Date.now();
              runnerMouseDownPos = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
            },
            onMouseUp: (e: any) => {
              const elapsed = Date.now() - runnerMouseDownTime;
              const moved = runnerMouseDownPos && (
                Math.abs((e?.clientX ?? 0) - runnerMouseDownPos.x) > 5 ||
                Math.abs((e?.clientY ?? 0) - runnerMouseDownPos.y) > 5
              );
              
              if (moved || elapsed > 300) {
                return; // Was a drag, don't trigger click
              }
              
              if (!runnerFocused) {
                runnerFocused = true;
                runnerFocusedInputIdx = -1;
              } else if (runnerFocusedInputIdx === -1 && !runnerInputTyping) {
                // Second click on tmux session → typing mode
                runnerInputTyping = true;
              } else {
                runnerFocusedInputIdx = -1;
              }
              requestRender?.();
            },
          })
        )
      );
    }
  }

  const contentNodes = [
    headerBox,
    modeInfo,
    gpuText,
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
      borderColor: runnerInputTyping ? "#9b59d6" : (runnerFocused ? C.green : C.border),
      backgroundColor: C.bgAlt,
      padding: 1,
      flexDirection: "column",
      gap: 0,
      zIndex: 1000,
      onMouseDown: (e: any) => {
        if (!runnerFocused) {
          e?.preventDefault?.();
          runnerFocused = true;
          runnerInputBuffer = launchCommand;
          runnerInputTyping = false;
          requestRender?.();
        }
      },
    },
    ...contentNodes,
    ...(errorBox ? [errorBox] : [])
  );
}


async function saveJobToStore(): Promise<void> {
  try {
    const jobData: Partial<Job> = {
      command: launchDistMode === "single" ? launchCommand : "",
      commands: launchDistMode === "one-to-one" ? launchCommands.filter(c => c.trim()) : [],
      gpus: launchSelectedGpus.map(g => [g.node, g.gpu] as [string, number]),
      requested_gpu_count: launchNumGpus,
      dist_mode: launchDistMode,
      exec_mode: launchMode,
      queue_mode: launchQueueMode,
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
      setLaunchError(`Failed to save job: ${stderr}`);
      runnerState = "failed";
      return;
    }
    
    let result: any;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      setLaunchError("Failed to parse job submission response");
      runnerState = "failed";
      return;
    }
    
    runnerState = "running";
    setStatus(`Job ${result.job_id} queued successfully`);
    launchOutput = `Job queued: ${result.job_id}\nStatus: ${result.status}\nGPUs: ${launchNumGpus}\nMode: ${launchDistMode} / ${launchMode}`;
    
    await loadJobsFromCLI();
  } catch (e: any) {
    setLaunchError(`Failed to queue job: ${e?.message || String(e)}`);
    runnerState = "failed";
  }
}

/**
 * Create job record from current launch configuration for immediate mode.
 * Returns job_id if successful, null otherwise.
 */
async function createImmediateJob(): Promise<string | null> {
  try {
    const jobData: Partial<Job> = {
      command: launchDistMode === "single" ? launchCommand : "",
      commands: launchDistMode === "one-to-one" ? launchCommands.filter(c => c.trim()) : [],
      gpus: launchSelectedGpus.map(g => [g.node, g.gpu] as [string, number]),
      requested_gpu_count: 0,
      dist_mode: launchDistMode,
      exec_mode: launchMode,
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
      const errMsg = await new Response(proc.stderr).text();
      tuiLog("ERROR", `Failed to create job: ${errMsg}`);
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
async function updateImmediateJob(
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
from opensmi.jobs import load_jobs, save_jobs, get_job, upsert_job
from opensmi.state import get_state_dir
from datetime import datetime, timezone

with open("${tmpFile}", "r") as f:
    update_data = json.load(f)

state_dir = get_state_dir()
jobs = load_jobs(state_dir)
job = get_job(jobs, update_data["job_id"])

if job:
    job.status = update_data["status"]
    job.tmux_sessions = update_data["tmux_sessions"]
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

async function executeLaunch(): Promise<void> {
  tuiLog("INFO", `executeLaunch — mode=${launchMode} dist=${launchDistMode} queue=${launchQueueMode} gpus=${launchSelectedGpus.length} cmd="${launchCommand.slice(0, 80)}"`);
  runnerState = "queued";
  runnerStderr = [];
  runnerAttachCmd = "";
  runnerStartTime = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" });
  
  if (!snapshot) {
    setLaunchError("No snapshot available");
    runnerState = "failed";
    return;
  }
  
  if (launchSelectedGpus.length === 0) {
    setLaunchError("No GPUs available");
    runnerState = "failed";
    return;
  }
  
  if (launchDistMode === "single") {
    if (!launchCommand.trim()) {
      setLaunchError("Command cannot be empty");
      runnerState = "failed";
      return;
    }
  } else {
    const nonEmpty = launchCommands.filter(c => c.trim()).length;
    if (nonEmpty === 0) {
      setLaunchError("At least one command must be provided");
      runnerState = "failed";
      return;
    }
    
    if (nonEmpty !== launchNumGpus) {
      launchErrorMsg = `Expected ${launchNumGpus} commands, got ${nonEmpty}`;
      runnerState = "failed";
      return;
    }
  }
  
  launchErrorMsg = "";
  launchOutput = "";
  runnerState = "preparing";
  
  try {
    // Hotfix: ensure latest setup edits are persisted before any submit/execute.
    await flushSetupChangesToConfig();

    // If queue mode is "queued", save to job store instead of executing immediately
    if (launchQueueMode === "queued") {
      await saveJobToStore();
      return;
    }
    
    // Immediate mode: execute now and track in job store
    
    // Create job record before execution
    const currentJobId = await createImmediateJob();
    if (!currentJobId) {
      setLaunchError("Failed to create job record");
      runnerState = "failed";
      return;
    }
    
    // Update launch history
    const tmpFile = `/tmp/opensmi-gpus-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(launchSelectedGpus));
    
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
    
    runnerState = "sent";
    
    // Execute and collect tmux session names
    const tmuxSessions: string[] = [];
    
    if (launchDistMode === "single") {
      const gpuIndices = launchSelectedGpus.map(g => g.gpu).join(",");
      if (launchMode === "tmux") {
        const nodes = Array.from(new Set(launchSelectedGpus.map(g => g.node)));
        const sessionName = launchTmuxSession.trim() || `opensmi-${currentJobId}-${tmuxSafeName(nodes[0])}`;
        tmuxSessions.push(sessionName);
        // Set launchTmuxSession so executeLaunchTmux uses it
        if (!launchTmuxSession.trim()) {
          launchTmuxSession = sessionName;
        }
        await executeLaunchTmux(launchCommand, gpuIndices);
      } else {
        await executeLaunchDirect(launchCommand, gpuIndices);
      }
    } else {
      // One-to-one mode
      if (launchMode === "tmux") {
        for (let i = 0; i < launchNumGpus; i++) {
          const cmd = launchCommands[i]?.trim();
          if (!cmd) continue;
          const gpu = launchSelectedGpus[i];
          if (!gpu) continue;
          const sessionName = launchTmuxSession.trim()
            ? `${launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
            : `opensmi-${currentJobId}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`;
          tmuxSessions.push(sessionName);
        }
      }
      await executeLaunchOneToOne();
    }
    
    // Update job status after execution
    const finalStatus = launchErrorMsg ? "failed" : (launchMode === "tmux" ? "running" : "done");
    await updateImmediateJob(currentJobId, finalStatus, tmuxSessions, launchErrorMsg || null);
    await loadJobsFromCLI();
    
    if (launchErrorMsg === "") {
      runnerState = "running";
    } else {
      runnerState = "failed";
    }
  } catch (e: any) {
    launchErrorMsg = e?.message || String(e);
    runnerState = "failed";
  }
}


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

async function executeLaunchDirect(command: string, gpuIndices: string): Promise<void> {
  // Remote exec: only supported when all selected GPUs are on one node.
  const nodes = Array.from(new Set(launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    runnerState = "failed";
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

  launchOutput = fullOutput.slice(0, 500);

  if (execStderr) {
    const stderrLines = execStderr.split("\n").filter((l: string) => l.trim());
    runnerStderr = stderrLines.slice(-2).map((l: string) => l.slice(0, 100));
  }

  if (!payload.ok) {
    setLaunchError(
      execStderr.trim() ||
        payload.rawStderr.trim() ||
        "Remote command failed (see Output)"
    );
    runnerState = "failed";
    return;
  }

  setStatus(
    `Launched (remote): ${command.slice(0, 40)}${command.length > 40 ? "..." : ""} on ${launchSelectedGpus.length} GPU(s)`
  );
}


async function executeLaunchOneToOne(): Promise<void> {
  const results: string[] = [];

  for (let i = 0; i < launchNumGpus; i++) {
    const cmd = launchCommands[i]?.trim();
    if (!cmd) continue;

    const gpu = launchSelectedGpus[i];
    if (!gpu) continue;

    const gpuIndex = String(gpu.gpu);

    if (launchMode === "tmux") {
      const sessionName = launchTmuxSession.trim()
        ? `${launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
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
      const execCode = res?.exit_code;
      const output = (res?.stdout || res?.stderr || "").trim();
      const preview = output.slice(0, 30).replace(/\n/g, " ");

      if (!payload.ok) {
        results.push(`${gpu.node}:GPU${gpu.gpu}: FAIL ${preview}${output.length > 30 ? "..." : ""}`);
      } else {
        results.push(`${gpu.node}:GPU${gpu.gpu}: OK ${preview}${output.length > 30 ? "..." : ""}`);
      }
    }
  }

  launchOutput = results.join("\n");

  if (launchMode === "tmux") {
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


async function executeLaunchTmux(command: string, gpuIndices: string): Promise<void> {
  const nodes = Array.from(new Set(launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    runnerState = "failed";
    return;
  }
  const node = nodes[0]!;

  const sessionName = launchTmuxSession.trim() || `opensmi-${Date.now()}-${tmuxSafeName(node)}`;

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
    launchOutput = preflightLines ? `Preflight:\n${preflightLines}` : payload.rawStdout.slice(0, 500);
    setLaunchError(errDetail);
    tuiLog("ERROR", `executeLaunchTmux failed: node=${node} session=${sessionName} err=${errDetail}`);
    runnerState = "failed";
    return;
  }

  const attachHint = `tmux attach -t ${sessionName}`;
  launchOutput = [
    preflightLines ? `Preflight:\n${preflightLines}` : "",
    `Local tmux session: ${sessionName} → SSH to ${node}`,
    "",
    "Attach with:",
    `  ${attachHint}`,
  ]
    .filter(Boolean)
    .join("\n");

  runnerAttachCmd = attachHint;
  runnerTmuxSession = sessionName;
  tuiLog("INFO", `executeLaunchTmux ok: node=${node} session=${sessionName}`);
  setStatus(`Launched (tmux → ${node}): ${sessionName}`);
}


// ── Main ───────────────────────────────────────────────────────────

/**
 * Navigate to a tab using the tab registry.
 * This ensures lifecycle hooks execute and state stays synchronized.
 * 
 * @param tabId - The tab ID to navigate to
 * @returns true if navigation succeeded, false otherwise
 */
async function navigateToTab(tabId: string): Promise<boolean> {
  const switched = await tabRegistry.switchTo(tabId);
  if (switched) {
    screen = tabRegistry.activeTabId as typeof screen;
  }
  return switched;
}

const SMOKE_TEST = process.argv.includes("--smoke-test") || process.env.OPENSMI_SMOKE_TEST === "1";

async function main() {
  // Smoke test mode: initialize renderer and exit immediately.
  // Used in CI/release to catch Bun/OpenTUI runtime crashes early.
  if (SMOKE_TEST) {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useMouse: false,
      useConsole: false,
      useAlternateScreen: false,
      openConsoleOnError: false,
    });

    // Render a single frame worth of UI.
    const container = new BoxRenderable(renderer, {
      id: "smoke-container",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: C.bg,
    });
    renderer.root.add(container);
    container.add(Text({ content: "opensmi-tui smoke test ok" }));
    renderer.requestRender();

    // Let one tick happen then destroy.
    await new Promise((r) => setTimeout(r, 50));
    renderer.destroy();
    process.exit(0);
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Trigger full re-render on terminal resize so colW is recomputed.
  renderer.on("resize", () => requestRender?.());

  // Mouse drag selection → auto-copy (OSC52)
  renderer.on("selection", (sel: any) => {
    try {
      const text = String(sel?.getSelectedText?.() ?? "");
      if (!text.trim()) return;

      if (!renderer.isOsc52Supported()) {
        setStatus("OSC52 unsupported in this terminal (can't auto-copy selection)");
        return;
      }

      const ok = renderer.copyToClipboardOSC52(text);
      
      // Show "Copied" message (2s) in lower right
      const charCount = text.length;
      setStatus(`Copied ${charCount} char${charCount === 1 ? '' : 's'}`, 2000);
      
      // Clear selection immediately after copy (tmux-like behavior)
      // Use setImmediate to clear on next tick, ensuring copy completes first
      setImmediate(() => {
        if (sel?.clearSelection) {
          sel.clearSelection();
        } else if (sel?.setSelection) {
          sel.setSelection(null, null, null);
        }
        requestRender?.();
      });
    } catch {
      // ignore
    }
  });

  // Create a container that we replace entirely on each render
  const container = new BoxRenderable(renderer, {
    id: "main-container",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: C.bg,
  });
  renderer.root.add(container);

  async function loadSystemUsers(force: boolean = false): Promise<void> {
    // Avoid hammering the cluster; refresh at most every 10 minutes unless forced.
    if (!force && systemUsersLoadedAt && Date.now() - systemUsersLoadedAt < 10 * 60_000) return;

    try {
      const { code, stdout, stderr } = await runOpensmi(["users", "--json", "--timeout", "8"]);
      if (code !== 0) {
        setStatus(`Failed to load system users: ${stderr.trim() || `exit ${code}`}`);
        return;
      }
      const data = JSON.parse(stdout) as any;
      const u = Array.isArray(data.users) ? (data.users as string[]) : [];
      systemUsers = u;
      systemUsersLoadedAt = Date.now();
      recomputeKnownUsers();
    } catch {
      // ignore
    }
  }

  function render() {
    // Expire transient status messages
    if (statusMsg && statusUntil > 0 && Date.now() > statusUntil) {
      statusMsg = "";
      statusUntil = 0;
    }

    // Remove all existing children
    const children = container.getChildren();
    for (const c of children) {
      container.remove(c.id);
    }

    let newNode: any;
    if (screen === "setup" || screen === "help") {
      tuiLog("INFO", `render: screen=${screen}, about to switch`);
    }
    switch (screen) {
      case "dashboard":
        newNode = renderDashboard();
        break;
      case "detail":
        newNode = renderDetail();
        break;
      case "help":
        newNode = renderHelp();
        break;
      case "my-gpu-view":
        newNode = renderMyGpuView();
        break;
      case "alloc":
        newNode = renderAlloc();
        break;
      case "kill":
        newNode = renderKill();
        break;
      case "jobs":
        newNode = renderJobsView();
        break;
      case "setup":
        try {
          newNode = renderSetupView();
        } catch (e: any) {
          tuiLog("ERROR", `renderSetupView failed: ${e?.message || String(e)}\n${e?.stack || ""}`);
          newNode = Box({ padding: 1 },
            Text({ content: `ERROR rendering Setup: ${(e as any)?.message || String(e)}`, fg: "red" }),
            Text({ content: `setupNodes: ${setupNodes.length}`, fg: "gray" }),
            Text({ content: `setupSelectedIdx: ${setupSelectedIdx}`, fg: "gray" }),
          );
        }
        break;
    }

    const toast = renderToast();
    const loading = renderLoadingBadge();
    const tabSwitcher = renderTabSwitcher();
    const root = Box(
      { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
      newNode,
      ...(toast ? [toast] : []),
      ...(loading ? [loading] : []),
      ...(tabSwitcher ? [tabSwitcher] : [])
    );
    container.add(root);

    // Hide stale cursor blocks when we leave input screens.
    try {
      if (screen !== "alloc") {
        renderer.setCursorPosition(0, 0, false);
      }
    } catch {
      // ignore
    }
    
    // Auto-refocus runner input when typing
    if (runnerInputTyping || runnerFocused) {
      setTimeout(() => {
        if (launchDistMode === "single") {
          const inputAny: any = container.findDescendantById("runner-cmd-input");
          if (inputAny) inputAny.focus();
        } else {
          const inputAny: any = container.findDescendantById("runner-cmd-input-0");
          if (inputAny) inputAny.focus();
        }
      }, 10);
    }
  }
  requestRender = render;

  tabRegistry.onMessage = (msg: string) => {
    setStatus(msg, 2000);
  };

  tabRegistry.register({
    id: "dashboard",
    label: "Dashboard",
    shortcut: "d",
    render: renderDashboard,
    onEnter: async () => {
      await Promise.all([pollCluster(), loadAllocations()]);
    },
  });

  tabRegistry.register({
    id: "detail",
    label: "Node Detail",
    shortcut: "n",
    render: renderDetail,
    hidden: true,
  });

  tabRegistry.register({
    id: "help",
    label: "Help",
    shortcut: "h",
    render: renderHelp,
  });

  tabRegistry.register({
    id: "jobs",
    label: "Jobs",
    shortcut: "j",
    render: renderJobsView,
    onEnter: async () => {
      await loadJobsFromCLI();
    },
  });

  tabRegistry.register({
    id: "my-gpu-view",
    label: "My GPUs",
    shortcut: "g",
    render: renderMyGpuView,
    onEnter: async () => {
      await loadMyGpuViewState();
      await Promise.all([pollCluster(), loadAllocations()]);
    },
  });

  tabRegistry.register({
    id: "setup",
    label: "Setup",
    shortcut: "s",
    render: renderSetupView,
    onEnter: async () => {
      try {
        await loadSetupNodes();
      } catch (e: any) {
        tuiLog("ERROR", `setup onEnter failed: ${e?.message || String(e)}`);
        setSetupMessage(`Error loading nodes: ${(e?.message || String(e)).slice(0, 60)}`);
      }
    },
  });

  render();

  // Cleanup stale temp files from previous crashes (older than 5 minutes)
  try {
    await Bun.$`find /tmp -maxdepth 1 -name 'opensmi-*.json' -mmin +5 -delete 2>/dev/null || true`;
  } catch {}

  // Initial load
  // Keep loading spinner animated while bootLoading is true.
  const bootSpinInterval = setInterval(() => {
    if (bootLoading) render();
  }, 80);

  await Promise.all([
    loadAdminStatus(),
    pollCluster(),
    loadAllocations(),
    loadSystemUsers(true),
    loadJobsFromCLI(),
  ]);
  await dispatchQueuedJobs();
  await watchRunningJobs();
  bootLoading = false;
  clearInterval(bootSpinInterval);
  render();

  // One-shot update hint (bottom-right toast, auto-hide)
  void maybeShowUpdateNotification();

  // Auto-refresh every 10s
  // Dispatch + watchdog run on ALL tabs (jobs shouldn't stall because user is on setup)
  // UI refresh is skipped on non-data tabs to avoid unnecessary redraws
  const refreshInterval = setInterval(async () => {
    if (runnerFocused || runnerInputTyping) return;
    
    // Always poll cluster + allocations (needed for dispatch decisions)
    await Promise.all([pollCluster(), loadAllocations()]);
    
    // Load jobs if on jobs tab
    if (screen === "jobs") {
      await loadJobsFromCLI();
    }
    
    // Dispatch queued jobs after snapshot update — runs regardless of active tab
    await dispatchQueuedJobs();
    
    // Watch running jobs for health and auto-restart — runs regardless of active tab
    await watchRunningJobs();
    
    // Only re-render if on a data-display tab
    if (screen === "dashboard" || screen === "detail" || screen === "jobs") {
      render();
    }
  }, 10_000);

  // Cleanup old jobs every hour
  let cleanupCounter = 0;
  const cleanupInterval = setInterval(async () => {
    cleanupCounter++;
    // Run cleanup every hour (360 cycles of 10s)
    if (cleanupCounter % 360 === 0) {
      await cleanupOldJobs();
      // Reload jobs to reflect cleanup
      await loadJobsFromCLI();
      requestRender?.();
    }
  }, 10_000);

  // Key handling
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (tabSwitcherOpen) {
      if (key.name === "escape") {
        tabSwitcherOpen = false;
        render();
        return;
      }
      
      if (key.name === "return") {
        const tabs = tabRegistry.getAllVisible();
        const selectedTab = tabs[tabSwitcherIdx];
        if (selectedTab) {
          const switched = await tabRegistry.switchTo(selectedTab.id);
          if (switched) {
            screen = selectedTab.id as typeof screen;
          }
          tabSwitcherOpen = false;
          render();
        }
        return;
      }
      
      if (key.name === "up" || key.name === "k") {
        const tabs = tabRegistry.getAllVisible();
        tabSwitcherIdx = (tabSwitcherIdx - 1 + tabs.length) % tabs.length;
        render();
        return;
      }
      
      if (key.name === "down" || key.name === "j") {
        const tabs = tabRegistry.getAllVisible();
        tabSwitcherIdx = (tabSwitcherIdx + 1) % tabs.length;
        render();
        return;
      }
      
      if (key.name.length === 1) {
        const tabs = tabRegistry.getAllVisible();
        const matchedTab = tabs.find(t => t.shortcut === key.name);
        if (matchedTab) {
          const switched = await tabRegistry.switchTo(matchedTab.id);
          if (switched) {
            screen = matchedTab.id as typeof screen;
          }
          tabSwitcherOpen = false;
          render();
        }
        return;
      }
      
      return;
    }
    
    // ctrl+x prefix key — works from ALL tabs
    if (key.name === "x" && key.ctrl) {
      prefixKeyPressed = true;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      prefixKeyTimeout = setTimeout(() => {
        prefixKeyPressed = false;
      }, 2000);
      render();
      return;
    }

    // ctrl+x t — tab switcher from ANY screen
    if (prefixKeyPressed && key.name === "t") {
      prefixKeyPressed = false;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      tabSwitcherOpen = true;
      tabSwitcherIdx = tabRegistry.getAllVisible().findIndex(t => t.id === tabRegistry.activeTabId);
      if (tabSwitcherIdx < 0) tabSwitcherIdx = 0;
      render();
      return;
    }

    // ctrl+x q — quit from ANY screen
    if (prefixKeyPressed && key.name === "q") {
      prefixKeyPressed = false;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      clearInterval(refreshInterval);
      renderer.destroy();
      process.exit(0);
    }

    if (screen === "dashboard" || screen === "my-gpu-view") {
      
      if (prefixKeyPressed && key.name === "down") {
        // ctrl+x down: focus runner
        prefixKeyPressed = false;
        if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
        runnerFocused = true;
        runnerInputBuffer = launchCommand;
        runnerFocusedInputIdx = 0; // Start at first input
        
        // Initialize commands with GPU info if not already set
        if (launchDistMode === "one-to-one") {
          for (let i = 0; i < launchCommands.length; i++) {
            if (!launchCommands[i] || launchCommands[i] === "") {
              const gpu = launchSelectedGpus[i];
              launchCommands[i] = getGpuCommandPlaceholder(gpu);
            }
          }
        }
        
        runnerInputTyping = false; // Ensure not in typing mode
        render();
        return;
      }
      
      if (prefixKeyPressed && key.name === "f") {
        prefixKeyPressed = false;
        if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
        runnerPaneFolded = !runnerPaneFolded;
        render();
        return;
      }
      
      if (prefixKeyPressed && key.name === "r" && screen === "my-gpu-view") {
        prefixKeyPressed = false;
        if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
        
        const selectedBundle = myGpuViewState.bundles[myGpuViewState.selectedBundleIdx];
        if (selectedBundle && selectedBundle.gpus.length > 0) {
          launchGpuMode = "selected";
          launchManualGpus = [...selectedBundle.gpus];
          launchNumGpus = selectedBundle.gpus.length;
          launchSelectedGpus = [...selectedBundle.gpus];
          launchSourceBundle = selectedBundle.label;
          
          if (launchDistMode === "one-to-one") {
            launchCommands = [];
            for (let i = 0; i < launchNumGpus; i++) {
              const gpu = launchSelectedGpus[i];
              launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }
          
          runnerPaneFolded = false;
          runnerFocused = true;
          runnerInputBuffer = launchCommand;
          runnerFocusedInputIdx = 0;
          runnerInputTyping = false;
          
          setStatus(`Runner opened with ${launchNumGpus} GPU(s) from ${selectedBundle.label}`, 2000);
        } else {
          setStatus("No GPUs in selected bundle");
        }
        
        render();
        return;
      }
      
      if (prefixKeyPressed && key.name === "return") {
        // ctrl+x Enter: execute commands
        prefixKeyPressed = false;
        if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
        
        // Capture input values from Input components (if in typing mode)
        // or fall back to stored values (if in focused-but-not-typing mode)
        if (launchDistMode === "single") {
          const inputAny: any = container.findDescendantById("runner-cmd-input");
          if (inputAny) {
            launchCommand = String(inputAny.value ?? "");
          }
          // Fallback: use runnerInputBuffer if Input wasn't rendered
          if (!launchCommand.trim() && runnerInputBuffer.trim()) {
            launchCommand = runnerInputBuffer;
          }
        } else {
          for (let i = 0; i < launchNumGpus; i++) {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
            if (inputAny) {
              launchCommands[i] = String(inputAny.value ?? "");
            }
          }
        }
        
        if (launchMode === "tmux") {
          const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
          if (tmuxInputAny) {
            launchTmuxSession = String(tmuxInputAny.value ?? "");
          }
        }
        
        runnerInputTyping = false;
        runnerFocused = false;
        await executeLaunch();
        render();
        return;
      }
      
      // === TYPING MODE ===
      if (runnerInputTyping) {
        if (key.name === "escape") {
          // Capture input values before exiting typing mode
          if (launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            runnerInputBuffer = String(inputAny?.value ?? "");
            launchCommand = runnerInputBuffer;
          } else {
            for (let i = 0; i < launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }
          
          if (launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }
          
          runnerInputTyping = false;
          render();
        } else if (key.name === "return") {
          // Enter in typing mode: capture values and exit typing mode
          // (execution requires ctrl+x Enter from focused mode)
          if (launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            runnerInputBuffer = String(inputAny?.value ?? "");
            launchCommand = runnerInputBuffer;
          } else {
            for (let i = 0; i < launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }
          
          if (launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }
          
          runnerInputTyping = false;
          // Stay in focused mode — user can ctrl+x Enter to execute
          render();
        } else if (key.name === "down" && launchDistMode === "one-to-one") {
          // Navigate to next input line (commands + tmux if applicable)
          const inputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
          if (inputAny) {
            launchCommands[runnerFocusedInputIdx] = String(inputAny?.value ?? "");
          }
          
          // If at last command line and tmux mode, move to tmux session input
          if (runnerFocusedInputIdx === launchNumGpus - 1 && launchMode === "tmux") {
            runnerFocusedInputIdx = -1; // Special value for tmux session
            render();
            setTimeout(() => {
              const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (tmuxInputAny) tmuxInputAny.focus();
            }, 50);
          } else {
            runnerFocusedInputIdx = Math.min(runnerFocusedInputIdx + 1, launchNumGpus - 1);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        } else if (key.name === "up" && launchDistMode === "one-to-one") {
          // Navigate to previous input line (tmux session ← commands)
          if (runnerFocusedInputIdx === -1) {
            // From tmux session back to last command
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
            runnerFocusedInputIdx = launchNumGpus - 1;
            render();
            setTimeout(() => {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }, 50);
          } else {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
            if (inputAny) {
              launchCommands[runnerFocusedInputIdx] = String(inputAny?.value ?? "");
            }
            
            runnerFocusedInputIdx = Math.max(runnerFocusedInputIdx - 1, 0);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        }
        // All other keys pass through to input
        return;
      }
      
      // (PREFIX KEY handlers moved to top of dashboard screen)
      
      // === RUNNER FOCUSED MODE ===
      if (runnerFocused) {
        if (key.name === "escape") {
          runnerFocused = false;
          
          // Capture input values
          if (launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            runnerInputBuffer = String(inputAny?.value ?? "");
            launchCommand = runnerInputBuffer;
          } else {
            for (let i = 0; i < launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }
          
          if (launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }
          
          render();
          return;
        }
        
        if (key.name === "return") {
          // Enter in focused mode: start typing on current highlighted line
          runnerInputTyping = true;
          render();
          setTimeout(() => {
            if (runnerFocusedInputIdx === -1) {
              // Tmux session input
              const inputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (inputAny) inputAny.focus();
            } else if (launchDistMode === "single") {
              const inputAny: any = container.findDescendantById("runner-cmd-input");
              if (inputAny) inputAny.focus();
            } else {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }
          }, 50);
          return;
        }
        
        if (key.name === "tab" && !key.shift) {
          key.preventDefault();
          launchMode = launchMode === "direct" ? "tmux" : "direct";
          render();
          return;
        }
        
        if (key.name === "tab" && key.shift) {
          key.preventDefault();
          if (launchDistMode === "single") {
            launchDistMode = "one-to-one";
            launchCommands = [];
            for (let i = 0; i < launchNumGpus; i++) {
              const gpu = launchSelectedGpus[i];
              launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
            runnerFocusedInputIdx = 0;
          } else {
            launchDistMode = "single";
            launchCommands = [];
          }
          render();
          return;
        }
        
        if (key.name === "+" || key.name === "=") {
          const oldMode = launchGpuMode;
          const oldCount = launchNumGpus;
          
          launchNumGpus = Math.min(launchNumGpus + 1, 16);
          
          // Get next best GPU via auto selection
          launchGpuMode = "auto";
          await refreshLaunchGpuSelection();
          
          // Add the new GPU to manual selection
          if (launchSelectedGpus.length > oldCount) {
            const newGpu = launchSelectedGpus[launchSelectedGpus.length - 1];
            if (newGpu && !launchManualGpus.some(g => g.node === newGpu.node && g.gpu === newGpu.gpu)) {
              launchManualGpus.push({ node: newGpu.node, gpu: newGpu.gpu });
            }
          }
          
          // Switch to selected mode to show marking
          launchGpuMode = "selected";
          launchSelectedGpus = launchManualGpus.slice(0, launchNumGpus);
          
          if (launchDistMode === "one-to-one") {
            while (launchCommands.length < launchNumGpus) {
              const idx = launchCommands.length;
              const gpu = launchSelectedGpus[idx];
              launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }
          
          render();
          return;
        }
        
        if (key.name === "-" || key.name === "_") {
          launchNumGpus = Math.max(launchNumGpus - 1, 0); // Allow down to 0
          if (launchDistMode === "one-to-one") {
            launchCommands = launchCommands.slice(0, launchNumGpus);
          }
          // Sync GPU selection: remove last selected if exceeds count
          if (launchManualGpus.length > launchNumGpus) {
            launchManualGpus.pop(); // Remove last selected GPU
          }
          await refreshLaunchGpuSelection();
          render();
          return;
        }
        
        if ((key.name === "q" || key.name === "Q") && !runnerInputTyping) {
          key.preventDefault();
          launchQueueMode = launchQueueMode === "immediate" ? "queued" : "immediate";
          setStatus(`Queue mode: ${launchQueueMode}`, 1500);
          render();
          return;
        }
        
        if (key.name === "down" && !runnerInputTyping) {
          // Navigate down through input lines
          if (launchDistMode === "single") {
            // Single mode: command → tmux session (if tmux mode)
            if (launchMode === "tmux" && runnerFocusedInputIdx === 0) {
              runnerFocusedInputIdx = -1; // -1 = tmux session
              render();
            }
          } else {
            // One-to-one: line 0 → 1 → ... → N-1 → tmux (if tmux mode)
            const maxCmdIdx = launchNumGpus - 1;
            if (runnerFocusedInputIdx < maxCmdIdx) {
              runnerFocusedInputIdx++;
              render();
            } else if (launchMode === "tmux" && runnerFocusedInputIdx === maxCmdIdx) {
              runnerFocusedInputIdx = -1; // tmux session
              render();
            }
          }
          return;
        }
        
        if (key.name === "up" && !runnerInputTyping) {
          // Navigate up through input lines
          if (launchDistMode === "single") {
            // Single mode: tmux → command
            if (launchMode === "tmux" && runnerFocusedInputIdx === -1) {
              runnerFocusedInputIdx = 0;
              render();
            }
          } else {
            // One-to-one: tmux → N-1 → ... → 1 → 0
            if (runnerFocusedInputIdx === -1) {
              runnerFocusedInputIdx = launchNumGpus - 1;
              render();
            } else if (runnerFocusedInputIdx > 0) {
              runnerFocusedInputIdx--;
              render();
            }
          }
          return;
        }
        
        if (key.name === "g" && !runnerInputTyping) {
          if (launchGpuMode === "auto") {
            launchGpuMode = "selected";
            launchManualGpus = [...launchSelectedGpus];
            launchSourceBundle = null;
            setStatus("GPU mode: Manual selection (click GPUs in panel or dashboard)");
          } else {
            launchGpuMode = "auto";
            launchManualGpus = [];
            launchSourceBundle = null;
            await refreshLaunchGpuSelection();
            setStatus("GPU mode: Auto-ranked selection");
          }
          render();
          return;
        }
        
        // Detect typing when any printable key is pressed
        if (key.sequence && key.sequence.length === 1) {
          runnerInputTyping = true;
          // Let the key pass through to input
        }
        return;
      }
      
      // === DASHBOARD FOCUS MODE (default) ===
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (snapshot && selectedNodeIdx > 0) {
          selectedNodeIdx--;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (snapshot && selectedNodeIdx < snapshot.nodes.length - 1) {
          selectedNodeIdx++;
          render();
        }
      } else if (key.name === "return") {
        await navigateToTab("detail");
        const node = snapshot?.nodes[selectedNodeIdx];
        selectedGpuIdx = gpuIndicesForNode(node)[0] ?? 0;
        if (node) void checkSudoForNode(node.node_alias);
        render();
      } else if (key.name === "r") {
        await Promise.all([pollCluster(), loadAllocations(), loadSystemUsers(true)]);
        render();
      } else if (key.name === "?" || key.name === "h") {
        await navigateToTab("help");
        render();
      }
      else if (key.name === "j") {
        await navigateToTab("jobs");
        render();
      } else if (key.name === "g" && !runnerFocused) {
        await navigateToTab("my-gpu-view");
        render();
      }
      
      if (screen === "my-gpu-view") {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
          return;
        }
        
        if (key.name === "up" || key.name === "k") {
          const bundles = myGpuViewState.bundles;
          if (bundles.length > 0) {
            myGpuViewState.selectedBundleIdx = (myGpuViewState.selectedBundleIdx - 1 + bundles.length) % bundles.length;
            render();
          }
          return;
        }
        
        if (key.name === "down" || key.name === "j") {
          const bundles = myGpuViewState.bundles;
          if (bundles.length > 0) {
            myGpuViewState.selectedBundleIdx = (myGpuViewState.selectedBundleIdx + 1) % bundles.length;
            render();
          }
          return;
        }
        
        if (key.name === "r") {
          await Promise.all([pollCluster(), loadAllocations()]);
          render();
          return;
        }
        
        if (key.name.length === 1) {
          const bundles = myGpuViewState.bundles;
          const matchedIdx = bundles.findIndex(b => b.shortcut === key.name);
          if (matchedIdx >= 0) {
            myGpuViewState.selectedBundleIdx = matchedIdx;
            render();
          }
          return;
        }
      }
    } else if (screen === "detail") {
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(selectedGpuIdx);
        if (pos > 0) {
          selectedGpuIdx = idxs[pos - 1]!;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(selectedGpuIdx);
        if (pos >= 0 && pos < idxs.length - 1) {
          selectedGpuIdx = idxs[pos + 1]!;
          render();
        }
      } else if (key.name === "return" || key.name === "a") {
        if (!requireAdminUI("allocate")) return;

        // Prevent the triggering keypress from being delivered to the newly focused Input.
        // OpenTUI dispatches global handlers first; if we re-render/focus during this handler,
        // the new Input may otherwise receive the same in-flight key event.
        key.preventDefault();
        key.stopPropagation();

        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        if (!node || node.error) return;

        openAllocModal(node, selectedGpuIdx);
      } else if (key.name === "*") {
        if (!requireAdminUI("open-to-all")) return;

        // Open-to-all allocation shortcut
        key.preventDefault();
        key.stopPropagation();

        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        if (!node || node.error) return;

        try {
          await allocSet(node.node_alias, selectedGpuIdx, "*");
          setStatus(`Saved allocation: ${node.node_alias} GPU${selectedGpuIdx} → *`);
          await Promise.all([pollCluster(), loadAllocations()]);
          render();
        } catch (e: any) {
          setStatus(e?.message ? `Alloc failed: ${e.message}` : "Alloc failed");
        }
      } else if (key.name === "x") {
        if (!requireAdminUI("clear allocation")) return;

        // Clear allocation for selected GPU
        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        if (!node || node.error) return;
        const existing = getAllocTarget(node.node_alias, selectedGpuIdx);
        if (!existing) return;
        try {
          await allocClear(node.node_alias, selectedGpuIdx);
          setStatus(`Cleared allocation: ${node.node_alias} GPU${selectedGpuIdx}`);
          await loadAllocations();
          render();
        } catch {}
      } else if (key.name === "k" && key.shift) {
        if (!requireAdminUI("kill")) return;

        // Kill violator processes on selected GPU
        if (!snapshot) return;
        const node = snapshot.nodes[selectedNodeIdx];
        if (!node || node.error) return;
        const gi = node.gpus.find((g) => g.index === selectedGpuIdx);
        if (!gi) return;

        const violProcs = node.processes.filter(
          (p) => p.gpu_uuid === gi.uuid && isViolation(node.node_alias, gi.index, p.user)
        );
        if (!violProcs.length) return;

        killCtx = {
          nodeAlias: node.node_alias,
          gpuIdx: selectedGpuIdx,
          pids: violProcs.map((p) => p.pid),
          users: violProcs.map((p) => p.user),
        };
        killErrorMsg = "";
        killOutput = "";
        killInProgress = false;
        screen = "kill";
        render();
      } else if (key.name === "escape" || key.name === "backspace") {
        await navigateToTab("dashboard");
        render();
      } else if (key.name === "r") {
        await Promise.all([pollCluster(), loadAllocations(), loadSystemUsers(true)]);
        render();
      }
      // Quit via ctrl+x q (unified shortcut)
      // } else if (key.name === "q") {
      //   clearInterval(refreshInterval);
      //   renderer.destroy();
      //   process.exit(0);
      // }
    } else if (screen === "kill") {
      if (key.name === "escape") {
        await navigateToTab("detail");
        killCtx = null;
        killErrorMsg = "";
        killOutput = "";
        render();
      } else if (key.name === "return" && !killInProgress) {
        if (!killCtx || !killCtx.pids.length) return;
        killInProgress = true;
        render();

        try {
          const { code, stdout, stderr } = await killPids(
            killCtx.nodeAlias,
            killCtx.pids
          );
          killOutput = stdout;
          if (code !== 0 && stderr.trim()) {
            killErrorMsg = stderr.trim().slice(0, 120);
          }
        } catch (e: any) {
          killErrorMsg = e?.message || String(e);
        }

        killInProgress = false;
        render();

        setTimeout(async () => {
          if (screen === "kill") {
            killCtx = null;
            killErrorMsg = "";
            killOutput = "";
            await navigateToTab("detail");
            await Promise.all([pollCluster(), loadAllocations()]);
            render();
          }
        }, 2000);
      }
    } else if (screen === "alloc") {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        await navigateToTab("detail");
        allocCtx = null;
        allocErrorMsg = "";
        allocUserListFocused = false;
        allocUserListIdx = 0;
        render();
      } else if (key.name === "left") {
        // Move focus from input to user list
        if (!allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          allocUserListFocused = true;
          allocUserListIdx = 0;
          render();
        }
      } else if (key.name === "right") {
        // Move focus from user list to input
        if (allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          allocUserListFocused = false;
          render();
          setTimeout(() => {
            const inputAny: any = container.findDescendantById("alloc-user-input");
            if (inputAny) inputAny.focus();
          }, 50);
        }
      } else if (key.name === "up" && allocUserListFocused) {
        key.preventDefault();
        allocUserListIdx = Math.max(allocUserListIdx - 1, 0);
        render();
        // Scroll into view
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "down" && allocUserListFocused) {
        key.preventDefault();
        const maxIdx = knownUsers.length - 1;
        allocUserListIdx = Math.min(allocUserListIdx + 1, maxIdx);
        render();
        // Scroll into view
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "return" && allocUserListFocused) {
        // Select user from list
        key.preventDefault();
        key.stopPropagation();
        const selectedUser = knownUsers[allocUserListIdx];
        if (selectedUser) {
          allocDraftUser = selectedUser;
          allocUserListFocused = false;
          render();
          setTimeout(() => {
            const inputAny: any = container.findDescendantById("alloc-user-input");
            if (inputAny) inputAny.focus();
          }, 50);
        }
      } else if (key.name === "tab") {
        key.preventDefault();
        key.stopPropagation();

        const inputAny: any = container.findDescendantById("alloc-user-input");
        const current = String(inputAny?.value ?? allocDraftUser);

        // Autocomplete the last segment to the first match.
        const parts = current.split(",");
        const last = (parts.pop() || "").trim();
        const f = last.toLowerCase();
        const universe = knownUsers.length ? knownUsers : [];
        // Prefer prefix matches for autocomplete, fall back to substring matches.
        const match =
          (f ? universe.find((u) => u.toLowerCase().startsWith(f)) : universe[0]) ||
          (f ? universe.find((u) => u.toLowerCase().includes(f)) : "") ||
          "";

        if (match) {
          const prefix = parts.map((p) => p.trim()).filter(Boolean);
          const out: string[] = [];
          const seen = new Set<string>();

          for (const p of prefix) {
            if (seen.has(p)) continue;
            seen.add(p);
            out.push(p);
          }
          if (!seen.has(match)) out.push(match);

          allocDraftUser = out.join(",");
          render();
        }
      } else if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        if (!allocCtx) {
          allocErrorMsg = "No allocation target";
          render();
          return;
        }

        const inputAny: any = container.findDescendantById("alloc-user-input");
        let user = String(inputAny?.value ?? "").trim();
        if (!user || user.toLowerCase() === "none") user = "*";
        allocDraftUser = user;

        try {
          await allocSet(allocCtx.nodeAlias, allocCtx.gpuIdx, user);
          setStatus(`Saved allocation: ${allocCtx.nodeAlias} GPU${allocCtx.gpuIdx} → ${user}`);
          allocCtx = null;
          allocErrorMsg = "";
          await Promise.all([pollCluster(), loadAllocations()]);
          await navigateToTab("detail");
          render();
        } catch (e: any) {
          allocErrorMsg = e?.message || String(e);
          render();
        }
      } else {
        // Update filtering/autocomplete state as the user types.
        if (allocTypingTimer) clearTimeout(allocTypingTimer);
        allocTypingTimer = setTimeout(() => {
          const inputAny: any = container.findDescendantById("alloc-user-input");
          allocDraftUser = String(inputAny?.value ?? "");
          render();
        }, 20);
      }
    } else if (screen === "help") {
      if (
        key.name === "escape" ||
        key.name === "backspace" ||
        key.name === "?" ||
        key.name === "q"
      ) {
        await navigateToTab("dashboard");
        render();
      }
    } else if (screen === "jobs") {
      if (jobDetailView && jobDetailLogView !== null) {
        // Log view mode
        if (key.name === "escape") {
          jobDetailLogView = null;
          jobDetailLogScroll = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          jobDetailLogScroll = Math.max(0, jobDetailLogScroll - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          jobDetailLogScroll++;
          render();
        } else if (key.name === "pageup") {
          jobDetailLogScroll = Math.max(0, jobDetailLogScroll - 20);
          render();
        } else if (key.name === "pagedown") {
          jobDetailLogScroll += 20;
          render();
        } else if (key.name === "r") {
          // Refresh log
          if (jobDetailLogSession) {
            jobDetailLogView = await captureTmuxPane(jobDetailLogSession);
            render();
          }
        }
      } else if (jobDetailView) {
        // Detail view mode
        const sessionCount = Math.max(jobDetailView.tmux_sessions.length, jobDetailView.gpus.length);
        
        if (key.name === "escape" || key.name === "backspace") {
          jobDetailView = null;
          jobDetailSelectedCmd = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          jobDetailSelectedCmd = Math.max(0, jobDetailSelectedCmd - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          jobDetailSelectedCmd = Math.min(sessionCount - 1, jobDetailSelectedCmd + 1);
          render();
        } else if (key.name === "return") {
          // Enter log view for selected session
          const session = jobDetailView.tmux_sessions[jobDetailSelectedCmd];
          if (session) {
            jobDetailLogSession = session;
            jobDetailLogScroll = 0;
            setStatus(`Loading log for ${session}...`);
            jobDetailLogView = await captureTmuxPane(session);
            // Auto-scroll to bottom
            const lines = jobDetailLogView.split("\n");
            const termHeight = process.stdout.rows || 40;
            jobDetailLogScroll = Math.max(0, lines.length - (termHeight - 4));
            render();
          } else {
            setStatus("No tmux session available for this GPU");
            render();
          }
        } else if (key.name === "c") {
          await cancelJobAction(jobDetailView);
          render();
        } else if (key.name === "r" && key.shift) {
          await retryJobAction(jobDetailView);
          render();
        } else if (key.name === "r") {
          await retrySelectedSessionAction(jobDetailView, jobDetailSelectedCmd);
          render();
        } else if (key.name === "x") {
          await cleanupTmuxSessionsAction(jobDetailView);
          render();
        }
      } else {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
        } else if (key.name === "up" || key.name === "k") {
          selectedJobIdx = Math.max(0, selectedJobIdx - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          selectedJobIdx = Math.min(jobList.length - 1, selectedJobIdx + 1);
          render();
        } else if (key.name === "return") {
          if (jobList.length > 0 && jobList[selectedJobIdx]) {
            jobDetailView = jobList[selectedJobIdx];
            jobDetailSelectedCmd = 0;
            jobDetailLogView = null;
            jobDetailLogScroll = 0;
            render();
            if (jobDetailView.status === "running" && jobDetailView.gpus.length > 0) {
              checkGpuLiveness(jobDetailView).then(() => render());
            }
          }
        } else if (key.name === "c") {
          if (jobList.length > 0 && jobList[selectedJobIdx]) {
            await cancelJobAction(jobList[selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && key.shift) {
          if (jobList.length > 0 && jobList[selectedJobIdx]) {
            await retryJobAction(jobList[selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && !key.shift) {
          setStatus("Refreshing jobs...");
          await loadJobsFromCLI();
          setStatus("Jobs refreshed", 1000);
          render();
        } else if (key.name === "d") {
          if (jobList.length > 0 && jobList[selectedJobIdx]) {
            await deleteJobAction(jobList[selectedJobIdx]);
            render();
          }
        } else if (key.name === "x") {
          if (jobList.length > 0 && jobList[selectedJobIdx]) {
            await cleanupTmuxSessionsAction(jobList[selectedJobIdx]);
            render();
          }
        }
      }
    } else if (screen === "setup") {
      if (setupEditingField) {
        // Editing mode
        const fieldOrder: Array<"env_manager" | "env_name" | "work_dir"> = ["env_manager", "env_name", "work_dir"];
        const currentFieldIdx = fieldOrder.indexOf(setupEditingField);

        if (key.name === "escape") {
          setupEditingField = null;
          setupEditBuffer = "";
          render();
        } else if (key.name === "return") {
          // Save current field and exit editing
          const node = setupNodes[setupSelectedIdx];
          if (node) {
            node[setupEditingField] = setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          setupEditingField = null;
          setupEditBuffer = "";
          render();
        } else if (key.name === "tab" || key.name === "down") {
          // Save current field, move to next
          const node = setupNodes[setupSelectedIdx];
          if (node) {
            node[setupEditingField] = setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx < fieldOrder.length - 1) {
            setupEditingField = fieldOrder[currentFieldIdx + 1];
            setupEditBuffer = node?.[setupEditingField] || "";
          } else {
            // Wrap or exit
            setupEditingField = null;
            setupEditBuffer = "";
          }
          render();
        } else if (key.name === "up") {
          // Save current field, move to previous
          const node = setupNodes[setupSelectedIdx];
          if (node) {
            node[setupEditingField] = setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx > 0) {
            setupEditingField = fieldOrder[currentFieldIdx - 1];
            setupEditBuffer = node?.[setupEditingField] || "";
          } else {
            setupEditingField = null;
            setupEditBuffer = "";
          }
          render();
        } else if (key.name === "backspace") {
          setupEditBuffer = setupEditBuffer.slice(0, -1);
          render();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          setupEditBuffer += key.sequence;
          render();
        }
      } else {
        // Navigation mode
        if (key.name === "up") {
          setupSelectedIdx = Math.max(0, setupSelectedIdx - 1);
          render();
        } else if (key.name === "down") {
          setupSelectedIdx = Math.min(setupNodes.length - 1, setupSelectedIdx + 1);
          render();
        } else if (key.name === "return") {
          // Start editing env_manager
          setupEditingField = "env_manager";
          setupEditBuffer = setupNodes[setupSelectedIdx]?.env_manager || "";
          render();
        } else if (key.name === "escape") {
          await navigateToTab("dashboard");
          render();
        } else if (key.sequence === "s" || key.sequence === "S") {
          // Save current node
          const node = setupNodes[setupSelectedIdx];
          if (node) {
            const ok = await saveSetupNode(node);
            if (ok) {
              setupDirtyAliases.delete(node.alias);
              setSetupMessage(`✓ Saved ${node.alias}: ${node.env_manager || "(none)"}:${node.env_name || "(none)"} dir=${node.work_dir || "(none)"}`);
              tuiLog("INFO", `setup: saved node=${node.alias} env=${node.env_manager}:${node.env_name} dir=${node.work_dir}`);
            } else {
              setSetupMessage(`✗ Failed to save ${node.alias}`);
            }
          }
          render();
        }
      }
    }
  });
}

main().catch((e) => {
  tuiLog("ERROR", `fatal: ${e?.message || String(e)}\n${e?.stack || ""}`);
  console.error(e);  // also print to stderr for immediate visibility
  process.exit(1);
});
