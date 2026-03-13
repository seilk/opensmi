/**
 * src/views/Detail.ts
 * Render functions for the GPU detail view, kill-process modal, and help screen.
 *
 * Extracted from index.ts — Phase 2B.
 * DO NOT modify index.ts directly (Phase 3 handles wiring).
 */

import { Box, Text, t, bold } from "@opentui/core";
import { S } from "../state/global";
import type { ClusterSnapshot, DashboardTab, NodeSnapshot } from "../types";
import { C } from "../theme";
import {
  getAllocation,
  expiresInShort,
  gpuUtilPct,
  createSparkline,
  createMemBar,
  gpuMemStr,
  gpuActivityStatus,
  isViolation,
  runtimeStr,
  gpuIndicesForNode,
  wrapText,
} from "../utils/format";

// ── Callback injection ─────────────────────────────────────────────
//
// These functions live in index.ts and cannot be imported without
// creating a circular dependency. Register them once at startup via
// `registerDetailCallbacks` before any render call.

type OpenAllocModalFn = (node: NodeSnapshot, gpuIdx: number) => void;

let _openAllocModal: OpenAllocModalFn = () => {};

export function registerDetailCallbacks(cbs: {
  openAllocModal: OpenAllocModalFn;
}): void {
  _openAllocModal = cbs.openAllocModal;
}

// ── Dashboard tab helpers (re-implemented from index.ts using S) ───

function buildDashboardTabs(): DashboardTab[] {
  const tabs: DashboardTab[] = [];

  const allManualNames = [
    S.snapshot?.cluster_name || "Cluster",
    ...S.extraClusterNames,
  ];
  allManualNames.forEach((name, i) => {
    tabs.push({ type: "manual", idx: i, name });
  });

  const slurmNames =
    S.slurmSnapshots.length > 0
      ? S.slurmSnapshots.map((s) => s.cluster_name || "Slurm")
      : S.slurmClusterConfigNames;
  slurmNames.forEach((name, i) => {
    tabs.push({ type: "slurm", idx: i, name });
  });

  return tabs;
}

function activeDashboardTab(): DashboardTab | null {
  const tabs = buildDashboardTabs();
  if (tabs.length === 0) return null;
  return tabs[S.activeClusterTabIdx] ?? tabs[0] ?? null;
}

function activeManualTabIdx(): number | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return null;
  return tab.idx;
}

export function activeDashboardSnapshot(): ClusterSnapshot | null {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return null;
  if (manualIdx === 0) return S.snapshot;
  return S.extraSnapshots[manualIdx - 1] || null;
}

export function activeDashboardSelectedNodeIdx(): number {
  const manualIdx = activeManualTabIdx();
  if (manualIdx === null) return 0;
  if (manualIdx === 0) return S.selectedNodeIdx;
  return S.extraSelectedNodeIdx[manualIdx - 1] || 0;
}

function wrapProcessCommand(
  prefix: string,
  command: string,
  maxWidth: number
): string[] {
  const usableWidth = Math.max(12, maxWidth - prefix.length);
  const wrapped = wrapText(command, usableWidth);
  if (wrapped.length === 0) return [prefix];
  return wrapped.map((line, idx) => `${idx === 0 ? prefix : " ".repeat(prefix.length)}${line}`);
}

// ── renderDetail ───────────────────────────────────────────────────

