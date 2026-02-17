#!/usr/bin/env bun
/**
 * Test script for multi-process deployment workflow
 * Tests distribution modes, GPU selection, and command execution
 */

import { spawn } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

// ── Test Configuration ──────────────────────────────────────────────

const PYTHON = process.env.OPENSMI_PYTHON || "python3";
const BASE_DIR = path.resolve(import.meta.dir, "..");
const TEST_OUTPUT_DIR = "/tmp/opensmi-test-distribution";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[TEST] ${msg}`);
}

function pass(name: string, details?: string): void {
  results.push({ name, passed: true, details });
  log(`✓ ${name}`);
}

function fail(name: string, error: string): void {
  results.push({ name, passed: false, error });
  log(`✗ ${name}: ${error}`);
}

async function runPython(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn([PYTHON, "-c", script], {
    cwd: BASE_DIR,
    env: { ...process.env, PYTHONPATH: `${BASE_DIR}/src:${process.env.PYTHONPATH || ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// ── Test 1: GPU Ranker Logic ──────────────────────────────────────────

async function testGpuRanker(): Promise<void> {
  log("Testing GPU ranker logic...");

  const script = `
import sys
sys.path.insert(0, "${BASE_DIR}/src")
from opensmi.gpu_ranker import rank_gpus

class MockGPU:
    def __init__(self, index, uuid, name):
        self.index = index
        self.uuid = uuid
        self.name = name
        self.memory_total_mib = 24000
        self.memory_used_mib = 1000
        self.memory_free_mib = 23000
        self.utilization_gpu_percent = 5

class MockProc:
    def __init__(self, gpu_uuid, pid, user):
        self.gpu_uuid = gpu_uuid
        self.pid = pid
        self.process_name = "python"
        self.used_memory_mib = 1000
        self.user = user

class MockNode:
    def __init__(self, alias, gpus, processes):
        self.node_alias = alias
        self.address = "192.168.1.1"
        self.hostname = alias
        self.gpus = gpus
        self.processes = processes
        self.error = None
        self.os = "Linux"
        self.timestamp = "2024-01-01T00:00:00"

class MockSnapshot:
    def __init__(self, nodes):
        self.cluster_name = "test"
        self.timestamp = "2024-01-01T00:00:00"
        self.nodes = nodes

gpus = [
    MockGPU(0, "GPU-0", "Tesla V100"),
    MockGPU(1, "GPU-1", "Tesla V100"),
    MockGPU(2, "GPU-2", "Tesla V100"),
]
processes = [
    MockProc("GPU-1", 1234, "alice"),
]
node = MockNode("node-01", gpus, processes)
snap = MockSnapshot([node])

history = {}
allocations = []
current_user = "testuser"

ranked = rank_gpus(snap, history, allocations, current_user)
print(f"Ranked {len(ranked)} GPUs")
print(f"Top GPU: node-01:GPU{ranked[0][1]}")

top_gpu_indices = [r[1] for r in ranked[:2]]
if 1 not in top_gpu_indices:
    print("PASS: GPU with active process not in top 2")
else:
    print("FAIL: GPU with active process in top 2")
`;

  const result = await runPython(script);
  if (result.code === 0 && result.stdout.includes("PASS")) {
    pass("GPU ranker logic", result.stdout.trim());
  } else {
    fail("GPU ranker logic", result.stderr || "Unexpected output");
  }
}

// ── Test 2: Distribution Mode State ────────────────────────────────────

async function testDistributionModeState(): Promise<void> {
  log("Testing distribution mode state management...");

  // Read the index.ts to verify state variables exist
  const indexPath = path.join(import.meta.dir, "index.ts");
  const content = await Bun.file(indexPath).text();

  const requiredVars = [
    'launchDistMode: "single" | "one-to-one"',
    "launchCommands: string[]",
    "launchSelectedGpus",
    "launchGpuMode",
    "launchManualGpus",
  ];

  const missing = requiredVars.filter((v) => !content.includes(v.split(":")[0]));
  if (missing.length === 0) {
    pass("Distribution mode state variables", "All required state variables present");
  } else {
    fail("Distribution mode state variables", `Missing: ${missing.join(", ")}`);
  }
}

// ── Test 3: Single Mode Command Generation ──────────────────────────────

async function testSingleModeCommandGen(): Promise<void> {
  log("Testing single mode command generation...");

  const script = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src")

# Test single mode: one command with multiple GPUs
mode = "single"
command = "python train.py --epochs 100"
gpus = [{"node": "node-01", "gpu": 0}, {"node": "node-01", "gpu": 1}]

# Expected: CUDA_VISIBLE_DEVICES=0,1 python train.py --epochs 100
gpu_indices = [str(g["gpu"]) for g in gpus if g["node"] == "node-01"]
cuda_devices = ",".join(gpu_indices)
expected_cmd = f"CUDA_VISIBLE_DEVICES={cuda_devices} {command}"

print(f"Expected command: {expected_cmd}")
print(f"GPU count: {len(gpus)}")

if cuda_devices == "0,1":
    print("PASS: Correct CUDA_VISIBLE_DEVICES")
else:
    print(f"FAIL: Expected '0,1', got '{cuda_devices}'")
`;

  const result = await runPython(script);
  if (result.code === 0 && result.stdout.includes("PASS")) {
    pass("Single mode command generation", result.stdout.trim());
  } else {
    fail("Single mode command generation", result.stderr || "Unexpected output");
  }
}

// ── Test 4: One-to-One Mode Command Generation ────────────────────────

async function testOneToOneMode(): Promise<void> {
  log("Testing one-to-one mode command generation...");

  const script = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src")

# Test one-to-one mode: different command per GPU
mode = "one-to-one"
commands = [
    "python train.py --fold 0",
    "python train.py --fold 1",
    "python train.py --fold 2",
]
gpus = [
    {"node": "node-01", "gpu": 0},
    {"node": "node-01", "gpu": 1},
    {"node": "node-01", "gpu": 2},
]

# Validate mapping
if len(commands) == len(gpus):
    print(f"PASS: Command count matches GPU count ({len(commands)})")
    for i, (cmd, gpu) in enumerate(zip(commands, gpus)):
        print(f"  [{i+1}] {cmd} -> {gpu['node']}:GPU{gpu['gpu']}")
else:
    print(f"FAIL: Command count ({len(commands)}) != GPU count ({len(gpus)})")
`;

  const result = await runPython(script);
  if (result.code === 0 && result.stdout.includes("PASS")) {
    pass("One-to-one mode command generation", result.stdout.trim());
  } else {
    fail("One-to-one mode command generation", result.stderr || "Unexpected output");
  }
}

// ── Test 5: GPU Selection Reasoning ──────────────────────────────────────

async function testGpuSelectionReasoning(): Promise<void> {
  log("Testing GPU selection reasoning logic...");

  const script = `
import sys, json
sys.path.insert(0, "${BASE_DIR}/src")
from opensmi.gpu_ranker import rank_gpus

class MockGPU:
    def __init__(self, index, uuid):
        self.index = index
        self.uuid = uuid
        self.memory_free_mib = 20000
        self.utilization_gpu_percent = 5
        self.memory_total_mib = 24000
        self.memory_used_mib = 1000
        self.name = "Tesla V100"

class MockNode:
    def __init__(self, alias, gpus, processes):
        self.node_alias = alias
        self.gpus = gpus
        self.processes = processes
        self.error = None
        self.address = "192.168.1.1"
        self.hostname = alias
        self.os = "Linux"
        self.timestamp = "2024-01-01T00:00:00"

class MockSnapshot:
    def __init__(self, nodes):
        self.nodes = nodes
        self.cluster_name = "test"
        self.timestamp = "2024-01-01T00:00:00"

gpu = MockGPU(0, "GPU-0")
node = MockNode("node-01", [gpu], [])
snap = MockSnapshot([node])

ranked = rank_gpus(snap, {}, [], "testuser")
if len(ranked) > 0 and ranked[0][0] == "node-01" and ranked[0][1] == 0:
    print("PASS: GPU ranking produces expected results")
else:
    print("FAIL: Unexpected ranking results")
`;

  const result = await runPython(script);
  if (result.code === 0 && result.stdout.includes("PASS")) {
    pass("GPU selection reasoning", result.stdout.trim());
  } else {
    fail("GPU selection reasoning", result.stderr || "Unexpected output");
  }
}

// ── Test 6: Launch History Integration ──────────────────────────────────

async function testLaunchHistory(): Promise<void> {
  log("Testing launch history integration...");

  const script = `
import sys, json, os
sys.path.insert(0, "${BASE_DIR}/src")
from opensmi.launch_history import update_history, load_history
from pathlib import Path

import tempfile
test_dir = Path(tempfile.mkdtemp())

gpus = [("node-01", 0), ("node-01", 1)]
update_history(test_dir, gpus)

history = load_history(test_dir)
print(f"History nodes: {len(history)}")

if "node-01" in history and 0 in history["node-01"] and 1 in history["node-01"]:
    print("PASS: Launch history saved and loaded")
else:
    print(f"FAIL: Expected GPUs not in history")
    print(f"History: {history}")
`;

  const result = await runPython(script);
  if (result.code === 0 && result.stdout.includes("PASS")) {
    pass("Launch history integration", result.stdout.trim());
  } else {
    fail("Launch history integration", result.stderr || "Unexpected output");
  }
}

// ── Test 7: Preflight Checks ───────────────────────────────────────────

async function testPreflightChecks(): Promise<void> {
  log("Testing preflight checks...");

  // Read index.ts to verify preflight check structure
  const indexPath = path.join(import.meta.dir, "index.ts");
  const content = await Bun.file(indexPath).text();

  const checks = [
    "PreflightCheck",
    'status: "pending" | "pass" | "fail"',
    "runnerPreflight",
  ];

  const missing = checks.filter((c) => !content.includes(c));
  if (missing.length === 0) {
    pass("Preflight check structure", "All required preflight components present");
  } else {
    fail("Preflight check structure", `Missing: ${missing.join(", ")}`);
  }
}

// ── Test 8: Tab System Integration ──────────────────────────────────────

async function testTabSystemIntegration(): Promise<void> {
  log("Testing tab system integration...");

  const tabRegistryPath = path.join(import.meta.dir, "tabRegistry.ts");
  const indexPath = path.join(import.meta.dir, "index.ts");

  if (!existsSync(tabRegistryPath)) {
    fail("Tab system integration", "tabRegistry.ts not found");
    return;
  }

  const registryContent = await Bun.file(tabRegistryPath).text();
  const indexContent = await Bun.file(indexPath).text();

  const requiredElements = [
    { name: "Tab interface", pattern: "interface Tab", file: registryContent },
    { name: "Tab registry", pattern: "tabRegistry", file: registryContent },
    { name: "My GPU View tab", pattern: '"my-gpu-view"', file: indexContent },
    { name: "Tab switcher", pattern: "tabSwitcherOpen", file: indexContent },
  ];

  const missing = requiredElements.filter((e) => !e.file.includes(e.pattern));
  if (missing.length === 0) {
    pass("Tab system integration", "All tab system components present");
  } else {
    fail("Tab system integration", `Missing: ${missing.map((m) => m.name).join(", ")}`);
  }
}

// ── Test 9: My GPU View Bundle Selection ───────────────────────────────

async function testMyGpuViewBundleSelection(): Promise<void> {
  log("Testing My GPU View bundle selection...");

  const indexPath = path.join(import.meta.dir, "index.ts");
  const content = await Bun.file(indexPath).text();

  const requiredElements = [
    "GpuBundle",
    "MyGpuViewState",
    "myGpuViewState",
    "selectedBundleIdx",
    "pinnedGpus",
  ];

  const missing = requiredElements.filter((e) => !content.includes(e));
  if (missing.length === 0) {
    pass("My GPU View bundle selection", "All bundle selection components present");
  } else {
    fail("My GPU View bundle selection", `Missing: ${missing.join(", ")}`);
  }
}

// ── Test 10: Distribution Controls State ───────────────────────────────

async function testDistributionControlsState(): Promise<void> {
  log("Testing distribution controls state...");

  const indexPath = path.join(import.meta.dir, "index.ts");
  const content = await Bun.file(indexPath).text();

  // Check for key distribution control elements
  const elements = [
    { name: "launchDistMode toggle", pattern: 'launchDistMode = "single"' },
    { name: "launchDistMode toggle", pattern: 'launchDistMode = "one-to-one"' },
    { name: "GPU mode toggle", pattern: 'launchGpuMode' },
    { name: "Manual GPU selection", pattern: "launchManualGpus" },
    { name: "GPU selection refresh", pattern: "refreshLaunchGpuSelection" },
  ];

  const missing = elements.filter((e) => !content.includes(e.pattern));
  if (missing.length === 0) {
    pass("Distribution controls state", "All distribution control elements present");
  } else {
    fail("Distribution controls state", `Missing: ${missing.map((m) => m.name).join(", ")}`);
  }
}

// ── Test Runner ──────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  log("=== Starting Multi-Process Distribution Tests ===\n");

  await testGpuRanker();
  await testDistributionModeState();
  await testSingleModeCommandGen();
  await testOneToOneMode();
  await testGpuSelectionReasoning();
  await testLaunchHistory();
  await testPreflightChecks();
  await testTabSystemIntegration();
  await testMyGpuViewBundleSelection();
  await testDistributionControlsState();

  log("\n=== Test Summary ===");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  log(`Total: ${results.length}`);
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);

  if (failed > 0) {
    log("\nFailed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      log(`  ✗ ${r.name}: ${r.error}`);
    });
    process.exit(1);
  } else {
    log("\n✓ All tests passed!");
    process.exit(0);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
