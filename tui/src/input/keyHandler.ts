import type { KeyEvent } from "@opentui/core";
import { tabRegistry } from '../../tabRegistry';
import { S, runnerMinHeight, runnerMaxHeight, OPERATOR } from '../state/global';
import { openAllocModal, requireAdminUI, checkSudoForNode } from '../components/AllocModal';
import { navigateByDelta, navigateToTab } from '../components/Layout';
import {
  runnerPaneTopRow, setLaunchError, getGpuCommandPlaceholder, getGpuLabel,
  refreshLaunchGpuSelection, createImmediateJob, updateImmediateJob, executeLaunch,
  executeRemoteExec, executeLaunchDirect, executeLaunchOneToOne, executeLaunchTmux,
} from '../components/Runner';
import {
  sortSlurmNodes, buildDashboardTabs, activeDashboardTab, activeDashboardSnapshot,
  activeDashboardSelectedNodeIdx, setActiveDashboardSelectedNodeIdx, openSrunPopup,
  closeSrunPopup, srunTokens, srunCommand, copyToClipboard, getLatestFreeGpus,
  activeSlurmTabIdx, slurmTabIdxForPopup, submitSrunPopup, slurmNameSafe,
  fetchQosForPartition, getMyJobIdsOnNode, cancelJobsOnNode, cancelExistingJobsInPopup,
  cancelSlurmJob, submitJobToSlurm, loadSlurmData,
} from '../views/dashboard';
import {
  dispatchQueuedJobs, watchRunningJobs, checkGpuLiveness, findAvailableGpus,
  cleanupOldJobs, executeJobRemote, cancelJobAction, retryJobAction,
  retrySelectedSessionAction, cleanupTmuxSessionsAction, deleteJobAction,
  killTmuxSessions, captureTmuxPane,
} from '../views/jobs';
import { computeGpuBundles, loadMyGpuViewState, saveMyGpuViewState } from '../views/MyGpus';
import { setSetupMessage, loadSetupNodes, saveSetupNode, markSetupNodeDirty, flushSetupChangesToConfig } from '../views/Setup';
import type { SlurmSortKey } from '../types';
import { C } from '../theme';
import {
  usersOnGpu, gpuIndicesForSnapshot, gpuIndicesForNode, truncateText, getAllocation,
  getAllocTarget, _parseIso, expiresInShort, gpuActivityStatus, countExpiringWithin,
  _parseTargets, _filteredDraftList, _toggleDraftUser, isViolation, gpuMemStr, gpuUtilPct,
  suggestGpu, runtimeStr, setStatus, stripAnsi, wrapText, wrapTextWithCursor, shellQuote,
} from '../utils/format';
import {
  pollAllClusters, loadAllocations, loadJobsFromCLI, allocSet, allocClear, killPids,
  tuiLog, runOpensmi, getStateDir, loadAdminStatus, saveJobToStore, updateJobInStore,
  loadClusterTabsFromConfig, recomputeKnownUsers, PYTHON, BASE_DIR, OPENSMI_ENV,
  OPENSMI_CWD, OPENSMI, updateGpuIdleTracking, loadSystemUsers,
} from '../state/api';
import { cycleAutoRefresh, stopIntervals, restartRefreshInterval, runRefreshCycle } from '../lifecycle/intervals';
import { tmuxSafeName } from '../utils/format';

let _lastBracketKeyTime = 0;
const BRACKET_KEY_DEBOUNCE_MS = 100;

export interface KeyHandlerContext {
  renderer: any;
  container: any;
  render: () => void;
  shutdown: () => void;
}