export function renderDetail(): any {
  const termWidth = process.stdout.columns || 80;
  const contentWidth = Math.max(termWidth - 2, 40);
  const activeSnap = activeDashboardSnapshot();
  const activeNodeIdx = activeDashboardSelectedNodeIdx();
  if (!activeSnap) return Text({ content: "No data" });

  const node = activeSnap.nodes[activeNodeIdx];
  if (!node) return Text({ content: "No node selected" });

  if (node.error) {
    return Box(
      { flexDirection: "column", backgroundColor: C.bg, padding: 1 },
      Text({ content: `${node.node_alias} - ERROR`, fg: C.red }),
      Text({ content: node.error, fg: C.red }),
      Text({ content: "" }),
      Text({ content: "[Esc/Backspace] Back", fg: C.textDim })
    );
  }

  const nodeGpuIdxs = gpuIndicesForNode(node);
  if (nodeGpuIdxs.length && !nodeGpuIdxs.includes(S.selectedGpuIdx)) {
    S.selectedGpuIdx = nodeGpuIdxs[0]!;
  }

  const children: any[] = [];

  // Header
  children.push(
    Text({
      content: `${node.node_alias} (${node.hostname || node.address}) - ${node.os || ""}`,
      fg: C.blue,
    }),
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
    const utilStr =
      utilVal !== null
        ? `Load ${String(utilVal).padStart(3)}% ${createSparkline(utilVal)}`
        : "Load   ?  ";
    const memBar = createMemBar(g.memory_used_mib ?? null, g.memory_total_mib ?? null);
    const activityStr = gpuActivityStatus(node, g.index, g.uuid);

    const isSel = g.index === S.selectedGpuIdx;
    const inLaunchSelection = S.launchManualGpus.some(
      (x) => x.node === node.node_alias && x.gpu === g.index
    );
    const prefix = isSel ? "▸" : inLaunchSelection ? "●" : " ";

    children.push(
      Box(
        {
          width: "100%",
          height: 1,
          position: "relative",
        },
        Text({
          content: ` ${prefix} GPU ${g.index}  |  ${g.name.padEnd(16)}  |  ${memBar} ${gpuMemStr(g.memory_used_mib)}/${gpuMemStr(g.memory_total_mib)}  |  ${utilStr}  |  ${allocStr.padEnd(15)}  | ${activityStr}`,
          fg: isSel ? "#ffffff" : inLaunchSelection ? C.yellow : C.cyan,
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

            S.selectedGpuIdx = g.index;

            // Double-click to open Allocate modal
            const now = Date.now();
            const clickKey = `${node.node_alias}:GPU${g.index}`;
            const isDouble =
              clickKey === S.lastGpuClickKey && now - S.lastGpuClickAt < 350;
            S.lastGpuClickKey = clickKey;
            S.lastGpuClickAt = now;

            if (isDouble) {
              _openAllocModal(node, g.index);
              return;
            }

            S.requestRender?.();
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
        const procLabel = (p.cmdline || p.process_name || "").trim() || p.process_name;
        const prefix = `    PID ${String(p.pid).padEnd(8)} ${p.user.padEnd(14)} ${mem.padStart(10)} ${rtCol}  `;
        const procLines = wrapProcessCommand(prefix, procLabel, contentWidth - violMark.length);
        procLines.forEach((line, idx) => {
          children.push(
            Text({
              content: idx === 0 ? `${line}${violMark}` : line,
              fg: viol ? C.red : C.text,
            })
          );
        });
      }
    }

    children.push(Text({ content: "" }));
  }

  // Sudo info footer line
  if (S.sudoInfoMsg) {
    children.push(
      Text({ content: `(Sudo: ${S.sudoInfoMsg})`, fg: C.textDim })
    );
  }

  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: C.bg,
      padding: 1,
    },
    ...children
  );
}

// ── renderHelp ─────────────────────────────────────────────────────

export function renderHelp(): any {
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      backgroundColor: C.bg,
    },
    Text({ content: t`${bold("Help - Keyboard Shortcuts")}`, fg: C.text }),
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
    Text({ content: "Quit:  q", fg: C.text })
  );
}

// ── renderKill ─────────────────────────────────────────────────────

export function renderKill(): any {
  const ctx = S.killCtx;
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

  const errorNode = S.killErrorMsg
    ? Text({ content: `Error: ${S.killErrorMsg}`, fg: C.red })
    : Text({ content: " ", fg: C.textDim });

  const outPreview = (S.killOutput || "")
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

  const footer = S.killInProgress
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
