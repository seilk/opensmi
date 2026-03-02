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
import { S as _S_module } from './src/state/global';
import { renderAlloc as _mod_renderAlloc } from './src/components/AllocModal';
import { renderGlobalTabBar as _mod_renderGlobalTabBar, renderGlobalFooter as _mod_renderGlobalFooter, renderToast as _mod_renderToast, renderTabSwitcher as _mod_renderTabSwitcher, navigateByDelta as _mod_navigateByDelta } from './src/components/Layout';
import { renderRunnerPane as _mod_renderRunnerPane } from './src/components/Runner';
import { renderLoadingBadge as _mod_renderLoadingBadge, renderDashboard as _mod_renderDashboard, renderSrunPopup as _mod_renderSrunPopup, renderSlurmClusterTab as _mod_renderSlurmClusterTab, sortSlurmNodes as _mod_sortSlurmNodes } from './src/views/Dashboard';
import { renderDetail as _mod_renderDetail, renderHelp as _mod_renderHelp, renderKill as _mod_renderKill } from './src/views/Detail';
import { renderJobsView as _mod_renderJobsView, renderJobsListView as _mod_renderJobsListView, renderJobDetailView as _mod_renderJobDetailView } from './src/views/Jobs';
import { renderMyGpuView as _mod_renderMyGpuView } from './src/views/MyGpus';
import { renderSetupView as _mod_renderSetupView } from './src/views/Setup';

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

let appVersion = ""; // populated at startup via opensmi --version
let latestVersion = ""; // populated after update check; non-empty = update available
let snapshot: ClusterSnapshot | null = null;
let extraSnapshots: (ClusterSnapshot | null)[] = [];
let extraPollErrors: string[] = [];
let extraClusterNames: string[] = [];
let extraSelectedNodeIdx: number[] = [];
let activeClusterTabIdx = 0;
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

// ── Global Tab Bar ─────────────────────────────────────────────────

