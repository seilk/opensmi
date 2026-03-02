/**
 * src/components/Layout.ts
 * Global layout chrome: tab bar, footer, toast, tab switcher, and navigation helper.
 * Extracted from index.ts — DO NOT modify index.ts (Phase 3 handles that).
 */

import { Box, Text, t, bold, fg } from "@opentui/core";
import { S } from "../state/global";
import { tabRegistry } from "../../tabRegistry";
import { C } from "../theme";

// ── Dashboard tab helpers ──────────────────────────────────────────

type DashboardTab =
  | { type: "manual"; idx: number; name: string }
  | { type: "slurm"; idx: number; name: string };

function buildDashboardTabs(): DashboardTab[] {
  const tabs: DashboardTab[] = [];

  const allManualNames = [S.snapshot?.cluster_name || "Cluster", ...S.extraClusterNames];
  allManualNames.forEach((name, i) => {
    tabs.push({ type: "manual", idx: i, name });
  });

  const slurmNames = S.slurmSnapshots.length > 0
    ? S.slurmSnapshots.map((s) => s.cluster_name || "Slurm")
    : S.slurmClusterConfigNames;
  slurmNames.forEach((name, i) => {
    tabs.push({ type: "slurm", idx: i, name });
  });

  return tabs;
}

// ── Global tab bar ─────────────────────────────────────────────────

export function renderGlobalTabBar() {
  const tabs = tabRegistry.getAllVisible();

  // App-level Tabs
  const appTabBoxes = tabs.map((tab, _i) => {
    const isActive = tab.id === tabRegistry.activeTabId;
    return Box(
      {
        backgroundColor: isActive ? C.blue : C.bgAlt,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseUp: async () => {
          if (!isActive) {
            await tabRegistry.switchTo(tab.id);
            S.screen = tabRegistry.activeTabId as typeof S.screen;
            S.requestRender?.();
          }
        },
      },
      Text({
        content: isActive
          ? t`${bold(fg("#ffffff")(` ${tab.label} `))}`
          : t`${fg(C.textDim)(` ${tab.label} `)}`,
      }),
    );
  });

  // App tab row
  const appTabRow = Box(
    { flexDirection: "row", width: "100%", paddingLeft: 0, backgroundColor: C.bgAlt },
    ...appTabBoxes,
    Box({ flexGrow: 1 }),
    Box(
      { paddingLeft: 2, paddingRight: 2 },
      Text({ content: t`${fg(C.textDim)("[/] App")}` })
    ),
    Box(
      { paddingLeft: 1, paddingRight: 1 },
      Text({
        content: S.latestVersion
          ? t`${fg(C.yellow)(`opensmi@${S.appVersion} → ${S.latestVersion} ↑`)}`
          : t`${fg(C.textDim)(S.appVersion ? `opensmi@${S.appVersion}` : "opensmi")}`,
      })
    )
  );

  // Cluster tab row — shown below app tabs when on dashboard/detail with multiple clusters
  let clusterTabRow: any = null;
  if (S.screen === "dashboard" || S.screen === "detail") {
    const clusterTabs = buildDashboardTabs();
    if (clusterTabs.length > 1) {
      const cBoxes = clusterTabs.map((ctab, i) => {
        const isCActive = i === S.activeClusterTabIdx;
        const label = ctab.name.length > 18 ? ctab.name.slice(0, 17) + "..." : ctab.name;
        return Box(
          {
            backgroundColor: isCActive ? C.green : C.bgAlt,
            paddingLeft: 1,
            paddingRight: 1,
            onMouseUp: async () => {
              if (S.activeClusterTabIdx === i) return;
              S.activeClusterTabIdx = i;
              S.slurmSelectedIdx = 0;
              S.slurmScrollOff = 0;
              S.slurmSortKey = "none";
              S.slurmRunPopup = null;
              if (S.screen === "detail") await navigateToTab("dashboard");
              S.requestRender?.();
            },
          },
          Text({
            content: isCActive
              ? t`${bold(fg("#ffffff")(label))}`
              : t`${fg(C.textDim)(label)}`,
          })
        );
      });
      clusterTabRow = Box(
        { flexDirection: "row", width: "100%", paddingLeft: 0, backgroundColor: C.bgAlt },
        ...cBoxes,
        Box({ flexGrow: 1 }),
        Box(
          { paddingLeft: 2, paddingRight: 2 },
          Text({ content: t`${fg(C.textDim)("[Tab] Cluster")}` })
        )
      );
    }
  }

  return Box(
    { flexDirection: "column", width: "100%", backgroundColor: C.bgAlt },
    appTabRow,
    ...(clusterTabRow ? [clusterTabRow] : [])
  );
}

// ── Global footer ──────────────────────────────────────────────────

