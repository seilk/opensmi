/**
 * src/views/dashboard/SSHView.ts
 * SSH cluster grid view: tab helpers, loading badge, main cluster grid render.
 * Split from Dashboard.ts — Phase 4 TUI modularization.
 */

import {
  Box, Text, t, bold, fg,
} from "@opentui/core";
import { C } from "../../theme";
import { S, CURRENT_USER_HOST } from "../../state/global";
import type {
  GPUInfo, NodeSnapshot, ClusterSnapshot,
  SlurmNodeInfo, SlurmSortKey,
  DashboardTab,
} from "../../types";
import {
  usersOnGpu, gpuIndicesForSnapshot, gpuIndicesForNode,
  getAllocation, isViolation, gpuUtilPct,
  createSparkline, expiresInShort, truncateText, setStatus,
} from "../../utils/format";
import { renderRunnerPane } from "../../components/Runner";
import { getGpuCommandPlaceholder } from "../../components/Runner";
import { renderSlurmClusterTab } from "./SlurmView";

// ── Dashboard Tab Helpers ────────────────────────────────────────

export function buildDashboardTabs(): DashboardTab[] {
  const tabs: DashboardTab[] = [];
  // Manual cluster 0 = primary
  tabs.push({ type: "manual", idx: 0, name: S.snapshot?.cluster_name || "Cluster" });
  // Extra manual clusters
  for (let i = 0; i < S.extraClusterNames.length; i++) {
    tabs.push({ type: "manual", idx: i + 1, name: S.extraClusterNames[i] || `Cluster ${i + 2}` });
  }
  // Slurm clusters
  const slurmNames = S.slurmSnapshots.length > 0
    ? S.slurmSnapshots.map(s => s.cluster_name)
    : S.slurmClusterConfigNames;
  for (let i = 0; i < slurmNames.length; i++) {
    tabs.push({ type: "slurm", idx: i, name: slurmNames[i] || `Slurm ${i + 1}` });
  }
  return tabs;
}

export function activeDashboardTab(): DashboardTab | null {
  const tabs = buildDashboardTabs();
  if (tabs.length === 0) return null;
  const idx = Math.min(S.activeClusterTabIdx, tabs.length - 1);
  return tabs[idx] ?? null;
}

export function activeManualTabIdx(): number | null {
  const tab = activeDashboardTab();
  return tab?.type === "manual" ? tab.idx : null;
}

export function activeDashboardSnapshot(): ClusterSnapshot | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return null;
  return tab.idx === 0 ? S.snapshot : (S.extraSnapshots[tab.idx - 1] ?? null);
}

export function activeDashboardPollError(): string {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return "";
  return tab.idx === 0 ? S.pollError : (S.extraPollErrors[tab.idx - 1] ?? "");
}

export function activeDashboardSelectedNodeIdx(): number {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return 0;
  return tab.idx === 0 ? S.selectedNodeIdx : (S.extraSelectedNodeIdx[tab.idx - 1] ?? 0);
}

export function setActiveDashboardSelectedNodeIdx(nextIdx: number): void {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "manual") return;
  if (tab.idx === 0) {
    S.selectedNodeIdx = nextIdx;
  } else {
    S.extraSelectedNodeIdx[tab.idx - 1] = nextIdx;
  }
}


export function renderLoadingBadge() {
  if (!S.bootLoading && S.snapshot) return null;

  const tick = Math.floor(Date.now() / 80);

  // Flowing glyph at spinner position (3-char)
  const flowGlyphs = ["░▒▓", "▒▓█", "▓█▓", "█▓▒", "▓▒░", "▒░▒"];
  const glyph = flowGlyphs[tick % flowGlyphs.length] || "░▒▓";
  const text = "opensmi: I'm coordinating with your GPUs...";

  // Prefer showing full message when terminal width allows.
  const termW = process.stdout.columns || 80;
  const maxBadgeW = Math.max(20, termW - 2);
  const minNeededW = text.length + 1 + glyph.length;
  const badgeW = Math.min(maxBadgeW, Math.max(44, minNeededW));
  const textMax = Math.max(0, badgeW - 4); // one space + 3-char glyph
  const textClamped = (() => {
    if (text.length <= textMax) return text;
    if (textMax <= 3) return text.slice(0, textMax);
    return `${text.slice(0, textMax - 3)}...`;
  })();
  const gap = " ";
  const tailPadW = Math.max(0, badgeW - (textClamped.length + gap.length + glyph.length));
  const tailPad = " ".repeat(tailPadW);

  return Box(
    {
      position: "absolute",
      left: 1,
      top: 0,
      width: badgeW,
      height: 1,
      flexDirection: "row",
      backgroundColor: C.bg,
      zIndex: 10_000,
    },
    Text({ content: `${textClamped}${gap}`, fg: C.blue }),
    Text({ content: glyph, fg: tick % 2 === 0 ? C.cyan : C.blue }),
    Text({ content: tailPad, fg: C.blue })
  );
}