// ── State sync bridge (Phase 3 Step 2) ──────────────────────────────────────
// Copies bare module-level globals → S before module render calls,
// and S → bare globals after. Remove in Phase 4 when index.ts uses S directly.
function syncStateToS(): void {
  (_S_module as any).appVersion = appVersion;
  (_S_module as any).latestVersion = latestVersion;
  (_S_module as any).snapshot = snapshot;
  (_S_module as any).extraSnapshots = extraSnapshots;
  (_S_module as any).extraPollErrors = extraPollErrors;
  (_S_module as any).extraClusterNames = extraClusterNames;
  (_S_module as any).extraSelectedNodeIdx = extraSelectedNodeIdx;
  (_S_module as any).activeClusterTabIdx = activeClusterTabIdx;
  (_S_module as any).allocations = allocations;
  (_S_module as any).gpuIdleStart = gpuIdleStart;
  (_S_module as any).lastPollTime = lastPollTime;
  (_S_module as any).pollError = pollError;
  (_S_module as any).isPolling = isPolling;
  (_S_module as any).bootLoading = bootLoading;
  (_S_module as any).selectedNodeIdx = selectedNodeIdx;
  (_S_module as any).selectedGpuIdx = selectedGpuIdx;
  (_S_module as any).screen = screen;
  (_S_module as any).tabSwitcherOpen = tabSwitcherOpen;
  (_S_module as any).tabSwitcherIdx = tabSwitcherIdx;
  (_S_module as any).lastGpuClickKey = lastGpuClickKey;
  (_S_module as any).lastGpuClickAt = lastGpuClickAt;
  (_S_module as any).lastNodeClickKey = lastNodeClickKey;
  (_S_module as any).lastNodeClickAt = lastNodeClickAt;
  (_S_module as any).allocCtx = allocCtx;
  (_S_module as any).allocUserListFocused = allocUserListFocused;
  (_S_module as any).allocUserListIdx = allocUserListIdx;
  (_S_module as any).allocDraftUser = allocDraftUser;
  (_S_module as any).allocErrorMsg = allocErrorMsg;
  (_S_module as any).allocTypingTimer = allocTypingTimer;
  (_S_module as any).allocUserHighlight = allocUserHighlight;
  (_S_module as any).lastAllocUserClickKey = lastAllocUserClickKey;
  (_S_module as any).lastAllocUserClickAt = lastAllocUserClickAt;
  (_S_module as any).killCtx = killCtx;
  (_S_module as any).killErrorMsg = killErrorMsg;
  (_S_module as any).killOutput = killOutput;
  (_S_module as any).killInProgress = killInProgress;
  (_S_module as any).prefixKeyPressed = prefixKeyPressed;
  (_S_module as any).prefixKeyTimeout = prefixKeyTimeout;
  (_S_module as any).runnerPaneFolded = runnerPaneFolded;
  (_S_module as any).runnerFocused = runnerFocused;
  (_S_module as any).runnerInputTyping = runnerInputTyping;
  (_S_module as any).runnerInputBuffer = runnerInputBuffer;
  (_S_module as any).runnerFocusedInputIdx = runnerFocusedInputIdx;
  (_S_module as any).runnerMouseDownTime = runnerMouseDownTime;
  (_S_module as any).runnerMouseDownPos = runnerMouseDownPos;
  (_S_module as any).runnerOpen = runnerOpen;
  (_S_module as any).runnerHeight = runnerHeight;
  (_S_module as any).runnerMaximized = runnerMaximized;
  (_S_module as any).launchCommand = launchCommand;
  (_S_module as any).launchNumGpus = launchNumGpus;
  (_S_module as any).launchErrorMsg = launchErrorMsg;
  (_S_module as any).launchErrorTimeout = launchErrorTimeout;
  (_S_module as any).launchOutput = launchOutput;
  (_S_module as any).launchSelectedGpus = launchSelectedGpus;
  (_S_module as any).launchMode = launchMode;
  (_S_module as any).launchTmuxSession = launchTmuxSession;
  (_S_module as any).launchDistMode = launchDistMode;
  (_S_module as any).launchCommands = launchCommands;
  (_S_module as any).launchGpuMode = launchGpuMode;
  (_S_module as any).launchManualGpus = launchManualGpus;
  (_S_module as any).launchExcludedGpus = launchExcludedGpus;
  (_S_module as any).launchSelectionReasoning = launchSelectionReasoning;
  (_S_module as any).launchSourceBundle = launchSourceBundle;
  (_S_module as any).launchQueueMode = launchQueueMode;
  (_S_module as any).runnerState = runnerState;
  (_S_module as any).runnerStartTime = runnerStartTime;
  (_S_module as any).runnerStderr = runnerStderr;
  (_S_module as any).runnerAttachCmd = runnerAttachCmd;
  (_S_module as any).runnerTmuxSession = runnerTmuxSession;
  (_S_module as any).runnerPreflight = runnerPreflight;
  (_S_module as any).isAdmin = isAdmin;
  (_S_module as any).adminHint = adminHint;
  (_S_module as any).sudoInfoMsg = sudoInfoMsg;
  (_S_module as any).sudoOkByNode = sudoOkByNode;
  (_S_module as any).sudoCheckingByNode = sudoCheckingByNode;
  (_S_module as any).myGpuViewState = myGpuViewState;
  (_S_module as any).statusMsg = statusMsg;
  (_S_module as any).statusMsgTimeout = statusMsgTimeout;
  (_S_module as any).statusUntil = statusUntil;
  (_S_module as any).systemUsers = systemUsers;
  (_S_module as any).systemUsersLoadedAt = systemUsersLoadedAt;
  (_S_module as any).knownUsers = knownUsers;
  (_S_module as any).requestRender = moduleRequestRender;
  (_S_module as any).jobList = jobList;
  (_S_module as any).selectedJobIdx = selectedJobIdx;
  (_S_module as any).jobDetailView = jobDetailView;
  (_S_module as any).jobDetailSelectedCmd = jobDetailSelectedCmd;
  (_S_module as any).jobDetailLogView = jobDetailLogView;
  (_S_module as any).jobDetailLogSession = jobDetailLogSession;
  (_S_module as any).jobDetailLogScroll = jobDetailLogScroll;
  (_S_module as any).jobsLastLoadTime = jobsLastLoadTime;
  (_S_module as any).setupNodes = setupNodes;
  (_S_module as any).setupSelectedIdx = setupSelectedIdx;
  (_S_module as any).setupEditingField = setupEditingField;
  (_S_module as any).setupEditBuffer = setupEditBuffer;
  (_S_module as any).setupMessage = setupMessage;
  (_S_module as any).setupMessageTimeout = setupMessageTimeout;
  (_S_module as any).setupDirtyAliases = setupDirtyAliases;
  (_S_module as any).slurmSnapshots = slurmSnapshots;
  (_S_module as any).slurmClusterConfigNames = slurmClusterConfigNames;
  (_S_module as any).slurmLoading = slurmLoading;
  (_S_module as any).slurmError = slurmError;
  (_S_module as any).slurmSelectedIdx = slurmSelectedIdx;
  (_S_module as any).slurmScrollOff = slurmScrollOff;
  (_S_module as any).slurmSortKey = slurmSortKey;
  (_S_module as any).slurmRunPopup = slurmRunPopup;
  (_S_module as any).nodeCancelStatus = nodeCancelStatus;
  (_S_module as any)._renderHook = moduleRenderHook;
  (_S_module as any).isDispatching = isDispatching;
}
function syncStateFromS(): void {
  appVersion = (_S_module as any).appVersion;
  latestVersion = (_S_module as any).latestVersion;
  snapshot = (_S_module as any).snapshot;
  extraSnapshots = (_S_module as any).extraSnapshots;
  extraPollErrors = (_S_module as any).extraPollErrors;
  extraClusterNames = (_S_module as any).extraClusterNames;
  extraSelectedNodeIdx = (_S_module as any).extraSelectedNodeIdx;
  activeClusterTabIdx = (_S_module as any).activeClusterTabIdx;
  allocations = (_S_module as any).allocations;
  gpuIdleStart = (_S_module as any).gpuIdleStart;
  lastPollTime = (_S_module as any).lastPollTime;
  pollError = (_S_module as any).pollError;
  isPolling = (_S_module as any).isPolling;
  bootLoading = (_S_module as any).bootLoading;
  selectedNodeIdx = (_S_module as any).selectedNodeIdx;
  selectedGpuIdx = (_S_module as any).selectedGpuIdx;
  screen = (_S_module as any).screen;
  tabSwitcherOpen = (_S_module as any).tabSwitcherOpen;
  tabSwitcherIdx = (_S_module as any).tabSwitcherIdx;
  lastGpuClickKey = (_S_module as any).lastGpuClickKey;
  lastGpuClickAt = (_S_module as any).lastGpuClickAt;
  lastNodeClickKey = (_S_module as any).lastNodeClickKey;
  lastNodeClickAt = (_S_module as any).lastNodeClickAt;
  allocCtx = (_S_module as any).allocCtx;
  allocUserListFocused = (_S_module as any).allocUserListFocused;
  allocUserListIdx = (_S_module as any).allocUserListIdx;
  allocDraftUser = (_S_module as any).allocDraftUser;
  allocErrorMsg = (_S_module as any).allocErrorMsg;
  allocTypingTimer = (_S_module as any).allocTypingTimer;
  allocUserHighlight = (_S_module as any).allocUserHighlight;
  lastAllocUserClickKey = (_S_module as any).lastAllocUserClickKey;
  lastAllocUserClickAt = (_S_module as any).lastAllocUserClickAt;
  killCtx = (_S_module as any).killCtx;
  killErrorMsg = (_S_module as any).killErrorMsg;
  killOutput = (_S_module as any).killOutput;
  killInProgress = (_S_module as any).killInProgress;
  prefixKeyPressed = (_S_module as any).prefixKeyPressed;
  prefixKeyTimeout = (_S_module as any).prefixKeyTimeout;
  runnerPaneFolded = (_S_module as any).runnerPaneFolded;
  runnerFocused = (_S_module as any).runnerFocused;
  runnerInputTyping = (_S_module as any).runnerInputTyping;
  runnerInputBuffer = (_S_module as any).runnerInputBuffer;
  runnerFocusedInputIdx = (_S_module as any).runnerFocusedInputIdx;
  runnerMouseDownTime = (_S_module as any).runnerMouseDownTime;
  runnerMouseDownPos = (_S_module as any).runnerMouseDownPos;
  runnerOpen = (_S_module as any).runnerOpen;
  runnerHeight = (_S_module as any).runnerHeight;
  runnerMaximized = (_S_module as any).runnerMaximized;
  launchCommand = (_S_module as any).launchCommand;
  launchNumGpus = (_S_module as any).launchNumGpus;
  launchErrorMsg = (_S_module as any).launchErrorMsg;
  launchErrorTimeout = (_S_module as any).launchErrorTimeout;
  launchOutput = (_S_module as any).launchOutput;
  launchSelectedGpus = (_S_module as any).launchSelectedGpus;
  launchMode = (_S_module as any).launchMode;
  launchTmuxSession = (_S_module as any).launchTmuxSession;
  launchDistMode = (_S_module as any).launchDistMode;
  launchCommands = (_S_module as any).launchCommands;
  launchGpuMode = (_S_module as any).launchGpuMode;
  launchManualGpus = (_S_module as any).launchManualGpus;
  launchExcludedGpus = (_S_module as any).launchExcludedGpus;
  launchSelectionReasoning = (_S_module as any).launchSelectionReasoning;
  launchSourceBundle = (_S_module as any).launchSourceBundle;
  launchQueueMode = (_S_module as any).launchQueueMode;
  runnerState = (_S_module as any).runnerState;
  runnerStartTime = (_S_module as any).runnerStartTime;
  runnerStderr = (_S_module as any).runnerStderr;
  runnerAttachCmd = (_S_module as any).runnerAttachCmd;
  runnerTmuxSession = (_S_module as any).runnerTmuxSession;
  runnerPreflight = (_S_module as any).runnerPreflight;
  isAdmin = (_S_module as any).isAdmin;
  adminHint = (_S_module as any).adminHint;
  sudoInfoMsg = (_S_module as any).sudoInfoMsg;
  sudoOkByNode = (_S_module as any).sudoOkByNode;
  sudoCheckingByNode = (_S_module as any).sudoCheckingByNode;
  Object.assign(myGpuViewState, (_S_module as any).myGpuViewState);
  statusMsg = (_S_module as any).statusMsg;
  statusMsgTimeout = (_S_module as any).statusMsgTimeout;
  statusUntil = (_S_module as any).statusUntil;
  systemUsers = (_S_module as any).systemUsers;
  systemUsersLoadedAt = (_S_module as any).systemUsersLoadedAt;
  knownUsers = (_S_module as any).knownUsers;
  jobList = (_S_module as any).jobList;
  selectedJobIdx = (_S_module as any).selectedJobIdx;
  jobDetailView = (_S_module as any).jobDetailView;
  jobDetailSelectedCmd = (_S_module as any).jobDetailSelectedCmd;
  jobDetailLogView = (_S_module as any).jobDetailLogView;
  jobDetailLogSession = (_S_module as any).jobDetailLogSession;
  jobDetailLogScroll = (_S_module as any).jobDetailLogScroll;
  jobsLastLoadTime = (_S_module as any).jobsLastLoadTime;
  setupNodes = (_S_module as any).setupNodes;
  setupSelectedIdx = (_S_module as any).setupSelectedIdx;
  setupEditingField = (_S_module as any).setupEditingField;
  setupEditBuffer = (_S_module as any).setupEditBuffer;
  setupMessage = (_S_module as any).setupMessage;
  setupMessageTimeout = (_S_module as any).setupMessageTimeout;
  setupDirtyAliases = (_S_module as any).setupDirtyAliases;
  slurmSnapshots = (_S_module as any).slurmSnapshots;
  slurmClusterConfigNames = (_S_module as any).slurmClusterConfigNames;
  slurmLoading = (_S_module as any).slurmLoading;
  slurmError = (_S_module as any).slurmError;
  slurmSelectedIdx = (_S_module as any).slurmSelectedIdx;
  slurmScrollOff = (_S_module as any).slurmScrollOff;
  slurmSortKey = (_S_module as any).slurmSortKey;
  slurmRunPopup = (_S_module as any).slurmRunPopup;
  nodeCancelStatus = (_S_module as any).nodeCancelStatus;
  isDispatching = (_S_module as any).isDispatching;
}

