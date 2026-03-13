#!/usr/bin/env bun

import { S } from "./src/state/global";
import type { SlurmRunPopup } from "./src/types";
import {
  buildSlurmSubmitRemoteCmd,
  normalizeQosSelection,
  selectedQosName,
  submitJobToSlurm,
} from "./src/views/dashboard/SlurmView";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`[TEST] ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`[TEST] ✗ ${name}: ${e?.message || String(e)}`);
  }
}

function resetPopup(overrides: Partial<SlurmRunPopup> = {}) {
  S._renderHook = () => {};
  S.slurmRunPopup = {
    clusterName: "cluster",
    nodeName: "node01",
    partition: "gpu",
    freeGpusAtOpen: 2,
    snapshotTime: new Date().toISOString(),
    loginNode: "login01",
    sshUser: "alice",
    sshPort: 22,
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
    qosLoading: false,
    qosFetchFailed: false,
    existingJobIds: [],
    existingJobCancelStatus: "idle",
    existingJobCancelMsg: "",
    ...(overrides || {}),
  };
}

function mockProc(stdout: string, stderr = "", exit = 0): any {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(exit),
  };
}

console.log("[TEST] === Slurm QoS Popup Tests ===\n");

await test("normalizes empty and real QoS selections without a synthetic default", () => {
  const emptyPopup = { qosList: [], qosIdx: 0 };
  normalizeQosSelection(emptyPopup);
  assert(emptyPopup.qosIdx === -1, "empty QoS list should clear selection");
  assert(selectedQosName(emptyPopup) === "", "empty QoS list should not expose a selection");

  const singlePopup = { qosList: ["normal"], qosIdx: 0 };
  normalizeQosSelection(singlePopup);
  assert(singlePopup.qosIdx === 0, "single real QoS should stay selected");
  assert(selectedQosName(singlePopup) === "normal", "single real QoS should be returned directly");

  const multiPopup = { qosList: ["normal", "high"], qosIdx: 99 };
  normalizeQosSelection(multiPopup);
  assert(multiPopup.qosIdx === 1, "selection should clamp to the final real QoS");
  assert(selectedQosName(multiPopup) === "high", "clamped selection should still be a real QoS");
});

await test("builds sbatch command without --qos when no real QoS is selected", () => {
  const cmd = buildSlurmSubmitRemoteCmd({
    partition: "gpu",
    nodeName: "node01",
    gpuCount: 1,
    qosList: [],
    qosIdx: -1,
  });
  assert(!cmd.includes("--qos="), "empty QoS list should omit --qos");
});

await test("builds sbatch command with only the selected real QoS", () => {
  const cmd = buildSlurmSubmitRemoteCmd({
    partition: "gpu",
    nodeName: "node01",
    gpuCount: 2,
    qosList: ["normal", "high"],
    qosIdx: 1,
  });
  assert(cmd.includes("--qos=high"), "selected real QoS should be emitted");
  assert(!cmd.includes("(default)"), "synthetic default should never appear in the command");
});

await test("blocks submit conservatively when QoS fetch failed", async () => {
  resetPopup({ qosFetchFailed: true });
  const originalSpawn = (Bun as any).spawn;
  let spawnCalls = 0;
  (Bun as any).spawn = (..._args: any[]) => {
    spawnCalls++;
    return mockProc("");
  };
  try {
    await submitJobToSlurm();
    assert(spawnCalls === 0, "fetch failure should block before any SSH call");
    assert(S.slurmRunPopup?.jobSubmitStatus === "error", "fetch failure should surface an error state");
    assert(!!S.slurmRunPopup?.jobErrorMsg.includes("blocked for safety"), "fetch failure error should mention the safety block");
  } finally {
    (Bun as any).spawn = originalSpawn;
  }
});

await test("marks qos lookup as failed when the ssh fetch exits non-zero", async () => {
  resetPopup();
  const originalSpawn = (Bun as any).spawn;
  (Bun as any).spawn = () => mockProc("", "permission denied", 255);
  try {
    const { fetchQosForPartition } = await import("./src/views/dashboard/SlurmView");
    await fetchQosForPartition("login01", "alice", "gpu");
    assert(S.slurmRunPopup?.qosFetchFailed === true, "non-zero ssh fetch should mark qosFetchFailed");
    assert(S.slurmRunPopup?.qosLoading === false, "fetch should always clear loading state");
  } finally {
    (Bun as any).spawn = originalSpawn;
  }
});

await test("allows submit with an empty fetched list and omits --qos", async () => {
  resetPopup({ qosList: [], qosIdx: -1 });
  const originalSpawn = (Bun as any).spawn;
  const calls: string[][] = [];
  (Bun as any).spawn = (cmd: string[]) => {
    calls.push(cmd);
    return calls.length === 1 ? mockProc("Submitted batch job 123\n") : mockProc("RUNNING\n");
  };
  try {
    await submitJobToSlurm();
    assert(calls.length >= 2, "empty QoS list should still submit and poll");
    assert(!calls[0]![6]!.includes("--qos="), "submitted sbatch command should omit --qos for an empty list");
    assert(S.slurmRunPopup?.jobSubmitStatus === "running", "successful empty-list submit should reach running state");
  } finally {
    (Bun as any).spawn = originalSpawn;
  }
});

console.log(`\n[TEST] Passed: ${passed}`);
console.log(`[TEST] Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