export function renderGlobalFooter() {
  let helpContent: any = "";

  if (S.runnerFocused) {
    helpContent = S.runnerInputTyping
      ? t`${fg("#9b59d6")("⌨ TYPING MODE")}  ${fg(C.textDim)("[Enter]")} Execute  ${fg(C.textDim)("[Esc]")} Cancel`
      : t`${fg(C.green)("● RUNNER FOCUSED")}  ${fg(C.textDim)("[Esc]")} Unfocus  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+x Enter]")} Execute  ${fg(C.textDim)("[Tab/+/-]")} Options`;
  } else {
    switch (S.screen) {
      case "dashboard":
        helpContent = t`${fg(C.textDim)("[ctrl+x ↓]")} Runner  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[ctrl+x q]")} Quit`;
        break;
      case "detail":
        helpContent = t`${fg(C.textDim)("[↑↓]")} GPU  ${fg(C.textDim)("[Enter/a]")} Allocate  ${fg(C.textDim)("[*]")} Open-to-all  ${fg(C.textDim)("[x]")} Clear  ${fg(C.textDim)("[Shift+k]")} Kill  ${fg(C.textDim)("[Esc]")} Back`;
        break;
      case "my-gpu-view":
        helpContent = t`${fg(C.textDim)("[↑↓/jk]")} Bundles  ${fg(C.textDim)("[Enter]")} Expand  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[Esc]")} Back`;
        break;
      case "jobs":
        helpContent = t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Logs  ${fg(C.textDim)("[c]")} Cancel  ${fg(C.textDim)("[d]")} Delete  ${fg(C.textDim)("[r]")} Refresh`;
        break;
      case "setup":
        helpContent = t`${fg(C.textDim)("[↑↓]")} Navigate  ${fg(C.textDim)("[Enter]")} Edit  ${fg(C.textDim)("[ctrl+s]")} Save  ${fg(C.textDim)("[Esc]")} Back`;
        break;
      default:
        helpContent = t`${fg(C.textDim)("[Esc]")} Back`;
    }
  }

  return Box(
    {
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: C.bgAlt,
    },
    Text({ content: helpContent }),
    Text({ content: S.statusMsg ? t`${fg(C.yellow)(S.statusMsg)}` : " " })
  );
}

// ── Toast ──────────────────────────────────────────────────────────

export function renderToast() {
  if (!S.statusMsg) return null;

  return Box(
    {
      position: "absolute",
      right: 2,
      bottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
      backgroundColor: C.bgAlt,
      borderStyle: "rounded",
      borderColor: C.border,
      zIndex: 10_000,
    },
    Text({ content: S.statusMsg, fg: C.yellow })
  );
}

// ── Tab switcher ───────────────────────────────────────────────────

export function renderTabSwitcher() {
  if (!S.tabSwitcherOpen) return null;

  const tabs = tabRegistry.getAllVisible();
  if (tabs.length === 0) return null;

  const maxWidth = 55;
  // rows: title + blank + N tabs + blank + help = N + 4
  // plus border (2) + padding (2) = N + 8
  const boxHeight = tabs.length + 8;

  const rows: any[] = [];
  rows.push(Text({ content: t`${bold(fg(C.blue)("Select Tab"))}` }));
  rows.push(Text({ content: "" }));

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const isSelected = i === S.tabSwitcherIdx;
    const isActive = tab.id === tabRegistry.activeTabId;
    const shortcutLabel = tab.shortcut ? `[${tab.shortcut.toUpperCase()}] ` : "    ";
    const activeLabel = isActive ? " ◀ Active" : "";
    const content = `${shortcutLabel}${tab.label}${activeLabel}`;

    rows.push(
      Text({
        content: isSelected ? `▸ ${content}` : `  ${content}`,
        fg: isSelected ? C.yellow : (isActive ? C.green : C.text),
      })
    );
  }

  rows.push(Text({ content: "" }));
  rows.push(
    Text({
      content: "[↑↓] Navigate  [Enter] Switch  [Shortcut] Jump  [Esc] Cancel",
      fg: C.textDim,
    })
  );

  return Box(
    {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: maxWidth,
      height: boxHeight,
      marginLeft: -Math.floor(maxWidth / 2),
      marginTop: -Math.floor(boxHeight / 2),
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: C.bgAlt,
      borderStyle: "rounded",
      borderColor: C.blue,
      zIndex: 20_000,
      flexDirection: "column",
    },
    ...rows
  );
}

// ── Tab navigation ─────────────────────────────────────────────────

export async function navigateToTab(tabId: string): Promise<boolean> {
  const switched = await tabRegistry.switchTo(tabId);
  if (switched) {
    S.screen = tabRegistry.activeTabId as typeof S.screen;
    // Note: render is triggered by caller (navigateByDelta or tab click handler)
  }
  return switched;
}

export async function navigateByDelta(delta: number): Promise<boolean> {
  const tabs = tabRegistry.getAllVisible();
  if (tabs.length === 0) return false;

  const current = tabs.findIndex((tab) => tab.id === tabRegistry.activeTabId);
  if (current < 0) return false;

  const next = (current + delta + tabs.length) % tabs.length;
  const nextTab = tabs[next];
  if (!nextTab) return false;

  // Switch tab (lock in switchTo prevents races)
  const switched = await tabRegistry.switchTo(nextTab.id);
  if (switched) {
    S.screen = tabRegistry.activeTabId as typeof S.screen;
    S.requestRender?.();
  }
  return switched;
}
