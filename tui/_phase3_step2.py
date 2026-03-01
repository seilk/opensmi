#!/usr/bin/env python3
"""
Phase 3 Step 2: Replace render function bodies in index.ts with thin wrappers
that delegate to extracted modules via a state-sync bridge.
"""

import re
import shutil
from pathlib import Path
from collections import defaultdict

WORK_DIR = Path(__file__).parent
INDEX_TS = WORK_DIR / "index.ts"
BACKUP   = WORK_DIR / "index.ts.backup"

# Ensure backup exists
if not BACKUP.exists():
    shutil.copy(INDEX_TS, BACKUP)
    print(f"[phase3] Created backup: {BACKUP}")
else:
    print(f"[phase3] Backup already exists: {BACKUP}")

# Always work from backup to ensure idempotency
source = BACKUP.read_text(encoding="utf-8")
lines  = source.splitlines(keepends=True)
print(f"[phase3] Read {len(lines)} lines from backup")

def find_function_range(lines, func_name):
    """Find 0-based (start, end) for 'function funcName(...)'. Returns None if not found."""
    pattern = re.compile(r'^\s*(?:async\s+)?function\s+' + re.escape(func_name) + r'\s*\(')
    start_idx = None
    for i, line in enumerate(lines):
        if pattern.match(line):
            start_idx = i
            break
    if start_idx is None:
        return None
    brace_depth = 0
    body_started = False
    for i in range(start_idx, len(lines)):
        for ch in lines[i]:
            if ch == '{':
                brace_depth += 1
                body_started = True
            elif ch == '}':
                brace_depth -= 1
                if body_started and brace_depth == 0:
                    return (start_idx, i)
    return None

# Functions to replace: (name, sig_params, call_params, module_path)
FUNCTIONS_TO_REPLACE = [
    ("renderGlobalTabBar",      "",                       "",             "./src/components/Layout"),
    ("renderGlobalFooter",      "",                       "",             "./src/components/Layout"),
    ("renderToast",             "",                       "",             "./src/components/Layout"),
    ("renderTabSwitcher",       "",                       "",             "./src/components/Layout"),
    ("renderLoadingBadge",      "",                       "",             "./src/views/Dashboard"),
    ("renderDashboard",         "",                       "",             "./src/views/Dashboard"),
    ("renderSrunPopup",         "popup: SlurmRunPopup",   "popup",        "./src/views/Dashboard"),
    ("renderSlurmClusterTab",   "slurmIdx: number",       "slurmIdx",     "./src/views/Dashboard"),
    ("renderDetail",            "",                       "",             "./src/views/Detail"),
    ("renderHelp",              "",                       "",             "./src/views/Detail"),
    ("renderKill",              "",                       "",             "./src/views/Detail"),
    ("renderJobsView",          "",                       "",             "./src/views/Jobs"),
    ("renderJobsListView",      "",                       "",             "./src/views/Jobs"),
    ("renderJobDetailView",     "",                       "",             "./src/views/Jobs"),
    ("renderMyGpuView",         "",                       "",             "./src/views/MyGpus"),
    ("renderAlloc",             "",                       "",             "./src/components/AllocModal"),
    ("renderGpuAssignmentPanel","",                       "",             "./src/components/Runner"),
    ("renderRunnerPane",        "",                       "",             "./src/components/Runner"),
    ("renderSetupView",         "",                       "",             "./src/views/Setup"),
]

# Collect replacements
replacements = []
working_lines = list(lines)

for func_name, sig_params, call_params, module_path in FUNCTIONS_TO_REPLACE:
    result = find_function_range(working_lines, func_name)
    if result is None:
        print(f"[phase3] WARNING: Could not find function '{func_name}' — skipping")
        continue
    start, end = result
    print(f"[phase3] Found {func_name}: lines {start+1}-{end+1} ({end-start+1} lines)")
    alias = f"_mod_{func_name}"
    sig = f"({sig_params})"
    call = f"({call_params})"
    stub = (
        f"function {func_name}{sig} {{\n"
        f"  syncStateToS();\n"
        f"  const _r = {alias}{call};\n"
        f"  syncStateFromS();\n"
        f"  return _r;\n"
        f"}}\n"
    )
    replacements.append((start, end, stub))

# Apply replacements in reverse order
replacements.sort(key=lambda x: x[0], reverse=True)
for start, end, stub in replacements:
    working_lines[start:end+1] = [stub]
print(f"[phase3] Applied {len(replacements)} function replacements")

# Build import block
module_to_funcs = defaultdict(list)
for func_name, _, _, module_path in FUNCTIONS_TO_REPLACE:
    module_to_funcs[module_path].append(func_name)

import_block = ["// ── Extracted Module Imports (Phase 3 Step 2) ──\n"]
import_block.append("import { S as _S_module } from \"./src/state/global\";\n")
for mod_path in sorted(module_to_funcs.keys()):
    funcs = module_to_funcs[mod_path]
    aliases = ", ".join(f"{f} as _mod_{f}" for f in funcs)
    import_block.append(f"import {{ {aliases} }} from \"{mod_path}\";\n")
import_block.append("\n")

# State variables to sync
# Variables that are `const` in index.ts and cannot be reassigned:
#   - runnerMinHeight, runnerMaxHeight: constants (never change) → skip from sync entirely
#   - myGpuViewState: const object → use Object.assign in syncStateFromS
CONST_OBJECT_VARS = {"myGpuViewState"}   # Object.assign approach
SKIP_FROM_SYNC    = {"runnerMinHeight", "runnerMaxHeight"}  # constants, never reassigned

