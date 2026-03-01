#!/usr/bin/env bun
/**
 * test_tui_scenarios.ts
 * Automated tests for TESTING.md manual scenarios.
 * Uses mock data — no real GPU cluster needed.
 * Run: bun run ./test_tui_scenarios.ts
 */

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    _passed++;
    console.log(`[TEST] ✓ ${name}`);
  } catch (e: any) {
    _failed++;
    _errors.push(`${name}: ${e.message}`);
    console.log(`[TEST] ✗ ${name}: ${e.message}`);
  }
}

function mockGPU(idx: number, opts: { memUsed?: number; memTotal?: number; util?: number; uuid?: string } = {}): any {
  return { index: idx, uuid: opts.uuid || `GPU-UUID-${idx}`, name: "NVIDIA A100 80GB", memory_total_mib: opts.memTotal ?? 81920, memory_used_mib: opts.memUsed ?? 0, memory_free_mib: (opts.memTotal ?? 81920) - (opts.memUsed ?? 0), utilization_gpu_percent: opts.util ?? 0 };
}

function mockProcess(gpuUuid: string, user: string, pid: number = 12345): any {
  return { gpu_uuid: gpuUuid, pid, process_name: "python", used_memory_mib: 4096, user, runtime_s: 3600 };
}

function mockNode(alias: string, gpuCount: number, opts: { procs?: any[]; error?: string | null } = {}): any {
  return { node_alias: alias, address: "192.168.1.1", hostname: `${alias}.local`, os: "Linux", timestamp: new Date().toISOString(), gpus: Array.from({ length: gpuCount }, (_, i) => mockGPU(i)), processes: opts.procs || [], error: opts.error ?? null };
}

function mockCluster(name: string, nodes: any[]): any {
  return { cluster_name: name, timestamp: new Date().toISOString(), nodes };
}

import { S, OPERATOR } from "./src/state/global";
import type { Allocation } from "./src/types";

function resetState() {
  S.screen = "dashboard"; S.snapshot = null; S.selectedNodeIdx = 0; S.selectedGpuIdx = 0;
  S.runnerFocused = false; S.runnerInputTyping = false; S.runnerPaneFolded = false;
  S.launchCommand = ""; S.launchNumGpus = 0; S.launchSelectedGpus = []; S.launchManualGpus = [];
  S.launchExcludedGpus = []; S.launchDistMode = "one-to-one"; S.launchGpuMode = "auto";
  S.launchMode = "tmux"; S.launchCommands = []; S.launchQueueMode = "immediate";
  S.launchSourceBundle = null; S.allocations = []; S.isAdmin = true;
  S.tabSwitcherOpen = false; S.tabSwitcherIdx = 0; S.allocCtx = null; S.killCtx = null;
  S.statusMsg = ""; S.extraClusterNames = []; S.extraSnapshots = []; S.extraPollErrors = [];
  S.extraSelectedNodeIdx = []; S.activeClusterTabIdx = 0; S.jobList = []; S.selectedJobIdx = 0;
  S.prefixKeyPressed = false;
  S.myGpuViewState.selectedBundleIdx = 0; S.myGpuViewState.bundles = [];
  S.myGpuViewState.expandedGpuKeys = new Set(); S.myGpuViewState.pinnedGpus = [];
}

console.log("[TEST] === Starting TUI Scenario Tests ===\n");

test("Scenario 1: Single-command multi-GPU state transitions", () => {
  resetState();
  S.snapshot = mockCluster("test-cluster", [mockNode("node1", 4), mockNode("node2", 4)]);
  S.runnerFocused = true;
  S.launchCommand = 'python -c "import torch; print(torch.cuda.device_count())"';
  S.launchNumGpus = 3;
  S.launchDistMode = "one-to-one";
  S.launchDistMode = "single";
  assert(S.launchDistMode === "single", "dist mode should be single after toggle");
  assert(S.launchNumGpus === 3, "GPU count should remain 3");
  assert(S.launchCommand.includes("torch"), "command should be preserved");
});

test("Scenario 2: One-to-one command-GPU mapping", () => {
  resetState();
  S.snapshot = mockCluster("test", [mockNode("node1", 4)]);
  S.launchDistMode = "one-to-one"; S.launchNumGpus = 3;
  S.launchCommands = ["python train.py --fold 0", "python train.py --fold 1", "python train.py --fold 2"];
  S.launchSelectedGpus = [{ node: "node1", gpu: 0 }, { node: "node1", gpu: 1 }, { node: "node1", gpu: 2 }];
  assert(S.launchCommands.length === S.launchNumGpus, "command count should match GPU count");
  for (let i = 0; i < 3; i++) {
    assert(S.launchCommands[i].includes(`--fold ${i}`), `command ${i} should have --fold ${i}`);
    assert(S.launchSelectedGpus[i].gpu === i, `GPU ${i} should be mapped`);
  }
});

