/**
 * src/components/AllocModal.ts
 * GPU allocation modal: openAllocModal, renderAlloc, requireAdminUI, checkSudoForNode.
 * Extracted from index.ts — DO NOT modify index.ts (Phase 3 handles that).
 */

import { Box, Text, Input, ScrollBox, t, fg } from "@opentui/core";
import { S } from "../state/global";
import { runOpensmi, tuiLog } from "../state/api";
import { C } from "../theme";
import type { NodeSnapshot } from "../types";
import {
  usersOnGpu,
  getAllocTarget,
  gpuMemStr,
  _filteredDraftList,
  setStatus,
} from "../utils/format";
import { allocSet } from "../state/api";

// ── Open alloc modal ───────────────────────────────────────────────

export function openAllocModal(node: NodeSnapshot, gpuIdx: number): void {
  S.allocCtx = { nodeAlias: node.node_alias, gpuIdx };
  S.allocErrorMsg = "";
  S.allocUserHighlight = "";

  const existing = getAllocTarget(node.node_alias, gpuIdx);
  let prefill = existing || "*";
  if (!existing) {
    const gi = node.gpus.find((g) => g.index === gpuIdx);
    if (gi) {
      const live = usersOnGpu(node, gi.uuid);
      if (live.length === 1) prefill = live[0] || "*";
    }
  }

  if (prefill.trim().toLowerCase() === "none") prefill = "*";

  S.allocDraftUser = prefill;
  S.screen = "alloc";
  S.requestRender?.();
}

// ── Admin / sudo guards ────────────────────────────────────────────

export function requireAdminUI(action: string): boolean {
  if (!S.isAdmin) {
    setStatus(`Admin only: ${action} (${S.adminHint})`);
    return false;
  }

  if (S.screen === "detail") {
    const node = S.snapshot?.nodes[S.selectedNodeIdx];
    const alias = node?.node_alias;
    if (alias) {
      const ok = S.sudoOkByNode[alias];
      if (ok === false) {
        setStatus(`Admin requires sudo-group on ${alias}`);
        return false;
      }
      if (ok === null || ok === undefined) {
        setStatus(`Checking sudo-group on ${alias}…`);
        return false;
      }
    }
  }

  return true;
}

export async function checkSudoForNode(nodeAlias: string): Promise<void> {
  if (S.sudoCheckingByNode[nodeAlias]) return;
  S.sudoCheckingByNode[nodeAlias] = true;
  S.sudoOkByNode[nodeAlias] = null;
  S.requestRender?.();

  try {
    const { code, stdout, stderr } = await runOpensmi([
      "sudo-check",
      nodeAlias,
      "--json",
    ]);
    if (code !== 0) {
      S.sudoOkByNode[nodeAlias] = false;
      S.sudoInfoMsg = `sudo-check failed on ${nodeAlias}: ${stderr.trim() || `exit ${code}`}`;
      S.requestRender?.();
      return;
    }

    const data = JSON.parse(stdout) as any;
    S.sudoOkByNode[nodeAlias] = !!data.ok;
    if (!data.ok) {
      const groups = Array.isArray(data.groups) ? data.groups.join(" ") : "";
      S.sudoInfoMsg = `Read-only: SSH user not in sudo group on ${nodeAlias} (groups: ${groups})`;
    } else {
      S.sudoInfoMsg = "";
    }
  } catch (e: any) {
    S.sudoOkByNode[nodeAlias] = false;
    S.sudoInfoMsg = `sudo-check error on ${nodeAlias}: ${e?.message || String(e)}`;
  } finally {
    S.sudoCheckingByNode[nodeAlias] = false;
    S.requestRender?.();
  }
}

// ── Render alloc modal ─────────────────────────────────────────────