STATE_VARS = [
    "appVersion", "latestVersion",
    "snapshot", "extraSnapshots", "extraPollErrors", "extraClusterNames",
    "extraSelectedNodeIdx", "activeClusterTabIdx",
    "allocations", "gpuIdleStart", "lastPollTime", "pollError",
    "isPolling", "bootLoading",
    "selectedNodeIdx", "selectedGpuIdx", "screen",
    "tabSwitcherOpen", "tabSwitcherIdx",
    "lastGpuClickKey", "lastGpuClickAt", "lastNodeClickKey", "lastNodeClickAt",
    "allocCtx", "allocUserListFocused", "allocUserListIdx",
    "allocDraftUser", "allocErrorMsg", "allocTypingTimer",
    "allocUserHighlight", "lastAllocUserClickKey", "lastAllocUserClickAt",
    "killCtx", "killErrorMsg", "killOutput", "killInProgress",
    "prefixKeyPressed", "prefixKeyTimeout",
    "runnerPaneFolded", "runnerFocused", "runnerInputTyping", "runnerInputBuffer",
    "runnerFocusedInputIdx", "runnerMouseDownTime", "runnerMouseDownPos",
    "runnerOpen", "runnerHeight", "runnerMaximized",
    "launchCommand", "launchNumGpus", "launchErrorMsg", "launchErrorTimeout",
    "launchOutput", "launchSelectedGpus", "launchMode", "launchTmuxSession",
    "launchDistMode", "launchCommands", "launchGpuMode", "launchManualGpus",
    "launchExcludedGpus", "launchSelectionReasoning", "launchSourceBundle",
    "launchQueueMode",
    "runnerState", "runnerStartTime", "runnerStderr", "runnerAttachCmd",
    "runnerTmuxSession", "runnerPreflight",
    "isAdmin", "adminHint", "sudoInfoMsg", "sudoOkByNode", "sudoCheckingByNode",
    "myGpuViewState",
    "statusMsg", "statusMsgTimeout", "statusUntil",
    "systemUsers", "systemUsersLoadedAt", "knownUsers",
    "requestRender",
    "jobList", "selectedJobIdx", "jobDetailView", "jobDetailSelectedCmd",
    "jobDetailLogView", "jobDetailLogSession", "jobDetailLogScroll", "jobsLastLoadTime",
    "setupNodes", "setupSelectedIdx", "setupEditingField", "setupEditBuffer",
    "setupMessage", "setupMessageTimeout", "setupDirtyAliases",
    "slurmSnapshots", "slurmClusterConfigNames", "slurmLoading", "slurmError",
    "slurmSelectedIdx", "slurmScrollOff", "slurmSortKey", "slurmRunPopup",
    "_slurmLastClickNode", "_slurmLastClickTime",
    "nodeCancelStatus",
    "_renderHook", "isDispatching",
]

sync_to_lines = []
sync_to_lines.append("// ── State sync bridge (Phase 3 Step 2) ──────────────────────────────────────\n")
sync_to_lines.append("// Copies bare module-level globals → S before module render calls,\n")
sync_to_lines.append("// and S → bare globals after. Remove in Phase 4 when index.ts uses S directly.\n")
sync_to_lines.append("function syncStateToS(): void {\n")
for v in STATE_VARS:
    if v in SKIP_FROM_SYNC:
        continue
    sync_to_lines.append(f"  (_S_module as any).{v} = {v};\n")
sync_to_lines.append("}\n")

sync_from_lines = []
sync_from_lines.append("function syncStateFromS(): void {\n")
for v in STATE_VARS:
    if v in SKIP_FROM_SYNC:
        continue
    if v in CONST_OBJECT_VARS:
        # Can't reassign const; copy properties instead
        sync_from_lines.append(f"  Object.assign({v}, (_S_module as any).{v});\n")
    else:
        sync_from_lines.append(f"  {v} = (_S_module as any).{v};\n")
sync_from_lines.append("}\n\n")

sync_block = "".join(sync_to_lines) + "".join(sync_from_lines)

# Find insertion point for imports (after the last `import` line)
last_import_line = 0
for i, line in enumerate(working_lines):
    stripped = line.strip()
    if stripped.startswith("import ") or stripped.startswith("import{"):
        last_import_line = i
print(f"[phase3] Last import at line {last_import_line + 1}")
working_lines.insert(last_import_line + 1, "".join(import_block))

# Find insertion point for sync functions (before first render function stub)
sync_insert_idx = None
first_render_pattern = re.compile(r'^function render\w+\s*\(')
for i, line in enumerate(working_lines):
    if first_render_pattern.match(line):
        sync_insert_idx = i
        break
if sync_insert_idx is None:
    for i, line in enumerate(working_lines):
        if line.strip().startswith("async function main()"):
            sync_insert_idx = i
            break
if sync_insert_idx is None:
    sync_insert_idx = len(working_lines) - 1
print(f"[phase3] Inserting sync functions before line {sync_insert_idx + 1}")
working_lines.insert(sync_insert_idx, sync_block)

# Write result
result = "".join(working_lines)
INDEX_TS.write_text(result, encoding="utf-8")
final_lines = result.count("\n")
print(f"[phase3] Written. Lines: {len(lines)} → {final_lines} (saved {len(lines) - final_lines})")
print("[phase3] Done.")