function moduleRequestRender(): void {
  syncStateFromS();
  requestRender?.();
}

function moduleRenderHook(): void {
  syncStateFromS();
  _renderHook?.();
}

function renderGlobalTabBar() {
  syncStateToS();
  const _r = _mod_renderGlobalTabBar();
  syncStateFromS();
  return _r;
}

function renderGlobalFooter() {
  syncStateToS();
  const _r = _mod_renderGlobalFooter();
  syncStateFromS();
  return _r;
}

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
let launchExcludedGpus: Array<{ node: string; gpu: number }> = [];
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

function runnerPaneTopRow(): number {
  const termRows = process.stdout.rows || 40;
  const paneRows = runnerPaneFolded
    ? 3
    : Math.max(3, Math.floor(termRows * 0.4));
  return Math.max(0, termRows - paneRows);
}

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
//  2) Installed binary:       opensmi (from PATH - works for pip, pyz, any install method)
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

async function loadClusterTabsFromConfig(): Promise<void> {
  try {
    // Load manual clusters
    const { code, stdout, stderr } = await runOpensmi(["clusters", "list", "--json"]);
    if (code !== 0) {
      setStatus(`Failed to load clusters: ${stderr.trim() || `exit ${code}`}`);
      extraClusterNames = [];
      extraSnapshots = [];
      extraPollErrors = [];
      extraSelectedNodeIdx = [];
      activeClusterTabIdx = 0;
    } else {
      const clusters = JSON.parse(stdout) as Array<{ cluster_name: string; node_count: number }>;
      if (clusters.length > 1) {
        extraClusterNames = clusters.slice(1).map((c) => String(c.cluster_name || "Cluster"));
        extraSnapshots = extraClusterNames.map(() => null);
        extraPollErrors = extraClusterNames.map(() => "");
        extraSelectedNodeIdx = extraClusterNames.map(() => 0);
      } else {
        extraClusterNames = [];
        extraSnapshots = [];
        extraPollErrors = [];
        extraSelectedNodeIdx = [];
        activeClusterTabIdx = 0;
      }
    }

    // Load Slurm cluster names from config (no SSH — just for tab bar placeholder)
    try {
      const slurm = await runOpensmi(["slurm", "--names-only"]);
      if (slurm.code === 0) {
        slurmClusterConfigNames = JSON.parse(slurm.stdout) as string[];
      }
    } catch {}

    const totalTabs = buildDashboardTabs().length;
    if (totalTabs > 0 && activeClusterTabIdx >= totalTabs) activeClusterTabIdx = 0;
  } catch (e: any) {
    setStatus(`Failed to load clusters: ${e?.message || String(e)}`);
    extraClusterNames = [];
    extraSnapshots = [];
    extraPollErrors = [];
    extraSelectedNodeIdx = [];
    activeClusterTabIdx = 0;
  }
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
      latestVersion = latest;
      setStatus(`Update available: v${latest}  → run: opensmi update`, 3000);
      requestRender?.();
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
excluded_nodes = set([g["node"] + ":" + str(g["gpu"]) for g in json.loads('${JSON.stringify(launchExcludedGpus)}')])
all_ranked_gpus = select_top_gpus(snap, 9999, history, alloc_data, current_user)
gpus = []
for n, g in all_ranked_gpus:
    if n + ":" + str(g) not in excluded_nodes:
        gpus.append((n, g))
        if len(gpus) >= ${launchNumGpus}:
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
  if (isPolling || (_S_module as any).isPolling) return;
  isPolling = true;
  (_S_module as any).isPolling = true;
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
    (_S_module as any).isPolling = false;
  }
}

