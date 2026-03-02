/**
 * src/state/global.ts
 * All mutable global state for the opensmi TUI, exported as a single object `S`.
 * Using a single object ensures that mutations are shared across all importing modules
 * (plain `export let` does not share mutations across ES module boundaries).
 *
 * Extracted from index.ts — DO NOT modify index.ts yet (Phase 3 handles that).
 */

import os from "node:os";
import type {
  ClusterSnapshot,
  Allocation,
  Job,
  RunnerState,
  PreflightCheck,
  MyGpuViewState,
  ScreenId,
  NodeEnvConfig,
  SlurmSnapshot,
  SlurmRunPopup,
  SlurmSortKey,
  NodeCancelStatus,
} from "../types";

// ── Constants (derived at startup) ────────────────────────────────

export const OPERATOR: string = process.env.SUDO_USER || process.env.USER || "unknown";

export const CURRENT_USER_HOST: string = (() => {
  try {
    const user = os.userInfo().username || process.env.USER || "?";
    const host = os.hostname().split(".")[0] || "?";
    return `${user}@${host}`;
  } catch {
    return process.env.USER ? `${process.env.USER}@?` : "?";
  }
})();

export const runnerMinHeight = 8;
export const runnerMaxHeight = 40;

// ── Single shared mutable state object ────────────────────────────

export const S = {
  // Version
  appVersion: "" as string,
  latestVersion: "" as string,

  // Cluster / polling
  snapshot: null as ClusterSnapshot | null,
  extraSnapshots: [] as (ClusterSnapshot | null)[],
  extraPollErrors: [] as string[],
  extraClusterNames: [] as string[],
  extraSelectedNodeIdx: [] as number[],
  activeClusterTabIdx: 0,
  allocations: [] as Allocation[],
  gpuIdleStart: {} as Record<string, number>,
  lastPollTime: "",
  pollError: "",
  isPolling: false,
  bootLoading: true,

  // Navigation
  selectedNodeIdx: 0,
  selectedGpuIdx: 0,
  screen: "dashboard" as ScreenId,

  // Tab switcher
  tabSwitcherOpen: false,
  tabSwitcherIdx: 0,

  // Click tracking
  lastGpuClickKey: "",
  lastGpuClickAt: 0,
  lastNodeClickKey: "",
  lastNodeClickAt: 0,

  // Alloc modal
  allocCtx: null as { nodeAlias: string; gpuIdx: number } | null,
  allocUserListFocused: false,
  allocUserListIdx: 0,
  allocDraftUser: "",
  allocErrorMsg: "",
  allocTypingTimer: null as any,
  allocUserHighlight: "",
  lastAllocUserClickKey: "",
  lastAllocUserClickAt: 0,

  // Kill modal
  killCtx: null as { nodeAlias: string; gpuIdx: number; pids: number[]; users: string[] } | null,
  killErrorMsg: "",
  killOutput: "",
  killInProgress: false,

  // Prefix key system (ctrl+x)
  prefixKeyPressed: false,
  prefixKeyTimeout: null as any,

  // Runner pane
  runnerPaneFolded: false,
  runnerFocused: false,
  runnerInputTyping: false,
  runnerInputBuffer: "",
  runnerFocusedInputIdx: 0,
  runnerMouseDownTime: 0,
  runnerMouseDownPos: null as { x: number; y: number } | null,
  runnerOpen: false,
  runnerHeight: 15,
  runnerMaximized: false,

  // Launch config
  launchCommand: "",
  launchNumGpus: 0,
  launchErrorMsg: "",
  launchErrorTimeout: null as any,
  launchOutput: "",
  launchSelectedGpus: [] as Array<{ node: string; gpu: number }>,
  launchMode: "tmux" as "direct" | "tmux",
  launchTmuxSession: "",
  launchDistMode: "one-to-one" as "single" | "one-to-one",
  launchCommands: [] as string[],
  launchGpuMode: "auto" as "auto" | "selected",
  launchManualGpus: [] as Array<{ node: string; gpu: number }>,
  launchExcludedGpus: [] as Array<{ node: string; gpu: number }>,
  launchSelectionReasoning: "",
  launchSourceBundle: null as string | null,
  launchQueueMode: "immediate" as "immediate" | "queued",

  // Runner execution state
  runnerState: "idle" as RunnerState,
  runnerStartTime: "",
  runnerStderr: [] as string[],
  runnerAttachCmd: "",
  runnerTmuxSession: "",
  runnerPreflight: [] as PreflightCheck[],

  // Admin / sudo
  isAdmin: false,
  adminHint: "",
  sudoInfoMsg: "",
  sudoOkByNode: {} as Record<string, boolean | null>,
  sudoCheckingByNode: {} as Record<string, boolean>,

  // My GPU View
  myGpuViewState: {
    selectedBundleIdx: 0,
    bundles: [],
    expandedGpuKeys: new Set<string>(),
    pinnedGpus: [],
  } as MyGpuViewState,

  // Status message
  statusMsg: "",
  statusMsgTimeout: null as any,
  statusUntil: 0,

  // Users
  systemUsers: [] as string[],
  systemUsersLoadedAt: 0,
  knownUsers: [] as string[],

  // Render hook
  requestRender: null as (() => void) | null,
  openSrunPopup: undefined as ((nodeName: string) => void) | undefined,

  // Jobs view
  jobList: [] as Job[],
  selectedJobIdx: 0,
  jobDetailView: null as Job | null,
  jobDetailSelectedCmd: 0,
  jobDetailLogView: null as string | null,
  jobDetailLogSession: "" as string,
  jobDetailLogScroll: 0,
  jobsLastLoadTime: 0,

  // Setup view
  setupNodes: [] as NodeEnvConfig[],
  setupSelectedIdx: 0,
  setupEditingField: null as "env_manager" | "env_name" | "work_dir" | null,
  setupEditBuffer: "",
  setupMessage: "",
  setupMessageTimeout: null as ReturnType<typeof setTimeout> | null,
  setupDirtyAliases: new Set<string>(),

  // Slurm
  slurmSnapshots: [] as SlurmSnapshot[],
  slurmClusterConfigNames: [] as string[],
  slurmLoading: false,
  slurmError: null as string | null,
  slurmSelectedIdx: 0,
  slurmScrollOff: 0,
  slurmSortKey: "none" as SlurmSortKey,
  slurmRunPopup: null as SlurmRunPopup | null,
  nodeCancelStatus: null as NodeCancelStatus | null,

  // Internal render hook (set inside main)
  _renderHook: null as (() => void) | null,

  // Job dispatch
  isDispatching: false,
};