export function renderAlloc() {
  const ctx = S.allocCtx;
  if (!ctx) return Text({ content: "No allocation context", fg: C.red });

  const nodeSnap = S.snapshot?.nodes.find((n) => n.node_alias === ctx.nodeAlias) || null;
  const gpuInfo = nodeSnap?.gpus.find((g) => g.index === ctx.gpuIdx) || null;
  const liveUsers = nodeSnap && gpuInfo ? usersOnGpu(nodeSnap, gpuInfo.uuid) : [];

  const currentAlloc = getAllocTarget(ctx.nodeAlias, ctx.gpuIdx);
  const currentAllocStr = currentAlloc ? currentAlloc : "*";
  const liveStr = liveUsers.length ? liveUsers.join(", ") : "(idle)";

  const universe = S.knownUsers.length ? S.knownUsers : liveUsers;
  const universeSet = new Set(universe);

  // For multi-user draft (comma-separated), filter only by the last segment being typed.
  const lastSegRaw = (S.allocDraftUser.split(",").pop() || "");
  const filterToken = lastSegRaw.trim().toLowerCase();

  const filteredUsers = filterToken
    ? universe.filter((u) => u.toLowerCase().includes(filterToken))
    : universe;

  const input = Input({
    id: "alloc-user-input",
    width: "100%",
    value: S.allocDraftUser,
    placeholder: "* (default) or username",
    backgroundColor: C.bgAlt,
    focusedBackgroundColor: "#3b4261",
    textColor: "#ffffff",
    cursorColor: C.green,
  });
  input.focus();

  const errorNode = S.allocErrorMsg
    ? Text({ content: `Error: ${S.allocErrorMsg}`, fg: C.red })
    : Text({ content: " ", fg: C.textDim });

  const userRows: any[] = [];
  if (!universe.length) {
    userRows.push(Text({ content: "(no users yet)", fg: C.textDim }));
  } else if (!filteredUsers.length) {
    userRows.push(Text({ content: "(no matches)", fg: C.textDim }));
  } else {
    const currentSet = new Set(_filteredDraftList(S.allocDraftUser, universeSet));

    for (let idx = 0; idx < filteredUsers.length; idx++) {
      const u = filteredUsers[idx];
      const isSel = currentSet.has(u);
      const isFocused = S.allocUserListFocused && idx === S.allocUserListIdx;
      userRows.push(
        Box(
          {
            width: "100%",
            height: 1,
            position: "relative",
            paddingLeft: 1,
            backgroundColor: isFocused ? C.green : (S.allocUserHighlight === u ? "#33467c" : isSel ? "#3b4261" : C.bg),
          },
          Text({ content: `${isSel ? "▸" : " "} ${u}`, fg: isFocused ? "#000000" : (isSel ? "#ffffff" : C.text) }),
          // Overlay to make the row reliably clickable without triggering text selection.
          Box({
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 1,
            onMouseDown: (_e: any) => {
              _e.preventDefault?.();
              _e.stopPropagation?.();

              // Single click: highlight and focus list. Double click: select user.
              const now = Date.now();
              const clickKey = `USER:${u}`;
              const isDouble = clickKey === S.lastAllocUserClickKey && now - S.lastAllocUserClickAt < 350;
              S.lastAllocUserClickKey = clickKey;
              S.lastAllocUserClickAt = now;

              // Set focus to user list and highlight this user
              S.allocUserListFocused = true;
              S.allocUserListIdx = idx;
              S.allocUserHighlight = u;

              if (!isDouble) {
                S.requestRender?.();
                return;
              }

              // Double-click: select user and return to input
              S.allocDraftUser = u;
              S.allocUserListFocused = false;
              S.allocErrorMsg = "";
              S.requestRender?.();
            },
          })
        )
      );
    }
  }

  const matchesLine = universe.length
    ? `Filter: ${filterToken || "(empty)"}   Matches: ${filteredUsers.length}/${universe.length}`
    : "Filter: (no users)";

  const leftPanel = Box(
    {
      width: 24,
      height: "100%",
      flexDirection: "column",
      gap: 0,
      backgroundColor: C.bgAlt,
      padding: 1,
      overflow: "hidden",
    },
    Text({ content: "Users (scroll)  Click=highlight  DblClick=toggle", fg: C.textDim }),
    ScrollBox(
      {
        id: "alloc-users-scroll",
        flexGrow: 1,
        width: "100%",
        overflow: "hidden",
        scrollY: true,
        verticalScrollbarOptions: {
          visible: true,
          showArrows: false,
        },
      },
      ...userRows
    )
  );

  const selectedUsers = _filteredDraftList(S.allocDraftUser, universeSet);
  const selectedRows: any[] = selectedUsers.length
    ? selectedUsers.map((u) => Text({ content: `  ${u}`, fg: C.text }))
    : [Text({ content: "  (none)", fg: C.textDim })];

  const rightPanel = Box(
    { flexDirection: "column", flexGrow: 1, height: "100%", gap: 1, overflow: "hidden" },
    Text({
      content: `Target: ${ctx.nodeAlias} GPU${ctx.gpuIdx}${gpuInfo ? ` - ${gpuInfo.name} (${gpuMemStr(gpuInfo.memory_total_mib)})` : ""}`,
      fg: C.cyan,
    }),
    Text({ content: `Current allocation: ${currentAllocStr}`, fg: C.textDim }),
    Text({ content: `Live users: ${liveStr}`, fg: C.textDim }),
    Text({ content: "Selected users:", fg: C.textDim }),
    ScrollBox(
      {
        id: "alloc-selected-scroll",
        height: 6,
        width: "100%",
        overflow: "hidden",
        scrollY: true,
        verticalScrollbarOptions: { visible: true, showArrows: false },
      },
      ...selectedRows
    ),
    Text({ content: "Enter username (default: * for everyone):", fg: C.textDim }),
    input,
    Text({ content: "[Tab] Autocomplete last segment", fg: C.textDim }),
    Text({ content: matchesLine, fg: C.textDim }),
    errorNode,
    Text({ content: "[Enter] Save    [Esc] Cancel", fg: C.textDim })
  );

  const modal = Box(
    {
      width: 92,
      maxHeight: "90%",
      borderStyle: "rounded",
      borderColor: C.border,
      title: "Allocate GPU",
      titleAlignment: "center",
      padding: 1,
      flexDirection: "column",
      gap: 1,
      backgroundColor: C.bg,
      overflow: "hidden",
    },
    Box(
      { flexDirection: "row", gap: 2, flexGrow: 1, width: "100%", overflow: "hidden" },
      leftPanel,
      rightPanel
    ),
    // replaced by global footer
  );

  return Box(
    {
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: C.bg,
    },
    modal
  );
}

// Re-export allocSet for convenience (callers that used to call it directly from index.ts)
export { allocSet };