async function pollExtraCluster(idx: number): Promise<void> {
  extraPollErrors[idx] = "";
  try {
    const clusterIdx = idx + 1;
    const proc = spawn([...OPENSMI, "poll", "--json", "--cluster-idx", String(clusterIdx)], {
      cwd: OPENSMI_CWD,
      env: OPENSMI_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    if (code !== 0) {
      extraPollErrors[idx] = stderr.trim() || `exit ${code}`;
      extraSnapshots[idx] = null;
      return;
    }

    const prevSelectedAlias = extraSnapshots[idx]?.nodes?.[extraSelectedNodeIdx[idx] || 0]?.node_alias;
    const next = JSON.parse(stdout) as ClusterSnapshot;
    next.nodes = [...next.nodes].sort((a, b) =>
      a.node_alias.localeCompare(b.node_alias, "en", { numeric: true, sensitivity: "base" })
    );

    extraSnapshots[idx] = next;
    const selectedIdx = extraSelectedNodeIdx[idx] || 0;
    if (prevSelectedAlias) {
      const i = next.nodes.findIndex((n) => n.node_alias === prevSelectedAlias);
      if (i >= 0) extraSelectedNodeIdx[idx] = i;
    }
    if (next.nodes.length === 0) {
      extraSelectedNodeIdx[idx] = 0;
    } else if (extraSelectedNodeIdx[idx] >= next.nodes.length) {
      extraSelectedNodeIdx[idx] = next.nodes.length - 1;
    }
  } catch (e: any) {
    extraPollErrors[idx] = e?.message || String(e);
    extraSnapshots[idx] = null;
  }
}

async function pollAllClusters(): Promise<void> {
  await Promise.all([pollCluster(), ...extraClusterNames.map((_, i) => pollExtraCluster(i))]);
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
  // Dispatch ALL queued jobs regardless of queue_mode - a queued job needs execution.
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

    const origGpus = job.gpus.slice();
    try {
      if (!hasExplicitGpus) {
        // No GPUs specified - auto-assign from available pool
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

      requestRender?.();
    }
  }
}

// Per-GPU liveness cache: jobId → { "node:gpu": alive }
const gpuLivenessCache: Map<string, Record<string, boolean>> = new Map();
// Consecutive "all dead" counter per job - only act after threshold
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
      // Don't act on failures - reset dead counter
      if (liveness === null) {
        tuiLog("DEBUG", `watchdog: job=${job.id} liveness check returned null (error/timeout), skipping`);
        // Don't increment dead count on errors - could be transient
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

      // ALL GPUs reported dead - increment consecutive counter
      const deadCount = (watchdogDeadCount.get(job.id) || 0) + 1;
      watchdogDeadCount.set(job.id, deadCount);

      const gpuSummary = Object.entries(liveness).map(([k, v]) => `${k}:${v ? "✓" : "✗"}`).join(" ");
      tuiLog("WARNING", `watchdog: job=${job.id} all dead (${deadCount}/${WATCHDOG_DEAD_THRESHOLD}) [${gpuSummary}]`);

      // Only act after consecutive threshold
      if (deadCount < WATCHDOG_DEAD_THRESHOLD) {
        continue;
      }

      // Confirmed dead - take action
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

function buildDashboardTabs(): DashboardTab[] {
  const tabs: DashboardTab[] = [];

  const allManualNames = [snapshot?.cluster_name || "Cluster", ...extraClusterNames];
  allManualNames.forEach((name, i) => {
    tabs.push({ type: "manual", idx: i, name });
  });

  const slurmNames = slurmSnapshots.length > 0
    ? slurmSnapshots.map((s) => s.cluster_name || "Slurm")
    : slurmClusterConfigNames;
  slurmNames.forEach((name, i) => {
    tabs.push({ type: "slurm", idx: i, name });
  });

  return tabs;
}

function activeDashboardTab(): DashboardTab | null {
  const tabs = buildDashboardTabs();
  if (tabs.length === 0) return null;
  return tabs[activeClusterTabIdx] ?? tabs[0] ?? null;
}



function activeManualTabIdx(): number | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return null;
  return tab.idx;
}

function activeDashboardSnapshot(): ClusterSnapshot | null {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return null;
  if (manualIdx === 0) return snapshot;
  return extraSnapshots[manualIdx - 1] || null;
}

function activeDashboardPollError(): string {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return "";
  if (manualIdx === 0) return pollError;
  return extraPollErrors[manualIdx - 1] || "";
}

function activeDashboardSelectedNodeIdx(): number {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return 0;
  if (manualIdx === 0) return selectedNodeIdx;
  return extraSelectedNodeIdx[manualIdx - 1] || 0;
}

function setActiveDashboardSelectedNodeIdx(nextIdx: number): void {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return;

  if (manualIdx === 0) {
    selectedNodeIdx = Math.max(0, nextIdx);
    return;
  }
  const arrIdx = manualIdx - 1;
  while (extraSelectedNodeIdx.length <= arrIdx) extraSelectedNodeIdx.push(0);
  extraSelectedNodeIdx[arrIdx] = Math.max(0, nextIdx);
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
  syncStateToS();
  const _r = _mod_renderToast();
  syncStateFromS();
  return _r;
}

function renderTabSwitcher() {
  syncStateToS();
  const _r = _mod_renderTabSwitcher();
  syncStateFromS();
  return _r;
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
  syncStateToS();
  const _r = _mod_renderLoadingBadge();
  syncStateFromS();
  return _r;
}

function renderDashboard() {
  syncStateToS();
  const _r = _mod_renderDashboard();
  syncStateFromS();
  return _r;
}

function renderDetail() {
  syncStateToS();
  const _r = _mod_renderDetail();
  syncStateFromS();
  return _r;
}

function renderHelp() {
  syncStateToS();
  const _r = _mod_renderHelp();
  syncStateFromS();
  return _r;
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

function formatJobDuration(startedAt: string | null, finishedAt: string | null): string {
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

function formatJobGpus(job: Job): string {
  if (job.gpus.length === 0) {
    if (job.requested_gpu_count > 0) {
      return `(auto×${job.requested_gpu_count})`;
    }
    return "-";
  }

  return job.gpus.map(([node, gpu]) => `${node}:${gpu}`).join(",");
}

function renderJobsView() {
  syncStateToS();
  const _r = _mod_renderJobsView();
  syncStateFromS();
  return _r;
}

function renderJobsListView() {
  syncStateToS();
  const _r = _mod_renderJobsListView();
  syncStateFromS();
  return _r;
}

function renderJobDetailView() {
  syncStateToS();
  const _r = _mod_renderJobDetailView();
  syncStateFromS();
  return _r;
}

function renderMyGpuView() {
  syncStateToS();
  const _r = _mod_renderMyGpuView();
  syncStateFromS();
  return _r;
}

function renderAlloc() {
  syncStateToS();
  const _r = _mod_renderAlloc();
  syncStateFromS();
  return _r;
}

function renderKill() {
  syncStateToS();
  const _r = _mod_renderKill();
  syncStateFromS();
  return _r;
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
  // Always read opensmi.json directly - this is config, not runtime state.
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

// ── srun Popup Helpers ───────────────────────────────────────────

function openSrunPopup(node: SlurmNodeInfo, clusterName: string, snap?: SlurmSnapshot) {
  slurmRunPopup = {
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
  _renderHook?.();
  // Async fetch QoS list for this partition
  if (snap?.login_node) {
    fetchQosForPartition(snap.login_node, snap.ssh_user || "", node.partition || "");
  }
}

function closeSrunPopup() {
  slurmRunPopup = null;
  _renderHook?.();
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
  const snap = slurmSnapshots[clusterIdx];
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
  const byName = slurmSnapshots.findIndex((s) => s.cluster_name === popup.clusterName);
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

function renderSrunPopup(popup: SlurmRunPopup) {
  syncStateToS();
  const _r = _mod_renderSrunPopup(popup);
  syncStateFromS();
  return _r;
}

async function submitSrunPopup() {
  if (!slurmRunPopup) return;
  const popup = slurmRunPopup;

  // If user edited the command, skip preflight and use override directly
  const cmd = popup.cmdOverride !== null ? popup.cmdOverride : srunCommand(popup);

  if (popup.cmdOverride === null) {
    // Preflight: re-check latest free GPUs (only for auto-generated commands)
    const popupSlurmIdx = slurmTabIdxForPopup(popup);
    const latestFree = popupSlurmIdx === null ? null : getLatestFreeGpus(popup.nodeName, popupSlurmIdx);
    if (latestFree === null) {
      popup.copyStatus = "stale";
      popup.errorMsg = "Node no longer found in cluster data.";
      _renderHook?.();
      return;
    }
    if (popup.gpuCount > latestFree) {
      popup.copyStatus = "stale";
      popup.errorMsg = `Capacity changed: was ${popup.freeGpusAtOpen}, now ${latestFree}. Adjust GPUs and retry.`;
      _renderHook?.();
      return;
    }
    if (latestFree === 0) {
      popup.copyStatus = "stale";
      popup.errorMsg = "No free GPUs available on this node.";
      _renderHook?.();
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
  _renderHook?.();
}

// Strict allowlist: Slurm names are alphanumeric + _ . : - only
function slurmNameSafe(s: string): boolean {
  return /^[A-Za-z0-9_.:\-]+$/.test(s);
}

async function fetchQosForPartition(loginNode: string, sshUser: string, partition: string) {
  if (!slurmRunPopup) return;
  const popup = slurmRunPopup;
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
    currentPopup = slurmRunPopup ?? popup;
    // Parse "AllowQos=normal,high" or "QoS=normal"
    const m = out.match(/AllowQos=([^\s]+)/) || out.match(/QoS=([^\s]+)/);
    if (m && m[1] !== "N/A" && m[1] !== "(null)") {
      currentPopup.qosList = m[1]!.split(",").filter(Boolean).filter(slurmNameSafe);
    }
    tuiLog("DEBUG", `QoS for ${partition}: ${JSON.stringify(currentPopup.qosList)}`);
  } catch (e) {
    tuiLog("DEBUG", `fetchQos failed: ${e}`);
    currentPopup.qosFetchFailed = true;
  } finally {
    currentPopup.qosLoading = false;
  }
  _renderHook?.();
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
let nodeCancelStatus: NodeCancelStatus | null = null;

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
    nodeCancelStatus = { node: node.name, status: "error", msg: "No login_node configured." };
    _renderHook?.();
    return;
  }

  nodeCancelStatus = { node: node.name, status: "cancelling", msg: "" };
  _renderHook?.();

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
        nodeCancelStatus = { node: node.name, status: "error", msg: `Owner check failed for job ${jobId}; blocked for safety.` };
        _renderHook?.();
        return;
      }
      if (jobOwner && snap.ssh_user && jobOwner !== snap.ssh_user) {
        nodeCancelStatus = { node: node.name, status: "error", msg: `Job ${jobId} owned by "${jobOwner}"; cancel denied.` };
        _renderHook?.();
        return;
      }
      const proc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget, `scancel ${jobId}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;
      tuiLog("INFO", `cancelJobsOnNode: scancel ${jobId} on ${node.name} done`);
    }
    nodeCancelStatus = { node: node.name, status: "done", msg: `Cancelled: ${jobIds.join(", ")}` };
    _renderHook?.();
    // Refresh cluster data after cancel - force render on completion
    setTimeout(async () => {
      await loadSlurmData();
      _renderHook?.();
    }, 1500);
  } catch (e: any) {
    nodeCancelStatus = { node: node.name, status: "error", msg: e?.message || String(e) };
    tuiLog("ERROR", `cancelJobsOnNode failed: ${nodeCancelStatus.msg}`);
  }
  _renderHook?.();
}

async function cancelExistingJobsInPopup() {
  if (!slurmRunPopup) return;
  const popup = slurmRunPopup;
  if (!popup.existingJobIds.length || !popup.loginNode) return;

  popup.existingJobCancelStatus = "cancelling";
  popup.existingJobCancelMsg = "";
  _renderHook?.();

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
        _renderHook?.();
        return;
      }
      if (jobOwner && popup.sshUser && jobOwner !== popup.sshUser) {
        popup.existingJobCancelStatus = "error";
        popup.existingJobCancelMsg = `Job ${jobId} owned by "${jobOwner}"; cancel denied.`;
        _renderHook?.();
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
    _renderHook?.();
    // Refresh cluster data
    setTimeout(async () => {
      await loadSlurmData();
      _renderHook?.();
    }, 1500);
  } catch (e: any) {
    popup.existingJobCancelStatus = "error";
    popup.existingJobCancelMsg = e?.message || String(e);
    _renderHook?.();
  }
}

async function cancelSlurmJob() {
  if (!slurmRunPopup) return;
  const popup = slurmRunPopup;
  if (!popup.jobId) return;
  // jobId must be purely numeric
  if (!/^\d+$/.test(popup.jobId)) {
    tuiLog("WARNING", `cancelSlurmJob: suspicious jobId "${popup.jobId}", aborting`);
    popup.jobSubmitStatus = "idle";
    _renderHook?.();
    return;
  }
  popup.jobSubmitStatus = "cancelling";
  _renderHook?.();
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
      _renderHook?.();
      return;
    }
    if (jobOwner && expectedUser && jobOwner !== expectedUser) {
      tuiLog("WARNING", `cancelSlurmJob: ownership mismatch - job ${popup.jobId} owner="${jobOwner}" expected="${expectedUser}", refusing scancel`);
      popup.jobSubmitStatus = "error";
      popup.jobErrorMsg = `Job ${popup.jobId} owned by "${jobOwner}"; cancel denied.`;
      _renderHook?.();
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
  _renderHook?.();
}

async function submitJobToSlurm() {
  if (!slurmRunPopup) return;
  const popup = slurmRunPopup;

  if (!popup.loginNode) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "No login_node configured for this cluster.";
    _renderHook?.();
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
      _renderHook?.();
      return;
    }
  }

  // Block submit if QoS is still loading
  if (popup.qosLoading) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "QoS list still loading - please wait a moment.";
    _renderHook?.();
    return;
  }

  popup.jobSubmitStatus = "submitting";
  popup.jobId = "";
  popup.gpuIdxList = "";
  popup.jobErrorMsg = "";
  popup.jobAbortRequested = false;
  _renderHook?.();

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
        _renderHook?.();
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
    _renderHook?.();
    tuiLog("INFO", `job submitted: JOBID=${popup.jobId}`);

    // 2. Poll squeue until RUNNING - 200ms tick × 300 = 60s max; abort responsive
    let running = false;
    const TICK_MS = 200;
    const POLL_EVERY = 10; // query squeue every 10 ticks (2s)
    let tickCount = 0;
    let totalTicks = 300;
    while (tickCount < totalTicks) {
      await new Promise(r => setTimeout(r, TICK_MS));
      if (!slurmRunPopup) return; // popup closed
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

    // 3. scontrol -d show job → GPU IDX
    const scCmd = ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
      "scontrol", "-d", "show", "job", popup.jobId];
    const scProc = Bun.spawn(scCmd, { stdout: "pipe", stderr: "pipe" });
    const scOut = await new Response(scProc.stdout).text();
    await scProc.exited;

    // Parse all "GresUsed=gpu:N(IDX:a,b,...)" segments, collect & dedupe indices
    const idxMatches = [...scOut.matchAll(/GresUsed=gpu:\d+\(IDX:([0-9,]+)\)/g)];
    if (idxMatches.length > 0) {
      const allIdx = idxMatches
        .flatMap(m => m[1]!.split(","))
        .filter(s => /^\d+$/.test(s))
        .map(Number);
      const unique = [...new Set(allIdx)].sort((a, b) => a - b);
      popup.gpuIdxList = unique.join(",");
    } else {
      popup.gpuIdxList = ""; // unavailable - don't show false data
      tuiLog("WARNING", `GresUsed IDX not found in scontrol output for job ${popup.jobId}`);
    }
    popup.jobSubmitStatus = "running";
    _renderHook?.();
    tuiLog("INFO", `job running: JOBID=${popup.jobId} GPU_IDX=${popup.gpuIdxList}`);

  } catch (e: any) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = e?.message || String(e);
    tuiLog("ERROR", `job submit failed: ${popup.jobErrorMsg}`);
    _renderHook?.();
  }
}

// ── Slurm Cluster Tab Renderer ───────────────────────────────────

function renderSlurmClusterTab(slurmIdx: number) {
  syncStateToS();
  const _r = _mod_renderSlurmClusterTab(slurmIdx);
  syncStateFromS();
  return _r;
}

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

let slurmSnapshots: SlurmSnapshot[] = [];
let slurmClusterConfigNames: string[] = []; // populated from config at startup (no SSH)
let slurmLoading = false;
let slurmError: string | null = null;
let slurmSelectedIdx = 0;
let slurmScrollOff = 0;
type SlurmSortKey = "none" | "name" | "state" | "gpu_used" | "gpu_free";
let slurmSortKey: SlurmSortKey = "none";

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
let slurmRunPopup: SlurmRunPopup | null = null;

// Module-level render hook, set inside main()
let _renderHook: (() => void) | null = null;

async function loadSlurmData(): Promise<void> {
  if (slurmLoading) return;
  slurmLoading = true;
  slurmError = null;
  tuiLog("DEBUG", `loadSlurmData: starting, OPENSMI=${JSON.stringify(OPENSMI)}, CWD=${OPENSMI_CWD}`);
  _renderHook?.();

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
    slurmSnapshots = Array.isArray(parsed) ? parsed : [parsed];
    tuiLog("INFO", `slurm: loaded ${slurmSnapshots.length} cluster(s), total ${slurmSnapshots.reduce((s, c) => s + c.nodes.length, 0)} nodes`);
  } catch (e: any) {
    slurmError = e?.message || String(e);
    slurmSnapshots = [];
    tuiLog("ERROR", `slurm load failed: ${slurmError}`);
  } finally {
    slurmLoading = false;
    _renderHook?.();
  }
}



function renderSetupView() {
  syncStateToS();
  const _r = _mod_renderSetupView();
  syncStateFromS();
  return _r;
}

function renderRunnerPane() {
  syncStateToS();
  const _r = _mod_renderRunnerPane();
  syncStateFromS();
  return _r;
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
  tuiLog("INFO", `executeLaunch - mode=${launchMode} dist=${launchDistMode} queue=${launchQueueMode} gpus=${launchSelectedGpus.length} cmd="${launchCommand.slice(0, 80)}"`);
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
    if (m) appVersion = m[0];
  } catch {}
  await Promise.all([
    loadAdminStatus(),
    pollAllClusters(),
    loadAllocations(),
    loadSystemUsers(true),
    loadJobsFromCLI(),
    loadSlurmData(),
  ]);

  clearInterval(splashInterval);
  process.stdout.write("\r\x1b[2K"); // clear splash line
  bootLoading = false;
  // ────────────────────────────────────────────────────────────────────────────

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
    _renderHook = render;  // expose to module-level functions
    screen = (_S_module as any).screen;
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
      {
        position: "relative",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: C.bg,
        onMouseDown: (e: any) => {
          if (!runnerFocused || runnerInputTyping) return;
          if (screen !== "dashboard" && screen !== "my-gpu-view") return;
          const y = Number(e?.clientY ?? -1);
          if (!Number.isFinite(y)) return;
          if (y < runnerPaneTopRow()) {
            runnerFocused = false;
            runnerInputTyping = false;
            requestRender?.();
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

  // openSrunPopup callback: receives node name (not index) to avoid sort-mismatch bugs
  (_S_module as any).openSrunPopup = (nodeName: string) => {
    const dashboardTab = activeDashboardTab();
    const activeSlurmIdx = dashboardTab?.type === "slurm" ? dashboardTab.idx : null;
    if (activeSlurmIdx === null) { render(); return; }

    const snap = slurmSnapshots[activeSlurmIdx];
    const node = snap?.nodes.find((n) => n.name === nodeName);
    if (node && snap) openSrunPopup(node, snap.cluster_name, snap);
    render();
  };

  tabRegistry.onMessage = (msg: string) => {
    setStatus(msg, 2000);
  };

  tabRegistry.register({
    id: "dashboard",
    label: "Dashboard",
    shortcut: "d",
    render: renderDashboard,
    onEnter: async () => {
      await Promise.all([pollAllClusters(), loadAllocations(), loadSlurmData()]);
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
      await Promise.all([pollAllClusters(), loadAllocations()]);
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
  await dispatchQueuedJobs();
  await watchRunningJobs();
  render();

  // One-shot update hint (bottom-right toast, auto-hide)
  void maybeShowUpdateNotification();

  // Auto-refresh every 10s
  // Dispatch + watchdog run on ALL tabs (jobs shouldn't stall because user is on setup)
  // UI refresh is skipped on non-data tabs to avoid unnecessary redraws
  const refreshInterval = setInterval(async () => {
    if (runnerFocused || runnerInputTyping) return;

    // Always poll cluster + allocations (needed for dispatch decisions)
    await Promise.all([pollAllClusters(), loadAllocations(), loadSlurmData()]);


    // Load jobs if on jobs tab
    if (screen === "jobs") {
      await loadJobsFromCLI();
    }

    // Dispatch queued jobs after snapshot update - runs regardless of active tab
    await dispatchQueuedJobs();

    // Watch running jobs for health and auto-restart - runs regardless of active tab
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

    // ctrl+x prefix key - works from ALL tabs
    if (key.name === "x" && key.ctrl) {
      prefixKeyPressed = true;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      prefixKeyTimeout = setTimeout(() => {
        prefixKeyPressed = false;
      }, 2000);
      render();
      return;
    }

    // ctrl+x t - tab switcher from ANY screen
    if (prefixKeyPressed && key.name === "t") {
      prefixKeyPressed = false;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      tabSwitcherOpen = true;
      runnerFocused = false;
      runnerInputTyping = false;
      tabSwitcherIdx = tabRegistry.getAllVisible().findIndex(t => t.id === tabRegistry.activeTabId);
      if (tabSwitcherIdx < 0) tabSwitcherIdx = 0;
      render();
      return;
    }

    // ctrl+x q - quit from ANY screen
    if (prefixKeyPressed && key.name === "q") {
      prefixKeyPressed = false;
      if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
      clearInterval(refreshInterval);
      renderer.destroy();
      process.exit(0);
    }

    if (screen === "dashboard" || screen === "my-gpu-view") {

      const bracketKey =
        key.sequence === "[" || key.sequence === "]"
          ? key.sequence
          : key.name === "[" || key.name === "]"
            ? key.name
            : null;
      if (bracketKey === "[") {
        await _mod_navigateByDelta(-1);
        return;
      }
      if (bracketKey === "]") {
        await _mod_navigateByDelta(1);
        return;
      }

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
          // Stay in focused mode - user can ctrl+x Enter to execute
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

      // === SLURM POPUP KEY HANDLING ===
      if (slurmRunPopup) {
        const popup = slurmRunPopup;

        // --- Edit mode: raw text input ---
        if (popup.editMode) {
          const cur = popup.cmdOverride ?? srunCommand(popup);
          const pos = Math.max(0, Math.min(popup.cursorPos, cur.length));
          if (key.name === "escape" || key.name === "return") {
            // Exit edit mode (keep changes)
            popup.editMode = false;
            popup.copyStatus = "idle";
            _renderHook?.();
          } else if (key.name === "left") {
            popup.cursorPos = Math.max(0, pos - 1);
            _renderHook?.();
          } else if (key.name === "right") {
            popup.cursorPos = Math.min(cur.length, pos + 1);
            _renderHook?.();
          } else if (key.name === "home" || (key.ctrl && key.sequence === "\x01")) {
            popup.cursorPos = 0;
            _renderHook?.();
          } else if (key.name === "end" || (key.ctrl && key.sequence === "\x05")) {
            popup.cursorPos = cur.length;
            _renderHook?.();
          } else if (key.name === "backspace" || key.sequence === "\x7f") {
            if (pos > 0) {
              popup.cmdOverride = cur.slice(0, pos - 1) + cur.slice(pos);
              popup.cursorPos = pos - 1;
              popup.copyStatus = "idle";
              _renderHook?.();
            }
          } else if (key.name === "delete") {
            if (pos < cur.length) {
              popup.cmdOverride = cur.slice(0, pos) + cur.slice(pos + 1);
              popup.copyStatus = "idle";
              _renderHook?.();
            }
          } else if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
            popup.cmdOverride = cur.slice(0, pos) + key.sequence + cur.slice(pos);
            popup.cursorPos = pos + 1;
            popup.copyStatus = "idle";
            _renderHook?.();
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
          _renderHook?.();
        } else if (key.sequence === "e" || key.sequence === "E") {
          // Enter edit mode (only when not in error/resubmit state)
          if (popup.jobSubmitStatus === "idle" || popup.jobSubmitStatus === "running") {
            if (popup.cmdOverride === null) popup.cmdOverride = srunCommand(popup);
            popup.editMode = true;
            popup.cursorPos = popup.cmdOverride.length;
            popup.copyStatus = "idle";
            _renderHook?.();
          }
        } else if ((key.sequence === "r" || key.sequence === "R") && popup.jobSubmitStatus !== "error") {
          // Reset command override (only when not in error - error uses R for resubmit above)
          popup.cmdOverride = null;
          popup.editMode = false;
          popup.copyStatus = "idle";
          _renderHook?.();
        } else if (key.name === "right" || key.sequence === "+") {
          if (popup.gpuCount < popup.freeGpusAtOpen) { popup.gpuCount++; popup.cmdOverride = null; popup.copyStatus = "idle"; _renderHook?.(); }
        } else if (key.name === "left" || key.sequence === "-") {
          if (popup.gpuCount > 1) { popup.gpuCount--; popup.cmdOverride = null; popup.copyStatus = "idle"; _renderHook?.(); }
        } else if (key.sequence === "s" || key.sequence === "S") {
          // Submit job
          if (popup.loginNode && popup.gpuCount >= 1 && popup.gpuCount <= popup.freeGpusAtOpen && popup.jobSubmitStatus === "idle") {
            submitJobToSlurm(); // async, don't await - updates via _renderHook
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
      if (activeSlurmIdx !== null && slurmSnapshots.length > 0) {
        const sNodes = slurmSnapshots[activeSlurmIdx]?.nodes || [];
        if (key.name === "up" || (key.name === "k" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            slurmSelectedIdx = slurmSelectedIdx <= 0 ? sNodes.length - 1 : slurmSelectedIdx - 1;
            // Scroll up with cursor
            if (slurmSelectedIdx < slurmScrollOff) slurmScrollOff = slurmSelectedIdx;
            // Wrap-around to bottom: adjust scroll to show last items
            if (slurmSelectedIdx === sNodes.length - 1) {
              slurmScrollOff = Math.max(0, sNodes.length - visH);
            }
            render();
          }
          return;
        } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            slurmSelectedIdx = slurmSelectedIdx >= sNodes.length - 1 ? 0 : slurmSelectedIdx + 1;
            // Scroll down with cursor
            if (slurmSelectedIdx >= slurmScrollOff + visH) slurmScrollOff = slurmSelectedIdx - visH + 1;
            // Wrap-around to top: reset scroll
            if (slurmSelectedIdx === 0) slurmScrollOff = 0;
            render();
          }
          return;
        } else if (key.name === "return") {
          // Enter on Slurm tab → open srun popup for selected node
          const snap = slurmSnapshots[activeSlurmIdx];
          const sortedN = _mod_sortSlurmNodes(snap?.nodes || [], slurmSortKey);
          const node = sortedN[slurmSelectedIdx];
          if (node && snap) openSrunPopup(node, snap.cluster_name, snap);
          render();
          return;
        } else if (key.sequence === "s" || key.sequence === "S") {
          const cycle: SlurmSortKey[] = ["none", "name", "state", "gpu_used", "gpu_free"];
          const idx = cycle.indexOf(slurmSortKey);
          const next = cycle[(idx + 1) % cycle.length] ?? "none";
          slurmSortKey = next;
          slurmScrollOff = 0;
          slurmSelectedIdx = 0;
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
        selectedGpuIdx = gpuIndicesForNode(node)[0] ?? 0;
        if (node) void checkSudoForNode(node.node_alias);
        render();
      } else if (key.name === "tab" || key.sequence === "\t") {
        const tabs = buildDashboardTabs();
        const total = tabs.length;
        if (total > 1) {
          const delta = key.shift ? -1 : 1;
          activeClusterTabIdx = (activeClusterTabIdx + delta + total) % total;
          slurmSelectedIdx = 0;
          slurmScrollOff = 0;
          slurmSortKey = "none";
          slurmRunPopup = null;

          const nextTab = tabs[activeClusterTabIdx] ?? null;
          if (nextTab?.type === "slurm" && !slurmSnapshots[nextTab.idx]?.nodes?.length) {
            await loadSlurmData();
          }
        }
        render();
      } else if (key.name === "r") {
        if (dashboardTab?.type === "slurm") {
          await loadSlurmData();
        } else {
          await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
        }
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
          await Promise.all([pollAllClusters(), loadAllocations()]);
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
      const _detailSnap = activeDashboardSnapshot();
      const _detailNodeIdx = activeDashboardSelectedNodeIdx();
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(selectedGpuIdx);
        if (pos > 0) {
          selectedGpuIdx = idxs[pos - 1]!;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
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

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        openAllocModal(node, selectedGpuIdx);
      } else if (key.name === "*") {
        if (!requireAdminUI("open-to-all")) return;

        // Open-to-all allocation shortcut
        key.preventDefault();
        key.stopPropagation();

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        try {
          await allocSet(node.node_alias, selectedGpuIdx, "*");
          setStatus(`Saved allocation: ${node.node_alias} GPU${selectedGpuIdx} → *`);
          await Promise.all([pollAllClusters(), loadAllocations()]);
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
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
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
        runnerFocused = false;
        runnerInputTyping = false;
        screen = "kill";
        render();
      } else if (key.name === "escape" || key.name === "backspace") {
        await navigateToTab("dashboard");
        render();
      } else if (key.name === "p") {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        
        const isPinned = myGpuViewState.pinnedGpus.some(g => g.node === node.node_alias && g.gpu === selectedGpuIdx);
        if (isPinned) {
          myGpuViewState.pinnedGpus = myGpuViewState.pinnedGpus.filter(g => !(g.node === node.node_alias && g.gpu === selectedGpuIdx));
          setStatus(`Unpinned GPU: ${node.node_alias}:GPU${selectedGpuIdx}`);
        } else {
          myGpuViewState.pinnedGpus.push({ node: node.node_alias, gpu: selectedGpuIdx });
          setStatus(`Pinned GPU: ${node.node_alias}:GPU${selectedGpuIdx}`);
        }
        await saveMyGpuViewState();
        render();
      } else if (key.name === "r") {
        await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
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
            await Promise.all([pollAllClusters(), loadAllocations()]);
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
          await Promise.all([pollAllClusters(), loadAllocations()]);
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