export function sortSlurmNodes(nodes: SlurmNodeInfo[], key: SlurmSortKey): SlurmNodeInfo[] {
  return [...nodes].sort((a, b) => {
    switch (key) {
      case "name":      return a.name.localeCompare(b.name);
      case "state":     return (a.state || "").localeCompare(b.state || "");
      case "gpu_used":  return b.gpu_used - a.gpu_used;
      case "gpu_free":  return b.gpu_free - a.gpu_free;
      default:          return 0;
    }
  });
}

export function renderDashboard() {
  const tabs = buildDashboardTabs();
  if (tabs.length > 0 && S.activeClusterTabIdx >= tabs.length) S.activeClusterTabIdx = 0;
  const activeTab = tabs[S.activeClusterTabIdx] ?? tabs[0] ?? null;


  if (activeTab?.type === "slurm") {
    return renderSlurmClusterTab(activeTab.idx);
  }

  const viewSnapshot = activeDashboardSnapshot();
  const viewPollError = activeDashboardPollError();
  const currentSelectedNodeIdx = activeDashboardSelectedNodeIdx();

  if (!viewSnapshot) {
    const msg = viewPollError || "opensmi: I'm coordinating with your GPUs...";
    return Box({ flexDirection: "column" }, Text({ content: msg }));
  }

  const totalGpus = viewSnapshot.nodes.reduce((s, n) => s + n.gpus.length, 0);
  const usedGpus = viewSnapshot.nodes.reduce((s, n) => {
    return s + n.gpus.filter((g) => usersOnGpu(n, g.uuid).length > 0).length;
  }, 0);

  // Count violations
  let violationCount = 0;
  for (const n of viewSnapshot.nodes) {
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
      content: t`${bold(fg(C.blue)("Dashboard"))}`,
    }),
    Text({
      content: t`${fg(C.textDim)(CURRENT_USER_HOST)}  GPUs: ${fg(C.green)(`${usedGpus}`)}/${totalGpus}  Violations: ${violationCount > 0 ? fg(C.red)(`${violationCount}`) : fg(C.green)("0")}  Poll: ${S.lastPollTime || "-"}`,
    })
  );

  const gpuCols = gpuIndicesForSnapshot(viewSnapshot);

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
  const rows = viewSnapshot.nodes.map((n, ni) => {
    const isSelected = ni === currentSelectedNodeIdx;
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
            const isDouble = clickKey === S.lastNodeClickKey && now - S.lastNodeClickAt < 350;
            S.lastNodeClickKey = clickKey;
            S.lastNodeClickAt = now;

            setActiveDashboardSelectedNodeIdx(ni);
            S.selectedGpuIdx = 0;

            if (isDouble) {
              S.openDetailView?.(n.node_alias);
              return;
            }

            S.requestRender?.();
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
        gpuCells.push(Text({ content: "-".padEnd(w), fg: C.textDim }));
        continue;
      }

      const isSelected = S.launchManualGpus.some(
        (x) => x.node === n.node_alias && x.gpu === i
      );
      const dot = isSelected ? "● " : "";

      const users = usersOnGpu(n, g.uuid);
      if (users.length === 0) {
        const alloc = getAllocation(n.node_alias, i);
        const remain = expiresInShort(alloc?.expires_at);
        const spark = createSparkline(gpuUtilPct(g));
        const label = alloc ? `[${alloc.target}${remain ? ` ${remain}` : ""}]` : `idle ${spark}`;
        const display = (dot + label).length > w - 1 ? (dot + label).slice(0, w - 2) + "…" : (dot + label);
        gpuCells.push(
          Box(
            { width: w, height: 1, position: "relative" },
            Text({ content: display.padEnd(w), fg: isSelected ? C.yellow : C.textDim }),
            S.runnerFocused ? Box({
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
                const idx = S.launchManualGpus.findIndex(
                  (x) => x.node === gpuKey.node && x.gpu === gpuKey.gpu
                );

                if (idx >= 0) {
                  // Unselect GPU
                  S.launchManualGpus.splice(idx, 1);
                  // Sync count and commands
                  S.launchNumGpus = S.launchManualGpus.length;
                  if (S.launchDistMode === "one-to-one") {
                    S.launchCommands = S.launchCommands.slice(0, S.launchNumGpus);
                  }
                } else {
                  // Select GPU
                  S.launchManualGpus.push(gpuKey);
                  // Sync count: increase if selection exceeds current count
                  if (S.launchManualGpus.length > S.launchNumGpus) {
                    S.launchNumGpus = S.launchManualGpus.length;
                    if (S.launchDistMode === "one-to-one") {
                      while (S.launchCommands.length < S.launchNumGpus) {
                        const cmdIdx = S.launchCommands.length;
                        const gpu = S.launchManualGpus[cmdIdx];
                        S.launchCommands.push(getGpuCommandPlaceholder(gpu));
                      }
                    }
                  }
                }

                S.launchGpuMode = "selected";
                S.launchSelectedGpus = S.launchManualGpus.slice(0, S.launchNumGpus);

                S.requestRender?.();
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
            S.runnerFocused ? Box({
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
                const idx = S.launchManualGpus.findIndex(
                  (x) => x.node === gpuKey.node && x.gpu === gpuKey.gpu
                );

                if (idx >= 0) {
                  // Unselect GPU
                  S.launchManualGpus.splice(idx, 1);
                  // Sync count and commands
                  S.launchNumGpus = S.launchManualGpus.length;
                  if (S.launchDistMode === "one-to-one") {
                    S.launchCommands = S.launchCommands.slice(0, S.launchNumGpus);
                  }
                } else {
                  // Select GPU
                  S.launchManualGpus.push(gpuKey);
                  // Sync count: increase if selection exceeds current count
                  if (S.launchManualGpus.length > S.launchNumGpus) {
                    S.launchNumGpus = S.launchManualGpus.length;
                    if (S.launchDistMode === "one-to-one") {
                      while (S.launchCommands.length < S.launchNumGpus) {
                        const cmdIdx = S.launchCommands.length;
                        const gpu = S.launchManualGpus[cmdIdx];
                        S.launchCommands.push(getGpuCommandPlaceholder(gpu));
                      }
                    }
                  }
                }

                S.launchGpuMode = "selected";
                S.launchSelectedGpus = S.launchManualGpus.slice(0, S.launchNumGpus);

                S.requestRender?.();
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
      !S.runnerFocused ? Box({
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
          const isDouble = clickKey === S.lastNodeClickKey && now - S.lastNodeClickAt < 350;
          S.lastNodeClickKey = clickKey;
          S.lastNodeClickAt = now;

          setActiveDashboardSelectedNodeIdx(ni);
          S.selectedGpuIdx = gpuIndicesForNode(n)[0] ?? 0;

          if (isDouble) {
            S.openDetailView?.(n.node_alias);
            return;
          }

          S.requestRender?.();
        },
      }) : undefined
    );
  });

  // User summary
  const userMap = new Map<string, number>();
  for (const n of viewSnapshot.nodes) {
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

    Box(
      { flexDirection: "row", paddingTop: 1 },
      Text({
        content: S.runnerInputTyping
          ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
          : (S.runnerFocused
              ? t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Esc]")} Unfocus  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+x Enter]")} Execute  ${fg(C.textDim)("[Click GPU]")} Select  ${fg(C.textDim)("[Tab/+/-]")} Options`
              : t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Detail`),
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
