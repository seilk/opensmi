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
} from './src/state/api';

// Debounce rapid bracket key presses to prevent state thrashing
let _lastBracketKeyTime = 0;
const BRACKET_KEY_DEBOUNCE_MS = 100;

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
      recomputeKnownUsers();
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

  async function runRefreshCycle() {
    if (_S_module.runnerFocused || _S_module.runnerInputTyping) return;
    _S_module.isRefreshing = true;
    render();
    try {
      await Promise.all([pollAllClusters(), loadAllocations(), loadSlurmData()]);
      if (_S_module.screen === "jobs") {
        await loadJobsFromCLI();
      }
      await dispatchQueuedJobs();
      await watchRunningJobs();
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
      void navigateByDelta(1);
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
        void navigateByDelta(bracketKey === "[" ? -1 : 1);
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
          const sortedN = sortSlurmNodes(snap?.nodes || [], _S_module.slurmSortKey);
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
            await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
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
            await Promise.all([pollAllClusters(), loadAllocations()]);
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
          await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
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
            await Promise.all([pollAllClusters(), loadAllocations()]);
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
          await Promise.all([pollAllClusters(), loadAllocations()]);
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
              checkGpuLiveness(_S_module.jobDetailView).then(() => render());
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
