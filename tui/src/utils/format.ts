/**
 * src/utils/format.ts
 * Pure formatting and utility functions for the opensmi TUI.
 * These functions are side-effect-free (except setStatus which mutates S.statusMsg).
 *
 * Extracted from index.ts — DO NOT modify index.ts yet (Phase 3 handles that).
 */

import type { GPUInfo, NodeSnapshot, ClusterSnapshot, Allocation } from "../types";
import { S } from "../state/global";

// ── GPU value helpers ──────────────────────────────────────────────

export function gpuMemStr(mib: number | null | undefined): string {
  if (mib === null || mib === undefined) return "?";
  return `${Math.round(mib / 1024)}G`;
}

export function gpuUtilPct(g: GPUInfo): number | null {
  if (g.utilization_gpu_percent !== null && g.utilization_gpu_percent !== undefined) {
    return g.utilization_gpu_percent;
  }
  if (g.utilization_gpu !== null && g.utilization_gpu !== undefined) {
    return g.utilization_gpu;
  }
  return null;
}

export function runtimeStr(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const s = Math.max(0, Math.floor(sec));

  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function truncateText(text: string, width: number): string {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(1, width - 1)) + "…";
}

// ── Sparkline / bars ──────────────────────────────────────────────

/**
 * Create a single sparkline character representing GPU utilization (0-100%).
 * Returns a unicode block character scaled to the percentage.
 */
