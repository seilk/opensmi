/**
 * src/views/Dashboard.ts
 * Dashboard view: main cluster grid, Slurm cluster tabs, loading badge.
 * Extracted from index.ts Phase 2A.
 */

import {
  Box, Text, Input, ScrollBox, t, bold, fg,
  type BoxRenderable,
} from "@opentui/core";
import { spawn } from "bun";
import { C } from "../theme";
import { S, OPERATOR, CURRENT_USER_HOST } from "../state/global";
import type {
  GPUInfo, NodeSnapshot, ClusterSnapshot, Allocation,
  SlurmGPUSlot, SlurmNodeInfo, SlurmSnapshot, SlurmRunPopup, SlurmSortKey,
  DashboardTab, ScreenId,
} from "../types";
import {
  usersOnGpu, gpuIndicesForSnapshot, gpuIndicesForNode,
  getAllocation, isViolation, gpuUtilPct, gpuMemStr,
  createSparkline, expiresInShort, truncateText, setStatus,
  stripAnsi, wrapText, wrapTextWithCursor, shellQuote,
} from "../utils/format";
import { runOpensmi, tuiLog, OPENSMI, OPENSMI_CWD, OPENSMI_ENV } from "../state/api";
import { checkSudoForNode } from "../components/AllocModal";
import { getGpuCommandPlaceholder, renderRunnerPane } from "../components/Runner";

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
      content: t`${fg(C.textDim)(CURRENT_USER_HOST)}  GPUs: ${fg(C.green)(`${usedGpus}`)}/${totalGpus}  Violations: ${violationCount > 0 ? fg(C.red)(`${violationCount}`) : fg(C.green)("0")}  Poll: ${S.lastPollTime || "-"}  ${S.isPolling ? fg(C.yellow)("⟳") : ""}`,
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
              S.screen = "detail";
              void checkSudoForNode(n.node_alias);
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
            S.screen = "detail";
            void checkSudoForNode(n.node_alias);
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
    Text({
      content: S.statusMsg ? t`${fg(C.yellow)(S.statusMsg)}` : " ",
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

export function openSrunPopup(node: SlurmNodeInfo, clusterName: string, snap?: SlurmSnapshot) {
  S.slurmRunPopup = {
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
  S._renderHook?.();
  // Async fetch QoS list for this partition
  if (snap?.login_node) {
    fetchQosForPartition(snap.login_node, snap.ssh_user || "", node.partition || "");
  }
}

export function closeSrunPopup() {
  S.slurmRunPopup = null;
  S._renderHook?.();
}

export function srunTokens(popup: SlurmRunPopup): string[] {
  return ["srun", "-p", popup.partition, "-w", popup.nodeName,
          "--gres", `gpu:${popup.gpuCount}`, "--pty", "bash"];
}


export function srunCommand(popup: SlurmRunPopup): string {
  return srunTokens(popup).map(shellQuote).join(" ");
}

export async function copyToClipboard(text: string): Promise<boolean> {
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

export function getLatestFreeGpus(nodeName: string, clusterIdx: number): number | null {
  const snap = S.slurmSnapshots[clusterIdx];
  if (!snap) return null;
  const node = snap.nodes.find(n => n.name === nodeName);
  return node ? node.gpu_free : null;
}

export function activeSlurmTabIdx(): number | null {
  const tab = activeDashboardTab();
  if (!tab || tab.type !== "slurm") return null;
  return tab.idx;
}

export function slurmTabIdxForPopup(popup: SlurmRunPopup): number | null {
  const activeIdx = activeSlurmTabIdx();
  if (activeIdx !== null) return activeIdx;
  const byName = S.slurmSnapshots.findIndex((s) => s.cluster_name === popup.clusterName);
  return byName >= 0 ? byName : null;
}

export function renderSrunPopup(popup: SlurmRunPopup): any {
  const autoCmd = srunCommand(popup);
  const cmd = popup.cmdOverride !== null ? popup.cmdOverride : autoCmd;
  const isEdited = popup.cmdOverride !== null;
  const popupSlurmIdx = slurmTabIdxForPopup(popup);
  const currentFree = popupSlurmIdx === null ? null : getLatestFreeGpus(popup.nodeName, popupSlurmIdx);
  const isStale = popup.copyStatus === "stale";
  const gpuInvalid = !isEdited && (popup.gpuCount < 1 || popup.gpuCount > popup.freeGpusAtOpen
    || !Number.isInteger(popup.gpuCount));
  const canCopy = !gpuInvalid && !isStale && !(isEdited && cmd.trim() === "");
  const busy = popup.jobSubmitStatus === "submitting" || popup.jobSubmitStatus === "polling" || popup.jobSubmitStatus === "cancelling";

  const w = Math.min(62, (process.stdout.columns || 80) - 4);
  const innerW = w - 2; // padding 1 each side

  const line = (content: any) => Box({ width: w, paddingLeft: 1, paddingRight: 1 }, content);

  const rows: any[] = [
    // Title bar
    Box({ width: w, backgroundColor: C.blue, paddingLeft: 1 },
      Text({ content: t`${bold(fg("#ffffff")("srun Job Submit"))} - ${bold(popup.nodeName)}` })
    ),
    line(Text({ content: "" })),
    // Existing my-job section
    ...(() => {
      if (popup.existingJobCancelStatus === "done") {
        return [
          line(Text({ content: t`${fg(C.green)(`✓ Cancelled: ${popup.existingJobCancelMsg.replace("Cancelled: ", "")}`)}` })),
          line(Text({ content: "" })),
        ];
      }
      if (popup.existingJobCancelStatus === "error") {
        return [
          line(Text({ content: t`${fg(C.red)(`✗ ${popup.existingJobCancelMsg}`)}` })),
          line(Text({ content: "" })),
        ];
      }
      if (popup.existingJobCancelStatus === "cancelling") {
        return [
          line(Text({ content: t`${fg(C.yellow)("⟳ Cancelling existing job(s)...")}` })),
          line(Text({ content: "" })),
        ];
      }
      if (popup.existingJobIds.length > 0) {
        return [
          line(Box({ flexDirection: "row" },
            Text({ content: t`${fg(C.yellow)(`⚠ Active job(s): ${popup.existingJobIds.join(", ")}  `)}` }),
            Box({
              paddingLeft: 1, paddingRight: 1, backgroundColor: C.red,
              onMouseDown: () => { cancelExistingJobsInPopup(); },
            }, Text({ content: "X: Cancel", fg: "#ffffff" })),
          )),
          line(Text({ content: "" })),
        ];
      }
      return [];
    })(),
    // Node info (read-only)
    line(Text({ content: t`${fg(C.textDim)("Partition :")} ${popup.partition}` })),
    line(Text({ content: t`${fg(C.textDim)("Node      :")} ${popup.nodeName}` })),
    line(Text({ content: t`${fg(C.textDim)("Free GPUs :")} ${popup.freeGpusAtOpen}${currentFree !== null && currentFree !== popup.freeGpusAtOpen ? fg(C.yellow)(` → now ${currentFree}`) : ""}` })),
    line(Text({ content: "" })),
    // GPU count input
    line(Box({ flexDirection: "row" },
      Text({ content: t`${fg(C.textDim)("GPUs      :")} ` }),
      Text({ content: `[${popup.gpuCount}]`, fg: gpuInvalid ? C.red : C.green }),
      Text({ content: t`  ${fg(C.textDim)("← / → to adjust")}` }),
    )),
  ];

  // QoS selector
  if (popup.qosLoading) {
    rows.push(line(Text({ content: t`${fg(C.textDim)("QoS       :")} ${fg(C.textDim)("⟳ loading...")}` })));
  } else if (popup.qosFetchFailed) {
    rows.push(line(Text({ content: t`${fg(C.red)("QoS       :")} ${fg(C.red)("unavailable - use 'e' to add --qos manually")}` })));
  } else if (popup.qosList.length > 0) {
    const qosLabel = popup.qosIdx === 0 ? "(default)" : popup.qosList[popup.qosIdx - 1]!;
    rows.push(line(Box({ flexDirection: "row" },
      Text({ content: t`${fg(C.textDim)("QoS       :")} ` }),
      Text({ content: `[${qosLabel}]`, fg: C.cyan }),
      Text({ content: t`  ${fg(C.textDim)("Q to cycle")}` }),
    )));
  }

  rows.push(line(Text({ content: "" })));

  // Command preview / edit (with line wrap)
  rows.push(line(Box({ flexDirection: "row" },
    Text({ content: t`${fg(C.textDim)("Command:")}` }),
    isEdited ? Text({ content: t`  ${fg(C.yellow)("[edited]")}` }) : Text({ content: "" }),
    popup.editMode
      ? Text({ content: t`  ${fg(C.cyan)("editing - Enter/Esc to confirm")}` })
      : Text({ content: t`  ${fg(C.textDim)("e: edit  r: reset cmd")}` }),
  )));

  if (popup.editMode) {
    const wrapW = innerW - 2; // "▶ " prefix
    const wrapped = wrapTextWithCursor(cmd, popup.cursorPos, wrapW);
    for (let i = 0; i < wrapped.length; i++) {
      rows.push(line(Box({ flexDirection: "row" },
        Text({ content: i === 0 ? "▶ " : "  ", fg: C.cyan }),
        Text({ content: wrapped[i]!, fg: C.cyan }),
      )));
    }
  } else {
    const wrapW = innerW;
    const wrapped = wrapText(cmd, wrapW);
    for (const wline of wrapped) {
      rows.push(line(Text({ content: wline, fg: canCopy ? C.text : C.red })));
    }
  }

  rows.push(line(Text({ content: "" })));

  // Copy status
  if (isStale) {
    rows.push(line(Text({ content: t`${fg(C.red)("⚠ " + popup.errorMsg)}` })));
    rows.push(line(Text({ content: "" })));
  }
  if (popup.copyStatus === "fail" && popup.fullCmdForFallback) {
    rows.push(line(Text({ content: t`${fg(C.yellow)("Clipboard unavailable - copy manually:")}` })));
    for (const wl of wrapText(popup.fullCmdForFallback, innerW)) {
      rows.push(line(Text({ content: wl, fg: C.text })));
    }
    rows.push(line(Text({ content: "" })));
  }
  if (popup.copyStatus === "ok") {
    rows.push(line(Text({ content: t`${fg(C.green)("✓ Copied to clipboard!")}` })));
    rows.push(line(Text({ content: "" })));
  }

  // Submit note + capacity warning
  rows.push(line(Text({ content: t`${fg(C.textDim)("ℹ  Reserves GPUs only - run workload after ssh attach.")}` })));
  rows.push(line(Text({ content: t`${fg(C.textDim)("⚠  Capacity is real-time and may change.")}` })));
  rows.push(line(Text({ content: "" })));

  // Job submit status / result
  if (popup.jobSubmitStatus === "submitting") {
    rows.push(line(Text({ content: t`${fg(C.cyan)("⟳ Submitting job...")}  ${fg(C.textDim)("Esc to abort")}` })));
    rows.push(line(Text({ content: "" })));
  } else if (popup.jobSubmitStatus === "polling") {
    rows.push(line(Text({ content: t`${fg(C.cyan)(`⟳ Waiting for job ${popup.jobId} to start...`)}  ${fg(C.textDim)("Esc to abort")}` })));
    rows.push(line(Text({ content: "" })));
  } else if (popup.jobSubmitStatus === "cancelling") {
    rows.push(line(Text({ content: t`${fg(C.yellow)("⟳ Cancelling job...")}` })));
    rows.push(line(Text({ content: "" })));
  } else if (popup.jobSubmitStatus === "running") {
    rows.push(line(Text({ content: t`${fg(C.green)(`✓ Job ${popup.jobId} is RUNNING`)}` })));
    rows.push(line(Text({ content: t`${fg(C.textDim)("Node      :")} ${popup.nodeName}` })));
    if (popup.gpuIdxList) {
      rows.push(line(Text({ content: t`${fg(C.textDim)("GPU IDX   :")} ${fg(C.green)(popup.gpuIdxList)}` })));
      rows.push(line(Text({ content: "" })));
      rows.push(line(Text({ content: t`${fg(C.textDim)("In your terminal:")}` })));
      rows.push(line(Text({ content: `ssh ${popup.nodeName}`, fg: C.text })));
      rows.push(line(Text({ content: `export CUDA_VISIBLE_DEVICES=${popup.gpuIdxList}`, fg: C.text })));
      rows.push(line(Text({ content: `# then run: python train.py  (or your workload)`, fg: C.textDim })));
    } else {
      rows.push(line(Text({ content: t`${fg(C.yellow)("GPU IDX   : unavailable (check scontrol manually)")}` })));
      rows.push(line(Text({ content: "" })));
      rows.push(line(Text({ content: t`${fg(C.textDim)("In your terminal:")}` })));
      rows.push(line(Text({ content: `ssh ${popup.nodeName}`, fg: C.text })));
      rows.push(line(Text({ content: `# check: scontrol -d show job ${popup.jobId} | grep IDX`, fg: C.textDim })));
    }
    rows.push(line(Text({ content: "" })));
  } else if (popup.jobSubmitStatus === "error") {
    for (const wl of wrapText(`✗ ${popup.jobErrorMsg}`, innerW)) {
      rows.push(line(Text({ content: wl, fg: C.red })));
    }
    rows.push(line(Text({ content: "" })));
  }

  // Action bar
  const canSubmit = !popup.editMode && !busy && !!popup.loginNode && !popup.qosLoading && !popup.qosFetchFailed && popup.gpuCount >= 1 && popup.gpuCount <= popup.freeGpusAtOpen && popup.jobSubmitStatus === "idle";
  const canCancel = popup.jobSubmitStatus === "running" && !!popup.jobId;
  const canResubmit = !busy && popup.jobSubmitStatus === "error" && !!popup.loginNode;

  rows.push(line(Box({ flexDirection: "row" },
    Box({
      paddingLeft: 1, paddingRight: 1,
      backgroundColor: canCopy && !popup.editMode && !busy ? C.blue : C.bgAlt,
      onMouseDown: canCopy && !popup.editMode && !busy ? async () => { await submitSrunPopup(); } : undefined,
    }, Text({ content: "c/Enter: Copy", fg: canCopy && !popup.editMode && !busy ? "#ffffff" : C.textDim })),
    Text({ content: "  " }),
    canCancel
      ? Box({
          paddingLeft: 1, paddingRight: 1, backgroundColor: C.red,
          onMouseDown: () => { cancelSlurmJob(); },
        }, Text({ content: "X: Cancel Job", fg: "#ffffff" }))
      : canResubmit
        ? Box({
            paddingLeft: 1, paddingRight: 1, backgroundColor: C.yellow,
            onMouseDown: () => { submitJobToSlurm(); },
          }, Text({ content: "R: Resubmit", fg: "#000000" }))
        : Box({
            paddingLeft: 1, paddingRight: 1,
            backgroundColor: canSubmit ? C.green : C.bgAlt,
            onMouseDown: canSubmit ? () => { submitJobToSlurm(); } : undefined,
          }, Text({ content: busy ? "…" : "S: Submit", fg: canSubmit ? "#000000" : C.textDim })),
    Text({ content: "  " }),
    Box({
      paddingLeft: 1, paddingRight: 1, backgroundColor: C.bgAlt,
      onMouseDown: () => {
        if (popup.editMode) { popup.editMode = false; S._renderHook?.(); }
        else if (busy) { popup.jobAbortRequested = true; S._renderHook?.(); }
        else closeSrunPopup();
      },
    }, Text({ content: popup.editMode ? "Esc: Done" : busy ? "Esc: Abort" : "Esc: Close", fg: C.textDim })),
  )));
  rows.push(line(Text({ content: "" })));

  // Center popup on S.screen
  const termW = process.stdout.columns || 80;
  const termH = process.stdout.rows || 24;
  const left = Math.max(0, Math.floor((termW - w) / 2));
  const top = Math.max(0, Math.floor((termH - rows.length) / 2));

  return Box(
    { position: "absolute", left, top, width: w, flexDirection: "column", backgroundColor: C.bg, zIndex: 100 },
    ...rows,
  );
}

export async function submitSrunPopup() {
  if (!S.slurmRunPopup) return;
  const popup = S.slurmRunPopup;

  // If user edited the command, skip preflight and use override directly
  const cmd = popup.cmdOverride !== null ? popup.cmdOverride : srunCommand(popup);

  if (popup.cmdOverride === null) {
    // Preflight: re-check latest free GPUs (only for auto-generated commands)
    const popupSlurmIdx = slurmTabIdxForPopup(popup);
    const latestFree = popupSlurmIdx === null ? null : getLatestFreeGpus(popup.nodeName, popupSlurmIdx);
    if (latestFree === null) {
      popup.copyStatus = "stale";
      popup.errorMsg = "Node no longer found in cluster data.";
      S._renderHook?.();
      return;
    }
    if (popup.gpuCount > latestFree) {
      popup.copyStatus = "stale";
      popup.errorMsg = `Capacity changed: was ${popup.freeGpusAtOpen}, now ${latestFree}. Adjust GPUs and retry.`;
      S._renderHook?.();
      return;
    }
    if (latestFree === 0) {
      popup.copyStatus = "stale";
      popup.errorMsg = "No free GPUs available on this node.";
      S._renderHook?.();
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
  S._renderHook?.();
}

export function slurmNameSafe(s: string): boolean {
  return /^[A-Za-z0-9_.:\-]+$/.test(s);
}

export async function fetchQosForPartition(loginNode: string, sshUser: string, partition: string) {
  if (!S.slurmRunPopup) return;
  const popup = S.slurmRunPopup;
  try {
    const sshTarget = sshUser ? `${sshUser}@${loginNode}` : loginNode;
    const proc = Bun.spawn(
      ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget,
       `scontrol show partition ${shellQuote(partition)}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // Parse "AllowQos=normal,high" or "QoS=normal"
    const m = out.match(/AllowQos=([^\s]+)/) || out.match(/QoS=([^\s]+)/);
    if (m && m[1] !== "N/A" && m[1] !== "(null)") {
      popup.qosList = m[1]!.split(",").filter(Boolean).filter(slurmNameSafe);
    }
    tuiLog("DEBUG", `QoS for ${partition}: ${JSON.stringify(popup.qosList)}`);
  } catch (e) {
    tuiLog("DEBUG", `fetchQos failed: ${e}`);
    popup.qosFetchFailed = true;
  } finally {
    popup.qosLoading = false;
  }
  S._renderHook?.();
}

export function getMyJobIdsOnNode(node: SlurmNodeInfo, sshUser: string): number[] {
  if (!sshUser) return [];
  const ids = new Set<number>();
  for (const slot of node.gpus) {
    if (slot.user === sshUser && slot.job_id !== null) {
      ids.add(slot.job_id);
    }
  }
  return [...ids];
}

export async function cancelJobsOnNode(node: SlurmNodeInfo, snap: SlurmSnapshot) {
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
    S.nodeCancelStatus = { node: node.name, status: "error", msg: "No login_node configured." };
    S._renderHook?.();
    return;
  }

  S.nodeCancelStatus = { node: node.name, status: "cancelling", msg: "" };
  S._renderHook?.();

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
        S.nodeCancelStatus = { node: node.name, status: "error", msg: `Owner check failed for job ${jobId}; blocked for safety.` };
        S._renderHook?.();
        return;
      }
      if (jobOwner && snap.ssh_user && jobOwner !== snap.ssh_user) {
        S.nodeCancelStatus = { node: node.name, status: "error", msg: `Job ${jobId} owned by "${jobOwner}"; cancel denied.` };
        S._renderHook?.();
        return;
      }
      const proc = Bun.spawn(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", sshTarget, `scancel ${jobId}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;
      tuiLog("INFO", `cancelJobsOnNode: scancel ${jobId} on ${node.name} done`);
    }
    S.nodeCancelStatus = { node: node.name, status: "done", msg: `Cancelled: ${jobIds.join(", ")}` };
    S._renderHook?.();
    // Refresh cluster data after cancel - force render on completion
    setTimeout(async () => {
      await loadSlurmData();
      S._renderHook?.();
    }, 1500);
  } catch (e: any) {
    S.nodeCancelStatus = { node: node.name, status: "error", msg: e?.message || String(e) };
    tuiLog("ERROR", `cancelJobsOnNode failed: ${S.nodeCancelStatus.msg}`);
  }
  S._renderHook?.();
}

export async function cancelExistingJobsInPopup() {
  if (!S.slurmRunPopup) return;
  const popup = S.slurmRunPopup;
  if (!popup.existingJobIds.length || !popup.loginNode) return;

  popup.existingJobCancelStatus = "cancelling";
  popup.existingJobCancelMsg = "";
  S._renderHook?.();

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
        S._renderHook?.();
        return;
      }
      if (jobOwner && popup.sshUser && jobOwner !== popup.sshUser) {
        popup.existingJobCancelStatus = "error";
        popup.existingJobCancelMsg = `Job ${jobId} owned by "${jobOwner}"; cancel denied.`;
        S._renderHook?.();
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
    S._renderHook?.();
    // Refresh cluster data
    setTimeout(async () => {
      await loadSlurmData();
      S._renderHook?.();
    }, 1500);
  } catch (e: any) {
    popup.existingJobCancelStatus = "error";
    popup.existingJobCancelMsg = e?.message || String(e);
    S._renderHook?.();
  }
}

export async function cancelSlurmJob() {
  if (!S.slurmRunPopup) return;
  const popup = S.slurmRunPopup;
  if (!popup.jobId) return;
  // jobId must be purely numeric
  if (!/^\d+$/.test(popup.jobId)) {
    tuiLog("WARNING", `cancelSlurmJob: suspicious jobId "${popup.jobId}", aborting`);
    popup.jobSubmitStatus = "idle";
    S._renderHook?.();
    return;
  }
  popup.jobSubmitStatus = "cancelling";
  S._renderHook?.();
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
      S._renderHook?.();
      return;
    }
    if (jobOwner && expectedUser && jobOwner !== expectedUser) {
      tuiLog("WARNING", `cancelSlurmJob: ownership mismatch - job ${popup.jobId} owner="${jobOwner}" expected="${expectedUser}", refusing scancel`);
      popup.jobSubmitStatus = "error";
      popup.jobErrorMsg = `Job ${popup.jobId} owned by "${jobOwner}"; cancel denied.`;
      S._renderHook?.();
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
  S._renderHook?.();
}

export async function submitJobToSlurm() {
  if (!S.slurmRunPopup) return;
  const popup = S.slurmRunPopup;

  if (!popup.loginNode) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "No login_node configured for this cluster.";
    S._renderHook?.();
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
      S._renderHook?.();
      return;
    }
  }

  // Block submit if QoS is still loading
  if (popup.qosLoading) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = "QoS list still loading - please wait a moment.";
    S._renderHook?.();
    return;
  }

  popup.jobSubmitStatus = "submitting";
  popup.jobId = "";
  popup.gpuIdxList = "";
  popup.jobErrorMsg = "";
  popup.jobAbortRequested = false;
  S._renderHook?.();

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
    const sbatchExit = await sbatchProc.exited;
    if (sbatchExit !== 0) {
      const sbatchErr = await new Response(sbatchProc.stderr).text();
      throw new Error(`sbatch failed: ${sbatchErr.trim() || `exit ${sbatchExit}`}`);
    }

    // Parse JOBID from "Submitted batch job 1059327" - retry up to 3× on parse failure
    let jobIdMatch = sbatchOut.match(/Submitted batch job (\d+)/);
    if (!jobIdMatch) {
      // Some clusters emit delayed output; retry stderr+stdout combination
      const sbatchErr2 = await new Response(sbatchProc.stderr).text();
      const combined = sbatchOut + sbatchErr2;
      jobIdMatch = combined.match(/Submitted batch job (\d+)/);
    }
    if (!jobIdMatch) {
      // Abort was requested before we even got JOBID - nothing to scancel
      if (popup.jobAbortRequested) {
        popup.jobSubmitStatus = "idle";
        S._renderHook?.();
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
    S._renderHook?.();
    tuiLog("INFO", `job submitted: JOBID=${popup.jobId}`);

    // 2. Poll squeue until RUNNING - 200ms tick × 300 = 60s max; abort responsive
    let running = false;
    const TICK_MS = 200;
    const POLL_EVERY = 10; // query squeue every 10 ticks (2s)
    let tickCount = 0;
    let totalTicks = 300;
    while (tickCount < totalTicks) {
      await new Promise(r => setTimeout(r, TICK_MS));
      if (!S.slurmRunPopup) return; // popup closed
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
    S._renderHook?.();
    tuiLog("INFO", `job running: JOBID=${popup.jobId} GPU_IDX=${popup.gpuIdxList}`);

  } catch (e: any) {
    popup.jobSubmitStatus = "error";
    popup.jobErrorMsg = e?.message || String(e);
    tuiLog("ERROR", `job submit failed: ${popup.jobErrorMsg}`);
    S._renderHook?.();
  }
}

export function renderSlurmClusterTab(slurmIdx: number) {
  const ssnap = S.slurmSnapshots[slurmIdx];
  if (!ssnap) {
    return Box(
      { flexDirection: "column", paddingLeft: 1, backgroundColor: C.bg },
      Box({ height: 0 }), // removed old tab bar
      Text({ content: "No data for this Slurm cluster.", fg: C.textDim }),
    );
  }

  const nodes = ssnap.nodes || [];
  const totalGpus = nodes.reduce((s, n) => s + n.gpu_total, 0);
  const usedGpus = nodes.reduce((s, n) => s + n.gpu_used, 0);
  const maxGpus = nodes.reduce((m, n) => Math.max(m, n.gpu_total), 0);

  const termWidth = process.stdout.columns || 80;

  // Tab bar handled globally

  // Header
  const slurmHeader = Box(
    { width: "100%", flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, backgroundColor: C.bgAlt },
    Text({ content: t`${bold(fg(C.blue)("Slurm"))} ${fg(C.textDim)("· dashboard")}` }),
    Text({ content: t`GPUs: ${fg(C.green)(`${usedGpus}`)}/${totalGpus}  ${S.slurmLoading ? fg(C.yellow)("⟳") : ""}`, fg: C.textDim }),
  );

  // Sort nodes
  const sortedNodes = sortSlurmNodes(nodes, S.slurmSortKey);

  // Column widths
  const nodeW = 12;
  // Dynamic partition width: fit longest name, min 12, max 22
  const maxPartLen = nodes.reduce((m, n) => Math.max(m, (n.partition || "").length), 9);
  const partW = Math.min(22, Math.max(12, maxPartLen + 1));
  const stateW = 10;
  const usedW = 6;
  const freeW = 6;
  // Clamp max GPU columns to fit S.screen - prefer showing user names legibly
  const maxDisplayGpus = Math.min(maxGpus, Math.floor((termWidth - nodeW - partW - stateW - usedW - freeW - 3) / 8));
  const gpuW = maxDisplayGpus > 0
    ? Math.max(8, Math.floor((termWidth - nodeW - partW - stateW - usedW - freeW - 3) / maxDisplayGpus))
    : 8;

  // Sort indicator helper
  // Descending sorts (higher value first) use ▼; ascending sorts use ▲
  const DESCENDING_SORT_KEYS: SlurmSortKey[] = ["gpu_used", "gpu_free"];
  const sortArrow = (col: SlurmSortKey) => {
    if (S.slurmSortKey === col) {
      return DESCENDING_SORT_KEYS.includes(col) ? fg(C.blue)(" ▼") : fg(C.blue)(" ▲");
    }
    return fg(C.textDim)(" ·");
  };

  // Table header with clickable sort columns
  const gpuHeaders = Array.from({ length: maxDisplayGpus }, (_, i) =>
    Box({ width: gpuW }, Text({ content: `GPU${i}`.padEnd(gpuW), fg: C.textDim }))
  );
  const moreGpusHdr = maxGpus > maxDisplayGpus
    ? Box({ width: 4 }, Text({ content: `+${maxGpus - maxDisplayGpus}`, fg: C.textDim }))
    : null;

  const tableHdr = Box(
    { flexDirection: "row", paddingLeft: 1, backgroundColor: C.bgAlt },
    Box(
      { width: nodeW, onMouseDown: () => { S.slurmSortKey = S.slurmSortKey === "name" ? "none" : "name"; S.slurmScrollOff = 0; S.slurmSelectedIdx = 0; S._renderHook?.(); } },
      Text({ content: t`${"Node".padEnd(nodeW - 2)}${sortArrow("name")}`, fg: C.textDim }),
    ),
    Box(
      { width: partW },
      Text({ content: "Partition".padEnd(partW), fg: C.textDim }),
    ),
    Box(
      { width: stateW, onMouseDown: () => { S.slurmSortKey = S.slurmSortKey === "state" ? "none" : "state"; S.slurmScrollOff = 0; S.slurmSelectedIdx = 0; S._renderHook?.(); } },
      Text({ content: t`${"State".padEnd(stateW - 2)}${sortArrow("state")}`, fg: C.textDim }),
    ),
    ...gpuHeaders,
    ...(moreGpusHdr ? [moreGpusHdr] : []),
    Box(
      { width: usedW, onMouseDown: () => { S.slurmSortKey = S.slurmSortKey === "gpu_used" ? "none" : "gpu_used"; S.slurmScrollOff = 0; S.slurmSelectedIdx = 0; S._renderHook?.(); } },
      Text({ content: t`${"Used".padEnd(usedW - 2)}${sortArrow("gpu_used")}`, fg: C.textDim }),
    ),
    Box(
      {
        width: freeW,
        onMouseDown: () => {
          S.slurmSortKey = S.slurmSortKey === "gpu_free" ? "none" : "gpu_free";
          S.slurmScrollOff = 0;
          S.slurmSelectedIdx = 0;
          S._renderHook?.();
        },
      },
      Text({ content: t`${"Free".padEnd(freeW - 2)}${sortArrow("gpu_free")}`, fg: C.textDim }),
    ),
  );

  const stateIcon: Record<string, string> = {
    idle: "🟢", mixed: "🟡", allocated: "🔴", down: "⚫", drain: "⚫", drained: "⚫",
  };

  const termHeight = process.stdout.rows || 24;
  // tabBar(1) + slurmHeader(1) + tableHdr(1) + footer(3) = 6 fixed lines
  const visibleRows = Math.max(1, termHeight - 6);

  // Clamp scroll offset (non-destructive: only reduce, never over-clamp on small lists)
  const maxScroll = Math.max(0, sortedNodes.length - visibleRows);
  if (S.slurmScrollOff > maxScroll) S.slurmScrollOff = maxScroll;
  if (S.slurmScrollOff < 0) S.slurmScrollOff = 0;

  // Build all node rows first, then slice for scroll
  const allNodeRows: any[] = [];
  for (let ni = 0; ni < sortedNodes.length; ni++) {
    const snode = sortedNodes[ni]!;
    const isSelected = ni === S.slurmSelectedIdx;
    const icon = stateIcon[snode.state?.toLowerCase()?.replace("*", "") || ""] || "⚪";

    const gpuCells = Array.from({ length: maxDisplayGpus }, (_, gi) => {
      const slot = snode.gpus?.[gi];
      if (!slot) return Box({ width: gpuW }, Text({ content: "".padEnd(gpuW), fg: C.textDim }));
      if (slot.user === "???") {
        // Occupied but owner unidentifiable (Slurm visibility/policy limit)
        return Box({ width: gpuW }, Text({ content: "👤".padEnd(gpuW), fg: C.yellow }));
      }
      if (slot.user) {
        const label = slot.user.length > gpuW - 1 ? slot.user.slice(0, gpuW - 2) + "…" : slot.user;
        return Box({ width: gpuW }, Text({ content: label.padEnd(gpuW), fg: C.yellow }));
      }
      return Box({ width: gpuW }, Text({ content: "·".padEnd(gpuW), fg: C.textDim }));
    });

    // Extra GPU count for truncated columns
    const hiddenGpus = maxGpus > maxDisplayGpus ? snode.gpus.slice(maxDisplayGpus) : [];
    const hiddenUsed = hiddenGpus.filter(g => g?.user).length;
    const moreCell = maxGpus > maxDisplayGpus
      ? Box({ width: 4 }, Text({ content: hiddenUsed > 0 ? `+${hiddenUsed}` : "   ", fg: hiddenUsed > 0 ? C.red : C.textDim }))
      : null;

    const capturedNode = snode;
    const handleNodeClick = () => {
      const now = Date.now();
      const clickKey = `SLURM_NODE:${ssnap.cluster_name}:${capturedNode.name}`;
      const isDouble = clickKey === S.lastNodeClickKey && now - S.lastNodeClickAt < 350;
      S.lastNodeClickKey = clickKey;
      S.lastNodeClickAt = now;

      S.slurmSelectedIdx = ni;
      if (isDouble) S.openSrunPopup?.(capturedNode.name);
      S.requestRender?.();
    };

    const myJobIds = getMyJobIdsOnNode(snode, ssnap.ssh_user || "");
    const hasMyJob = myJobIds.length > 0;

    allNodeRows.push(
      Box(
        { flexDirection: "row", paddingLeft: 1, width: "100%", backgroundColor: isSelected ? C.bgAlt : undefined, onMouseDown: handleNodeClick },
        Box({ width: nodeW }, Text({ content: `${hasMyJob ? "★" : icon}${snode.name}`.slice(0, nodeW).padEnd(nodeW), fg: hasMyJob ? C.cyan : isSelected ? "#ffffff" : C.text })),
        Box({ width: partW }, Text({ content: (snode.partition || "").slice(0, partW - 1).padEnd(partW), fg: C.textDim })),
        Box({ width: stateW }, Text({ content: (snode.state || "").replace("*", "").slice(0, stateW - 1).padEnd(stateW), fg: C.textDim })),
        ...gpuCells,
        ...(moreCell ? [moreCell] : []),
        Box({ width: usedW }, Text({
          content: `${snode.gpu_used}/${snode.gpu_total}`.padEnd(usedW),
          fg: snode.gpu_used > 0 ? C.yellow : C.textDim,
        })),
        Box({ width: freeW }, Text({
          content: `${snode.gpu_free}/${snode.gpu_total}`.padEnd(freeW),
          fg: snode.gpu_free === 0 ? C.red : snode.gpu_free === snode.gpu_total ? C.green : C.yellow,
        })),
      )
    );
  }

  // Apply scroll window
  const nodeRows = allNodeRows.slice(S.slurmScrollOff, S.slurmScrollOff + visibleRows);

  // Scroll indicator
  const scrollInfo = sortedNodes.length > visibleRows
    ? ` [${S.slurmScrollOff + 1}-${Math.min(S.slurmScrollOff + visibleRows, sortedNodes.length)}/${sortedNodes.length}]`
    : "";

  // User summary
  const userCounts: Record<string, number> = {};
  for (const sn of nodes) {
    for (const sg of (sn.gpus || [])) {
      if (sg.user) userCounts[sg.user] = (userCounts[sg.user] || 0) + 1;
    }
  }
  const userParts = Object.entries(userCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([u, c]) => u === "???" ? `👤:${c}` : `${u}:${c}`)
    .join("  ");

  // Node cancel status line
  let cancelStatusContent: any = " ";
  if (S.nodeCancelStatus && S.nodeCancelStatus.node) {
    if (S.nodeCancelStatus.status === "cancelling") {
      cancelStatusContent = t`${fg(C.yellow)(`⟳ Cancelling job on ${S.nodeCancelStatus.node}...`)}`;
    } else if (S.nodeCancelStatus.status === "done") {
      cancelStatusContent = t`${fg(C.green)(`✓ ${S.nodeCancelStatus.msg}`)}`;
    } else if (S.nodeCancelStatus.status === "error") {
      cancelStatusContent = t`${fg(C.red)(`✗ ${S.nodeCancelStatus.msg}`)}`;
    }
  }

  const footer = Box(
    { width: "100%", flexDirection: "column", paddingLeft: 1, paddingTop: 1 },
    Text({ content: t`${fg(C.textDim)("Users:")} ${userParts || "(none)"}  ${fg(C.textDim)(scrollInfo)}` }),
    Text({ content: cancelStatusContent }),
    Text({ content: t`${fg(C.textDim)("[/]")} App Tabs  ${fg(C.textDim)("[Tab]")} Cluster  ${fg(C.textDim)("[↑↓/jk]")} Scroll  ${fg(C.textDim)("[s]")} Sort` }),
    Text({ content: t`${fg(C.textDim)("[Enter/Dbl-click]")} Popup  ${fg(C.textDim)("[ctrl+x ↓]")} Runner  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[ctrl+x q]")} Quit` }),
  );

  // Error rows
  const errorRows: any[] = [];
  if (ssnap.errors?.length) {
    errorRows.push(Box({ paddingLeft: 1 }, Text({ content: t`⚠ ${ssnap.errors.join("; ")}`, fg: C.red })));
  }

  // Thin scrollbar (1 char wide, right edge)
  const scrollbar = (() => {
    if (nodes.length <= visibleRows) return null;
    const trackH = visibleRows;
    const thumbH = Math.max(1, Math.round((visibleRows / nodes.length) * trackH));
    const thumbTop = Math.round((S.slurmScrollOff / (nodes.length - visibleRows)) * (trackH - thumbH));
    const chars = Array.from({ length: trackH }, (_, i) => {
      const inThumb = i >= thumbTop && i < thumbTop + thumbH;
      return Text({ content: inThumb ? "█" : "░", fg: inThumb ? C.blue : C.textDim });
    });
    return Box(
      {
        position: "absolute",
        right: 0,
        top: 3, // below tabBar + header + tableHdr
        width: 1,
        flexDirection: "column",
      },
      ...chars,
    );
  })();

  // Mouse scroll handler for the node list area
  const onMouseScroll = (e: any) => {
    if (!e.scroll) return;
    const maxSc = Math.max(0, sortedNodes.length - visibleRows);
    if (e.scroll.direction === "down") {
      S.slurmScrollOff = Math.min(maxSc, S.slurmScrollOff + 3);
      S.slurmSelectedIdx = Math.min(nodes.length - 1, S.slurmScrollOff);
    } else if (e.scroll.direction === "up") {
      S.slurmScrollOff = Math.max(0, S.slurmScrollOff - 3);
      S.slurmSelectedIdx = Math.max(0, S.slurmScrollOff);
    }
    S._renderHook?.();
    S.requestRender?.();
  };

  return Box(
    {
      position: "relative", width: "100%", height: "100%", backgroundColor: C.bg,
      onMouseScroll,
    },
    Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg },
      
      slurmHeader,
      tableHdr,
      ...nodeRows,
      ...errorRows,
      footer,
    ),
    ...(scrollbar ? [scrollbar] : []),
    // srun popup overlay (no runner pane in Slurm tab)
    ...(S.slurmRunPopup ? [renderSrunPopup(S.slurmRunPopup)] : []),
  );
}

export async function loadSlurmData(): Promise<void> {
  if (S.slurmLoading) return;
  S.slurmLoading = true;
  S.slurmError = null;
  tuiLog("DEBUG", `loadSlurmData: starting, OPENSMI=${JSON.stringify(OPENSMI)}, CWD=${OPENSMI_CWD}`);
  S._renderHook?.();

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
    S.slurmSnapshots = Array.isArray(parsed) ? parsed : [parsed];
    tuiLog("INFO", `slurm: loaded ${S.slurmSnapshots.length} cluster(s), total ${S.slurmSnapshots.reduce((s, c) => s + c.nodes.length, 0)} nodes`);
  } catch (e: any) {
    S.slurmError = e?.message || String(e);
    S.slurmSnapshots = [];
    tuiLog("ERROR", `slurm load failed: ${S.slurmError}`);
  } finally {
    S.slurmLoading = false;
    S._renderHook?.();
  }
}
