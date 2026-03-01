/**
 * src/views/MyGpus.ts
 * "My GPUs" tab view: shows GPU bundles (allocated, active, pinned) for the current operator.
 * Extracted from index.ts — DO NOT modify index.ts (Phase 3 handles that).
 */

import { Box, Text, t, bold, fg } from "@opentui/core";
import { S, OPERATOR } from "../state/global";
import { getStateDir, tuiLog } from "../state/api";
import { C } from "../theme";
import type { GpuBundle } from "../types";
import {
  gpuMemStr,
  gpuUtilPct,
  createSparkline,
  createMemBar,
  runtimeStr,
  getAllocation,
  usersOnGpu,
  gpuActivityStatus,
  _parseTargets,
} from "../utils/format";

// ── GPU bundle computation ─────────────────────────────────────────

export function computeGpuBundles(): GpuBundle[] {
  const bundles: GpuBundle[] = [];

  const allocatedGpus = S.allocations
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
  if (S.snapshot) {
    for (const node of S.snapshot.nodes) {
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
  for (const key of Array.from(activeGpuSet)) {
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

  if (S.myGpuViewState.pinnedGpus.length > 0) {
    bundles.push({
      id: "pinned",
      label: `Pinned GPUs (${S.myGpuViewState.pinnedGpus.length})`,
      type: "pinned",
      gpus: S.myGpuViewState.pinnedGpus,
      shortcut: "+",
    });
  }

  return bundles;
}

// ── Persistent state ───────────────────────────────────────────────

export async function loadMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  try {
    const raw = await Bun.file(stateFile).text();
    const data = JSON.parse(raw);
    S.myGpuViewState.pinnedGpus = data.pinned_gpus || [];
    const expandedBundles = data.expanded_bundles || [];
    S.myGpuViewState.expandedGpuKeys = new Set(expandedBundles);
  } catch {
    S.myGpuViewState.pinnedGpus = [];
    S.myGpuViewState.expandedGpuKeys = new Set();
  }
}

export async function saveMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  const data = {
    pinned_gpus: S.myGpuViewState.pinnedGpus,
    expanded_bundles: Array.from(S.myGpuViewState.expandedGpuKeys),
  };
  try {
    await Bun.write(stateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    tuiLog("ERROR", `Failed to save My GPU View state: ${e}`);
  }
}

// ── Render ─────────────────────────────────────────────────────────

export function renderMyGpuView() {
  const bundles = computeGpuBundles();
  S.myGpuViewState.bundles = bundles;

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
      Text({ content: "[p] Pin a GPU from dashboard or details", fg: C.textDim }),
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
      content: t`Bundles: ${bundles.length}  Poll: ${S.lastPollTime || "-"}  ${S.isPolling ? fg(C.yellow)("⟳") : ""}`,
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
  bundleRows.push(Text({ content: "" }));

  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    const isSelected = i === S.myGpuViewState.selectedBundleIdx;
    const prefix = isSelected ? "▸ " : "  ";
    const shortcutLabel = bundle.shortcut ? ` [${bundle.shortcut}]` : "";

    bundleRows.push(
      Text({
        content: `${prefix}${bundle.label}${shortcutLabel}`,
        fg: isSelected ? C.yellow : C.text,
      })
    );
  }

  const selectedBundle = bundles[S.myGpuViewState.selectedBundleIdx];
  const gpuDetails: any[] = [];

  if (selectedBundle && S.snapshot) {
    gpuDetails.push(
      Text({
        content: t`${bold(fg(C.cyan)(selectedBundle.label))}`,
      })
    );
    gpuDetails.push(Text({ content: "" }));

    for (const gpuRef of selectedBundle.gpus) {
      const node = S.snapshot.nodes.find(n => n.node_alias === gpuRef.node);
      if (!node || node.error) {
        gpuDetails.push(
          Text({
            content: `  ${gpuRef.node}:GPU${gpuRef.gpu} - ERROR`,
            fg: C.red,
          })
        );
        continue;
      }

      const gpu = node.gpus.find(g => g.index === gpuRef.gpu);
      if (!gpu) {
        gpuDetails.push(
          Text({
            content: `  ${gpuRef.node}:GPU${gpuRef.gpu} - NOT FOUND`,
            fg: C.red,
          })
        );
        continue;
      }

      const procs = node.processes.filter(p => p.gpu_uuid === gpu.uuid);
      const alloc = getAllocation(gpuRef.node, gpuRef.gpu);
      const _allocStr = alloc ? alloc.target : "*";
      const utilVal = gpuUtilPct(gpu);
      const utilStr = utilVal !== null ? `Load ${String(utilVal).padStart(3)}% ${createSparkline(utilVal)}` : "Load   ?  ";
      const memBar = createMemBar(gpu.memory_used_mib ?? null, gpu.memory_total_mib ?? null);
      const activityStr = gpuActivityStatus(node, gpuRef.gpu, gpu.uuid);

      gpuDetails.push(
        Text({
          content: `  ${gpuRef.node}:GPU${gpuRef.gpu}  |  ${gpu.name.padEnd(16)}  |  ${memBar} ${gpuMemStr(gpu.memory_used_mib)}/${gpuMemStr(gpu.memory_total_mib)}  |  ${utilStr}  |  ${activityStr}`,
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
      content: S.runnerInputTyping
        ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
        : (S.runnerFocused
            ? t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Esc]")} Unfocus  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+x Enter]")} Execute  ${fg(C.textDim)("[Tab/+/-]")} Options`
            : t`[↑↓] Navigate Bundles  [ctrl+x r] Run Command  [ctrl+x ↓] Runner  [ctrl+x t] Switch Tab  [Esc] Dashboard`),
      fg: C.textDim,
    }),
    Text({
      content: S.statusMsg ? t`${fg(C.yellow)(S.statusMsg)}` : " ",
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