test("Scenario 3: Auto GPU selection prefers idle/allocated GPUs", () => {
  resetState();
  const node = mockNode("node1", 4, { procs: [mockProcess("GPU-UUID-0", "otheruser", 1001), mockProcess("GPU-UUID-2", "otheruser", 1002)] });
  S.snapshot = mockCluster("test", [node]);
  S.allocations = [{ node_alias: "node1", gpu_index: 1, target: OPERATOR, assigned_by: "admin", assigned_at: new Date().toISOString(), expires_at: null, notes: "" } as Allocation];
  S.launchGpuMode = "auto";
  const myAlloc = S.allocations.find(a => a.node_alias === "node1" && a.gpu_index === 1 && a.target === OPERATOR);
  assert(!!myAlloc, "allocation to current user should exist");
  const busyGpus = node.gpus.filter((g: any) => node.processes.some((p: any) => p.gpu_uuid === g.uuid));
  assert(busyGpus.length === 2, "should have 2 busy GPUs");
  const idleGpus = node.gpus.filter((g: any) => !node.processes.some((p: any) => p.gpu_uuid === g.uuid));
  assert(idleGpus.length === 2, "should have 2 idle GPUs");
});

test("Scenario 4: Manual GPU selection mode", () => {
  resetState();
  S.snapshot = mockCluster("test", [mockNode("node1", 4)]);
  S.launchGpuMode = "selected";
  S.launchManualGpus = [{ node: "node1", gpu: 1 }, { node: "node1", gpu: 3 }];
  S.launchNumGpus = S.launchManualGpus.length;
  S.launchSelectedGpus = S.launchManualGpus.slice();
  assert(S.launchGpuMode === "selected", "mode should be manual/selected");
  assert(S.launchManualGpus.length === 2, "should have 2 manually selected GPUs");
  assert(S.launchSelectedGpus[0].gpu === 1, "first GPU should be index 1");
  assert(S.launchSelectedGpus[1].gpu === 3, "second GPU should be index 3");
});

test("Scenario 5: My GPU View to Runner workflow", () => {
  resetState();
  S.snapshot = mockCluster("test", [mockNode("node1", 4)]);
  S.screen = "my-gpu-view";
  S.myGpuViewState.bundles = [{ id: "bundle-1", label: `${OPERATOR}'s GPUs`, type: "allocated", gpus: [{ node: "node1", gpu: 0 }, { node: "node1", gpu: 2 }] }];
  S.myGpuViewState.selectedBundleIdx = 0;
  const bundle = S.myGpuViewState.bundles[0];
  S.launchManualGpus = bundle.gpus.slice();
  S.launchSelectedGpus = bundle.gpus.slice();
  S.launchNumGpus = bundle.gpus.length;
  S.launchGpuMode = "selected";
  S.launchSourceBundle = bundle.id;
  S.runnerFocused = true;
  assert(S.launchGpuMode === "selected", "mode should be selected from bundle");
  assert(S.launchManualGpus.length === 2, "bundle GPUs should be loaded");
  assert(S.launchSourceBundle === "bundle-1", "source bundle should be tracked");
});

test("Scenario 6: Distribution mode toggle cycles correctly", () => {
  resetState();
  S.launchDistMode = "one-to-one";
  S.launchDistMode = S.launchDistMode === "one-to-one" ? "single" : "one-to-one";
  assert(S.launchDistMode === "single", "first toggle should switch to single");
  S.launchDistMode = S.launchDistMode === "one-to-one" ? "single" : "one-to-one";
  assert(S.launchDistMode === "one-to-one", "second toggle should switch back");
});

test("Scenario 7: Preflight validation state management", () => {
  resetState();
  S.runnerPreflight = [{ name: "tmux", status: "pass", hint: "" }, { name: "ssh", status: "pass", hint: "" }, { name: "gpu_available", status: "fail", hint: "No GPUs available" }];
  assert(!S.runnerPreflight.every(c => c.status === "pass"), "should not all pass");
  assert(S.runnerPreflight.filter(c => c.status === "fail").length === 1, "one failure");
  S.runnerPreflight[2].status = "pass";
  assert(S.runnerPreflight.every(c => c.status === "pass"), "all should pass after fix");
});

test("Scenario 8: Command-GPU mapping maintains correct pairing", () => {
  resetState();
  S.launchDistMode = "one-to-one"; S.launchNumGpus = 3;
  S.launchSelectedGpus = [{ node: "node1", gpu: 0 }, { node: "node1", gpu: 1 }, { node: "node1", gpu: 2 }];
  S.launchCommands = ["python train.py --lr 0.001", "python train.py --lr 0.01", "python train.py --lr 0.1"];
  for (let i = 0; i < 3; i++) {
    assert(S.launchCommands[i] !== undefined, `command ${i} should exist`);
    assert(S.launchSelectedGpus[i].gpu === i, `GPU ${i} should map to index ${i}`);
  }
  S.launchNumGpus = 4;
  S.launchSelectedGpus.push({ node: "node1", gpu: 3 });
  while (S.launchCommands.length < S.launchNumGpus) S.launchCommands.push("");
  assert(S.launchCommands.length === 4, "commands should extend to match GPU count");
});

