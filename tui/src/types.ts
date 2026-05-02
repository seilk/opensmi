/**
 * src/types.ts
 * All shared TypeScript interfaces and type aliases for the opensmi TUI.
 * Extracted from index.ts to enable modular imports across src/ modules.
 */

// ── GPU / Cluster data ─────────────────────────────────────────────

export interface GPUInfo {
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

export interface GPUProcess {
  gpu_uuid: string;
  pid: number;
  process_name: string;
  cmdline?: string | null;
  used_memory_mib: number | null;
  user: string;
  runtime_s?: number | null;
}

export interface NodeSnapshot {
  node_alias: string;
  address: string;
  hostname: string | null;
  os: string | null;
  timestamp: string | null;
  gpus: GPUInfo[];
  processes: GPUProcess[];
  error: string | null;
}

export interface ClusterSnapshot {
  cluster_name: string;
  timestamp: string;
  nodes: NodeSnapshot[];
}

// ── Allocation / Job ───────────────────────────────────────────────

export interface Allocation {
  node_alias: string;
  gpu_index: number;
  target: string;
  assigned_by: string;
  assigned_at: string;
  expires_at?: string | null;
  notes: string;
}

export interface Job {
  id: string;
  command: string;
  commands: string[];
  gpus: [string, number][];
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

// ── Runner / Preflight ─────────────────────────────────────────────

export type RunnerState = "idle" | "queued" | "preparing" | "sent" | "running" | "failed";

export type PreflightCheck = {
  name: string;
  status: "pending" | "pass" | "fail";
  hint: string;
};

// ── My GPU View ────────────────────────────────────────────────────

export interface GpuBundle {
  id: string;
  label: string;
  type: "allocated" | "active" | "pinned";
  gpus: Array<{ node: string; gpu: number }>;
  shortcut?: string;
}

export interface MyGpuViewState {
  selectedBundleIdx: number;
  bundles: GpuBundle[];
  expandedGpuKeys: Set<string>;
  pinnedGpus: Array<{ node: string; gpu: number }>;
}

// ── Slurm ──────────────────────────────────────────────────────────

export interface SlurmGPUSlot {
  index: number;
  user: string | null;
  job_id: number | null;
  job_name: string | null;
  job_state: string | null;
  job_time: string | null;
}

export interface SlurmNodeInfo {
  name: string;
  partition: string;
  state: string;
  gpu_type: string;
  gpu_total: number;
  gpu_used: number;
  gpu_free: number;
  gpus: SlurmGPUSlot[];
}

export interface SlurmSnapshot {
  cluster_name: string;
  timestamp: string;
  nodes: SlurmNodeInfo[];
  errors: string[];
  login_node: string | null;
  ssh_user: string;
  ssh_port: number;
  identityfile: string;
  proxyjump: string;
}

export interface SlurmRunPopup {
  clusterName: string;
  nodeName: string;
  partition: string;
  freeGpusAtOpen: number;
  snapshotTime: string;
  loginNode: string;
  sshUser: string;
  sshPort: number;
  identityfile: string;
  proxyjump: string;
  gpuCount: number;
  editMode: boolean;
  cmdOverride: string | null;
  cursorPos: number;
  copyStatus: "idle" | "ok" | "fail" | "stale";
  errorMsg: string;
  fullCmdForFallback: string;
  jobSubmitStatus: "idle" | "submitting" | "polling" | "running" | "cancelling" | "error";
  jobId: string;
  gpuIdxList: string;
  jobErrorMsg: string;
  jobAbortRequested: boolean;
  qosList: string[];
  qosIdx: number;
  qosLoading: boolean;
  qosFetchFailed: boolean;
  existingJobIds: number[];
  existingJobCancelStatus: "idle" | "cancelling" | "done" | "error";
  existingJobCancelMsg: string;
}

export type SlurmSortKey = "none" | "name" | "state" | "gpu_used" | "gpu_free";

// ── Dashboard Tabs ─────────────────────────────────────────────────

export type DashboardTab =
  | { type: "manual"; idx: number; name: string }
  | { type: "slurm"; idx: number; name: string };

// ── Screen ─────────────────────────────────────────────────────────

export type ScreenId = "dashboard" | "detail" | "help" | "alloc" | "kill" | "my-gpu-view" | "jobs" | "setup";

// ── Setup ──────────────────────────────────────────────────────────

export interface NodeEnvConfig {
  alias: string;
  env_manager: string;
  env_name: string;
  work_dir: string;
}

// ── Misc ───────────────────────────────────────────────────────────

export interface NodeCancelStatus {
  node: string;
  status: "idle" | "cancelling" | "done" | "error";
  msg: string;
}
