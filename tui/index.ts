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

// ── Types ──────────────────────────────────────────────────────────

interface GPUInfo {
  index: number;
  uuid: string;
  name: string;
  memory_total_mib: number | null;
}

interface GPUProcess {
  gpu_uuid: string;
  pid: number;
  process_name: string;
  used_memory_mib: number | null;
  user: string;
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
  notes: string;
}

// ── State ──────────────────────────────────────────────────────────

let snapshot: ClusterSnapshot | null = null;
let allocations: Allocation[] = [];
let lastPollTime = "";
let pollError = "";
let selectedNodeIdx = 0;
let selectedGpuIdx = 0;
let screen: "dashboard" | "detail" | "help" | "alloc" | "kill" = "dashboard";
let lastGpuClickKey = "";
let lastGpuClickAt = 0;
let lastNodeClickKey = "";
let lastNodeClickAt = 0;
let allocCtx: { nodeAlias: string; gpuIdx: number } | null = null;
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

// Permissions
const OPERATOR = process.env.SUDO_USER || process.env.USER || "unknown";
let isAdmin = false;
let adminHint = "";

// UI helpers
let statusMsg = "";
let statusUntil = 0;
let systemUsers: string[] = [];
let systemUsersLoadedAt = 0;
let knownUsers: string[] = [];
let requestRender: (() => void) | null = null;

function getStateDir(): string {
  const homedir = process.env.HOME || "~";
  return process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
}

async function loadAdminStatus(): Promise<void> {
  try {
    const cfgPath = `${getStateDir()}/config.json`;
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
    adminHint = `Read-only (${OPERATOR}); config.json missing`;
  }
}

const PYTHON = "python3";

// For dev (repo checkout), running from tui/ we want to point one level up.
// For a compiled binary, the source tree may not exist; in that case we should NOT force cwd.
const DEFAULT_BASE_DIR = new URL("..", import.meta.url).pathname;
const EXEC_DIR = path.dirname(process.execPath);

function _isRepoRoot(p: string): boolean {
  return existsSync(`${p}/pyproject.toml`) && existsSync(`${p}/opensmi/__init__.py`);
}

const BASE_DIR_CANDIDATES = [
  process.env.OPENSMI_BASE_DIR,
  DEFAULT_BASE_DIR,
  // If running a locally built binary from tui/dist, repo root is typically ../../
  path.resolve(EXEC_DIR, "..", ".."),
  process.cwd(),
].filter(Boolean) as string[];

const BASE_DIR = BASE_DIR_CANDIDATES.find(_isRepoRoot) || "";
const OPENSMI_CWD = BASE_DIR ? BASE_DIR : undefined;

const OPENSMI = [PYTHON, "-m", "opensmi"];

