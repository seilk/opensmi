/**
 * src/views/Setup.ts
 * Setup/configuration view and related functions for the opensmi TUI.
 * Handles per-node environment configuration (conda/venv/work_dir).
 *
 * Extracted from index.ts — DO NOT modify index.ts.
 */

import { Box, Text, t, bold, fg } from "@opentui/core";
import { existsSync } from "node:fs";
import { S } from "../state/global";
import type { NodeEnvConfig } from "../types";
import { tuiLog, getStateDir } from "../state/api";
import { C } from "../theme";

// ── Setup message ─────────────────────────────────────────────────

export function setSetupMessage(msg: string, ms = 2000): void {
  S.setupMessage = msg;
  if (S.setupMessageTimeout) clearTimeout(S.setupMessageTimeout);
  S.setupMessageTimeout = setTimeout(() => {
    S.setupMessage = "";
    S.requestRender?.();
  }, ms);
}

// ── Load / Save ───────────────────────────────────────────────────

export async function loadSetupNodes(): Promise<void> {
  // Always read opensmi.json directly - this is config, not runtime state.
  // Never depend on cluster snapshot (which requires SSH poll).
  S.setupNodes = [];

  const configPaths = [
    process.env.OPENSMI_CONFIG,
    `${getStateDir()}/opensmi.json`,
  ].filter(Boolean) as string[];

  let nodes: Array<{ alias: string; env_manager?: string; env_name?: string; work_dir?: string }> = [];
  let loadedFrom = "(none)";

  for (const cp of configPaths) {
    try {
      const exists = existsSync(cp!);
      tuiLog("DEBUG", `loadSetupNodes: trying ${cp} exists=${exists}`);
      if (!exists) continue;
      const raw = await Bun.file(cp!).text();
      const cfg = JSON.parse(raw);
      if (Array.isArray(cfg.nodes) && cfg.nodes.length > 0) {
        nodes = cfg.nodes;
        loadedFrom = cp!;
        break;
      }
    } catch (e: any) {
      tuiLog("ERROR", `loadSetupNodes: failed reading ${cp}: ${e?.message || e}`);
      continue;
    }
  }

  for (const n of nodes) {
    S.setupNodes.push({
      alias: String(n.alias || "").replace(/#/g, "-").replace(/:/g, "-"),
      env_manager: String(n.env_manager || ""),
      env_name: String(n.env_name || ""),
      work_dir: String(n.work_dir || ""),
    });
  }

  S.setupNodes.sort((a, b) => a.alias.localeCompare(b.alias));
  tuiLog("INFO", `loadSetupNodes: ${S.setupNodes.length} nodes from ${loadedFrom} (candidates: ${configPaths.join(", ")})`);
}

export async function saveSetupNode(node: NodeEnvConfig): Promise<boolean> {
  // Write directly to opensmi.json - no CLI dependency.
  const configPaths = [
    process.env.OPENSMI_CONFIG,
    `${getStateDir()}/opensmi.json`,
  ].filter(Boolean) as string[];

  for (const cp of configPaths) {
    try {
      const raw = await Bun.file(cp!).text();
      const cfg = JSON.parse(raw);
      if (!Array.isArray(cfg.nodes)) continue;

      const target = cfg.nodes.find((n: any) =>
        String(n.alias || "").replace(/#/g, "-").replace(/:/g, "-") === node.alias
      );
      if (!target) continue;

      // Set or remove fields (keep config clean)
      if (node.env_manager) target.env_manager = node.env_manager;
      else delete target.env_manager;
      if (node.env_name) target.env_name = node.env_name;
      else delete target.env_name;
      if (node.work_dir) target.work_dir = node.work_dir;
      else delete target.work_dir;

      await Bun.write(cp!, JSON.stringify(cfg, null, 2) + "\n");
      return true;
    } catch { continue; }
  }
  return false;
}

export function markSetupNodeDirty(node: NodeEnvConfig | undefined): void {
  if (!node) return;
  S.setupDirtyAliases.add(node.alias);
}

export async function flushSetupChangesToConfig(): Promise<void> {
  // If user is still typing in setup editor, commit the buffer first.
  if (S.setupEditingField) {
    const node = S.setupNodes[S.setupSelectedIdx];
    if (node) {
      node[S.setupEditingField] = S.setupEditBuffer.trim();
      markSetupNodeDirty(node);
    }
    S.setupEditingField = null;
    S.setupEditBuffer = "";
  }

  if (S.setupDirtyAliases.size === 0) {
    return;
  }

  const failed: string[] = [];

  for (const alias of Array.from(S.setupDirtyAliases)) {
    const node = S.setupNodes.find((n) => n.alias === alias);
    if (!node) {
      S.setupDirtyAliases.delete(alias);
      continue;
    }

    const ok = await saveSetupNode(node);
    if (ok) {
      S.setupDirtyAliases.delete(alias);
      tuiLog("INFO", `setup hotfix: persisted node=${alias}`);
    } else {
      failed.push(alias);
      tuiLog("ERROR", `setup hotfix: failed persisting node=${alias}`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`Setup save failed for: ${failed.join(", ")}`);
  }
}

// ── Render ────────────────────────────────────────────────────────

export function renderSetupView() {
  tuiLog("INFO", `renderSetupView called: setupNodes.length=${S.setupNodes.length}, setupSelectedIdx=${S.setupSelectedIdx}`);
  const rows: any[] = [];

  rows.push(Text({ content: t`${bold("Setup")} - Per-Node Environment Configuration`, fg: C.text }));
  rows.push(Text({ content: t`${fg(C.textDim)("Configure conda/micromamba/venv and work directory per node. Saved to opensmi.json.")}` }));
  rows.push(Text({ content: " " }));

  if (S.setupNodes.length === 0) {
    rows.push(Text({ content: "  No nodes found in opensmi.json.", fg: C.textDim }));
    rows.push(Text({ content: `  Config search paths:`, fg: C.textDim }));
    const paths = [
      process.env.OPENSMI_CONFIG,
      `${getStateDir()}/opensmi.json`,
    ].filter(Boolean) as string[];
    for (const p of paths) {
      const exists = existsSync(p);
      rows.push(Text({ content: `    ${exists ? "✓" : "✗"} ${p}`, fg: exists ? C.green : C.textDim }));
    }
    rows.push(Text({ content: " " }));
    rows.push(Text({ content: "  Run 'opensmi init' to create a config, or set OPENSMI_CONFIG.", fg: C.textDim }));
  }

  for (let i = 0; i < S.setupNodes.length; i++) {
    const n = S.setupNodes[i];
    const selected = i === S.setupSelectedIdx;
    const prefix = selected ? "▸ " : "  ";
    const color = selected ? C.green : C.text;

    const envStr = n.env_manager && n.env_name
      ? `${n.env_manager}:${n.env_name}`
      : "(none)";
    const dirStr = n.work_dir || "(none)";

    rows.push(Text({
      content: t`${fg(color)(`${prefix}${n.alias.padEnd(14)} env: ${envStr.padEnd(25)} dir: ${dirStr}`)}`,
    }));

    // Show edit fields for selected node
    if (selected && S.setupEditingField) {
      const fields: Array<{ label: string; key: "env_manager" | "env_name" | "work_dir"; hint: string }> = [
        { label: "Env Manager", key: "env_manager", hint: "conda / miniconda / micromamba / venv" },
        { label: "Env Name   ", key: "env_name", hint: "e.g. ml, torch2" },
        { label: "Work Dir   ", key: "work_dir", hint: "e.g. ~/projects" },
      ];
      for (const f of fields) {
        const editing = S.setupEditingField === f.key;
        const val = String(editing ? S.setupEditBuffer : (n[f.key] ?? ""));
        const lineColor = editing ? "#9b59d6" : C.textDim;
        const cursor = editing ? "█" : "";
        const hint = editing ? "" : ` (${f.hint})`;
        rows.push(Text({
          content: `    ${f.label}: ${val}${cursor}${hint}`,
          fg: lineColor,
        }));
      }
    }
  }

  rows.push(Text({ content: " " }));
  rows.push(Text({ content: t`${fg(C.textDim)("↑↓ select  Enter edit  Tab next field  Esc cancel  s: save")}` }));
  if (S.setupMessage) {
    rows.push(Text({ content: t`${fg(C.green)(S.setupMessage)}` }));
  }

  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      backgroundColor: C.bg,
    },
    ...rows
  );
}