export function createSparkline(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "░";
  const glyphs = ["░", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const clamped = Math.max(0, Math.min(100, pct));
  const idx = Math.round((clamped / 100) * (glyphs.length - 1));
  return glyphs[idx] ?? "░";
}

/**
 * Create a short ASCII progress bar for memory usage.
 * Returns a fixed-width string like "[████░░]".
 */
export function createMemBar(
  usedMib: number | null | undefined,
  totalMib: number | null | undefined
): string {
  const barWidth = 6;
  if (usedMib == null || totalMib == null || totalMib <= 0) {
    return "[" + "░".repeat(barWidth) + "]";
  }
  const ratio = Math.max(0, Math.min(1, usedMib / totalMib));
  const filled = Math.round(ratio * barWidth);
  return "[" + "█".repeat(filled) + "░".repeat(barWidth - filled) + "]";
}

// ── Time helpers ──────────────────────────────────────────────────

export function _parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function expiresInShort(expiresAt: string | null | undefined): string {
  const d = _parseIso(expiresAt);
  if (!d) return "";

  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "expired";

  const totalMin = Math.floor(diffMs / 60_000);
  const day = Math.floor(totalMin / (60 * 24));
  const hour = Math.floor((totalMin % (60 * 24)) / 60);
  const min = totalMin % 60;

  if (day > 0) return `${day}d${hour}h`;
  if (hour > 0) return `${hour}h${min}m`;
  return `${Math.max(1, min)}m`;
}

export function countExpiringWithin(hours: number): number {
  const now = Date.now();
  const windowMs = Math.max(1, hours) * 60 * 60 * 1000;
  let count = 0;

  for (const a of S.allocations) {
    const d = _parseIso(a.expires_at);
    if (!d) continue;
    const diff = d.getTime() - now;
    if (diff > 0 && diff <= windowMs) count += 1;
  }

  return count;
}

// ── Node / GPU index helpers ──────────────────────────────────────

export function usersOnGpu(node: NodeSnapshot, gpuUuid: string): string[] {
  const seen = new Set<string>();
  const users: string[] = [];
  for (const p of node.processes) {
    if (p.gpu_uuid !== gpuUuid) continue;
    if (seen.has(p.user)) continue;
    seen.add(p.user);
    users.push(p.user);
  }
  return users;
}

export function gpuIndicesForSnapshot(s: ClusterSnapshot | null): number[] {
  if (!s) return [];
  const set = new Set<number>();
  for (const n of s.nodes) {
    if (n.error) continue;
    for (const g of n.gpus) set.add(g.index);
  }
  return [...set].sort((a, b) => a - b);
}

export function gpuIndicesForNode(
  node: NodeSnapshot | null | undefined
): number[] {
  if (!node || node.error) return [];
  const set = new Set<number>();
  for (const g of node.gpus) set.add(g.index);
  return [...set].sort((a, b) => a - b);
}

// ── Allocation helpers ─────────────────────────────────────────────

export function getAllocation(
  nodeAlias: string,
  gpuIdx: number
): Allocation | null {
  const a = S.allocations.find(
    (a) => a.node_alias === nodeAlias && a.gpu_index === gpuIdx
  );
  return a || null;
}

export function getAllocTarget(
  nodeAlias: string,
  gpuIdx: number
): string | null {
  return getAllocation(nodeAlias, gpuIdx)?.target || null;
}

export function isViolation(
  nodeAlias: string,
  gpuIdx: number,
  user: string
): boolean {
  const target = getAllocTarget(nodeAlias, gpuIdx);
  if (target === null) return false; // default-open before explicit admin allocation
  if (target === "*") return false;

  const allowed = new Set(_parseTargets(target));
  return !allowed.has(user);
}

// ── GPU activity ──────────────────────────────────────────────────

export function gpuActivityStatus(
  node: NodeSnapshot,
  gpuIdx: number,
  gpuUuid: string
): string {
  const procs = node.processes.filter((p) => p.gpu_uuid === gpuUuid);

  if (procs.length > 0) {
    return "in use";
  }

  // Check allocation
  const alloc = S.allocations.find(
    (a) => a.node_alias === node.node_alias && a.gpu_index === gpuIdx
  );

  if (alloc) {
    const assignedAt = _parseIso(alloc.assigned_at);
    if (assignedAt) {
      const idleMs = Date.now() - assignedAt.getTime();
      if (idleMs > 0) {
        const totalMin = Math.floor(idleMs / 60_000);
        const day = Math.floor(totalMin / (60 * 24));
        const hour = Math.floor((totalMin % (60 * 24)) / 60);
        const min = totalMin % 60;

        if (day > 0) return `idle ${day}d${hour}h (alloc)`;
        if (hour > 0) return `idle ${hour}h${min}m (alloc)`;
        if (min > 0) return `idle ${min}m (alloc)`;
        return "idle <1m (alloc)";
      }
    }
  }

  // Fallback to TUI observation tracking
  const key = `${node.node_alias}:${gpuUuid}`;
  const idleStartTime = S.gpuIdleStart[key];

  if (!idleStartTime) {
    return "idle (unknown)";
  }

  const idleMs = Date.now() - idleStartTime;
  if (idleMs < 0) return "idle (unknown)";

  const totalMin = Math.floor(idleMs / 60_000);
  const day = Math.floor(totalMin / (60 * 24));
  const hour = Math.floor((totalMin % (60 * 24)) / 60);
  const min = totalMin % 60;

  if (day > 0) return `idle ${day}d${hour}h`;
  if (hour > 0) return `idle ${hour}h${min}m`;
  if (min > 0) return `idle ${min}m`;
  return "idle <1m";
}

// ── Status message ────────────────────────────────────────────────

export function setStatus(msg: string, ttlMs: number = 1000): void {
  S.statusMsg = msg;
  S.statusUntil = Date.now() + ttlMs;
  S.requestRender?.();
}

// ── Known users ───────────────────────────────────────────────────

export function recomputeKnownUsers(): void {
  const users = new Set<string>();

  for (const u of S.systemUsers) users.add(u);

  if (S.snapshot) {
    for (const n of S.snapshot.nodes) {
      if (n.error) continue;
      for (const p of n.processes) {
        if (p.user && p.user !== "unknown") users.add(p.user);
      }
    }
  }

  for (const a of S.allocations) {
    const t = (a.target || "").trim();
    if (!t || t === "*" || t.toLowerCase() === "none") continue;
    users.add(t);
  }

  S.knownUsers = [...users].sort((a, b) => a.localeCompare(b));
}

// ── Draft / target parsing ────────────────────────────────────────

export function _parseTargets(target: string): string[] {
  const parts = target
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function _filteredDraftList(
  raw: string,
  universeSet: Set<string>
): string[] {
  return _parseTargets(raw).filter((t) => t === "*" || universeSet.has(t));
}

export function _toggleDraftUser(
  raw: string,
  user: string,
  universeSet: Set<string>
): string {
  const cur = _filteredDraftList(raw, universeSet);
  const idx = cur.indexOf(user);
  if (idx >= 0) {
    cur.splice(idx, 1);
  } else {
    cur.push(user);
  }
  return cur.join(",");
}

// ── GPU suggestion ────────────────────────────────────────────────

export function suggestGpu(node: NodeSnapshot): GPUInfo | null {
  if (!node.gpus.length) return null;

  const byUuidProcCount = new Map<string, number>();
  for (const p of node.processes) {
    byUuidProcCount.set(
      p.gpu_uuid,
      (byUuidProcCount.get(p.gpu_uuid) || 0) + 1
    );
  }

  const sorted = [...node.gpus].sort((a, b) => {
    const aProc = byUuidProcCount.get(a.uuid) || 0;
    const bProc = byUuidProcCount.get(b.uuid) || 0;
    if (aProc !== bProc) return aProc - bProc;

    const aUtil = gpuUtilPct(a) ?? Number.MAX_SAFE_INTEGER;
    const bUtil = gpuUtilPct(b) ?? Number.MAX_SAFE_INTEGER;
    if (aUtil !== bUtil) return aUtil - bUtil;

    const aFree = a.memory_free_mib ?? -1;
    const bFree = b.memory_free_mib ?? -1;
    if (aFree !== bFree) return bFree - aFree;

    return a.index - b.index;
  });

  return sorted[0] || null;
}

// ── ANSI / text wrapping ──────────────────────────────────────────

/** Strip ANSI escape codes for display-width calculation only. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Wrap a string into lines based on ANSI-stripped display width
 * (raw string preserved per line).
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const displayLen = stripAnsi(text).length;
  if (displayLen <= maxWidth) return [text];

  const lines: string[] = [];
  let rawIdx = 0;
  let displayCount = 0;
  let lineStart = 0;
  while (rawIdx < text.length) {
    const ansiMatch = text.slice(rawIdx).match(/^\x1b\[[0-9;]*[A-Za-z]/);
    if (ansiMatch) {
      rawIdx += ansiMatch[0].length;
      continue;
    }
    displayCount++;
    rawIdx++;
    if (displayCount >= maxWidth) {
      lines.push(text.slice(lineStart, rawIdx));
      lineStart = rawIdx;
      displayCount = 0;
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  return lines.length > 0 ? lines : [text];
}

/**
 * Wrap text and insert a visible cursor `|` at cursorPos for edit mode rendering.
 */
export function wrapTextWithCursor(
  text: string,
  cursorPos: number,
  maxWidth: number
): string[] {
  if (maxWidth <= 0) return [text];
  const clampedPos = Math.max(0, Math.min(cursorPos, text.length));
  const withCursor = text.slice(0, clampedPos) + "|" + text.slice(clampedPos);
  return wrapText(withCursor, maxWidth);
}

// ── Shell / tmux utilities ────────────────────────────────────────

export function shellQuote(token: string): string {
  if (token.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function tmuxSafeName(s: string): string {
  return s.replace(/#/g, "-").replace(/[.:]/g, "-");
}