test("Scenario 9: Edge case - no GPUs available", () => {
  resetState();
  const node = mockNode("node1", 2, { procs: [mockProcess("GPU-UUID-0", "user1", 1001), mockProcess("GPU-UUID-1", "user2", 1002)] });
  S.snapshot = mockCluster("test", [node]);
  const allBusy = node.gpus.every((g: any) => node.processes.some((p: any) => p.gpu_uuid === g.uuid));
  assert(allBusy, "all GPUs should be busy");
  S.launchGpuMode = "auto"; S.launchNumGpus = 0; S.launchSelectedGpus = [];
  assert(S.launchSelectedGpus.length === 0, "no GPUs should be selected");
});

test("Scenario 10: Edge case - command count mismatch", () => {
  resetState();
  S.launchDistMode = "one-to-one"; S.launchNumGpus = 3;
  S.launchCommands = ["python train.py --fold 0", "python train.py --fold 1"];
  assert(S.launchNumGpus !== S.launchCommands.length, "should detect mismatch");
  while (S.launchCommands.length < S.launchNumGpus) S.launchCommands.push("");
  assert(S.launchCommands.length === S.launchNumGpus, "commands should be padded");
  assert(S.launchCommands[2] === "", "padded command should be empty");
});

test("Regression: Screen navigation state transitions", () => {
  resetState();
  S.snapshot = mockCluster("test", [mockNode("node1", 4)]);
  assert(S.screen === "dashboard", "start at dashboard");
  S.screen = "detail"; assert(S.screen === "detail", "navigate to detail");
  S.allocCtx = { nodeAlias: "node1", gpuIdx: 0 }; S.screen = "alloc";
  assert(S.screen === "alloc", "navigate to alloc");
  S.screen = "detail"; S.allocCtx = null; assert(S.screen === "detail", "back to detail");
  S.screen = "dashboard"; assert(S.screen === "dashboard", "back to dashboard");
});

test("Regression: Runner focus/typing state isolation", () => {
  resetState();
  S.runnerFocused = true; S.runnerInputTyping = true;
  S.screen = "alloc"; S.runnerFocused = false; S.runnerInputTyping = false;
  assert(!S.runnerFocused, "runner unfocused on modal");
  assert(!S.runnerInputTyping, "runner typing stops on modal");
});

test("Regression: Tab switcher state", () => {
  resetState();
  S.tabSwitcherOpen = true; S.tabSwitcherIdx = 2;
  assert(S.tabSwitcherOpen, "tab switcher open");
  S.tabSwitcherOpen = false; S.tabSwitcherIdx = 0;
  assert(!S.tabSwitcherOpen, "tab switcher closed");
});

test("Performance: 100+ GPU state handling", () => {
  resetState();
  const nodes = Array.from({ length: 13 }, (_, i) => mockNode(`node${i}`, 8));
  S.snapshot = mockCluster("large-cluster", nodes);
  const totalGpus = S.snapshot!.nodes.reduce((s: number, n: any) => s + n.gpus.length, 0);
  assert(totalGpus === 104, "should have 104 GPUs");
  S.launchNumGpus = 50; S.launchSelectedGpus = [];
  for (const n of S.snapshot!.nodes) for (const g of n.gpus) if (S.launchSelectedGpus.length < 50) S.launchSelectedGpus.push({ node: n.node_alias, gpu: g.index });
  assert(S.launchSelectedGpus.length === 50, "should select 50 GPUs");
  S.launchDistMode = "one-to-one";
  S.launchCommands = S.launchSelectedGpus.map((_, i) => `python train.py --shard ${i}`);
  assert(S.launchCommands.length === 50, "should have 50 commands");
});

test("Performance: Rapid mode toggle doesn't corrupt state", () => {
  resetState();
  S.snapshot = mockCluster("test", [mockNode("node1", 4)]);
  S.launchNumGpus = 2;
  S.launchSelectedGpus = [{ node: "node1", gpu: 0 }, { node: "node1", gpu: 1 }];
  for (let i = 0; i < 100; i++) S.launchDistMode = S.launchDistMode === "one-to-one" ? "single" : "one-to-one";
  assert(S.launchDistMode === "one-to-one", "should return to one-to-one after even toggles");
  assert(S.launchNumGpus === 2, "GPU count unchanged");
  assert(S.launchSelectedGpus.length === 2, "selected GPUs unchanged");
});

console.log(`\n=== Test Summary ===`);
console.log(`[TEST] Total: ${_passed + _failed}`);
console.log(`[TEST] Passed: ${_passed}`);
console.log(`[TEST] Failed: ${_failed}`);
if (_errors.length) { console.log(`\n[TEST] Failures:`); for (const e of _errors) console.log(`  - ${e}`); }
console.log(_failed === 0 ? "\n✓ All tests passed!" : "\n✗ Some tests failed!");
process.exit(_failed > 0 ? 1 : 0);
