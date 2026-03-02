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
import { existsSync } from "node:fs";
import path from "node:path";
import { tabRegistry, type Tab } from "./tabRegistry";
import { tmuxSafeName } from './src/utils/format';
import { S as _S_module, runnerMinHeight, runnerMaxHeight, OPERATOR } from './src/state/global';
import { renderAlloc as _mod_renderAlloc } from './src/components/AllocModal';
import { renderGlobalTabBar as _mod_renderGlobalTabBar, renderGlobalFooter as _mod_renderGlobalFooter, renderToast as _mod_renderToast, renderTabSwitcher as _mod_renderTabSwitcher, navigateByDelta as _mod_navigateByDelta } from './src/components/Layout';
import { renderRunnerPane as _mod_renderRunnerPane } from './src/components/Runner';
import { renderLoadingBadge as _mod_renderLoadingBadge, renderDashboard as _mod_renderDashboard, renderSrunPopup as _mod_renderSrunPopup, renderSlurmClusterTab as _mod_renderSlurmClusterTab, sortSlurmNodes as _mod_sortSlurmNodes } from './src/views/Dashboard';
import { renderDetail as _mod_renderDetail, renderHelp as _mod_renderHelp, renderKill as _mod_renderKill } from './src/views/Detail';
import {
  renderJobsView as _mod_renderJobsView,
  renderJobsListView as _mod_renderJobsListView,
  renderJobDetailView as _mod_renderJobDetailView,
  dispatchQueuedJobs as _mod_dispatchQueuedJobs,
  watchRunningJobs as _mod_watchRunningJobs,
  checkGpuLiveness as _mod_checkGpuLiveness,
  findAvailableGpus,
  cleanupOldJobs,
  executeJobRemote,
  cancelJobAction,
  retryJobAction,
  retrySelectedSessionAction,
  cleanupTmuxSessionsAction,
  deleteJobAction,
  killTmuxSessions,
  captureTmuxPane,
  getJobStatusIcon,
  formatJobTimestamp,
  formatJobDuration,
  formatJobGpus,
} from './src/views/Jobs';
import { renderMyGpuView as _mod_renderMyGpuView } from './src/views/MyGpus';
import { renderSetupView as _mod_renderSetupView } from './src/views/Setup';
import type { RunnerState, PreflightCheck, GpuBundle, MyGpuViewState } from './src/types';
import {
  pollCluster as _mod_pollCluster,
  pollExtraCluster as _mod_pollExtraCluster,
  pollAllClusters as _mod_pollAllClusters,
  recomputeKnownUsers as _mod_recomputeKnownUsers,
  tuiLog,
  PYTHON,
  BASE_DIR,
  OPENSMI_ENV,
  OPENSMI_CWD,
  OPENSMI,
  getStateDir,
  runOpensmi,
  loadAdminStatus,
  allocSet,
  allocClear,
  killPids,
  loadAllocations,
  loadJobsFromCLI,
  updateJobInStore,
  loadClusterTabsFromConfig,
  parseSemver,
  isRemoteNewer,
  maybeShowUpdateNotification,
  saveJobToStore,
} from './src/state/api';

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


// Command runner pane state

// Prefix key system (ctrl+x)

// ── Global Tab Bar ─────────────────────────────────────────────────

// ── State sync bridge (Phase 3 Step 2) ──────────────────────────────────────
// Copies bare module-level globals → S before module render calls,
// and S → bare globals after. Remove in Phase 4 when index.ts uses S directly.


const renderGlobalTabBar = _mod_renderGlobalTabBar;

const renderGlobalFooter = _mod_renderGlobalFooter;


// Debounce rapid bracket key presses to prevent state thrashing
let _lastBracketKeyTime = 0;
const BRACKET_KEY_DEBOUNCE_MS = 100;




function runnerPaneTopRow(): number {
  const termRows = process.stdout.rows || 40;
  const paneRows = _S_module.runnerPaneFolded
    ? 3
    : Math.max(3, Math.floor(termRows * 0.4));
  return Math.max(0, termRows - paneRows);
}

