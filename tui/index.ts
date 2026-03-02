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
import path from "node:path";
import { tabRegistry, type Tab } from "./tabRegistry";
import { tmuxSafeName } from './src/utils/format';
import { S as _S_module, runnerMinHeight, runnerMaxHeight, OPERATOR } from './src/state/global';
import { renderAlloc, openAllocModal, requireAdminUI, checkSudoForNode } from './src/components/AllocModal';
import { renderGlobalTabBar, renderGlobalFooter, renderToast, renderTabSwitcher, navigateByDelta, navigateToTab } from './src/components/Layout';
import { renderRunnerPane, runnerPaneTopRow, setLaunchError, getGpuCommandPlaceholder, getGpuLabel, refreshLaunchGpuSelection, createImmediateJob, updateImmediateJob, executeLaunch, executeRemoteExec, executeLaunchDirect, executeLaunchOneToOne, executeLaunchTmux } from './src/components/Runner';
import { renderLoadingBadge, renderDashboard, renderSrunPopup, renderSlurmClusterTab, sortSlurmNodes, buildDashboardTabs, activeDashboardTab, activeManualTabIdx, activeDashboardSnapshot, activeDashboardPollError, activeDashboardSelectedNodeIdx, setActiveDashboardSelectedNodeIdx, openSrunPopup, closeSrunPopup, srunTokens, srunCommand, copyToClipboard, getLatestFreeGpus, activeSlurmTabIdx, slurmTabIdxForPopup, submitSrunPopup, slurmNameSafe, fetchQosForPartition, getMyJobIdsOnNode, cancelJobsOnNode, cancelExistingJobsInPopup, cancelSlurmJob, submitJobToSlurm, loadSlurmData } from './src/views/Dashboard';
import { renderDetail, renderHelp, renderKill } from './src/views/Detail';
import {
  renderJobsView,
  renderJobsListView,
  renderJobDetailView,
  dispatchQueuedJobs,
  watchRunningJobs,
  checkGpuLiveness,
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
import { renderMyGpuView, computeGpuBundles, loadMyGpuViewState, saveMyGpuViewState } from './src/views/MyGpus';
import { renderSetupView, setSetupMessage, loadSetupNodes, saveSetupNode, markSetupNodeDirty, flushSetupChangesToConfig } from './src/views/Setup';
import type { RunnerState, PreflightCheck, GpuBundle, MyGpuViewState, GPUInfo, GPUProcess, NodeSnapshot, ClusterSnapshot, Allocation, Job, SlurmGPUSlot, SlurmNodeInfo, SlurmSnapshot, DashboardTab, SlurmSortKey, SlurmRunPopup, NodeEnvConfig, NodeCancelStatus } from './src/types';
import { C } from './src/theme';
import { usersOnGpu, gpuIndicesForSnapshot, gpuIndicesForNode, truncateText, getAllocation, getAllocTarget, _parseIso, expiresInShort, gpuActivityStatus, countExpiringWithin, _parseTargets, _filteredDraftList, _toggleDraftUser, isViolation, gpuMemStr, gpuUtilPct, suggestGpu, runtimeStr, setStatus, stripAnsi, wrapText, wrapTextWithCursor, shellQuote } from './src/utils/format';
import {
  pollCluster,
  pollExtraCluster,
  pollAllClusters,
  recomputeKnownUsers,
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
  updateGpuIdleTracking,
  loadSystemUsers,
} from './src/state/api';
import { startIntervals, stopIntervals, cycleAutoRefresh } from './src/lifecycle/intervals';
import { registerKeyHandler } from './src/input/keyHandler';

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
    pollAllClusters(),
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
      void Promise.all([pollAllClusters(), loadAllocations(), loadSlurmData()])
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
      void Promise.all([pollAllClusters(), loadAllocations()]).then(() => _S_module.requestRender?.());
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

  function shutdown() {
    stopIntervals();
    renderer.destroy();
    process.exit(0);
  }

  startIntervals(render);
  registerKeyHandler({ renderer, container, render, shutdown });
}

main().catch((e) => {
  tuiLog("ERROR", `fatal: ${e?.message || String(e)}\n${e?.stack || ""}`);
  console.error(e);
  process.exit(1);
});