async function runMicvgpus(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn([...OPENSMI, ...args], {
    cwd: OPENSMI_CWD,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function allocSet(
  nodeAlias: string,
  gpuIdx: number,
  user: string
): Promise<void> {
  const by = process.env.USER || "admin";
  const { code, stderr } = await runMicvgpus([
    "alloc",
    "set",
    nodeAlias,
    String(gpuIdx),
    user,
    "--by",
    by,
  ]);

  if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`);
}

async function allocClear(nodeAlias: string, gpuIdx: number): Promise<void> {
  const { code, stderr } = await runMicvgpus([
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
  return await runMicvgpus(args);
}

// ── Data fetching ──────────────────────────────────────────────────

async function pollCluster(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  pollError = "";

  try {
    const proc = spawn([...OPENSMI, "poll", "--json"], {
      cwd: OPENSMI_CWD,
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

    snapshot = JSON.parse(stdout) as ClusterSnapshot;
    lastPollTime = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" });
    recomputeKnownUsers();
  } catch (e: any) {
    pollError = e.message || String(e);
  } finally {
    isPolling = false;
  }
}

async function loadAllocations(): Promise<void> {
  try {
    // We load from the JSON file directly (source of truth for the TUI)
    const homedir = process.env.HOME || "~";
    const stateDir = process.env.OPENSMI_STATE_DIR || `${homedir}/.opensmi`;
    const allocPath = `${stateDir}/allocations.json`;
    try {
      const raw = await Bun.file(allocPath).text();
      const data = JSON.parse(raw);
      allocations = (data.allocations || []) as Allocation[];
    } catch {
      allocations = [];
    }
  } catch {
    allocations = [];
  } finally {
    recomputeKnownUsers();
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

function getAllocTarget(nodeAlias: string, gpuIdx: number): string | null {
  const a = allocations.find(
    (a) => a.node_alias === nodeAlias && a.gpu_index === gpuIdx
  );
  return a?.target || null;
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
  if (target === null) return true; // unallocated = violation when require_allocation
  if (target === "*") return false;

  const allowed = new Set(_parseTargets(target));
  return !allowed.has(user);
}

function gpuMemStr(mib: number | null): string {
  if (mib === null) return "?";
  return `${Math.round(mib / 1024)}G`;
}

function setStatus(msg: string, ttlMs: number = 3000) {
  statusMsg = msg;
  statusUntil = Date.now() + ttlMs;
  requestRender?.();
}

function openAllocModal(node: NodeSnapshot, gpuIdx: number): void {
  allocCtx = { nodeAlias: node.node_alias, gpuIdx };
  allocErrorMsg = "";
  allocUserHighlight = "";

  const existing = getAllocTarget(node.node_alias, gpuIdx);
  let prefill = existing || "";
  if (!prefill) {
    const gi = node.gpus.find((g) => g.index === gpuIdx);
    if (gi) {
      const live = usersOnGpu(node, gi.uuid);
      if (live.length === 1) prefill = live[0] || "";
    }
  }

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
    if (!t || t === "*") continue;
    users.add(t);
  }

  knownUsers = [...users].sort((a, b) => a.localeCompare(b));
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

function requireAdminUI(action: string): boolean {
  if (isAdmin) return true;
  setStatus(`Admin only: ${action} (${adminHint})`);
  return false;
}

function renderLoadingBadge() {
  if (!bootLoading && snapshot) return null;

  const msg = bootLoading ? "Loading..." : "Loading...";
  return Box(
    {
      position: "absolute",
      left: 1,
      top: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: C.bgAlt,
      borderStyle: "rounded",
      borderColor: C.border,
      zIndex: 10_000,
    },
    Text({ content: msg, fg: C.textDim })
  );
}

function renderDashboard() {
  if (!snapshot) return Box({ flexDirection: "column" }, Text({ content: "Loading..." }));

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
      content: t`GPUs: ${fg(C.green)(`${usedGpus}`)}/${totalGpus}  Violations: ${violationCount > 0 ? fg(C.red)(`${violationCount}`) : fg(C.green)("0")}  Poll: ${lastPollTime || "—"}  ${isPolling ? fg(C.yellow)("⟳") : ""}`,
    })
  );

  // Table header
  const colW = [10, 16, 16, 16, 16, 6];
  const tableHeader = Box(
    {
      flexDirection: "row",
      paddingLeft: 1,
      backgroundColor: C.bgAlt,
    },
    Text({ content: "Node".padEnd(colW[0]!), fg: C.textDim }),
    Text({ content: "GPU 0".padEnd(colW[1]!), fg: C.textDim }),
    Text({ content: "GPU 1".padEnd(colW[2]!), fg: C.textDim }),
    Text({ content: "GPU 2".padEnd(colW[3]!), fg: C.textDim }),
    Text({ content: "GPU 3".padEnd(colW[4]!), fg: C.textDim }),
    Text({ content: "Free".padEnd(colW[5]!), fg: C.textDim })
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
        Text({ content: n.node_alias.padEnd(colW[0]!), fg: isSelected ? "#ffffff" : C.text }),
        Text({ content: `ERROR: ${n.error}`.slice(0, 60), fg: C.red }),
        // Click anywhere on the row to jump to detail.
        Box({
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 999,
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
            }

            requestRender?.();
          },
        })
      );
    }

    const idxToUuid: Record<number, string> = {};
    for (const g of n.gpus) idxToUuid[g.index] = g.uuid;

    const gpuCells: any[] = [];
    let free = 0;

    for (let i = 0; i < 4; i++) {
      const uuid = idxToUuid[i];
      if (!uuid) {
        gpuCells.push(Text({ content: "—".padEnd(colW[i + 1]!), fg: C.textDim }));
        continue;
      }
      const users = usersOnGpu(n, uuid);
      if (users.length === 0) {
        const allocTarget = getAllocTarget(n.node_alias, i);
        const label = allocTarget ? `[${allocTarget}]` : "idle";
        gpuCells.push(Text({ content: label.padEnd(colW[i + 1]!), fg: C.textDim }));
        free++;
      } else {
        const hasViolation = users.some((u) => isViolation(n.node_alias, i, u));
        const cell = users.join("+");
        const display = cell.length > colW[i + 1]! - 1 ? cell.slice(0, colW[i + 1]! - 2) + "…" : cell;
        gpuCells.push(
          Text({
            content: display.padEnd(colW[i + 1]!),
            fg: hasViolation ? C.red : C.green,
          })
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
      Text({
        content: (isSelected ? "▸ " : "  ").slice(0, 2) + n.node_alias.padEnd(colW[0]! - 2),
        fg: isSelected ? "#ffffff" : C.cyan,
      }),
      ...gpuCells,
      Text({ content: `${free}/4`, fg: free > 0 ? C.green : C.yellow }),
      // Click anywhere on the row to jump to detail.
      Box({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 999,
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
          }

          requestRender?.();
        },
      })
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
        content: t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Detail  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[?]")} Help  ${fg(C.textDim)("[q]")} Quit`,
      })
    )
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg },
    header,
    tableHeader,
    ...rows,
    footer
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

  const children: any[] = [];

  // Header
  children.push(
    Text({ content: `${node.node_alias} (${node.hostname || node.address}) — ${node.os || ""}`, fg: C.blue }),
    Text({ content: "" })
  );

  // Per-GPU sections
  for (const g of node.gpus) {
    const procs = node.processes.filter((p) => p.gpu_uuid === g.uuid);
    const allocTarget = getAllocTarget(node.node_alias, g.index);
    const allocStr = allocTarget ? `Alloc: ${allocTarget}` : "Alloc: (none)";

    const isSel = g.index === selectedGpuIdx;
    const prefix = isSel ? "▸" : " ";
    children.push(
      Box(
        { width: "100%", height: 1, position: "relative" },
        Text({
          content: ` ${prefix} GPU ${g.index}  |  ${g.name}  |  ${gpuMemStr(g.memory_total_mib)}  |  ${allocStr}`,
          fg: isSel ? "#ffffff" : C.cyan,
        }),
        Box({
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 999,
          onMouseDown: (e: any) => {
            e.preventDefault?.();
            e.stopPropagation?.();

            selectedGpuIdx = g.index;

            // Double-click to open Allocate modal.
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
        children.push(
          Text({
            content: `    PID ${String(p.pid).padEnd(8)} ${p.user.padEnd(14)} ${mem.padStart(10)}  ${p.process_name}${violMark}`,
            fg: viol ? C.red : C.text,
          })
        );
      }
    }

    children.push(Text({ content: "" }));
  }

  children.push(
    Text({
      content:
        isAdmin
          ? "[↑↓] GPU  [a] Allocate  [*] Open-to-all  [x] Clear alloc  [Shift+K] Kill violators  [Esc] Back  [r] Refresh"
          : "[↑↓] GPU  [Esc] Back  [r] Refresh   (read-only)",
      fg: C.textDim,
    }),
    Text({ content: statusMsg ? ` ${statusMsg}` : " ", fg: statusMsg ? C.yellow : C.textDim })
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 1 },
    ...children
  );
}

function renderHelp() {
  return Box(
    { flexDirection: "column", backgroundColor: C.bg, padding: 2 },
    Text({ content: t`${bold(fg(C.blue)("opensmi — Help"))}` }),
    Text({ content: "" }),
    Text({ content: t`${fg(C.cyan)("Dashboard:")}` }),
    Text({ content: "  ↑/↓ or j/k   Navigate nodes" }),
    Text({ content: "  Enter         Node detail view" }),
    Text({ content: "  r             Refresh (poll all nodes)" }),
    Text({ content: "  q / Ctrl+C    Quit" }),
    Text({ content: "" }),
    Text({ content: t`${fg(C.cyan)("Detail view:")}` }),
    Text({ content: "  ↑/↓ or j/k        Select GPU" }),
    Text({ content: "  a                Allocate selected GPU" }),
    Text({ content: "  x                Clear allocation" }),
    Text({ content: "  Shift+K          Kill violators (best-effort)" }),
    Text({ content: "  Esc / Backspace   Back to dashboard" }),
    Text({ content: "  r                 Refresh" }),
    Text({ content: "" }),
    Text({ content: t`${fg(C.cyan)("Colors:")}` }),
    Text({ content: t`  ${fg(C.green)("Green")}   — Allocated user (OK)` }),
    Text({ content: t`  ${fg(C.red)("Red")}     — Violation (wrong/unallocated user)` }),
    Text({ content: t`  ${fg(C.textDim)("Gray")}    — Idle / no process` }),
    Text({ content: "" }),
    Text({ content: t`${fg(C.textDim)("[Esc]")} Back` })
  );
}

function renderAlloc() {
  const ctx = allocCtx;
  if (!ctx) return Text({ content: "No allocation context", fg: C.red });

  const nodeSnap = snapshot?.nodes.find((n) => n.node_alias === ctx.nodeAlias) || null;
  const gpuInfo = nodeSnap?.gpus.find((g) => g.index === ctx.gpuIdx) || null;
  const liveUsers = nodeSnap && gpuInfo ? usersOnGpu(nodeSnap, gpuInfo.uuid) : [];

  const currentAlloc = getAllocTarget(ctx.nodeAlias, ctx.gpuIdx);
  const currentAllocStr = currentAlloc ? currentAlloc : "(none)";
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
    placeholder: "username or *",
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

    for (const u of filteredUsers) {
      const isSel = currentSet.has(u);
      userRows.push(
        Box(
          {
            width: "100%",
            height: 1,
            position: "relative",
            paddingLeft: 1,
            backgroundColor: allocUserHighlight === u ? "#33467c" : isSel ? "#3b4261" : C.bg,
          },
          Text({ content: `${isSel ? "▸" : " "} ${u}`, fg: isSel ? "#ffffff" : C.text }),
          // Overlay to make the row reliably clickable without triggering text selection.
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 999,
            onMouseDown: (_e: any) => {
              _e.preventDefault?.();
              _e.stopPropagation?.();

              // Single click: highlight only. Double click: toggle selection (type).
              const now = Date.now();
              const clickKey = `USER:${u}`;
              const isDouble = clickKey === lastAllocUserClickKey && now - lastAllocUserClickAt < 350;
              lastAllocUserClickKey = clickKey;
              lastAllocUserClickAt = now;

              allocUserHighlight = u;

              if (!isDouble) {
                requestRender?.();
                return;
              }

              allocDraftUser = _toggleDraftUser(allocDraftUser, u, universeSet);
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
    Text({ content: "Enter username (or * for everyone):", fg: C.textDim }),
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

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

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
      setStatus(ok ? `Copied ${text.length} chars` : "Copy failed");
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
      const { code, stdout, stderr } = await runMicvgpus(["users", "--json", "--timeout", "8"]);
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
      case "alloc":
        newNode = renderAlloc();
        break;
      case "kill":
        newNode = renderKill();
        break;
    }

    // Wrap the screen in a relative container so we can overlay toast UI.
    const toast = renderToast();
    const loading = renderLoadingBadge();
    const root = Box(
      { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
      newNode,
      ...(toast ? [toast] : []),
      ...(loading ? [loading] : [])
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
  }
  requestRender = render;

  // Render immediately so the user sees "Loading..." during the first poll.
  render();

  // Initial load
  await Promise.all([
    loadAdminStatus(),
    pollCluster(),
    loadAllocations(),
    loadSystemUsers(true),
  ]);
  bootLoading = false;
  render();

  // Auto-refresh every 15s (disabled while editing allocations)
  const refreshInterval = setInterval(async () => {
    if (screen !== "dashboard" && screen !== "detail") return;
    await Promise.all([pollCluster(), loadAllocations()]);
    render();
  }, 15_000);

  // Key handling
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (screen === "dashboard") {
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
        screen = "detail";
        selectedGpuIdx = 0;
        render();
      } else if (key.name === "r") {
        await Promise.all([pollCluster(), loadAllocations(), loadSystemUsers(true)]);
        render();
      } else if (key.name === "?" || key.name === "h") {
        screen = "help";
        render();
      } else if (key.name === "q") {
        clearInterval(refreshInterval);
        renderer.destroy();
        process.exit(0);
      }
    } else if (screen === "detail") {
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (selectedGpuIdx > 0) {
          selectedGpuIdx--;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (selectedGpuIdx < 3) {
          selectedGpuIdx++;
          render();
        }
      } else if (key.name === "a") {
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
        screen = "dashboard";
        render();
      } else if (key.name === "r") {
        await Promise.all([pollCluster(), loadAllocations(), loadSystemUsers(true)]);
        render();
      } else if (key.name === "q") {
        clearInterval(refreshInterval);
        renderer.destroy();
        process.exit(0);
      }
    } else if (screen === "kill") {
      if (key.name === "escape") {
        screen = "detail";
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

        // Auto-return to detail after 2s
        setTimeout(async () => {
          if (screen === "kill") {
            killCtx = null;
            killErrorMsg = "";
            killOutput = "";
            screen = "detail";
            await Promise.all([pollCluster(), loadAllocations()]);
            render();
          }
        }, 2000);
      }
    } else if (screen === "alloc") {
      // IMPORTANT: don't bind Backspace here — it must delete characters in the Input.
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        screen = "detail";
        allocCtx = null;
        allocErrorMsg = "";
        render();
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
        const user = String(inputAny?.value ?? "").trim();
        allocDraftUser = user;

        if (!user) {
          allocErrorMsg = "Username required (use * for everyone)";
          render();
          return;
        }

        try {
          await allocSet(allocCtx.nodeAlias, allocCtx.gpuIdx, user);
          setStatus(`Saved allocation: ${allocCtx.nodeAlias} GPU${allocCtx.gpuIdx} → ${user}`);
          allocCtx = null;
          allocErrorMsg = "";
          await Promise.all([pollCluster(), loadAllocations()]);
          screen = "detail";
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
        screen = "dashboard";
        render();
      }
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