function setLaunchError(msg: string): void {
  tuiLog("ERROR", `launch error: ${msg}`);
  _S_module.launchErrorMsg = msg;
  if (_S_module.launchErrorTimeout) clearTimeout(_S_module.launchErrorTimeout);
  _S_module.launchErrorTimeout = setTimeout(() => {
    _S_module.launchErrorMsg = "";
    _S_module.requestRender?.();
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
  if (!_S_module.snapshot) {
    _S_module.launchSelectedGpus = [];
    return;
  }

  // In "selected" mode, use manually selected GPUs
  if (_S_module.launchGpuMode === "selected") {
    _S_module.launchSelectedGpus = _S_module.launchManualGpus.slice(0, _S_module.launchNumGpus);
    return;
  }

  // In "auto" mode, rank and select GPUs automatically
  try {
    const tmpFile = `/tmp/opensmi-snap-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(_S_module.snapshot));

    const allocFile = `/tmp/opensmi-alloc-${crypto.randomUUID()}.json`;
    await Bun.write(allocFile, JSON.stringify(_S_module.allocations));

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
excluded_nodes = set([g["node"] + ":" + str(g["gpu"]) for g in json.loads('${JSON.stringify(_S_module.launchExcludedGpus)}')])
all_ranked_gpus = select_top_gpus(snap, 9999, history, alloc_data, current_user)
gpus = []
for n, g in all_ranked_gpus:
    if n + ":" + str(g) not in excluded_nodes:
        gpus.append((n, g))
        if len(gpus) >= ${_S_module.launchNumGpus}:
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
      _S_module.launchSelectedGpus = JSON.parse(rankStdout);
    } else {
      _S_module.launchSelectedGpus = [];
    }

    try {
      await Bun.$`rm -f ${tmpFile} ${allocFile} ${operatorFile}`;
    } catch {}
  } catch {
    _S_module.launchSelectedGpus = [];
  }
}

// ── Data fetching ──────────────────────────────────────────────────

function updateGpuIdleTracking(): void {
  if (!_S_module.snapshot) return;

  const now = Date.now();

  for (const node of _S_module.snapshot.nodes) {
    if (node.error) continue;

    for (const gpu of node.gpus) {
      const key = `${node.node_alias}:${gpu.uuid}`;
      const procs = node.processes.filter(p => p.gpu_uuid === gpu.uuid);

      if (procs.length === 0) {
        // GPU is idle
        if (!_S_module.gpuIdleStart[key]) {
          _S_module.gpuIdleStart[key] = now;
        }
      } else {
        // GPU has processes - reset idle tracking
        delete _S_module.gpuIdleStart[key];
      }
    }
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

function buildDashboardTabs(): DashboardTab[] {
  const tabs: DashboardTab[] = [];

  const allManualNames = [_S_module.snapshot?.cluster_name || "Cluster", ..._S_module.extraClusterNames];
  allManualNames.forEach((name, i) => {
    tabs.push({ type: "manual", idx: i, name });
  });

  const slurmNames = _S_module.slurmSnapshots.length > 0
    ? _S_module.slurmSnapshots.map((s) => s.cluster_name || "Slurm")
    : _S_module.slurmClusterConfigNames;
  slurmNames.forEach((name, i) => {
    tabs.push({ type: "slurm", idx: i, name });
  });

  return tabs;
}

function activeDashboardTab(): DashboardTab | null {
  const tabs = buildDashboardTabs();
  if (tabs.length === 0) return null;
  return tabs[_S_module.activeClusterTabIdx] ?? tabs[0] ?? null;
}


function activeManualTabIdx(): number | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return null;
  return tab.idx;
}

function activeDashboardSnapshot(): ClusterSnapshot | null {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return null;
  if (manualIdx === 0) return _S_module.snapshot;
  return _S_module.extraSnapshots[manualIdx - 1] || null;
}

function activeDashboardPollError(): string {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return "";
  if (manualIdx === 0) return _S_module.pollError;
  return _S_module.extraPollErrors[manualIdx - 1] || "";
}

function activeDashboardSelectedNodeIdx(): number {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return 0;
  if (manualIdx === 0) return _S_module.selectedNodeIdx;
  return _S_module.extraSelectedNodeIdx[manualIdx - 1] || 0;
}

function setActiveDashboardSelectedNodeIdx(nextIdx: number): void {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return;

  if (manualIdx === 0) {
    _S_module.selectedNodeIdx = Math.max(0, nextIdx);
    return;
  }
  const arrIdx = manualIdx - 1;
  while (_S_module.extraSelectedNodeIdx.length <= arrIdx) _S_module.extraSelectedNodeIdx.push(0);
  _S_module.extraSelectedNodeIdx[arrIdx] = Math.max(0, nextIdx);
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
  const a = _S_module.allocations.find(
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
  const alloc = _S_module.allocations.find(
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
  const idleStartTime = _S_module.gpuIdleStart[key];

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

  for (const a of _S_module.allocations) {
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
  _S_module.statusMsg = msg;
  _S_module.statusUntil = Date.now() + ttlMs;
  _S_module.requestRender?.();
}

function openAllocModal(node: NodeSnapshot, gpuIdx: number): void {
  _S_module.allocCtx = { nodeAlias: node.node_alias, gpuIdx };
  _S_module.allocErrorMsg = "";
  _S_module.allocUserHighlight = "";

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

  _S_module.allocDraftUser = prefill;
  _S_module.screen = "alloc";
  _S_module.requestRender?.();
}

function computeGpuBundles(): GpuBundle[] {
  const bundles: GpuBundle[] = [];

  const allocatedGpus = _S_module.allocations
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
  if (_S_module.snapshot) {
    for (const node of _S_module.snapshot.nodes) {
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

  if (_S_module.myGpuViewState.pinnedGpus.length > 0) {
    bundles.push({
      id: "pinned",
      label: `Pinned GPUs (${_S_module.myGpuViewState.pinnedGpus.length})`,
      type: "pinned",
      gpus: _S_module.myGpuViewState.pinnedGpus,
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
    _S_module.myGpuViewState.pinnedGpus = data.pinned_gpus || [];
    const expandedBundles = data.expanded_bundles || [];
    _S_module.myGpuViewState.expandedGpuKeys = new Set(expandedBundles);
  } catch {
    _S_module.myGpuViewState.pinnedGpus = [];
    _S_module.myGpuViewState.expandedGpuKeys = new Set();
  }
}

async function saveMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  const data = {
    pinned_gpus: _S_module.myGpuViewState.pinnedGpus,
    expanded_bundles: Array.from(_S_module.myGpuViewState.expandedGpuKeys),
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

const renderToast = _mod_renderToast;

const renderTabSwitcher = _mod_renderTabSwitcher;

function requireAdminUI(action: string): boolean {
  if (!_S_module.isAdmin) {
    setStatus(`Admin only: ${action} (${_S_module.adminHint})`);
    return false;
  }

  if (_S_module.screen === "detail") {
    const node = _S_module.snapshot?.nodes[_S_module.selectedNodeIdx];
    const alias = node?.node_alias;
    if (alias) {
      const ok = _S_module.sudoOkByNode[alias];
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
  if (_S_module.sudoCheckingByNode[nodeAlias]) return;
  _S_module.sudoCheckingByNode[nodeAlias] = true;
  _S_module.sudoOkByNode[nodeAlias] = null;
  _S_module.requestRender?.();

  try {
    const { code, stdout, stderr } = await runOpensmi([
      "sudo-check",
      nodeAlias,
      "--json",
    ]);
    if (code !== 0) {
      _S_module.sudoOkByNode[nodeAlias] = false;
      _S_module.sudoInfoMsg = `sudo-check failed on ${nodeAlias}: ${stderr.trim() || `exit ${code}`}`;
      _S_module.requestRender?.();
      return;
    }

    const data = JSON.parse(stdout) as any;
    _S_module.sudoOkByNode[nodeAlias] = !!data.ok;
    if (!data.ok) {
      const groups = Array.isArray(data.groups) ? data.groups.join(" ") : "";
      _S_module.sudoInfoMsg = `Read-only: SSH user not in sudo group on ${nodeAlias} (groups: ${groups})`;
    } else {
      _S_module.sudoInfoMsg = "";
    }
  } catch (e: any) {
    _S_module.sudoOkByNode[nodeAlias] = false;
    _S_module.sudoInfoMsg = `sudo-check error on ${nodeAlias}: ${e?.message || String(e)}`;
  } finally {
    _S_module.sudoCheckingByNode[nodeAlias] = false;
    _S_module.requestRender?.();
  }
}

const renderLoadingBadge = _mod_renderLoadingBadge;

const renderDashboard = _mod_renderDashboard;

const renderDetail = _mod_renderDetail;

const renderHelp = _mod_renderHelp;

const renderJobsView = _mod_renderJobsView;

const renderJobsListView = _mod_renderJobsListView;

const renderJobDetailView = _mod_renderJobDetailView;

const renderMyGpuView = _mod_renderMyGpuView;

const renderAlloc = _mod_renderAlloc;

const renderKill = _mod_renderKill;


// ── Setup Tab ──────────────────────────────────────────────────────

interface NodeEnvConfig {
  alias: string;
  env_manager: string;
  env_name: string;
  work_dir: string;
}


function setSetupMessage(msg: string, ms = 2000) {
  _S_module.setupMessage = msg;
  if (_S_module.setupMessageTimeout) clearTimeout(_S_module.setupMessageTimeout);
  _S_module.setupMessageTimeout = setTimeout(() => { _S_module.setupMessage = ""; _S_module.requestRender?.(); }, ms);
}

async function loadSetupNodes(): Promise<void> {
  // Always read opensmi.json directly - this is config, not runtime state.
  // Never depend on cluster snapshot (which requires SSH poll).
  _S_module.setupNodes = [];

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
    _S_module.setupNodes.push({
      alias: String(n.alias || "").replace(/#/g, "-").replace(/:/g, "-"),
      env_manager: String(n.env_manager || ""),
      env_name: String(n.env_name || ""),
      work_dir: String(n.work_dir || ""),
    });
  }

  _S_module.setupNodes.sort((a, b) => a.alias.localeCompare(b.alias));
  tuiLog("INFO", `loadSetupNodes: ${_S_module.setupNodes.length} nodes from ${loadedFrom} (candidates: ${configPaths.join(", ")})`);
}

async function saveSetupNode(node: NodeEnvConfig): Promise<boolean> {
  // Write directly to opensmi.json - no CLI dependency.
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
  _S_module.setupDirtyAliases.add(node.alias);
}

async function flushSetupChangesToConfig(): Promise<void> {
  // If user is still typing in setup editor, commit the buffer first.
  if (_S_module.setupEditingField) {
    const node = _S_module.setupNodes[_S_module.setupSelectedIdx];
    if (node) {
      node[_S_module.setupEditingField] = _S_module.setupEditBuffer.trim();
      markSetupNodeDirty(node);
    }
    _S_module.setupEditingField = null;
    _S_module.setupEditBuffer = "";
  }

  if (_S_module.setupDirtyAliases.size === 0) {
    return;
  }

  const failed: string[] = [];

  for (const alias of Array.from(_S_module.setupDirtyAliases)) {
    const node = _S_module.setupNodes.find((n) => n.alias === alias);
    if (!node) {
      _S_module.setupDirtyAliases.delete(alias);
      continue;
    }

    const ok = await saveSetupNode(node);
    if (ok) {
      _S_module.setupDirtyAliases.delete(alias);
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

// ── srun Popup Helpers ───────────────────────────────────────────

function openSrunPopup(node: SlurmNodeInfo, clusterName: string, snap?: SlurmSnapshot) {
  _S_module.slurmRunPopup = {
    clusterName,
    nodeName: node.name,
    partition: node.partition || "",
    freeGpusAtOpen: node.gpu_free,
    snapshotTime: new Date().toISOString(),
    loginNode: snap?.login_node || "",
    sshUser: snap?.ssh_user || "",
    gpuCount: 1,
    editMode: false,
    cmdOverride: null,
    cursorPos: 0,
    copyStatus: "idle",
    errorMsg: "",
    fullCmdForFallback: "",
    jobSubmitStatus: "idle",
    jobId: "",
    gpuIdxList: "",
    jobErrorMsg: "",
    jobAbortRequested: false,
    qosList: [],
    qosIdx: 0,
    qosLoading: !!snap?.login_node,
    qosFetchFailed: false,
    existingJobIds: snap ? getMyJobIdsOnNode(node, snap.ssh_user || "") : [],
    existingJobCancelStatus: "idle",
    existingJobCancelMsg: "",
  };
  tuiLog("INFO", `srun popup opened: node=${node.name} partition=${node.partition} free=${node.gpu_free}`);
  _S_module._renderHook?.();
  // Async fetch QoS list for this partition
  if (snap?.login_node) {
    fetchQosForPartition(snap.login_node, snap.ssh_user || "", node.partition || "");
  }
}

function closeSrunPopup() {
  _S_module.slurmRunPopup = null;
  void loadSlurmData().then(() => { _S_module._renderHook?.(); });
  _S_module._renderHook?.();
}

function srunTokens(popup: SlurmRunPopup): string[] {
  return ["srun", "-p", popup.partition, "-w", popup.nodeName,
          "--gres", `gpu:${popup.gpuCount}`, "--pty", "bash"];
}

function shellQuote(token: string): string {
  if (token.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(token)) return token;
  // POSIX-safe single-quote escaping: ' -> '\''
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function srunCommand(popup: SlurmRunPopup): string {
  return srunTokens(popup).map(shellQuote).join(" ");
}

async function copyToClipboard(text: string): Promise<boolean> {
  const cmds = [
    ["pbcopy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
    ["wl-copy"],
  ];
  for (const [bin, ...args] of cmds) {
    try {
      const proc = Bun.spawn([bin!, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      const code = await proc.exited;
      if (code === 0) return true;
    } catch {}
  }
  return false;
}

function getLatestFreeGpus(nodeName: string, clusterIdx: number): number | null {
  const snap = _S_module.slurmSnapshots[clusterIdx];
  if (!snap) return null;
  const node = snap.nodes.find(n => n.name === nodeName);
  return node ? node.gpu_free : null;
}

function activeSlurmTabIdx(): number | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "slurm") return null;
  return tab.idx;
}

function slurmTabIdxForPopup(popup: SlurmRunPopup): number | null {
  const activeIdx = activeSlurmTabIdx();
  if (activeIdx !== null) return activeIdx;
  const byName = _S_module.slurmSnapshots.findIndex((s) => s.cluster_name === popup.clusterName);
  return byName >= 0 ? byName : null;
}

const ANSI_RE_GLOBAL = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]", "g");
const ANSI_RE_START = new RegExp("^\\u001b\\[[0-9;]*[A-Za-z]");

// Strip ANSI escape codes for display-width calculation only
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE_GLOBAL, "");
}

// Wrap a string into lines based on ANSI-stripped display width (raw string preserved per line)
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const displayLen = stripAnsi(text).length;
  if (displayLen <= maxWidth) return [text];
  // Split by display characters, tracking raw offsets
  const lines: string[] = [];
  let rawIdx = 0;
  let displayCount = 0;
  let lineStart = 0;
  while (rawIdx < text.length) {
    // Skip ANSI sequences (don't count toward display width)
    const ansiMatch = text.slice(rawIdx).match(ANSI_RE_START);
    if (ansiMatch) {
      rawIdx += ansiMatch[0].length;
      continue;
    }
    displayCount++;
    rawIdx++;
    if (displayCount >= maxWidth) {
      lines.push(text.slice(lineStart, rawIdx));
      lineStart = rawIdx;
      displayCount = 0;
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  return lines.length > 0 ? lines : [text];
}

// Wrap text and insert a visible cursor `|` at cursorPos for edit mode rendering
function wrapTextWithCursor(text: string, cursorPos: number, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const clampedPos = Math.max(0, Math.min(cursorPos, text.length));
  const withCursor = text.slice(0, clampedPos) + "|" + text.slice(clampedPos);
  return wrapText(withCursor, maxWidth);
}

const renderSrunPopup = _mod_renderSrunPopup;

async function submitSrunPopup() {
  if (!_S_module.slurmRunPopup) return;
  const popup = _S_module.slurmRunPopup;

  // If user edited the command, skip preflight and use override directly
  const cmd = popup.cmdOverride !== null ? popup.cmdOverride : srunCommand(popup);

  if (popup.cmdOverride === null) {
    // Preflight: re-check latest free GPUs (only for auto-generated commands)
    const popupSlurmIdx = slurmTabIdxForPopup(popup);
    const latestFree = popupSlurmIdx === null ? null : getLatestFreeGpus(popup.nodeName, popupSlurmIdx);
    if (latestFree === null) {
      popup.copyStatus = "stale";
      popup.errorMsg = "Node no longer found in cluster data.";
      _S_module._renderHook?.();
      return;
    }
    if (popup.gpuCount > latestFree) {
      popup.copyStatus = "stale";
      popup.errorMsg = `Capacity changed: was ${popup.freeGpusAtOpen}, now ${latestFree}. Adjust GPUs and retry.`;
      _S_module._renderHook?.();
      return;
    }
    if (latestFree === 0) {
      popup.copyStatus = "stale";
      popup.errorMsg = "No free GPUs available on this node.";
      _S_module._renderHook?.();
      return;
    }
  }
  tuiLog("INFO", `srun popup submit: node=${popup.nodeName} partition=${popup.partition} gpus=${popup.gpuCount}`);

  const ok = await copyToClipboard(cmd);
  if (ok) {
    popup.copyStatus = "ok";
    popup.fullCmdForFallback = "";
  } else {
    popup.copyStatus = "fail";
    popup.fullCmdForFallback = cmd;
  }
  _S_module._renderHook?.();
}

// Strict allowlist: Slurm names are alphanumeric + _ . : - only
function slurmNameSafe(s: string): boolean {
  return /^[A-Za-z0-9_.:\-]+$/.test(s);
}

async function fetchQosForPartition(loginNode: string, sshUser: string, partition: string) {
  if (!_S_module.slurmRunPopup) return;
  const popup = _S_module.slurmRunPopup;
  let currentPopup = popup;
  try {
    const sshTarget = sshUser ? `${sshUser}@${loginNode}` : loginNode;
    const proc = Bun.spawn(
      ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
       `scontrol show partition ${shellQuote(partition)}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // Re-read popup after await in case it was closed+reopened
    currentPopup = _S_module.slurmRunPopup ?? popup;
    // Parse "AllowQos=normal,high" or "QoS=normal"
    const m = out.match(/AllowQos=([^\s]+)/) || out.match(/QoS=([^\s]+)/);
    if (m && m[1] !== "N/A" && m[1] !== "(null)") {
      currentPopup.qosList = m[1]!.split(",").filter(Boolean).filter(slurmNameSafe).filter(q => q.toLowerCase() !== "default");
    }
    tuiLog("DEBUG", `QoS for ${partition}: ${JSON.stringify(currentPopup.qosList)}`);
  } catch (e) {
    tuiLog("DEBUG", `fetchQos failed: ${e}`);
    currentPopup.qosFetchFailed = true;
  } finally {
    currentPopup.qosLoading = false;
  }
  _S_module._renderHook?.();
}

// Returns deduplicated job IDs on a node that belong to sshUser
function getMyJobIdsOnNode(node: SlurmNodeInfo, sshUser: string): number[] {
  if (!sshUser) return [];
  const ids = new Set<number>();
  for (const slot of node.gpus) {
    if (slot.user === sshUser && slot.job_id !== null) {
      ids.add(slot.job_id);
    }
  }
  return [...ids];
}

// Cancel jobs on a node by SSH - no popup required
interface NodeCancelStatus { node: string; status: "idle" | "cancelling" | "done" | "error"; msg: string; }

async function cancelJobsOnNode(node: SlurmNodeInfo, snap: SlurmSnapshot) {
  const jobIds = getMyJobIdsOnNode(node, snap.ssh_user || "");
  if (jobIds.length === 0) return;

  // Validate all job IDs
  for (const id of jobIds) {
    if (!/^\d+$/.test(String(id))) {
      tuiLog("WARNING", `cancelJobsOnNode: suspicious jobId "${id}", skipped`);
      return;
    }
  }

  if (!snap.login_node) {
    _S_module.nodeCancelStatus = { node: node.name, status: "error", msg: "No login_node configured." };
    _S_module._renderHook?.();
    return;
  }

  _S_module.nodeCancelStatus = { node: node.name, status: "cancelling", msg: "" };
  _S_module._renderHook?.();

  const sshTarget = snap.ssh_user ? `${snap.ssh_user}@${snap.login_node}` : snap.login_node;

  try {
    for (const jobId of jobIds) {
      // Ownership check before cancelling
      const ownerProc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
         `squeue -h -j ${jobId} -o %u`],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ownerExit = await ownerProc.exited;
      const jobOwner = (await new Response(ownerProc.stdout).text()).trim();
      if (ownerExit !== 0 || (!jobOwner && snap.ssh_user)) {
        _S_module.nodeCancelStatus = { node: node.name, status: "error", msg: `Owner check failed for job ${jobId}; blocked for safety.` };
        _S_module._renderHook?.();
        return;
      }
      if (jobOwner && snap.ssh_user && jobOwner !== snap.ssh_user) {
        _S_module.nodeCancelStatus = { node: node.name, status: "error", msg: `Job ${jobId} owned by "${jobOwner}"; cancel denied.` };
        _S_module._renderHook?.();
        return;
      }
      const proc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget, `scancel ${jobId}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;
      tuiLog("INFO", `cancelJobsOnNode: scancel ${jobId} on ${node.name} done`);
    }
    _S_module.nodeCancelStatus = { node: node.name, status: "done", msg: `Cancelled: ${jobIds.join(", ")}` };
    _S_module._renderHook?.();
    setTimeout(async () => {
      await loadSlurmData();
      _S_module._renderHook?.();
    }, 500);
  } catch (e: any) {
    _S_module.nodeCancelStatus = { node: node.name, status: "error", msg: e?.message || String(e) };
    tuiLog("ERROR", `cancelJobsOnNode failed: ${_S_module.nodeCancelStatus.msg}`);
  }
  _S_module._renderHook?.();
}

async function cancelExistingJobsInPopup() {
  if (!_S_module.slurmRunPopup) return;
  const popup = _S_module.slurmRunPopup;
  if (!popup.existingJobIds.length || !popup.loginNode) return;

  popup.existingJobCancelStatus = "cancelling";
  popup.existingJobCancelMsg = "";
  _S_module._renderHook?.();

  const sshTarget = popup.sshUser ? `${popup.sshUser}@${popup.loginNode}` : popup.loginNode;
  try {
    for (const jobId of popup.existingJobIds) {
      if (!/^\d+$/.test(String(jobId))) continue;
      // Ownership check
      const ownerProc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget, `squeue -h -j ${jobId} -o %u`],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ownerExit = await ownerProc.exited;
      const jobOwner = (await new Response(ownerProc.stdout).text()).trim();
      if (ownerExit !== 0 || (!jobOwner && popup.sshUser)) {
        popup.existingJobCancelStatus = "error";
        popup.existingJobCancelMsg = `Owner check failed for job ${jobId}; blocked for safety.`;
        _S_module._renderHook?.();
        return;
      }
      if (jobOwner && popup.sshUser && jobOwner !== popup.sshUser) {
        popup.existingJobCancelStatus = "error";
        popup.existingJobCancelMsg = `Job ${jobId} owned by "${jobOwner}"; cancel denied.`;
        _S_module._renderHook?.();
        return;
      }
      const proc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget, `scancel ${jobId}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;
      tuiLog("INFO", `cancelExistingJobs: scancel ${jobId} done`);
    }
    popup.existingJobCancelStatus = "done";
    popup.existingJobCancelMsg = `Cancelled: ${popup.existingJobIds.join(", ")}`;
    popup.existingJobIds = [];
    _S_module._renderHook?.();
    setTimeout(async () => {
      await loadSlurmData();
      _S_module._renderHook?.();
    }, 500);
  } catch (e: any) {
    popup.existingJobCancelStatus = "error";
    popup.existingJobCancelMsg = e?.message || String(e);
    _S_module._renderHook?.();
  }
}

async function cancelSlurmJob() {
  if (!_S_module.slurmRunPopup) return;
  const popup = _S_module.slurmRunPopup;
  if (!popup.jobId) return;
  // jobId must be purely numeric
  if (!/^\d+$/.test(popup.jobId)) {
    tuiLog("WARNING", `cancelSlurmJob: suspicious jobId "${popup.jobId}", aborting`);
    popup.jobSubmitStatus = "idle";
    _S_module._renderHook?.();
    return;
  }
  popup.jobSubmitStatus = "cancelling";
  _S_module._renderHook?.();
  try {
    const sshTarget = popup.sshUser ? `${popup.sshUser}@${popup.loginNode}` : popup.loginNode;
    // Ownership check: verify job belongs to current user before cancelling
    const ownerProc = Bun.spawn(
      ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
       `squeue -h -j ${popup.jobId} -o %u`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ownerExit = await ownerProc.exited;
    const jobOwner = (await new Response(ownerProc.stdout).text()).trim();
    const expectedUser = popup.sshUser || "";
    if (ownerExit !== 0 || (!jobOwner && expectedUser)) {
      // squeue lookup failed (permissions issue or transient error) - block for safety
      tuiLog("WARNING", `cancelSlurmJob: owner lookup failed (exit=${ownerExit} jobOwner="${jobOwner}") - blocking scancel`);
      popup.jobSubmitStatus = "error";
      popup.jobErrorMsg = `Owner check unavailable (squeue exit ${ownerExit}); cancel blocked for safety. Run: scancel ${popup.jobId}`;
      _S_module._renderHook?.();
      return;
    }
    if (jobOwner && expectedUser && jobOwner !== expectedUser) {
      tuiLog("WARNING", `cancelSlurmJob: ownership mismatch - job ${popup.jobId} owner="${jobOwner}" expected="${expectedUser}", refusing scancel`);
      popup.jobSubmitStatus = "error";
      popup.jobErrorMsg = `Job ${popup.jobId} owned by "${jobOwner}"; cancel denied.`;
      _S_module._renderHook?.();
      return;
    }
    const proc = Bun.spawn(
      ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
       `scancel ${popup.jobId}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    tuiLog("INFO", `scancel ${popup.jobId} done (owner: ${jobOwner || "unverified"})`);
  } catch (e) {
    tuiLog("WARNING", `scancel failed: ${e}`);
  }
  popup.jobSubmitStatus = "idle";
  popup.jobId = "";
  popup.gpuIdxList = "";
  popup.jobAbortRequested = false;
  _S_module._renderHook?.();
}

async function submitJobToSlurm() {
  if (!_S_module.slurmRunPopup) return;
  const popup = _S_module.slurmRunPopup;

  if (!popup.loginNode) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "No login_node configured for this cluster.";
    _S_module._renderHook?.();
    return;
  }

  // Injection guard: validate all user-controlled Slurm fields
  const fieldsToValidate: [string, string][] = [
    ["partition", popup.partition],
    ["node", popup.nodeName],
  ];
  const selectedQosName = popup.qosList[popup.qosIdx - 1] || "";
  if (selectedQosName) fieldsToValidate.push(["qos", selectedQosName]);
  for (const [fieldName, value] of fieldsToValidate) {
    if (!slurmNameSafe(value)) {
      const msg = `Invalid characters in ${fieldName} (allowed: A-Z a-z 0-9 _ . : -): "${value}"`;
      tuiLog("WARNING", `injection guard blocked: field=${fieldName} value="${value}"`);
      popup.jobSubmitStatus = "error";
      popup.jobErrorMsg = msg;
      _S_module._renderHook?.();
      return;
    }
  }

  // Block submit if QoS is still loading
  if (popup.qosLoading) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "QoS list still loading - please wait a moment.";
    _S_module._renderHook?.();
    return;
  }

  popup.jobSubmitStatus = "submitting";
  popup.jobId = "";
  popup.gpuIdxList = "";
  popup.jobErrorMsg = "";
  popup.jobAbortRequested = false;
  _S_module._renderHook?.();

  tuiLog("INFO", `job submit: node=${popup.nodeName} partition=${popup.partition} gpus=${popup.gpuCount} qos=${selectedQosName || "(default)"} login=${popup.loginNode}`);

  try {
    // 1. sbatch sleep infinity
    // Pass as a single shell string to SSH so --wrap 'sleep infinity' is not split
    const sshTarget = popup.sshUser ? `${popup.sshUser}@${popup.loginNode}` : popup.loginNode;
    const qosPart = selectedQosName ? ` --qos=${shellQuote(selectedQosName)}` : "";
    const remoteCmd = `sbatch --partition=${shellQuote(popup.partition)} --nodelist=${shellQuote(popup.nodeName)} --gres=gpu:${popup.gpuCount}${qosPart} --wrap 'sleep infinity'`;
    const sshCmd = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", sshTarget, remoteCmd];

    const sbatchProc = Bun.spawn(sshCmd, { stdout: "pipe", stderr: "pipe" });
    const sbatchOut = await new Response(sbatchProc.stdout).text();
    const sbatchErr = await new Response(sbatchProc.stderr).text();
    const sbatchExit = await sbatchProc.exited;
    if (sbatchExit !== 0) {
      throw new Error(`sbatch failed: ${sbatchErr.trim() || `exit ${sbatchExit}`}`);
    }

    // Parse JOBID from "Submitted batch job 1059327" - retry up to 3× on parse failure
    let jobIdMatch = sbatchOut.match(/Submitted batch job (\d+)/);
    if (!jobIdMatch) {
      // Some clusters emit delayed output; retry stderr+stdout combination
      const combined = sbatchOut + sbatchErr;
      jobIdMatch = combined.match(/Submitted batch job (\d+)/);
    }
    if (!jobIdMatch) {
      // Abort was requested before we even got JOBID - nothing to scancel
      if (popup.jobAbortRequested) {
        popup.jobSubmitStatus = "idle";
        _S_module._renderHook?.();
        return;
      }
      throw new Error(`Could not parse JOBID from sbatch output: "${sbatchOut.trim()}"`);
    }
    popup.jobId = jobIdMatch[1]!;
    // Check abort immediately after obtaining jobId - no orphan
    if (popup.jobAbortRequested) {
      tuiLog("INFO", `abort before polling: cancelling job ${popup.jobId}`);
      await cancelSlurmJob();
      return;
    }
    popup.jobSubmitStatus = "polling";
    _S_module._renderHook?.();
    tuiLog("INFO", `job submitted: JOBID=${popup.jobId}`);

    // 2. Poll squeue until RUNNING - 200ms tick × 300 = 60s max; abort responsive
    let running = false;
    const TICK_MS = 200;
    const POLL_EVERY = 10; // query squeue every 10 ticks (2s)
    let tickCount = 0;
    let totalTicks = 300;
    while (tickCount < totalTicks) {
      await new Promise(r => setTimeout(r, TICK_MS));
      if (!_S_module.slurmRunPopup) return; // popup closed
      if (popup.jobAbortRequested) {
        tuiLog("INFO", `abort requested for job ${popup.jobId}, cancelling`);
        await cancelSlurmJob();
        return;
      }
      tickCount++;
      if (tickCount % POLL_EVERY !== 0) continue;
      const sqCmd = ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
        "squeue", "-j", popup.jobId, "-h", "-o", "%T"];
      const sqProc = Bun.spawn(sqCmd, { stdout: "pipe", stderr: "pipe" });
      const sqOut = (await new Response(sqProc.stdout).text()).trim();
      await sqProc.exited;
      tuiLog("DEBUG", `poll squeue job ${popup.jobId}: state=${sqOut}`);
      if (sqOut === "RUNNING") { running = true; break; }
      if (sqOut === "FAILED" || sqOut === "CANCELLED" || sqOut === "TIMEOUT") {
        throw new Error(`Job ${popup.jobId} ended unexpectedly (state: ${sqOut})`);
      }
      // empty = job not in queue yet (pending or not found) - keep polling
    }
    if (!running) throw new Error(`Job ${popup.jobId} did not reach RUNNING state within 60s`);

    popup.jobSubmitStatus = "running";
    _S_module._renderHook?.();
    tuiLog("INFO", `job running: JOBID=${popup.jobId}`);
    void loadSlurmData().then(() => { _S_module._renderHook?.(); });

  } catch (e: any) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = e?.message || String(e);
    tuiLog("ERROR", `job submit failed: ${popup.jobErrorMsg}`);
    _S_module._renderHook?.();
  }
}

// ── Slurm Cluster Tab Renderer ───────────────────────────────────

const renderSlurmClusterTab = _mod_renderSlurmClusterTab;

// ── Slurm Tab ────────────────────────────────────────────────────

interface SlurmGPUSlot {
  index: number;
  user: string | null;
  job_id: number | null;
  job_name: string | null;
  job_state: string | null;
  job_time: string | null;
}

interface SlurmNodeInfo {
  name: string;
  partition: string;
  state: string;
  gpu_type: string;
  gpu_total: number;
  gpu_used: number;
  gpu_free: number;
  gpus: SlurmGPUSlot[];
}

interface SlurmSnapshot {
  cluster_name: string;
  timestamp: string;
  nodes: SlurmNodeInfo[];
  errors: string[];
  login_node: string | null;
  ssh_user: string;
}

type DashboardTab =
  | { type: "manual"; idx: number; name: string }
  | { type: "slurm"; idx: number; name: string };

type SlurmSortKey = "none" | "name" | "state" | "gpu_used" | "gpu_free";

// srun popup state
interface SlurmRunPopup {
  // snapshot at open time (immutable)
  clusterName: string;
  nodeName: string;
  partition: string;
  freeGpusAtOpen: number;
  snapshotTime: string;
  loginNode: string;
  sshUser: string;
  // user input
  gpuCount: number;
  // command edit
  editMode: boolean;
  cmdOverride: string | null; // null = use auto-generated command
  cursorPos: number;           // cursor index in cmdOverride (or auto cmd)
  // copy ui state
  copyStatus: "idle" | "ok" | "fail" | "stale";
  errorMsg: string;
  fullCmdForFallback: string; // set on copy failure
  // job submit state
  jobSubmitStatus: "idle" | "submitting" | "polling" | "running" | "cancelling" | "error";
  jobId: string;
  gpuIdxList: string;   // e.g. "2,3,5,7"
  jobErrorMsg: string;
  jobAbortRequested: boolean;
  // qos
  qosList: string[];
  qosIdx: number;       // 0 = no QoS (use partition default)
  qosLoading: boolean;     // true while fetching QoS list
  qosFetchFailed: boolean; // true if fetch failed - Submit blocked, user must edit cmd
  // existing jobs on this node (populated at open time)
  existingJobIds: number[];
  existingJobCancelStatus: "idle" | "cancelling" | "done" | "error";
  existingJobCancelMsg: string;
}

// Module-level render hook, set inside main()

async function loadSlurmData(): Promise<void> {
  if (_S_module.slurmLoading) return;
  _S_module.slurmLoading = true;
  _S_module.slurmError = null;
  tuiLog("DEBUG", `loadSlurmData: starting, OPENSMI=${JSON.stringify(OPENSMI)}, CWD=${OPENSMI_CWD}`);
  _S_module._renderHook?.();

  try {
    // Use --all to load all configured Slurm clusters
    const proc = spawn([...OPENSMI, "slurm", "--all", "--json"], {
      cwd: OPENSMI_CWD,
      env: OPENSMI_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 && exitCode !== 1) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr.trim() || `exit code ${exitCode}`);
    }

    const parsed = JSON.parse(stdout);
    // --all returns an array; single returns an object
    _S_module.slurmSnapshots = Array.isArray(parsed) ? parsed : [parsed];
    tuiLog("INFO", `slurm: loaded ${_S_module.slurmSnapshots.length} cluster(s), total ${_S_module.slurmSnapshots.reduce((s, c) => s + c.nodes.length, 0)} nodes`);
  } catch (e: any) {
    _S_module.slurmError = e?.message || String(e);
    _S_module.slurmSnapshots = [];
    tuiLog("ERROR", `slurm load failed: ${_S_module.slurmError}`);
  } finally {
    _S_module.slurmLoading = false;
    _S_module._renderHook?.();
  }
}


const renderSetupView = _mod_renderSetupView;

const renderRunnerPane = _mod_renderRunnerPane;


/**
 * Create job record from current launch configuration for immediate mode.
 * Returns job_id if successful, null otherwise.
 */
async function createImmediateJob(): Promise<string | null> {
  try {
    const jobData: Partial<Job> = {
      command: _S_module.launchDistMode === "single" ? _S_module.launchCommand : "",
      commands: _S_module.launchDistMode === "one-to-one" ? _S_module.launchCommands.filter(c => c.trim()) : [],
      gpus: _S_module.launchSelectedGpus.map(g => [g.node, g.gpu] as [string, number]),
      requested_gpu_count: 0,
      dist_mode: _S_module.launchDistMode,
      exec_mode: _S_module.launchMode,
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

async function executeLaunch(): Promise<void> {
  tuiLog("INFO", `executeLaunch - mode=${_S_module.launchMode} dist=${_S_module.launchDistMode} queue=${_S_module.launchQueueMode} gpus=${_S_module.launchSelectedGpus.length} cmd="${_S_module.launchCommand.slice(0, 80)}"`);
  _S_module.runnerState = "queued";
  _S_module.runnerStderr = [];
  _S_module.runnerAttachCmd = "";
  _S_module.runnerStartTime = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" });

  if (!_S_module.snapshot) {
    setLaunchError("No _S_module.snapshot available");
    _S_module.runnerState = "failed";
    return;
  }

  if (_S_module.launchSelectedGpus.length === 0) {
    setLaunchError("No GPUs available");
    _S_module.runnerState = "failed";
    return;
  }

  if (_S_module.launchDistMode === "single") {
    if (!_S_module.launchCommand.trim()) {
      setLaunchError("Command cannot be empty");
      _S_module.runnerState = "failed";
      return;
    }
  } else {
    const nonEmpty = _S_module.launchCommands.filter(c => c.trim()).length;
    if (nonEmpty === 0) {
      setLaunchError("At least one command must be provided");
      _S_module.runnerState = "failed";
      return;
    }

    if (nonEmpty !== _S_module.launchNumGpus) {
      _S_module.launchErrorMsg = `Expected ${_S_module.launchNumGpus} commands, got ${nonEmpty}`;
      _S_module.runnerState = "failed";
      return;
    }
  }

  _S_module.launchErrorMsg = "";
  _S_module.launchOutput = "";
  _S_module.runnerState = "preparing";

  try {
    // Hotfix: ensure latest setup edits are persisted before any submit/execute.
    await flushSetupChangesToConfig();

    // If queue mode is "queued", save to job store instead of executing immediately
    if (_S_module.launchQueueMode === "queued") {
      await saveJobToStore();
      return;
    }

    // Immediate mode: execute now and track in job store

    // Create job record before execution
    const currentJobId = await createImmediateJob();
    if (!currentJobId) {
      setLaunchError("Failed to create job record");
      _S_module.runnerState = "failed";
      return;
    }

    // Update launch history
    const tmpFile = `/tmp/opensmi-gpus-${crypto.randomUUID()}.json`;
    await Bun.write(tmpFile, JSON.stringify(_S_module.launchSelectedGpus));

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

    _S_module.runnerState = "sent";

    // Execute and collect tmux session names
    const tmuxSessions: string[] = [];

    if (_S_module.launchDistMode === "single") {
      const gpuIndices = _S_module.launchSelectedGpus.map(g => g.gpu).join(",");
      if (_S_module.launchMode === "tmux") {
        const nodes = Array.from(new Set(_S_module.launchSelectedGpus.map(g => g.node)));
        const sessionName = _S_module.launchTmuxSession.trim() || `opensmi-${currentJobId}-${tmuxSafeName(nodes[0])}`;
        tmuxSessions.push(sessionName);
        // Set launchTmuxSession so executeLaunchTmux uses it
        if (!_S_module.launchTmuxSession.trim()) {
          _S_module.launchTmuxSession = sessionName;
        }
        await executeLaunchTmux(_S_module.launchCommand, gpuIndices);
      } else {
        await executeLaunchDirect(_S_module.launchCommand, gpuIndices);
      }
    } else {
      // One-to-one mode
      if (_S_module.launchMode === "tmux") {
        for (let i = 0; i < _S_module.launchNumGpus; i++) {
          const cmd = _S_module.launchCommands[i]?.trim();
          if (!cmd) continue;
          const gpu = _S_module.launchSelectedGpus[i];
          if (!gpu) continue;
          const sessionName = _S_module.launchTmuxSession.trim()
            ? `${_S_module.launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
            : `opensmi-${currentJobId}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`;
          tmuxSessions.push(sessionName);
        }
      }
      await executeLaunchOneToOne();
    }

    // Update job status after execution
    const finalStatus = _S_module.launchErrorMsg ? "failed" : (_S_module.launchMode === "tmux" ? "running" : "done");
    await updateImmediateJob(currentJobId, finalStatus, tmuxSessions, _S_module.launchErrorMsg || null);
    await loadJobsFromCLI();

    if (_S_module.launchErrorMsg === "") {
      _S_module.runnerState = "running";
    } else {
      _S_module.runnerState = "failed";
    }
  } catch (e: any) {
    _S_module.launchErrorMsg = e?.message || String(e);
    _S_module.runnerState = "failed";
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
  const nodes = Array.from(new Set(_S_module.launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    _S_module.runnerState = "failed";
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

  _S_module.launchOutput = fullOutput.slice(0, 500);

  if (execStderr) {
    const stderrLines = execStderr.split("\n").filter((l: string) => l.trim());
    _S_module.runnerStderr = stderrLines.slice(-2).map((l: string) => l.slice(0, 100));
  }

  if (!payload.ok) {
    setLaunchError(
      execStderr.trim() ||
        payload.rawStderr.trim() ||
        "Remote command failed (see Output)"
    );
    _S_module.runnerState = "failed";
    return;
  }

  setStatus(
    `Launched (remote): ${command.slice(0, 40)}${command.length > 40 ? "..." : ""} on ${_S_module.launchSelectedGpus.length} GPU(s)`
  );
}


async function executeLaunchOneToOne(): Promise<void> {
  const results: string[] = [];

  for (let i = 0; i < _S_module.launchNumGpus; i++) {
    const cmd = _S_module.launchCommands[i]?.trim();
    if (!cmd) continue;

    const gpu = _S_module.launchSelectedGpus[i];
    if (!gpu) continue;

    const gpuIndex = String(gpu.gpu);

    if (_S_module.launchMode === "tmux") {
      const sessionName = _S_module.launchTmuxSession.trim()
        ? `${_S_module.launchTmuxSession}-${tmuxSafeName(gpu.node)}-gpu${gpu.gpu}`
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

  _S_module.launchOutput = results.join("\n");

  if (_S_module.launchMode === "tmux") {
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
  const nodes = Array.from(new Set(_S_module.launchSelectedGpus.map((g) => g.node)));
  if (nodes.length !== 1) {
    setLaunchError(`Single mode requires all GPUs on one node (got: ${nodes.join(", ")})`);
    _S_module.runnerState = "failed";
    return;
  }
  const node = nodes[0]!;

  const sessionName = _S_module.launchTmuxSession.trim() || `opensmi-${Date.now()}-${tmuxSafeName(node)}`;

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
    _S_module.launchOutput = preflightLines ? `Preflight:\n${preflightLines}` : payload.rawStdout.slice(0, 500);
    setLaunchError(errDetail);
    tuiLog("ERROR", `executeLaunchTmux failed: node=${node} session=${sessionName} err=${errDetail}`);
    _S_module.runnerState = "failed";
    return;
  }

  const attachHint = `tmux attach -t ${sessionName}`;
  _S_module.launchOutput = [
    preflightLines ? `Preflight:\n${preflightLines}` : "",
    `Local tmux session: ${sessionName} → SSH to ${node}`,
    "",
    "Attach with:",
    `  ${attachHint}`,
  ]
    .filter(Boolean)
    .join("\n");

  _S_module.runnerAttachCmd = attachHint;
  _S_module.runnerTmuxSession = sessionName;
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
    _S_module.screen = tabRegistry.activeTabId as typeof _S_module.screen;
    (_S_module as any).screen = _S_module.screen;
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

  // ── Pre-TUI splash: show loading message until all clusters are ready ──────
  // Write directly to stdout before entering alternate screen.
  // The spinner ticks every 80ms; we clear and replace the line in-place.
  const splashText = "opensmi: I'm coordinating with your GPUs";
  const spinFrames = ["░▒▓", "▒▓█", "▓█▓", "█▓▒", "▓▒░", "▒░▒"];
  let spinIdx = 0;
  process.stdout.write("\n");
  const splashInterval = setInterval(() => {
    const glyph = spinFrames[spinIdx++ % spinFrames.length];
    process.stdout.write(`\r  ${splashText} ${glyph}  `);
  }, 80);

  // Run all initial loads before entering TUI
  await loadClusterTabsFromConfig();
  try {
    const vr = await runOpensmi(["--version"]);
    const m = vr.stdout.match(/\d+\.\d+\.\d+/);
    if (m) _S_module.appVersion = m[0];
  } catch {}
  await Promise.all([
    loadAdminStatus(),
    _mod_pollAllClusters(),
    loadAllocations(),
    loadSystemUsers(true),
    loadJobsFromCLI(),
    loadSlurmData(),
  ]);

  clearInterval(splashInterval);
  process.stdout.write("\r\x1b[2K"); // clear splash line
  _S_module.bootLoading = false;
  // ────────────────────────────────────────────────────────────────────────────

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Trigger full re-render on terminal resize so colW is recomputed.
  renderer.on("resize", () => _S_module.requestRender?.());

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

      // Show "Copied" message (1s) in lower right
      const charCount = text.length;
      setStatus(`Copied ${charCount} char${charCount === 1 ? '' : 's'}`, 1000);

      // Clear selection immediately after copy (tmux-like behavior)
      // Use setImmediate to clear on next tick, ensuring copy completes first
      setImmediate(() => {
        if (sel?.clearSelection) {
          sel.clearSelection();
        } else if (sel?.setSelection) {
          sel.setSelection(null, null, null);
        }
        _S_module.requestRender?.();
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
    if (!force && _S_module.systemUsersLoadedAt && Date.now() - _S_module.systemUsersLoadedAt < 10 * 60_000) return;

    try {
      const { code, stdout, stderr } = await runOpensmi(["users", "--json", "--timeout", "8"]);
      if (code !== 0) {
        setStatus(`Failed to load system users: ${stderr.trim() || `exit ${code}`}`);
        return;
      }
      const data = JSON.parse(stdout) as any;
      const u = Array.isArray(data.users) ? (data.users as string[]) : [];
      _S_module.systemUsers = u;
      _S_module.systemUsersLoadedAt = Date.now();
      _mod_recomputeKnownUsers();
    } catch {
      // ignore
    }
  }

  function render() {
    _S_module._renderHook = render;  // expose to module-level functions
    _S_module.screen = (_S_module as any).screen;
    // Expire transient status messages
    if (_S_module.statusMsg && _S_module.statusUntil > 0 && Date.now() > _S_module.statusUntil) {
      _S_module.statusMsg = "";
      _S_module.statusUntil = 0;
    }

    // Remove all existing children
    const children = container.getChildren();
    for (const c of children) {
      container.remove(c.id);
    }

    let newNode: any;
    if (_S_module.screen === "setup" || _S_module.screen === "help") {
      tuiLog("INFO", `render: _S_module.screen=${_S_module.screen}, about to switch`);
    }
    switch (_S_module.screen) {
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
            Text({ content: `_S_module.setupNodes: ${_S_module.setupNodes.length}`, fg: "gray" }),
            Text({ content: `_S_module.setupSelectedIdx: ${_S_module.setupSelectedIdx}`, fg: "gray" }),
          );
        }
        break;
    }

    const toast = renderToast();
    const loading = renderLoadingBadge();
    const tabSwitcher = renderTabSwitcher();
    const root = Box(
      {
        position: "relative",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: C.bg,
        onMouseDown: (e: any) => {
          if (!_S_module.runnerFocused || _S_module.runnerInputTyping) return;
          if (_S_module.screen !== "dashboard" && _S_module.screen !== "my-gpu-view") return;
          const y = Number(e?.clientY ?? -1);
          if (!Number.isFinite(y)) return;
          if (y < runnerPaneTopRow()) {
            _S_module.runnerFocused = false;
            _S_module.runnerInputTyping = false;
            _S_module.requestRender?.();
          }
        },
      },
      renderGlobalTabBar(),
      Box({ flexGrow: 1, width: "100%" }, newNode),
      renderGlobalFooter(),
      ...(toast ? [toast] : []),
      ...(loading ? [loading] : []),
      ...(tabSwitcher ? [tabSwitcher] : [])
    );
    container.add(root);

    // Hide stale cursor blocks when we leave input screens.
    try {
      if (_S_module.screen !== "alloc") {
        renderer.setCursorPosition(0, 0, false);
      }
    } catch {
      // ignore
    }

    // Auto-refocus runner input when typing
    if (_S_module.runnerInputTyping || _S_module.runnerFocused) {
      setTimeout(() => {
        if (_S_module.launchDistMode === "single") {
          const inputAny: any = container.findDescendantById("runner-cmd-input");
          if (inputAny) inputAny.focus();
        } else {
          const inputAny: any = container.findDescendantById("runner-cmd-input-0");
          if (inputAny) inputAny.focus();
        }
      }, 10);
    }
  }
  _S_module.requestRender = render;

  // openSrunPopup callback: receives node name (not index) to avoid sort-mismatch bugs
  (_S_module as any).openSrunPopup = (nodeName: string) => {
    const dashboardTab = activeDashboardTab();
    const activeSlurmIdx = dashboardTab?.type === "slurm" ? dashboardTab.idx : null;
    if (activeSlurmIdx === null) { render(); return; }

    const snap = _S_module.slurmSnapshots[activeSlurmIdx];
    const node = snap?.nodes.find((n) => n.name === nodeName);
    if (node && snap) openSrunPopup(node, snap.cluster_name, snap);
    render();
  };

  (_S_module as any).openDetailView = (nodeAlias: string) => {
    const snap = activeDashboardSnapshot();
    if (!snap) return;
    const ni = snap.nodes.findIndex((n) => n.node_alias === nodeAlias);
    if (ni >= 0) setActiveDashboardSelectedNodeIdx(ni);
    _S_module.selectedGpuIdx = gpuIndicesForNode(snap.nodes[ni >= 0 ? ni : 0])[0] ?? 0;
    void navigateToTab("detail").then(() => {
      const node = activeDashboardSnapshot()?.nodes[activeDashboardSelectedNodeIdx()];
      if (node) void checkSudoForNode(node.node_alias);
      render();
    });
  };

  (_S_module as any).cycleAutoRefresh = () => { cycleAutoRefresh(); };

  tabRegistry.onMessage = (msg: string) => {
    setStatus(msg, 2000);
  };

  tabRegistry.register({
    id: "dashboard",
    label: "Dashboard",
    shortcut: "d",
    render: renderDashboard,
    onEnter: () => {
      void Promise.all([_mod_pollAllClusters(), loadAllocations(), loadSlurmData()])
        .then(() => { _S_module.requestRender?.(); })
        .catch(() => {});
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
      // Trigger background refresh without blocking tab switch
      void Promise.all([_mod_pollAllClusters(), loadAllocations()]).then(() => _S_module.requestRender?.());
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

  // Initial data is already loaded above (before TUI started).
  // Just kick off background workers.
  await _mod_dispatchQueuedJobs();
  await _mod_watchRunningJobs();
  render();

  // One-shot update hint (bottom-right toast, auto-hide)
  void maybeShowUpdateNotification();

  async function runRefreshCycle() {
    if (_S_module.runnerFocused || _S_module.runnerInputTyping) return;
    _S_module.isRefreshing = true;
    render();
    try {
      await Promise.all([_mod_pollAllClusters(), loadAllocations(), loadSlurmData()]);
      if (_S_module.screen === "jobs") {
        await loadJobsFromCLI();
      }
      await _mod_dispatchQueuedJobs();
      await _mod_watchRunningJobs();
    } finally {
      _S_module.isRefreshing = false;
      if (_S_module.screen === "dashboard" || _S_module.screen === "detail" || _S_module.screen === "jobs") {
        render();
      }
    }
  }

  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  function restartRefreshInterval() {
    if (refreshInterval !== null) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
    if (_S_module.autoRefreshSec === 0) return;
    refreshInterval = setInterval(() => { void runRefreshCycle(); }, _S_module.autoRefreshSec * 1000);
  }

  restartRefreshInterval();

  function cycleAutoRefresh() {
    const cycle: Array<0 | 10 | 30 | 60> = [10, 30, 60, 0];
    const next = cycle[(cycle.indexOf(_S_module.autoRefreshSec) + 1) % cycle.length]!;
    _S_module.autoRefreshSec = next;
    restartRefreshInterval();
    render();
  }

  // Cleanup old jobs every hour
  let cleanupCounter = 0;
  let cleanupInterval: ReturnType<typeof setInterval> | null = setInterval(async () => {
    cleanupCounter++;
    // Run cleanup every hour (360 cycles of 10s)
    if (cleanupCounter % 360 === 0) {
      await cleanupOldJobs();
      // Reload jobs to reflect cleanup
      await loadJobsFromCLI();
      _S_module.requestRender?.();
    }
  }, 10_000);

  // Key handling
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (_S_module.tabSwitcherOpen) {
      if (key.name === "escape") {
        _S_module.tabSwitcherOpen = false;
        render();
        return;
      }

      if (key.name === "return") {
        const tabs = tabRegistry.getAllVisible();
        const selectedTab = tabs[_S_module.tabSwitcherIdx];
        if (selectedTab) {
          const switched = await tabRegistry.switchTo(selectedTab.id);
          if (switched) {
            _S_module.screen = selectedTab.id as typeof _S_module.screen;
          }
          _S_module.tabSwitcherOpen = false;
          render();
        }
        return;
      }

      if (key.name === "up" || key.name === "k") {
        const tabs = tabRegistry.getAllVisible();
        _S_module.tabSwitcherIdx = (_S_module.tabSwitcherIdx - 1 + tabs.length) % tabs.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "j") {
        const tabs = tabRegistry.getAllVisible();
        _S_module.tabSwitcherIdx = (_S_module.tabSwitcherIdx + 1) % tabs.length;
        render();
        return;
      }

      if (key.name.length === 1) {
        const tabs = tabRegistry.getAllVisible();
        const matchedTab = tabs.find(t => t.shortcut === key.name);
        if (matchedTab) {
          const switched = await tabRegistry.switchTo(matchedTab.id);
          if (switched) {
            _S_module.screen = matchedTab.id as typeof _S_module.screen;
          }
          _S_module.tabSwitcherOpen = false;
          render();
        }
        return;
      }

      return;
    }

    // ctrl+x prefix key - works from ALL tabs
    if (key.name === "x" && key.ctrl) {
      _S_module.prefixKeyPressed = true;
      if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);
      _S_module.prefixKeyTimeout = setTimeout(() => {
        _S_module.prefixKeyPressed = false;
      }, 2000);
      render();
      return;
    }

    // ctrl+x t - tab switcher from ANY screen
    if (_S_module.prefixKeyPressed && key.name === "t") {
      _S_module.prefixKeyPressed = false;
      if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);
      _S_module.tabSwitcherOpen = true;
      _S_module.runnerFocused = false;
      _S_module.runnerInputTyping = false;
      _S_module.tabSwitcherIdx = tabRegistry.getAllVisible().findIndex(t => t.id === tabRegistry.activeTabId);
      if (_S_module.tabSwitcherIdx < 0) _S_module.tabSwitcherIdx = 0;
      render();
      return;
    }

    // ctrl+x q - quit from ANY screen
    if (_S_module.prefixKeyPressed && key.name === "q") {
      _S_module.prefixKeyPressed = false;
      if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);
      if (refreshInterval !== null) clearInterval(refreshInterval);
      if (cleanupInterval !== null) clearInterval(cleanupInterval);
      renderer.destroy();
      process.exit(0);
    }

    if (key.sequence === "/" || key.name === "/") {
      const now = Date.now();
      if (now - _lastBracketKeyTime < BRACKET_KEY_DEBOUNCE_MS) {
        return;
      }
      _lastBracketKeyTime = now;
      void _mod_navigateByDelta(1);
      return;
    }

    if ((key.name === "R" && key.shift) || key.sequence === "R") {
      cycleAutoRefresh();
      return;
    }

    if (_S_module.screen === "dashboard" || _S_module.screen === "my-gpu-view") {

      const bracketKey =
        key.sequence === "[" || key.sequence === "]"
          ? key.sequence
          : key.name === "[" || key.name === "]"
            ? key.name
            : null;
      if (bracketKey === "[" || bracketKey === "]") {
        const now = Date.now();
        if (now - _lastBracketKeyTime < BRACKET_KEY_DEBOUNCE_MS) {
          return;  // Ignore rapid-fire key presses
        }
        _lastBracketKeyTime = now;
        void _mod_navigateByDelta(bracketKey === "[" ? -1 : 1);
        return;
      }

      if (_S_module.prefixKeyPressed && key.name === "down") {
        // ctrl+x down: focus runner
        _S_module.prefixKeyPressed = false;
        if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);
        _S_module.runnerFocused = true;
        _S_module.runnerInputBuffer = _S_module.launchCommand;
        _S_module.runnerFocusedInputIdx = 0; // Start at first input

        // Initialize commands with GPU info if not already set
        if (_S_module.launchDistMode === "one-to-one") {
          for (let i = 0; i < _S_module.launchCommands.length; i++) {
            if (!_S_module.launchCommands[i] || _S_module.launchCommands[i] === "") {
              const gpu = _S_module.launchSelectedGpus[i];
              _S_module.launchCommands[i] = getGpuCommandPlaceholder(gpu);
            }
          }
        }

        _S_module.runnerInputTyping = false; // Ensure not in typing mode
        render();
        return;
      }

      if (_S_module.prefixKeyPressed && key.name === "f") {
        _S_module.prefixKeyPressed = false;
        if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);
        _S_module.runnerPaneFolded = !_S_module.runnerPaneFolded;
        render();
        return;
      }

      if (_S_module.prefixKeyPressed && key.name === "r" && _S_module.screen === "my-gpu-view") {
        _S_module.prefixKeyPressed = false;
        if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);

        const selectedBundle = _S_module.myGpuViewState.bundles[_S_module.myGpuViewState.selectedBundleIdx];
        if (selectedBundle && selectedBundle.gpus.length > 0) {
          _S_module.launchGpuMode = "selected";
          _S_module.launchManualGpus = [...selectedBundle.gpus];
          _S_module.launchNumGpus = selectedBundle.gpus.length;
          _S_module.launchSelectedGpus = [...selectedBundle.gpus];
          _S_module.launchSourceBundle = selectedBundle.label;

          if (_S_module.launchDistMode === "one-to-one") {
            _S_module.launchCommands = [];
            for (let i = 0; i < _S_module.launchNumGpus; i++) {
              const gpu = _S_module.launchSelectedGpus[i];
              _S_module.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }

          _S_module.runnerPaneFolded = false;
          _S_module.runnerFocused = true;
          _S_module.runnerInputBuffer = _S_module.launchCommand;
          _S_module.runnerFocusedInputIdx = 0;
          _S_module.runnerInputTyping = false;

          setStatus(`Runner opened with ${_S_module.launchNumGpus} GPU(s) from ${selectedBundle.label}`, 2000);
        } else {
          setStatus("No GPUs in selected bundle");
        }

        render();
        return;
      }

      if (_S_module.prefixKeyPressed && key.name === "return") {
        // ctrl+x Enter: execute commands
        _S_module.prefixKeyPressed = false;
        if (_S_module.prefixKeyTimeout) clearTimeout(_S_module.prefixKeyTimeout);

        // Capture input values from Input components (if in typing mode)
        // or fall back to stored values (if in focused-but-not-typing mode)
        if (_S_module.launchDistMode === "single") {
          const inputAny: any = container.findDescendantById("runner-cmd-input");
          if (inputAny) {
            _S_module.launchCommand = String(inputAny.value ?? "");
          }
          // Fallback: use runnerInputBuffer if Input wasn't rendered
          if (!_S_module.launchCommand.trim() && _S_module.runnerInputBuffer.trim()) {
            _S_module.launchCommand = _S_module.runnerInputBuffer;
          }
        } else {
          for (let i = 0; i < _S_module.launchNumGpus; i++) {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
            if (inputAny) {
              _S_module.launchCommands[i] = String(inputAny.value ?? "");
            }
          }
        }

        if (_S_module.launchMode === "tmux") {
          const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
          if (tmuxInputAny) {
            _S_module.launchTmuxSession = String(tmuxInputAny.value ?? "");
          }
        }

        _S_module.runnerInputTyping = false;
        _S_module.runnerFocused = false;
        await executeLaunch();
        render();
        return;
      }

      // === TYPING MODE ===
      if (_S_module.runnerInputTyping) {
        if (key.name === "escape") {
          // Capture input values before exiting typing mode
          if (_S_module.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            _S_module.runnerInputBuffer = String(inputAny?.value ?? "");
            _S_module.launchCommand = _S_module.runnerInputBuffer;
          } else {
            for (let i = 0; i < _S_module.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                _S_module.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (_S_module.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              _S_module.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          _S_module.runnerInputTyping = false;
          render();
        } else if (key.name === "return") {
          // Enter in typing mode: capture values and exit typing mode
          // (execution requires ctrl+x Enter from focused mode)
          if (_S_module.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            _S_module.runnerInputBuffer = String(inputAny?.value ?? "");
            _S_module.launchCommand = _S_module.runnerInputBuffer;
          } else {
            for (let i = 0; i < _S_module.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                _S_module.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (_S_module.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              _S_module.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          _S_module.runnerInputTyping = false;
          // Stay in focused mode - user can ctrl+x Enter to execute
          render();
        } else if (key.name === "down" && _S_module.launchDistMode === "one-to-one") {
          // Navigate to next input line (commands + tmux if applicable)
          const inputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
          if (inputAny) {
            _S_module.launchCommands[_S_module.runnerFocusedInputIdx] = String(inputAny?.value ?? "");
          }

          // If at last command line and tmux mode, move to tmux session input
          if (_S_module.runnerFocusedInputIdx === _S_module.launchNumGpus - 1 && _S_module.launchMode === "tmux") {
            _S_module.runnerFocusedInputIdx = -1; // Special value for tmux session
            render();
            setTimeout(() => {
              const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (tmuxInputAny) tmuxInputAny.focus();
            }, 50);
          } else {
            _S_module.runnerFocusedInputIdx = Math.min(_S_module.runnerFocusedInputIdx + 1, _S_module.launchNumGpus - 1);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        } else if (key.name === "up" && _S_module.launchDistMode === "one-to-one") {
          // Navigate to previous input line (tmux session ← commands)
          if (_S_module.runnerFocusedInputIdx === -1) {
            // From tmux session back to last command
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              _S_module.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
            _S_module.runnerFocusedInputIdx = _S_module.launchNumGpus - 1;
            render();
            setTimeout(() => {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }, 50);
          } else {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
            if (inputAny) {
              _S_module.launchCommands[_S_module.runnerFocusedInputIdx] = String(inputAny?.value ?? "");
            }

            _S_module.runnerFocusedInputIdx = Math.max(_S_module.runnerFocusedInputIdx - 1, 0);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        }
        // All other keys pass through to input
        return;
      }

      // (PREFIX KEY handlers moved to top of dashboard screen)

      // === RUNNER FOCUSED MODE ===
      if (_S_module.runnerFocused && (_S_module.screen === "dashboard" || _S_module.screen === "my-gpu-view")) {
        if (key.name === "escape") {
          _S_module.runnerFocused = false;

          // Capture input values
          if (_S_module.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            _S_module.runnerInputBuffer = String(inputAny?.value ?? "");
            _S_module.launchCommand = _S_module.runnerInputBuffer;
          } else {
            for (let i = 0; i < _S_module.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                _S_module.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (_S_module.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              _S_module.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          render();
          return;
        }

        if (key.name === "return") {
          // Enter in focused mode: start typing on current highlighted line
          _S_module.runnerInputTyping = true;
          render();
          setTimeout(() => {
            if (_S_module.runnerFocusedInputIdx === -1) {
              // Tmux session input
              const inputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (inputAny) inputAny.focus();
            } else if (_S_module.launchDistMode === "single") {
              const inputAny: any = container.findDescendantById("runner-cmd-input");
              if (inputAny) inputAny.focus();
            } else {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${_S_module.runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }
          }, 50);
          return;
        }

        if (key.name === "tab" && !key.shift) {
          key.preventDefault();
          _S_module.launchMode = _S_module.launchMode === "direct" ? "tmux" : "direct";
          render();
          return;
        }

        if (key.name === "tab" && key.shift) {
          key.preventDefault();
          if (_S_module.launchDistMode === "single") {
            _S_module.launchDistMode = "one-to-one";
            _S_module.launchCommands = [];
            for (let i = 0; i < _S_module.launchNumGpus; i++) {
              const gpu = _S_module.launchSelectedGpus[i];
              _S_module.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
            _S_module.runnerFocusedInputIdx = 0;
          } else {
            _S_module.launchDistMode = "single";
            _S_module.launchCommands = [];
          }
          render();
          return;
        }

        if (key.name === "+" || key.name === "=") {
          const oldMode = _S_module.launchGpuMode;
          const oldCount = _S_module.launchNumGpus;

          _S_module.launchNumGpus = Math.min(_S_module.launchNumGpus + 1, 16);

          // Get next best GPU via auto selection
          _S_module.launchGpuMode = "auto";
          await refreshLaunchGpuSelection();

          // Add the new GPU to manual selection
          if (_S_module.launchSelectedGpus.length > oldCount) {
            const newGpu = _S_module.launchSelectedGpus[_S_module.launchSelectedGpus.length - 1];
            if (newGpu && !_S_module.launchManualGpus.some(g => g.node === newGpu.node && g.gpu === newGpu.gpu)) {
              _S_module.launchManualGpus.push({ node: newGpu.node, gpu: newGpu.gpu });
            }
          }

          // Switch to selected mode to show marking
          _S_module.launchGpuMode = "selected";
          _S_module.launchSelectedGpus = _S_module.launchManualGpus.slice(0, _S_module.launchNumGpus);

          if (_S_module.launchDistMode === "one-to-one") {
            while (_S_module.launchCommands.length < _S_module.launchNumGpus) {
              const idx = _S_module.launchCommands.length;
              const gpu = _S_module.launchSelectedGpus[idx];
              _S_module.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }

          render();
          return;
        }

        if (key.name === "-" || key.name === "_") {
          _S_module.launchNumGpus = Math.max(_S_module.launchNumGpus - 1, 0); // Allow down to 0
          if (_S_module.launchDistMode === "one-to-one") {
            _S_module.launchCommands = _S_module.launchCommands.slice(0, _S_module.launchNumGpus);
          }
          // Sync GPU selection: remove last selected if exceeds count
          if (_S_module.launchManualGpus.length > _S_module.launchNumGpus) {
            _S_module.launchManualGpus.pop(); // Remove last selected GPU
          }
          await refreshLaunchGpuSelection();
          render();
          return;
        }

        if ((key.name === "q" || key.name === "Q") && !_S_module.runnerInputTyping) {
          key.preventDefault();
          _S_module.launchQueueMode = _S_module.launchQueueMode === "immediate" ? "queued" : "immediate";
          setStatus(`Queue mode: ${_S_module.launchQueueMode}`, 1500);
          render();
          return;
        }

        if (key.name === "down" && !_S_module.runnerInputTyping) {
          // Navigate down through input lines
          if (_S_module.launchDistMode === "single") {
            // Single mode: command → tmux session (if tmux mode)
            if (_S_module.launchMode === "tmux" && _S_module.runnerFocusedInputIdx === 0) {
              _S_module.runnerFocusedInputIdx = -1; // -1 = tmux session
              render();
            }
          } else {
            // One-to-one: line 0 → 1 → ... → N-1 → tmux (if tmux mode)
            const maxCmdIdx = _S_module.launchNumGpus - 1;
            if (_S_module.runnerFocusedInputIdx < maxCmdIdx) {
              _S_module.runnerFocusedInputIdx++;
              render();
            } else if (_S_module.launchMode === "tmux" && _S_module.runnerFocusedInputIdx === maxCmdIdx) {
              _S_module.runnerFocusedInputIdx = -1; // tmux session
              render();
            }
          }
          return;
        }

        if (key.name === "up" && !_S_module.runnerInputTyping) {
          // Navigate up through input lines
          if (_S_module.launchDistMode === "single") {
            // Single mode: tmux → command
            if (_S_module.launchMode === "tmux" && _S_module.runnerFocusedInputIdx === -1) {
              _S_module.runnerFocusedInputIdx = 0;
              render();
            }
          } else {
            // One-to-one: tmux → N-1 → ... → 1 → 0
            if (_S_module.runnerFocusedInputIdx === -1) {
              _S_module.runnerFocusedInputIdx = _S_module.launchNumGpus - 1;
              render();
            } else if (_S_module.runnerFocusedInputIdx > 0) {
              _S_module.runnerFocusedInputIdx--;
              render();
            }
          }
          return;
        }

        if (key.name === "g" && !_S_module.runnerInputTyping) {
          if (_S_module.launchGpuMode === "auto") {
            _S_module.launchGpuMode = "selected";
            _S_module.launchManualGpus = [...launchSelectedGpus];
            _S_module.launchSourceBundle = null;
            setStatus("GPU mode: Manual selection (click GPUs in panel or dashboard)");
          } else {
            _S_module.launchGpuMode = "auto";
            _S_module.launchManualGpus = [];
            _S_module.launchSourceBundle = null;
            await refreshLaunchGpuSelection();
            setStatus("GPU mode: Auto-ranked selection");
          }
          render();
          return;
        }

        // Detect typing when any printable key is pressed
        if (key.sequence && key.sequence.length === 1) {
          _S_module.runnerInputTyping = true;
          // Let the key pass through to input
        }
        return;
      }

      // === SLURM POPUP KEY HANDLING ===
      if (_S_module.slurmRunPopup) {
        const popup = _S_module.slurmRunPopup;

        // --- Edit mode: raw text input ---
        if (popup.editMode) {
          const cur = popup.cmdOverride ?? srunCommand(popup);
          const pos = Math.max(0, Math.min(popup.cursorPos, cur.length));
          if (key.name === "escape" || key.name === "return") {
            // Exit edit mode (keep changes)
            popup.editMode = false;
            popup.copyStatus = "idle";
            _S_module._renderHook?.();
          } else if (key.name === "left") {
            popup.cursorPos = Math.max(0, pos - 1);
            _S_module._renderHook?.();
          } else if (key.name === "right") {
            popup.cursorPos = Math.min(cur.length, pos + 1);
            _S_module._renderHook?.();
          } else if (key.name === "home" || (key.ctrl && key.sequence === "\x01")) {
            popup.cursorPos = 0;
            _S_module._renderHook?.();
          } else if (key.name === "end" || (key.ctrl && key.sequence === "\x05")) {
            popup.cursorPos = cur.length;
            _S_module._renderHook?.();
          } else if (key.name === "backspace" || key.sequence === "\x7f") {
            if (pos > 0) {
              popup.cmdOverride = cur.slice(0, pos - 1) + cur.slice(pos);
              popup.cursorPos = pos - 1;
              popup.copyStatus = "idle";
              _S_module._renderHook?.();
            }
          } else if (key.name === "delete") {
            if (pos < cur.length) {
              popup.cmdOverride = cur.slice(0, pos) + cur.slice(pos + 1);
              popup.copyStatus = "idle";
              _S_module._renderHook?.();
            }
          } else if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
            popup.cmdOverride = cur.slice(0, pos) + key.sequence + cur.slice(pos);
            popup.cursorPos = pos + 1;
            popup.copyStatus = "idle";
            _S_module._renderHook?.();
          }
          return;
        }

        // --- Normal mode ---
        const isBusy = popup.jobSubmitStatus === "submitting" || popup.jobSubmitStatus === "polling" || popup.jobSubmitStatus === "cancelling";
        if (key.name === "escape") {
          if (isBusy) {
            popup.jobAbortRequested = true;
            render();
          } else {
            closeSrunPopup();
            render();
          }
        } else if ((key.sequence === "x" || key.sequence === "X") && popup.jobSubmitStatus === "running" && popup.jobId) {
          cancelSlurmJob();
          render();
        } else if ((key.sequence === "x" || key.sequence === "X") && popup.jobSubmitStatus === "idle" && popup.existingJobIds.length > 0) {
          cancelExistingJobsInPopup();
          render();
        } else if ((key.sequence === "r" || key.sequence === "R") && popup.jobSubmitStatus === "error" && popup.loginNode) {
          // Resubmit
          popup.jobSubmitStatus = "idle";
          popup.jobErrorMsg = "";
          submitJobToSlurm();
          render();
        } else if ((key.sequence === "q" || key.sequence === "Q") && popup.qosList.length > 0 && !isBusy) {
          popup.qosIdx = (popup.qosIdx + 1) % (popup.qosList.length + 1);
          _S_module._renderHook?.();
        } else if (key.sequence === "e" || key.sequence === "E") {
          // Enter edit mode (only when not in error/resubmit state)
          if (popup.jobSubmitStatus === "idle" || popup.jobSubmitStatus === "running") {
            if (popup.cmdOverride === null) popup.cmdOverride = srunCommand(popup);
            popup.editMode = true;
            popup.cursorPos = popup.cmdOverride.length;
            popup.copyStatus = "idle";
            _S_module._renderHook?.();
          }
        } else if ((key.sequence === "r" || key.sequence === "R") && popup.jobSubmitStatus !== "error") {
          // Reset command override (only when not in error - error uses R for resubmit above)
          popup.cmdOverride = null;
          popup.editMode = false;
          popup.copyStatus = "idle";
          _S_module._renderHook?.();
        } else if (key.name === "right" || key.sequence === "+") {
          if (popup.gpuCount < popup.freeGpusAtOpen) { popup.gpuCount++; popup.cmdOverride = null; popup.copyStatus = "idle"; _S_module._renderHook?.(); }
        } else if (key.name === "left" || key.sequence === "-") {
          if (popup.gpuCount > 1) { popup.gpuCount--; popup.cmdOverride = null; popup.copyStatus = "idle"; _S_module._renderHook?.(); }
        } else if (key.sequence === "s" || key.sequence === "S") {
          // Submit job
          if (popup.loginNode && popup.gpuCount >= 1 && popup.gpuCount <= popup.freeGpusAtOpen && popup.jobSubmitStatus === "idle") {
            submitJobToSlurm(); // async, don't await - updates via _S_module._renderHook
            render();
          }
        } else if (key.name === "return" || key.sequence === "c" || key.sequence === "C") {
          const isEdited = popup.cmdOverride !== null;
          const gpuOk = popup.gpuCount >= 1 && popup.gpuCount <= popup.freeGpusAtOpen;
          if (isEdited || gpuOk) {
            await submitSrunPopup();
            render();
          }
        }
        return;
      }

      // === DASHBOARD FOCUS MODE (default) ===

      const dashboardTab = activeDashboardTab();
      const activeSlurmIdx = dashboardTab?.type === "slurm" ? dashboardTab.idx : null;

      // When viewing a Slurm cluster tab, handle navigation for Slurm nodes
      if (activeSlurmIdx !== null && _S_module.slurmSnapshots.length > 0) {
        const sNodes = _S_module.slurmSnapshots[activeSlurmIdx]?.nodes || [];
        if (key.name === "up" || (key.name === "k" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            _S_module.slurmSelectedIdx = _S_module.slurmSelectedIdx <= 0 ? sNodes.length - 1 : _S_module.slurmSelectedIdx - 1;
            // Scroll up with cursor
            if (_S_module.slurmSelectedIdx < _S_module.slurmScrollOff) _S_module.slurmScrollOff = _S_module.slurmSelectedIdx;
            // Wrap-around to bottom: adjust scroll to show last items
            if (_S_module.slurmSelectedIdx === sNodes.length - 1) {
              _S_module.slurmScrollOff = Math.max(0, sNodes.length - visH);
            }
            render();
          }
          return;
        } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            _S_module.slurmSelectedIdx = _S_module.slurmSelectedIdx >= sNodes.length - 1 ? 0 : _S_module.slurmSelectedIdx + 1;
            // Scroll down with cursor
            if (_S_module.slurmSelectedIdx >= _S_module.slurmScrollOff + visH) _S_module.slurmScrollOff = _S_module.slurmSelectedIdx - visH + 1;
            // Wrap-around to top: reset scroll
            if (_S_module.slurmSelectedIdx === 0) _S_module.slurmScrollOff = 0;
            render();
          }
          return;
        } else if (key.name === "return") {
          // Enter on Slurm tab → open srun popup for selected node
          const snap = _S_module.slurmSnapshots[activeSlurmIdx];
          const sortedN = _mod_sortSlurmNodes(snap?.nodes || [], _S_module.slurmSortKey);
          const node = sortedN[_S_module.slurmSelectedIdx];
          if (node && snap) openSrunPopup(node, snap.cluster_name, snap);
          render();
          return;
        } else if (key.sequence === "s" || key.sequence === "S") {
          const cycle: SlurmSortKey[] = ["none", "name", "state", "gpu_used", "gpu_free"];
          const idx = cycle.indexOf(_S_module.slurmSortKey);
          const next = cycle[(idx + 1) % cycle.length] ?? "none";
          _S_module.slurmSortKey = next;
          _S_module.slurmScrollOff = 0;
          _S_module.slurmSelectedIdx = 0;
          render();
          return;
        }
      }

      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        const dashboardSnapshot = activeDashboardSnapshot();
        if (dashboardSnapshot && dashboardSnapshot.nodes.length > 0) {
          const selectedIdx = activeDashboardSelectedNodeIdx();
          if (selectedIdx <= 0) {
            setActiveDashboardSelectedNodeIdx(dashboardSnapshot.nodes.length - 1);
          } else {
            setActiveDashboardSelectedNodeIdx(selectedIdx - 1);
          }
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        const dashboardSnapshot = activeDashboardSnapshot();
        if (dashboardSnapshot && dashboardSnapshot.nodes.length > 0) {
          const selectedIdx = activeDashboardSelectedNodeIdx();
          if (selectedIdx >= dashboardSnapshot.nodes.length - 1) {
            setActiveDashboardSelectedNodeIdx(0);
          } else {
            setActiveDashboardSelectedNodeIdx(selectedIdx + 1);
          }
          render();
        }
      } else if (key.name === "return") {
        if (dashboardTab?.type === "slurm") {
          render();
          return;
        }
        await navigateToTab("detail");
        const node = activeDashboardSnapshot()?.nodes[activeDashboardSelectedNodeIdx()];
        _S_module.selectedGpuIdx = gpuIndicesForNode(node)[0] ?? 0;
        if (node) void checkSudoForNode(node.node_alias);
        render();
      } else if (key.name === "tab" || key.sequence === "\t") {
        const tabs = buildDashboardTabs();
        const total = tabs.length;
        if (total > 1) {
          const delta = key.shift ? -1 : 1;
          _S_module.activeClusterTabIdx = (_S_module.activeClusterTabIdx + delta + total) % total;
          _S_module.slurmSelectedIdx = 0;
          _S_module.slurmScrollOff = 0;
          _S_module.slurmSortKey = "none";
          _S_module.slurmRunPopup = null;

          const nextTab = tabs[_S_module.activeClusterTabIdx] ?? null;
          if (nextTab?.type === "slurm" && !_S_module.slurmSnapshots[nextTab.idx]?.nodes?.length) {
            await loadSlurmData();
          }
        }
        render();
      } else if (key.name === "r") {
        _S_module.isRefreshing = true; render();
        try {
          if (dashboardTab?.type === "slurm") {
            await loadSlurmData();
          } else {
            await Promise.all([_mod_pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
          }
        } finally {
          _S_module.isRefreshing = false; 
        }
        render();
      } else if (key.name === "?" || key.name === "h") {
        await navigateToTab("help");
        render();
      }
      else if (key.name === "j") {
        await navigateToTab("jobs");
        render();
      } else if (key.name === "g" && !_S_module.runnerFocused) {
        await navigateToTab("my-gpu-view");
        render();
      }

      if (_S_module.screen === "my-gpu-view") {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
          return;
        }

        if (key.name === "up" || key.name === "k") {
          const bundles = _S_module.myGpuViewState.bundles;
          if (bundles.length > 0) {
            _S_module.myGpuViewState.selectedBundleIdx = (_S_module.myGpuViewState.selectedBundleIdx - 1 + bundles.length) % bundles.length;
            render();
          }
          return;
        }

        if (key.name === "down" || key.name === "j") {
          const bundles = _S_module.myGpuViewState.bundles;
          if (bundles.length > 0) {
            _S_module.myGpuViewState.selectedBundleIdx = (_S_module.myGpuViewState.selectedBundleIdx + 1) % bundles.length;
            render();
          }
          return;
        }

        if (key.name === "r") {
          _S_module.isRefreshing = true; render();
          try {
            await Promise.all([_mod_pollAllClusters(), loadAllocations()]);
          } finally {
            _S_module.isRefreshing = false; 
          }
          render();
          return;
        }

        if (key.name.length === 1) {
          const bundles = _S_module.myGpuViewState.bundles;
          const matchedIdx = bundles.findIndex(b => b.shortcut === key.name);
          if (matchedIdx >= 0) {
            _S_module.myGpuViewState.selectedBundleIdx = matchedIdx;
            render();
          }
          return;
        }
      }
    } else if (_S_module.screen === "detail") {
      const _detailSnap = activeDashboardSnapshot();
      const _detailNodeIdx = activeDashboardSelectedNodeIdx();
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(_S_module.selectedGpuIdx);
        if (pos > 0) {
          _S_module.selectedGpuIdx = idxs[pos - 1]!;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(_S_module.selectedGpuIdx);
        if (pos >= 0 && pos < idxs.length - 1) {
          _S_module.selectedGpuIdx = idxs[pos + 1]!;
          render();
        }
      } else if (key.name === "return" || key.name === "a") {
        if (!requireAdminUI("allocate")) return;

        // Prevent the triggering keypress from being delivered to the newly focused Input.
        // OpenTUI dispatches global handlers first; if we re-render/focus during this handler,
        // the new Input may otherwise receive the same in-flight key event.
        key.preventDefault();
        key.stopPropagation();

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        openAllocModal(node, _S_module.selectedGpuIdx);
      } else if (key.name === "*") {
        if (!requireAdminUI("open-to-all")) return;

        // Open-to-all allocation shortcut
        key.preventDefault();
        key.stopPropagation();

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        try {
          await allocSet(node.node_alias, _S_module.selectedGpuIdx, "*");
          setStatus(`Saved allocation: ${node.node_alias} GPU${_S_module.selectedGpuIdx} → *`);
          await Promise.all([_mod_pollAllClusters(), loadAllocations()]);
          render();
        } catch (e: any) {
          setStatus(e?.message ? `Alloc failed: ${e.message}` : "Alloc failed");
        }
      } else if (key.name === "x") {
        if (!requireAdminUI("clear allocation")) return;

        // Clear allocation for selected GPU
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        const existing = getAllocTarget(node.node_alias, _S_module.selectedGpuIdx);
        if (!existing) return;
        try {
          await allocClear(node.node_alias, _S_module.selectedGpuIdx);
          setStatus(`Cleared allocation: ${node.node_alias} GPU${_S_module.selectedGpuIdx}`);
          await loadAllocations();
          render();
        } catch {}
      } else if (key.name === "k" && key.shift) {
        if (!requireAdminUI("kill")) return;

        // Kill violator processes on selected GPU
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        const gi = node.gpus.find((g) => g.index === _S_module.selectedGpuIdx);
        if (!gi) return;

        const violProcs = node.processes.filter(
          (p) => p.gpu_uuid === gi.uuid && isViolation(node.node_alias, gi.index, p.user)
        );
        if (!violProcs.length) return;

        _S_module.killCtx = {
          nodeAlias: node.node_alias,
          gpuIdx: _S_module.selectedGpuIdx,
          pids: violProcs.map((p) => p.pid),
          users: violProcs.map((p) => p.user),
        };
        _S_module.killErrorMsg = "";
        _S_module.killOutput = "";
        _S_module.killInProgress = false;
        _S_module.runnerFocused = false;
        _S_module.runnerInputTyping = false;
        _S_module.screen = "kill";
        render();
      } else if (key.name === "escape" || key.name === "backspace") {
        await navigateToTab("dashboard");
        render();
      } else if (key.name === "p") {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        
        const isPinned = _S_module.myGpuViewState.pinnedGpus.some(g => g.node === node.node_alias && g.gpu === _S_module.selectedGpuIdx);
        if (isPinned) {
          _S_module.myGpuViewState.pinnedGpus = _S_module.myGpuViewState.pinnedGpus.filter(g => !(g.node === node.node_alias && g.gpu === _S_module.selectedGpuIdx));
          setStatus(`Unpinned GPU: ${node.node_alias}:GPU${_S_module.selectedGpuIdx}`);
        } else {
          _S_module.myGpuViewState.pinnedGpus.push({ node: node.node_alias, gpu: _S_module.selectedGpuIdx });
          setStatus(`Pinned GPU: ${node.node_alias}:GPU${_S_module.selectedGpuIdx}`);
        }
        await saveMyGpuViewState();
        render();
      } else if (key.name === "r") {
        _S_module.isRefreshing = true; render();
        try {
          await Promise.all([_mod_pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
        } finally {
          _S_module.isRefreshing = false; 
        }
        render();
      }
      // Quit via ctrl+x q (unified shortcut)
      // } else if (key.name === "q") {
      //   clearInterval(refreshInterval);
      //   renderer.destroy();
      //   process.exit(0);
      // }
    } else if (_S_module.screen === "kill") {
      if (key.name === "escape") {
        await navigateToTab("detail");
        _S_module.killCtx = null;
        _S_module.killErrorMsg = "";
        _S_module.killOutput = "";
        render();
      } else if (key.name === "return" && !_S_module.killInProgress) {
        if (!_S_module.killCtx || !_S_module.killCtx.pids.length) return;
        _S_module.killInProgress = true;
        render();

        try {
          const { code, stdout, stderr } = await killPids(
            _S_module.killCtx.nodeAlias,
            _S_module.killCtx.pids
          );
          _S_module.killOutput = stdout;
          if (code !== 0 && stderr.trim()) {
            _S_module.killErrorMsg = stderr.trim().slice(0, 120);
          }
        } catch (e: any) {
          _S_module.killErrorMsg = e?.message || String(e);
        }

        _S_module.killInProgress = false;
        render();

        setTimeout(async () => {
          if (_S_module.screen === "kill") {
            _S_module.killCtx = null;
            _S_module.killErrorMsg = "";
            _S_module.killOutput = "";
            await navigateToTab("detail");
            await Promise.all([_mod_pollAllClusters(), loadAllocations()]);
            render();
          }
        }, 2000);
      }
    } else if (_S_module.screen === "alloc") {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        await navigateToTab("detail");
        _S_module.allocCtx = null;
        _S_module.allocErrorMsg = "";
        _S_module.allocUserListFocused = false;
        _S_module.allocUserListIdx = 0;
        render();
      } else if (key.name === "left") {
        // Move focus from input to user list
        if (!_S_module.allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          _S_module.allocUserListFocused = true;
          _S_module.allocUserListIdx = 0;
          render();
        }
      } else if (key.name === "right") {
        // Move focus from user list to input
        if (_S_module.allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          _S_module.allocUserListFocused = false;
          render();
          setTimeout(() => {
            const inputAny: any = container.findDescendantById("alloc-user-input");
            if (inputAny) inputAny.focus();
          }, 50);
        }
      } else if (key.name === "up" && _S_module.allocUserListFocused) {
        key.preventDefault();
        _S_module.allocUserListIdx = Math.max(_S_module.allocUserListIdx - 1, 0);
        render();
        // Scroll into view
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(_S_module.allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "down" && _S_module.allocUserListFocused) {
        key.preventDefault();
        const maxIdx = _S_module.knownUsers.length - 1;
        _S_module.allocUserListIdx = Math.min(_S_module.allocUserListIdx + 1, maxIdx);
        render();
        // Scroll into view
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(_S_module.allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "return" && _S_module.allocUserListFocused) {
        // Select user from list
        key.preventDefault();
        key.stopPropagation();
        const selectedUser = _S_module.knownUsers[_S_module.allocUserListIdx];
        if (selectedUser) {
          _S_module.allocDraftUser = selectedUser;
          _S_module.allocUserListFocused = false;
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
        const current = String(inputAny?.value ?? _S_module.allocDraftUser);

        // Autocomplete the last segment to the first match.
        const parts = current.split(",");
        const last = (parts.pop() || "").trim();
        const f = last.toLowerCase();
        const universe = _S_module.knownUsers.length ? _S_module.knownUsers : [];
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

          _S_module.allocDraftUser = out.join(",");
          render();
        }
      } else if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        if (!_S_module.allocCtx) {
          _S_module.allocErrorMsg = "No allocation target";
          render();
          return;
        }

        const inputAny: any = container.findDescendantById("alloc-user-input");
        let user = String(inputAny?.value ?? "").trim();
        if (!user || user.toLowerCase() === "none") user = "*";
        _S_module.allocDraftUser = user;

        try {
          await allocSet(_S_module.allocCtx.nodeAlias, _S_module.allocCtx.gpuIdx, user);
          setStatus(`Saved allocation: ${_S_module.allocCtx.nodeAlias} GPU${_S_module.allocCtx.gpuIdx} → ${user}`);
          _S_module.allocCtx = null;
          _S_module.allocErrorMsg = "";
          await Promise.all([_mod_pollAllClusters(), loadAllocations()]);
          await navigateToTab("detail");
          render();
        } catch (e: any) {
          _S_module.allocErrorMsg = e?.message || String(e);
          render();
        }
      } else {
        // Update filtering/autocomplete state as the user types.
        if (_S_module.allocTypingTimer) clearTimeout(_S_module.allocTypingTimer);
        _S_module.allocTypingTimer = setTimeout(() => {
          const inputAny: any = container.findDescendantById("alloc-user-input");
          _S_module.allocDraftUser = String(inputAny?.value ?? "");
          render();
        }, 20);
      }
    } else if (_S_module.screen === "help") {
      if (
        key.name === "escape" ||
        key.name === "backspace" ||
        key.name === "?" ||
        key.name === "q"
      ) {
        await navigateToTab("dashboard");
        render();
      }
    } else if (_S_module.screen === "jobs") {
      if (_S_module.jobDetailView && _S_module.jobDetailLogView !== null) {
        // Log view mode
        if (key.name === "escape") {
          _S_module.jobDetailLogView = null;
          _S_module.jobDetailLogScroll = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          _S_module.jobDetailLogScroll = Math.max(0, _S_module.jobDetailLogScroll - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          _S_module.jobDetailLogScroll++;
          render();
        } else if (key.name === "pageup") {
          _S_module.jobDetailLogScroll = Math.max(0, _S_module.jobDetailLogScroll - 20);
          render();
        } else if (key.name === "pagedown") {
          _S_module.jobDetailLogScroll += 20;
          render();
        } else if (key.name === "r") {
          // Refresh log
          if (_S_module.jobDetailLogSession) {
            _S_module.jobDetailLogView = await captureTmuxPane(_S_module.jobDetailLogSession);
            render();
          }
        }
      } else if (_S_module.jobDetailView) {
        // Detail view mode
        const sessionCount = Math.max(_S_module.jobDetailView.tmux_sessions.length, _S_module.jobDetailView.gpus.length);

        if (key.name === "escape" || key.name === "backspace") {
          _S_module.jobDetailView = null;
          _S_module.jobDetailSelectedCmd = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          _S_module.jobDetailSelectedCmd = Math.max(0, _S_module.jobDetailSelectedCmd - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          _S_module.jobDetailSelectedCmd = Math.min(sessionCount - 1, _S_module.jobDetailSelectedCmd + 1);
          render();
        } else if (key.name === "return") {
          // Enter log view for selected session
          const session = _S_module.jobDetailView.tmux_sessions[_S_module.jobDetailSelectedCmd];
          if (session) {
            _S_module.jobDetailLogSession = session;
            _S_module.jobDetailLogScroll = 0;
            setStatus(`Loading log for ${session}...`);
            _S_module.jobDetailLogView = await captureTmuxPane(session);
            // Auto-scroll to bottom
            const lines = _S_module.jobDetailLogView.split("\n");
            const termHeight = process.stdout.rows || 40;
            _S_module.jobDetailLogScroll = Math.max(0, lines.length - (termHeight - 4));
            render();
          } else {
            setStatus("No tmux session available for this GPU");
            render();
          }
        } else if (key.name === "c") {
          await cancelJobAction(_S_module.jobDetailView);
          render();
        } else if (key.name === "r" && key.shift) {
          await retryJobAction(_S_module.jobDetailView);
          render();
        } else if (key.name === "r") {
          await retrySelectedSessionAction(_S_module.jobDetailView, _S_module.jobDetailSelectedCmd);
          render();
        } else if (key.name === "x") {
          await cleanupTmuxSessionsAction(_S_module.jobDetailView);
          render();
        }
      } else {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
        } else if (key.name === "up" || key.name === "k") {
          _S_module.selectedJobIdx = Math.max(0, _S_module.selectedJobIdx - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          _S_module.selectedJobIdx = Math.min(_S_module.jobList.length - 1, _S_module.selectedJobIdx + 1);
          render();
        } else if (key.name === "return") {
          if (_S_module.jobList.length > 0 && _S_module.jobList[_S_module.selectedJobIdx]) {
            _S_module.jobDetailView = _S_module.jobList[_S_module.selectedJobIdx];
            _S_module.jobDetailSelectedCmd = 0;
            _S_module.jobDetailLogView = null;
            _S_module.jobDetailLogScroll = 0;
            render();
            if (_S_module.jobDetailView.status === "running" && _S_module.jobDetailView.gpus.length > 0) {
              _mod_checkGpuLiveness(_S_module.jobDetailView).then(() => render());
            }
          }
        } else if (key.name === "c") {
          if (_S_module.jobList.length > 0 && _S_module.jobList[_S_module.selectedJobIdx]) {
            await cancelJobAction(_S_module.jobList[_S_module.selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && key.shift) {
          if (_S_module.jobList.length > 0 && _S_module.jobList[_S_module.selectedJobIdx]) {
            await retryJobAction(_S_module.jobList[_S_module.selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && !key.shift) {
          setStatus("Refreshing jobs...");
          await loadJobsFromCLI();
          setStatus("Jobs refreshed", 1000);
          render();
        } else if (key.name === "d") {
          if (_S_module.jobList.length > 0 && _S_module.jobList[_S_module.selectedJobIdx]) {
            await deleteJobAction(_S_module.jobList[_S_module.selectedJobIdx]);
            render();
          }
        } else if (key.name === "x") {
          if (_S_module.jobList.length > 0 && _S_module.jobList[_S_module.selectedJobIdx]) {
            await cleanupTmuxSessionsAction(_S_module.jobList[_S_module.selectedJobIdx]);
            render();
          }
        }
      }
    } else if (_S_module.screen === "setup") {
      if (_S_module.setupEditingField) {
        // Editing mode
        const fieldOrder: Array<"env_manager" | "env_name" | "work_dir"> = ["env_manager", "env_name", "work_dir"];
        const currentFieldIdx = fieldOrder.indexOf(_S_module.setupEditingField);

        if (key.name === "escape") {
          _S_module.setupEditingField = null;
          _S_module.setupEditBuffer = "";
          render();
        } else if (key.name === "return") {
          // Save current field and exit editing
          const node = _S_module.setupNodes[_S_module.setupSelectedIdx];
          if (node) {
            node[_S_module.setupEditingField] = _S_module.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          _S_module.setupEditingField = null;
          _S_module.setupEditBuffer = "";
          render();
        } else if (key.name === "tab" || key.name === "down") {
          // Save current field, move to next
          const node = _S_module.setupNodes[_S_module.setupSelectedIdx];
          if (node) {
            node[_S_module.setupEditingField] = _S_module.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx < fieldOrder.length - 1) {
            _S_module.setupEditingField = fieldOrder[currentFieldIdx + 1];
            _S_module.setupEditBuffer = node?.[_S_module.setupEditingField] || "";
          } else {
            // Wrap or exit
            _S_module.setupEditingField = null;
            _S_module.setupEditBuffer = "";
          }
          render();
        } else if (key.name === "up") {
          // Save current field, move to previous
          const node = _S_module.setupNodes[_S_module.setupSelectedIdx];
          if (node) {
            node[_S_module.setupEditingField] = _S_module.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx > 0) {
            _S_module.setupEditingField = fieldOrder[currentFieldIdx - 1];
            _S_module.setupEditBuffer = node?.[_S_module.setupEditingField] || "";
          } else {
            _S_module.setupEditingField = null;
            _S_module.setupEditBuffer = "";
          }
          render();
        } else if (key.name === "backspace") {
          _S_module.setupEditBuffer = _S_module.setupEditBuffer.slice(0, -1);
          render();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          _S_module.setupEditBuffer += key.sequence;
          render();
        }
      } else {
        // Navigation mode
        if (key.name === "up") {
          _S_module.setupSelectedIdx = Math.max(0, _S_module.setupSelectedIdx - 1);
          render();
        } else if (key.name === "down") {
          _S_module.setupSelectedIdx = Math.min(_S_module.setupNodes.length - 1, _S_module.setupSelectedIdx + 1);
          render();
        } else if (key.name === "return") {
          // Start editing env_manager
          _S_module.setupEditingField = "env_manager";
          _S_module.setupEditBuffer = _S_module.setupNodes[_S_module.setupSelectedIdx]?.env_manager || "";
          render();
        } else if (key.name === "escape") {
          await navigateToTab("dashboard");
          render();
        } else if (key.sequence === "s" || key.sequence === "S") {
          // Save current node
          const node = _S_module.setupNodes[_S_module.setupSelectedIdx];
          if (node) {
            const ok = await saveSetupNode(node);
            if (ok) {
              _S_module.setupDirtyAliases.delete(node.alias);
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