export function registerKeyHandler(ctx: KeyHandlerContext): void {
  const { renderer, container, render, shutdown } = ctx;

  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (S.tabSwitcherOpen) {
      if (key.name === "escape") {
        S.tabSwitcherOpen = false;
        render();
        return;
      }

      if (key.name === "return") {
        const tabs = tabRegistry.getAllVisible();
        const selectedTab = tabs[S.tabSwitcherIdx];
        if (selectedTab) {
          const switched = await tabRegistry.switchTo(selectedTab.id);
          if (switched) {
            S.screen = selectedTab.id as typeof S.screen;
          }
          S.tabSwitcherOpen = false;
          render();
        }
        return;
      }

      if (key.name === "up" || key.name === "k") {
        const tabs = tabRegistry.getAllVisible();
        S.tabSwitcherIdx = (S.tabSwitcherIdx - 1 + tabs.length) % tabs.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "j") {
        const tabs = tabRegistry.getAllVisible();
        S.tabSwitcherIdx = (S.tabSwitcherIdx + 1) % tabs.length;
        render();
        return;
      }

      if (key.name.length === 1) {
        const tabs = tabRegistry.getAllVisible();
        const matchedTab = tabs.find(t => t.shortcut === key.name);
        if (matchedTab) {
          const switched = await tabRegistry.switchTo(matchedTab.id);
          if (switched) {
            S.screen = matchedTab.id as typeof S.screen;
          }
          S.tabSwitcherOpen = false;
          render();
        }
        return;
      }

      return;
    }

    if (key.name === "x" && key.ctrl) {
      S.prefixKeyPressed = true;
      if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);
      S.prefixKeyTimeout = setTimeout(() => {
        S.prefixKeyPressed = false;
      }, 2000);
      render();
      return;
    }

    if (S.prefixKeyPressed && key.name === "t") {
      S.prefixKeyPressed = false;
      if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);
      S.tabSwitcherOpen = true;
      S.runnerFocused = false;
      S.runnerInputTyping = false;
      S.tabSwitcherIdx = tabRegistry.getAllVisible().findIndex(t => t.id === tabRegistry.activeTabId);
      if (S.tabSwitcherIdx < 0) S.tabSwitcherIdx = 0;
      render();
      return;
    }

    if (S.prefixKeyPressed && key.name === "q") {
      S.prefixKeyPressed = false;
      if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);
      shutdown();
      return;
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

    if (S.screen === "dashboard" || S.screen === "my-gpu-view") {

      const bracketKey =
        key.sequence === "[" || key.sequence === "]"
          ? key.sequence
          : key.name === "[" || key.name === "]"
            ? key.name
            : null;
      if (bracketKey === "[" || bracketKey === "]") {
        const now = Date.now();
        if (now - _lastBracketKeyTime < BRACKET_KEY_DEBOUNCE_MS) {
          return;
        }
        _lastBracketKeyTime = now;
        void navigateByDelta(bracketKey === "[" ? -1 : 1);
        return;
      }

      if (S.prefixKeyPressed && key.name === "down") {
        S.prefixKeyPressed = false;
        if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);
        S.runnerFocused = true;
        S.runnerInputBuffer = S.launchCommand;
        S.runnerFocusedInputIdx = 0;

        if (S.launchDistMode === "one-to-one") {
          for (let i = 0; i < S.launchCommands.length; i++) {
            if (!S.launchCommands[i] || S.launchCommands[i] === "") {
              const gpu = S.launchSelectedGpus[i];
              S.launchCommands[i] = getGpuCommandPlaceholder(gpu);
            }
          }
        }

        S.runnerInputTyping = false;
        render();
        return;
      }

      if (S.prefixKeyPressed && key.name === "f") {
        S.prefixKeyPressed = false;
        if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);
        S.runnerPaneFolded = !S.runnerPaneFolded;
        render();
        return;
      }

      if (S.prefixKeyPressed && key.name === "r" && S.screen === "my-gpu-view") {
        S.prefixKeyPressed = false;
        if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);

        const selectedBundle = S.myGpuViewState.bundles[S.myGpuViewState.selectedBundleIdx];
        if (selectedBundle && selectedBundle.gpus.length > 0) {
          S.launchGpuMode = "selected";
          S.launchManualGpus = [...selectedBundle.gpus];
          S.launchNumGpus = selectedBundle.gpus.length;
          S.launchSelectedGpus = [...selectedBundle.gpus];
          S.launchSourceBundle = selectedBundle.label;

          if (S.launchDistMode === "one-to-one") {
            S.launchCommands = [];
            for (let i = 0; i < S.launchNumGpus; i++) {
              const gpu = S.launchSelectedGpus[i];
              S.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }

          S.runnerPaneFolded = false;
          S.runnerFocused = true;
          S.runnerInputBuffer = S.launchCommand;
          S.runnerFocusedInputIdx = 0;
          S.runnerInputTyping = false;

          setStatus(`Runner opened with ${S.launchNumGpus} GPU(s) from ${selectedBundle.label}`, 2000);
        } else {
          setStatus("No GPUs in selected bundle");
        }

        render();
        return;
      }

      if (S.prefixKeyPressed && key.name === "return") {
        S.prefixKeyPressed = false;
        if (S.prefixKeyTimeout) clearTimeout(S.prefixKeyTimeout);

        if (S.launchDistMode === "single") {
          const inputAny: any = container.findDescendantById("runner-cmd-input");
          if (inputAny) {
            S.launchCommand = String(inputAny.value ?? "");
          }
          if (!S.launchCommand.trim() && S.runnerInputBuffer.trim()) {
            S.launchCommand = S.runnerInputBuffer;
          }
        } else {
          for (let i = 0; i < S.launchNumGpus; i++) {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
            if (inputAny) {
              S.launchCommands[i] = String(inputAny.value ?? "");
            }
          }
        }

        if (S.launchMode === "tmux") {
          const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
          if (tmuxInputAny) {
            S.launchTmuxSession = String(tmuxInputAny.value ?? "");
          }
        }

        S.runnerInputTyping = false;
        S.runnerFocused = false;
        await executeLaunch();
        render();
        return;
      }

      if (S.runnerInputTyping) {
        if (key.name === "escape") {
          if (S.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            S.runnerInputBuffer = String(inputAny?.value ?? "");
            S.launchCommand = S.runnerInputBuffer;
          } else {
            for (let i = 0; i < S.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                S.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (S.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              S.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          S.runnerInputTyping = false;
          render();
        } else if (key.name === "return") {
          if (S.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            S.runnerInputBuffer = String(inputAny?.value ?? "");
            S.launchCommand = S.runnerInputBuffer;
          } else {
            for (let i = 0; i < S.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                S.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (S.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              S.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          S.runnerInputTyping = false;
          render();
        } else if (key.name === "down" && S.launchDistMode === "one-to-one") {
          const inputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
          if (inputAny) {
            S.launchCommands[S.runnerFocusedInputIdx] = String(inputAny?.value ?? "");
          }

          if (S.runnerFocusedInputIdx === S.launchNumGpus - 1 && S.launchMode === "tmux") {
            S.runnerFocusedInputIdx = -1;
            render();
            setTimeout(() => {
              const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (tmuxInputAny) tmuxInputAny.focus();
            }, 50);
          } else {
            S.runnerFocusedInputIdx = Math.min(S.runnerFocusedInputIdx + 1, S.launchNumGpus - 1);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        } else if (key.name === "up" && S.launchDistMode === "one-to-one") {
          if (S.runnerFocusedInputIdx === -1) {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              S.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
            S.runnerFocusedInputIdx = S.launchNumGpus - 1;
            render();
            setTimeout(() => {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }, 50);
          } else {
            const inputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
            if (inputAny) {
              S.launchCommands[S.runnerFocusedInputIdx] = String(inputAny?.value ?? "");
            }

            S.runnerFocusedInputIdx = Math.max(S.runnerFocusedInputIdx - 1, 0);
            render();
            setTimeout(() => {
              const nextInputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
              if (nextInputAny) nextInputAny.focus();
            }, 50);
          }
        }
        return;
      }

      if (S.runnerFocused && (S.screen === "dashboard" || S.screen === "my-gpu-view")) {
        if (key.name === "escape") {
          S.runnerFocused = false;

          if (S.launchDistMode === "single") {
            const inputAny: any = container.findDescendantById("runner-cmd-input");
            S.runnerInputBuffer = String(inputAny?.value ?? "");
            S.launchCommand = S.runnerInputBuffer;
          } else {
            for (let i = 0; i < S.launchNumGpus; i++) {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${i}`);
              if (inputAny) {
                S.launchCommands[i] = String(inputAny?.value ?? "");
              }
            }
          }

          if (S.launchMode === "tmux") {
            const tmuxInputAny: any = container.findDescendantById("runner-tmux-session-input");
            if (tmuxInputAny) {
              S.launchTmuxSession = String(tmuxInputAny?.value ?? "");
            }
          }

          render();
          return;
        }

        if (key.name === "return") {
          S.runnerInputTyping = true;
          render();
          setTimeout(() => {
            if (S.runnerFocusedInputIdx === -1) {
              const inputAny: any = container.findDescendantById("runner-tmux-session-input");
              if (inputAny) inputAny.focus();
            } else if (S.launchDistMode === "single") {
              const inputAny: any = container.findDescendantById("runner-cmd-input");
              if (inputAny) inputAny.focus();
            } else {
              const inputAny: any = container.findDescendantById(`runner-cmd-input-${S.runnerFocusedInputIdx}`);
              if (inputAny) inputAny.focus();
            }
          }, 50);
          return;
        }

        if (key.name === "tab" && !key.shift) {
          key.preventDefault();
          S.launchMode = S.launchMode === "direct" ? "tmux" : "direct";
          render();
          return;
        }

        if (key.name === "tab" && key.shift) {
          key.preventDefault();
          if (S.launchDistMode === "single") {
            S.launchDistMode = "one-to-one";
            S.launchCommands = [];
            for (let i = 0; i < S.launchNumGpus; i++) {
              const gpu = S.launchSelectedGpus[i];
              S.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
            S.runnerFocusedInputIdx = 0;
          } else {
            S.launchDistMode = "single";
            S.launchCommands = [];
          }
          render();
          return;
        }

        if (key.name === "+" || key.name === "=") {
          const oldMode = S.launchGpuMode;
          const oldCount = S.launchNumGpus;

          S.launchNumGpus = Math.min(S.launchNumGpus + 1, 16);

          S.launchGpuMode = "auto";
          await refreshLaunchGpuSelection();

          if (S.launchSelectedGpus.length > oldCount) {
            const newGpu = S.launchSelectedGpus[S.launchSelectedGpus.length - 1];
            if (newGpu && !S.launchManualGpus.some(g => g.node === newGpu.node && g.gpu === newGpu.gpu)) {
              S.launchManualGpus.push({ node: newGpu.node, gpu: newGpu.gpu });
            }
          }

          S.launchGpuMode = "selected";
          S.launchSelectedGpus = S.launchManualGpus.slice(0, S.launchNumGpus);

          if (S.launchDistMode === "one-to-one") {
            while (S.launchCommands.length < S.launchNumGpus) {
              const idx = S.launchCommands.length;
              const gpu = S.launchSelectedGpus[idx];
              S.launchCommands.push(getGpuCommandPlaceholder(gpu));
            }
          }

          render();
          return;
        }

        if (key.name === "-" || key.name === "_") {
          S.launchNumGpus = Math.max(S.launchNumGpus - 1, 0);
          if (S.launchDistMode === "one-to-one") {
            S.launchCommands = S.launchCommands.slice(0, S.launchNumGpus);
          }
          if (S.launchManualGpus.length > S.launchNumGpus) {
            S.launchManualGpus.pop();
          }
          await refreshLaunchGpuSelection();
          render();
          return;
        }

        if ((key.name === "q" || key.name === "Q") && !S.runnerInputTyping) {
          key.preventDefault();
          S.launchQueueMode = S.launchQueueMode === "immediate" ? "queued" : "immediate";
          setStatus(`Queue mode: ${S.launchQueueMode}`, 1500);
          render();
          return;
        }

        if (key.name === "down" && !S.runnerInputTyping) {
          if (S.launchDistMode === "single") {
            if (S.launchMode === "tmux" && S.runnerFocusedInputIdx === 0) {
              S.runnerFocusedInputIdx = -1;
              render();
            }
          } else {
            const maxCmdIdx = S.launchNumGpus - 1;
            if (S.runnerFocusedInputIdx < maxCmdIdx) {
              S.runnerFocusedInputIdx++;
              render();
            } else if (S.launchMode === "tmux" && S.runnerFocusedInputIdx === maxCmdIdx) {
              S.runnerFocusedInputIdx = -1;
              render();
            }
          }
          return;
        }

        if (key.name === "up" && !S.runnerInputTyping) {
          if (S.launchDistMode === "single") {
            if (S.launchMode === "tmux" && S.runnerFocusedInputIdx === -1) {
              S.runnerFocusedInputIdx = 0;
              render();
            }
          } else {
            if (S.runnerFocusedInputIdx === -1) {
              S.runnerFocusedInputIdx = S.launchNumGpus - 1;
              render();
            } else if (S.runnerFocusedInputIdx > 0) {
              S.runnerFocusedInputIdx--;
              render();
            }
          }
          return;
        }

        if (key.name === "g" && !S.runnerInputTyping) {
          if (S.launchGpuMode === "auto") {
            S.launchGpuMode = "selected";
            S.launchManualGpus = [...S.launchSelectedGpus];
            S.launchSourceBundle = null;
            setStatus("GPU mode: Manual selection (click GPUs in panel or dashboard)");
          } else {
            S.launchGpuMode = "auto";
            S.launchManualGpus = [];
            S.launchSourceBundle = null;
            await refreshLaunchGpuSelection();
            setStatus("GPU mode: Auto-ranked selection");
          }
          render();
          return;
        }

        if (key.sequence && key.sequence.length === 1) {
          S.runnerInputTyping = true;
        }
        return;
      }

      if (S.slurmRunPopup) {
        const popup = S.slurmRunPopup;

        if (popup.editMode) {
          const cur = popup.cmdOverride ?? srunCommand(popup);
          const pos = Math.max(0, Math.min(popup.cursorPos, cur.length));
          if (key.name === "escape" || key.name === "return") {
            popup.editMode = false;
            popup.copyStatus = "idle";
            S._renderHook?.();
          } else if (key.name === "left") {
            popup.cursorPos = Math.max(0, pos - 1);
            S._renderHook?.();
          } else if (key.name === "right") {
            popup.cursorPos = Math.min(cur.length, pos + 1);
            S._renderHook?.();
          } else if (key.name === "home" || (key.ctrl && key.sequence === "\x01")) {
            popup.cursorPos = 0;
            S._renderHook?.();
          } else if (key.name === "end" || (key.ctrl && key.sequence === "\x05")) {
            popup.cursorPos = cur.length;
            S._renderHook?.();
          } else if (key.name === "backspace" || key.sequence === "\x7f") {
            if (pos > 0) {
              popup.cmdOverride = cur.slice(0, pos - 1) + cur.slice(pos);
              popup.cursorPos = pos - 1;
              popup.copyStatus = "idle";
              S._renderHook?.();
            }
          } else if (key.name === "delete") {
            if (pos < cur.length) {
              popup.cmdOverride = cur.slice(0, pos) + cur.slice(pos + 1);
              popup.copyStatus = "idle";
              S._renderHook?.();
            }
          } else if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
            popup.cmdOverride = cur.slice(0, pos) + key.sequence + cur.slice(pos);
            popup.cursorPos = pos + 1;
            popup.copyStatus = "idle";
            S._renderHook?.();
          }
          return;
        }

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
          popup.jobSubmitStatus = "idle";
          popup.jobErrorMsg = "";
          submitJobToSlurm();
          render();
        } else if ((key.sequence === "q" || key.sequence === "Q") && popup.qosList.length > 0 && !isBusy) {
          popup.qosIdx = (popup.qosIdx + 1) % (popup.qosList.length + 1);
          S._renderHook?.();
        } else if (key.sequence === "e" || key.sequence === "E") {
          if (popup.jobSubmitStatus === "idle" || popup.jobSubmitStatus === "running") {
            if (popup.cmdOverride === null) popup.cmdOverride = srunCommand(popup);
            popup.editMode = true;
            popup.cursorPos = popup.cmdOverride.length;
            popup.copyStatus = "idle";
            S._renderHook?.();
          }
        } else if ((key.sequence === "r" || key.sequence === "R") && popup.jobSubmitStatus !== "error") {
          popup.cmdOverride = null;
          popup.editMode = false;
          popup.copyStatus = "idle";
          S._renderHook?.();
        } else if (key.name === "right" || key.sequence === "+") {
          if (popup.gpuCount < popup.freeGpusAtOpen) { popup.gpuCount++; popup.cmdOverride = null; popup.copyStatus = "idle"; S._renderHook?.(); }
        } else if (key.name === "left" || key.sequence === "-") {
          if (popup.gpuCount > 1) { popup.gpuCount--; popup.cmdOverride = null; popup.copyStatus = "idle"; S._renderHook?.(); }
        } else if (key.sequence === "s" || key.sequence === "S") {
          if (popup.loginNode && popup.gpuCount >= 1 && popup.gpuCount <= popup.freeGpusAtOpen && popup.jobSubmitStatus === "idle") {
            submitJobToSlurm();
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

      const dashboardTab = activeDashboardTab();
      const activeSlurmIdx = dashboardTab?.type === "slurm" ? dashboardTab.idx : null;

      if (activeSlurmIdx !== null && S.slurmSnapshots.length > 0) {
        const sNodes = S.slurmSnapshots[activeSlurmIdx]?.nodes || [];
        if (key.name === "up" || (key.name === "k" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            S.slurmSelectedIdx = S.slurmSelectedIdx <= 0 ? sNodes.length - 1 : S.slurmSelectedIdx - 1;
            if (S.slurmSelectedIdx < S.slurmScrollOff) S.slurmScrollOff = S.slurmSelectedIdx;
            if (S.slurmSelectedIdx === sNodes.length - 1) {
              S.slurmScrollOff = Math.max(0, sNodes.length - visH);
            }
            render();
          }
          return;
        } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
          if (sNodes.length > 0) {
            const visH = Math.max(1, (process.stdout.rows || 24) - 6);
            S.slurmSelectedIdx = S.slurmSelectedIdx >= sNodes.length - 1 ? 0 : S.slurmSelectedIdx + 1;
            if (S.slurmSelectedIdx >= S.slurmScrollOff + visH) S.slurmScrollOff = S.slurmSelectedIdx - visH + 1;
            if (S.slurmSelectedIdx === 0) S.slurmScrollOff = 0;
            render();
          }
          return;
        } else if (key.name === "return") {
          const snap = S.slurmSnapshots[activeSlurmIdx];
          const sortedN = sortSlurmNodes(snap?.nodes || [], S.slurmSortKey);
          const node = sortedN[S.slurmSelectedIdx];
          if (node && snap) openSrunPopup(node, snap.cluster_name, snap);
          render();
          return;
        } else if (key.sequence === "s" || key.sequence === "S") {
          const cycle: SlurmSortKey[] = ["none", "name", "state", "gpu_used", "gpu_free"];
          const idx = cycle.indexOf(S.slurmSortKey);
          const next = cycle[(idx + 1) % cycle.length] ?? "none";
          S.slurmSortKey = next;
          S.slurmScrollOff = 0;
          S.slurmSelectedIdx = 0;
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
        S.selectedGpuIdx = gpuIndicesForNode(node)[0] ?? 0;
        if (node) void checkSudoForNode(node.node_alias);
        render();
      } else if (key.name === "tab" || key.sequence === "\t") {
        const tabs = buildDashboardTabs();
        const total = tabs.length;
        if (total > 1) {
          const delta = key.shift ? -1 : 1;
          S.activeClusterTabIdx = (S.activeClusterTabIdx + delta + total) % total;
          S.slurmSelectedIdx = 0;
          S.slurmScrollOff = 0;
          S.slurmSortKey = "none";
          S.slurmRunPopup = null;

          const nextTab = tabs[S.activeClusterTabIdx] ?? null;
          if (nextTab?.type === "slurm" && !S.slurmSnapshots[nextTab.idx]?.nodes?.length) {
            await loadSlurmData();
          }
        }
        render();
      } else if (key.name === "r") {
        S.isRefreshing = true; render();
        try {
          if (dashboardTab?.type === "slurm") {
            await loadSlurmData();
          } else {
            await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
          }
        } finally {
          S.isRefreshing = false;
        }
        render();
      } else if (key.name === "?" || key.name === "h") {
        await navigateToTab("help");
        render();
      }
      else if (key.name === "j") {
        await navigateToTab("jobs");
        render();
      } else if (key.name === "g" && !S.runnerFocused) {
        await navigateToTab("my-gpu-view");
        render();
      }

      if (S.screen === "my-gpu-view") {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
          return;
        }

        if (key.name === "up" || key.name === "k") {
          const bundles = S.myGpuViewState.bundles;
          if (bundles.length > 0) {
            S.myGpuViewState.selectedBundleIdx = (S.myGpuViewState.selectedBundleIdx - 1 + bundles.length) % bundles.length;
            render();
          }
          return;
        }

        if (key.name === "down" || key.name === "j") {
          const bundles = S.myGpuViewState.bundles;
          if (bundles.length > 0) {
            S.myGpuViewState.selectedBundleIdx = (S.myGpuViewState.selectedBundleIdx + 1) % bundles.length;
            render();
          }
          return;
        }

        if (key.name === "r") {
          S.isRefreshing = true; render();
          try {
            await Promise.all([pollAllClusters(), loadAllocations()]);
          } finally {
            S.isRefreshing = false;
          }
          render();
          return;
        }

        if (key.name.length === 1) {
          const bundles = S.myGpuViewState.bundles;
          const matchedIdx = bundles.findIndex(b => b.shortcut === key.name);
          if (matchedIdx >= 0) {
            S.myGpuViewState.selectedBundleIdx = matchedIdx;
            render();
          }
          return;
        }
      }
    } else if (S.screen === "detail") {
      const _detailSnap = activeDashboardSnapshot();
      const _detailNodeIdx = activeDashboardSelectedNodeIdx();
      if (key.name === "up" || (key.name === "k" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(S.selectedGpuIdx);
        if (pos > 0) {
          S.selectedGpuIdx = idxs[pos - 1]!;
          render();
        }
      } else if (key.name === "down" || (key.name === "j" && !key.shift)) {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        const idxs = gpuIndicesForNode(node);
        if (!idxs.length) return;

        const pos = idxs.indexOf(S.selectedGpuIdx);
        if (pos >= 0 && pos < idxs.length - 1) {
          S.selectedGpuIdx = idxs[pos + 1]!;
          render();
        }
      } else if (key.name === "return" || key.name === "a") {
        if (!requireAdminUI("allocate")) return;

        key.preventDefault();
        key.stopPropagation();

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        openAllocModal(node, S.selectedGpuIdx);
      } else if (key.name === "*") {
        if (!requireAdminUI("open-to-all")) return;

        key.preventDefault();
        key.stopPropagation();

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        try {
          await allocSet(node.node_alias, S.selectedGpuIdx, "*");
          setStatus(`Saved allocation: ${node.node_alias} GPU${S.selectedGpuIdx} → *`);
          await Promise.all([pollAllClusters(), loadAllocations()]);
          render();
        } catch (e: any) {
          setStatus(e?.message ? `Alloc failed: ${e.message}` : "Alloc failed");
        }
      } else if (key.name === "x") {
        if (!requireAdminUI("clear allocation")) return;

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        const existing = getAllocTarget(node.node_alias, S.selectedGpuIdx);
        if (!existing) return;
        try {
          await allocClear(node.node_alias, S.selectedGpuIdx);
          setStatus(`Cleared allocation: ${node.node_alias} GPU${S.selectedGpuIdx}`);
          await loadAllocations();
          render();
        } catch {}
      } else if (key.name === "k" && key.shift) {
        if (!requireAdminUI("kill")) return;

        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;
        const gi = node.gpus.find((g) => g.index === S.selectedGpuIdx);
        if (!gi) return;

        const violProcs = node.processes.filter(
          (p) => p.gpu_uuid === gi.uuid && isViolation(node.node_alias, gi.index, p.user)
        );
        if (!violProcs.length) return;

        S.killCtx = {
          nodeAlias: node.node_alias,
          gpuIdx: S.selectedGpuIdx,
          pids: violProcs.map((p) => p.pid),
          users: violProcs.map((p) => p.user),
        };
        S.killErrorMsg = "";
        S.killOutput = "";
        S.killInProgress = false;
        S.runnerFocused = false;
        S.runnerInputTyping = false;
        S.screen = "kill";
        render();
      } else if (key.name === "escape" || key.name === "backspace") {
        await navigateToTab("dashboard");
        render();
      } else if (key.name === "p") {
        if (!_detailSnap) return;
        const node = _detailSnap.nodes[_detailNodeIdx];
        if (!node || node.error) return;

        const isPinned = S.myGpuViewState.pinnedGpus.some(g => g.node === node.node_alias && g.gpu === S.selectedGpuIdx);
        if (isPinned) {
          S.myGpuViewState.pinnedGpus = S.myGpuViewState.pinnedGpus.filter(g => !(g.node === node.node_alias && g.gpu === S.selectedGpuIdx));
          setStatus(`Unpinned GPU: ${node.node_alias}:GPU${S.selectedGpuIdx}`);
        } else {
          S.myGpuViewState.pinnedGpus.push({ node: node.node_alias, gpu: S.selectedGpuIdx });
          setStatus(`Pinned GPU: ${node.node_alias}:GPU${S.selectedGpuIdx}`);
        }
        await saveMyGpuViewState();
        render();
      } else if (key.name === "r") {
        S.isRefreshing = true; render();
        try {
          await Promise.all([pollAllClusters(), loadAllocations(), loadSystemUsers(true)]);
        } finally {
          S.isRefreshing = false;
        }
        render();
      }
    } else if (S.screen === "kill") {
      if (key.name === "escape") {
        await navigateToTab("detail");
        S.killCtx = null;
        S.killErrorMsg = "";
        S.killOutput = "";
        render();
      } else if (key.name === "return" && !S.killInProgress) {
        if (!S.killCtx || !S.killCtx.pids.length) return;
        S.killInProgress = true;
        render();

        try {
          const { code, stdout, stderr } = await killPids(
            S.killCtx.nodeAlias,
            S.killCtx.pids
          );
          S.killOutput = stdout;
          if (code !== 0 && stderr.trim()) {
            S.killErrorMsg = stderr.trim().slice(0, 120);
          }
        } catch (e: any) {
          S.killErrorMsg = e?.message || String(e);
        }

        S.killInProgress = false;
        render();

        setTimeout(async () => {
          if (S.screen === "kill") {
            S.killCtx = null;
            S.killErrorMsg = "";
            S.killOutput = "";
            await navigateToTab("detail");
            await Promise.all([pollAllClusters(), loadAllocations()]);
            render();
          }
        }, 2000);
      }
    } else if (S.screen === "alloc") {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        await navigateToTab("detail");
        S.allocCtx = null;
        S.allocErrorMsg = "";
        S.allocUserListFocused = false;
        S.allocUserListIdx = 0;
        render();
      } else if (key.name === "left") {
        if (!S.allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          S.allocUserListFocused = true;
          S.allocUserListIdx = 0;
          render();
        }
      } else if (key.name === "right") {
        if (S.allocUserListFocused) {
          key.preventDefault();
          key.stopPropagation();
          S.allocUserListFocused = false;
          render();
          setTimeout(() => {
            const inputAny: any = container.findDescendantById("alloc-user-input");
            if (inputAny) inputAny.focus();
          }, 50);
        }
      } else if (key.name === "up" && S.allocUserListFocused) {
        key.preventDefault();
        S.allocUserListIdx = Math.max(S.allocUserListIdx - 1, 0);
        render();
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(S.allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "down" && S.allocUserListFocused) {
        key.preventDefault();
        const maxIdx = S.knownUsers.length - 1;
        S.allocUserListIdx = Math.min(S.allocUserListIdx + 1, maxIdx);
        render();
        setTimeout(() => {
          const scrollBox: any = container.findDescendantById("alloc-users-scroll");
          if (scrollBox?.scrollToChild) {
            scrollBox.scrollToChild(S.allocUserListIdx);
          }
        }, 50);
      } else if (key.name === "return" && S.allocUserListFocused) {
        key.preventDefault();
        key.stopPropagation();
        const selectedUser = S.knownUsers[S.allocUserListIdx];
        if (selectedUser) {
          S.allocDraftUser = selectedUser;
          S.allocUserListFocused = false;
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
        const current = String(inputAny?.value ?? S.allocDraftUser);

        const parts = current.split(",");
        const last = (parts.pop() || "").trim();
        const f = last.toLowerCase();
        const universe = S.knownUsers.length ? S.knownUsers : [];
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

          S.allocDraftUser = out.join(",");
          render();
        }
      } else if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        if (!S.allocCtx) {
          S.allocErrorMsg = "No allocation target";
          render();
          return;
        }

        const inputAny: any = container.findDescendantById("alloc-user-input");
        let user = String(inputAny?.value ?? "").trim();
        if (!user || user.toLowerCase() === "none") user = "*";
        S.allocDraftUser = user;

        try {
          await allocSet(S.allocCtx.nodeAlias, S.allocCtx.gpuIdx, user);
          setStatus(`Saved allocation: ${S.allocCtx.nodeAlias} GPU${S.allocCtx.gpuIdx} → ${user}`);
          S.allocCtx = null;
          S.allocErrorMsg = "";
          await Promise.all([pollAllClusters(), loadAllocations()]);
          await navigateToTab("detail");
          render();
        } catch (e: any) {
          S.allocErrorMsg = e?.message || String(e);
          render();
        }
      } else {
        if (S.allocTypingTimer) clearTimeout(S.allocTypingTimer);
        S.allocTypingTimer = setTimeout(() => {
          const inputAny: any = container.findDescendantById("alloc-user-input");
          S.allocDraftUser = String(inputAny?.value ?? "");
          render();
        }, 20);
      }
    } else if (S.screen === "help") {
      if (
        key.name === "escape" ||
        key.name === "backspace" ||
        key.name === "?" ||
        key.name === "q"
      ) {
        await navigateToTab("dashboard");
        render();
      }
    } else if (S.screen === "jobs") {
      if (S.jobDetailView && S.jobDetailLogView !== null) {
        if (key.name === "escape") {
          S.jobDetailLogView = null;
          S.jobDetailLogScroll = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          S.jobDetailLogScroll = Math.max(0, S.jobDetailLogScroll - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          S.jobDetailLogScroll++;
          render();
        } else if (key.name === "pageup") {
          S.jobDetailLogScroll = Math.max(0, S.jobDetailLogScroll - 20);
          render();
        } else if (key.name === "pagedown") {
          S.jobDetailLogScroll += 20;
          render();
        } else if (key.name === "r") {
          if (S.jobDetailLogSession) {
            S.jobDetailLogView = await captureTmuxPane(S.jobDetailLogSession);
            render();
          }
        }
      } else if (S.jobDetailView) {
        const sessionCount = Math.max(S.jobDetailView.tmux_sessions.length, S.jobDetailView.gpus.length);

        if (key.name === "escape" || key.name === "backspace") {
          S.jobDetailView = null;
          S.jobDetailSelectedCmd = 0;
          render();
        } else if (key.name === "up" || key.name === "k") {
          S.jobDetailSelectedCmd = Math.max(0, S.jobDetailSelectedCmd - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          S.jobDetailSelectedCmd = Math.min(sessionCount - 1, S.jobDetailSelectedCmd + 1);
          render();
        } else if (key.name === "return") {
          const session = S.jobDetailView.tmux_sessions[S.jobDetailSelectedCmd];
          if (session) {
            S.jobDetailLogSession = session;
            S.jobDetailLogScroll = 0;
            setStatus(`Loading log for ${session}...`);
            S.jobDetailLogView = await captureTmuxPane(session);
            const lines = S.jobDetailLogView.split("\n");
            const termHeight = process.stdout.rows || 40;
            S.jobDetailLogScroll = Math.max(0, lines.length - (termHeight - 4));
            render();
          } else {
            setStatus("No tmux session available for this GPU");
            render();
          }
        } else if (key.name === "c") {
          await cancelJobAction(S.jobDetailView);
          render();
        } else if (key.name === "r" && key.shift) {
          await retryJobAction(S.jobDetailView);
          render();
        } else if (key.name === "r") {
          await retrySelectedSessionAction(S.jobDetailView, S.jobDetailSelectedCmd);
          render();
        } else if (key.name === "x") {
          await cleanupTmuxSessionsAction(S.jobDetailView);
          render();
        }
      } else {
        if (key.name === "escape" || key.name === "backspace") {
          await navigateToTab("dashboard");
          render();
        } else if (key.name === "up" || key.name === "k") {
          S.selectedJobIdx = Math.max(0, S.selectedJobIdx - 1);
          render();
        } else if (key.name === "down" || key.name === "j") {
          S.selectedJobIdx = Math.min(S.jobList.length - 1, S.selectedJobIdx + 1);
          render();
        } else if (key.name === "return") {
          if (S.jobList.length > 0 && S.jobList[S.selectedJobIdx]) {
            S.jobDetailView = S.jobList[S.selectedJobIdx];
            S.jobDetailSelectedCmd = 0;
            S.jobDetailLogView = null;
            S.jobDetailLogScroll = 0;
            render();
            if (S.jobDetailView.status === "running" && S.jobDetailView.gpus.length > 0) {
              checkGpuLiveness(S.jobDetailView).then(() => render());
            }
          }
        } else if (key.name === "c") {
          if (S.jobList.length > 0 && S.jobList[S.selectedJobIdx]) {
            await cancelJobAction(S.jobList[S.selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && key.shift) {
          if (S.jobList.length > 0 && S.jobList[S.selectedJobIdx]) {
            await retryJobAction(S.jobList[S.selectedJobIdx]);
            render();
          }
        } else if (key.name === "r" && !key.shift) {
          setStatus("Refreshing jobs...");
          await loadJobsFromCLI();
          setStatus("Jobs refreshed", 1000);
          render();
        } else if (key.name === "d") {
          if (S.jobList.length > 0 && S.jobList[S.selectedJobIdx]) {
            await deleteJobAction(S.jobList[S.selectedJobIdx]);
            render();
          }
        } else if (key.name === "x") {
          if (S.jobList.length > 0 && S.jobList[S.selectedJobIdx]) {
            await cleanupTmuxSessionsAction(S.jobList[S.selectedJobIdx]);
            render();
          }
        }
      }
    } else if (S.screen === "setup") {
      if (S.setupEditingField) {
        const fieldOrder: Array<"env_manager" | "env_name" | "work_dir"> = ["env_manager", "env_name", "work_dir"];
        const currentFieldIdx = fieldOrder.indexOf(S.setupEditingField);

        if (key.name === "escape") {
          S.setupEditingField = null;
          S.setupEditBuffer = "";
          render();
        } else if (key.name === "return") {
          const node = S.setupNodes[S.setupSelectedIdx];
          if (node) {
            node[S.setupEditingField] = S.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          S.setupEditingField = null;
          S.setupEditBuffer = "";
          render();
        } else if (key.name === "tab" || key.name === "down") {
          const node = S.setupNodes[S.setupSelectedIdx];
          if (node) {
            node[S.setupEditingField] = S.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx < fieldOrder.length - 1) {
            S.setupEditingField = fieldOrder[currentFieldIdx + 1];
            S.setupEditBuffer = node?.[S.setupEditingField] || "";
          } else {
            S.setupEditingField = null;
            S.setupEditBuffer = "";
          }
          render();
        } else if (key.name === "up") {
          const node = S.setupNodes[S.setupSelectedIdx];
          if (node) {
            node[S.setupEditingField] = S.setupEditBuffer.trim();
            markSetupNodeDirty(node);
          }
          if (currentFieldIdx > 0) {
            S.setupEditingField = fieldOrder[currentFieldIdx - 1];
            S.setupEditBuffer = node?.[S.setupEditingField] || "";
          } else {
            S.setupEditingField = null;
            S.setupEditBuffer = "";
          }
          render();
        } else if (key.name === "backspace") {
          S.setupEditBuffer = S.setupEditBuffer.slice(0, -1);
          render();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          S.setupEditBuffer += key.sequence;
          render();
        }
      } else {
        if (key.name === "up") {
          S.setupSelectedIdx = Math.max(0, S.setupSelectedIdx - 1);
          render();
        } else if (key.name === "down") {
          S.setupSelectedIdx = Math.min(S.setupNodes.length - 1, S.setupSelectedIdx + 1);
          render();
        } else if (key.name === "return") {
          S.setupEditingField = "env_manager";
          S.setupEditBuffer = S.setupNodes[S.setupSelectedIdx]?.env_manager || "";
          render();
        } else if (key.name === "escape") {
          await navigateToTab("dashboard");
          render();
        } else if (key.sequence === "s" || key.sequence === "S") {
          const node = S.setupNodes[S.setupSelectedIdx];
          if (node) {
            const ok = await saveSetupNode(node);
            if (ok) {
              S.setupDirtyAliases.delete(node.alias);
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
