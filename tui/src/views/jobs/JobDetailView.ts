import { Box, Text, t, bold, fg } from "@opentui/core";
import { S } from "../../state/global";
import { C } from "../../theme";
import { gpuLivenessCache, getJobStatusIcon, formatJobTimestamp, formatJobDuration, formatJobGpus } from "./JobListView";
import { renderJobsListView } from "./JobListView";

export function renderJobDetailView() {
  if (!S.jobDetailView) return renderJobsListView();

  // Log view mode: show captured tmux pane output
  if (S.jobDetailLogView !== null) {
    const logLines = S.jobDetailLogView.split("\n");
    const termHeight = process.stdout.rows || 40;
    const termWidth = process.stdout.columns || 80;
    const visibleLines = termHeight - 4;
    const maxScroll = Math.max(0, logLines.length - visibleLines);
    S.jobDetailLogScroll = Math.min(S.jobDetailLogScroll, maxScroll);

    const displayLines = logLines.slice(S.jobDetailLogScroll, S.jobDetailLogScroll + visibleLines);

    const rows: any[] = [];
    rows.push(Text({
      content: t`${bold(fg(C.blue)("Log"))} - ${S.jobDetailLogSession}  ${fg(C.textDim)(`(${S.jobDetailLogScroll + 1}-${S.jobDetailLogScroll + displayLines.length}/${logLines.length} lines)`)}`,
    }));
    rows.push(Text({ content: t`${fg(C.textDim)("─".repeat(Math.max(termWidth - 2, 20)))}` }));

    for (const line of displayLines) {
      rows.push(Text({ content: line, fg: C.text }));
    }

    rows.push(Text({ content: t`${fg(C.textDim)("─".repeat(Math.max(termWidth - 2, 20)))}` }));
    rows.push(Text({
      content: t`${fg(C.textDim)("[↑↓]")} Scroll  ${fg(C.textDim)("[r]")} Refresh  ${fg(C.textDim)("[Esc]")} Back to detail`,
      fg: C.textDim,
    }));

    return Box(
      { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, paddingLeft: 1, paddingRight: 1 },
      ...rows
    );
  }

  const job = S.jobDetailView;
  const statusInfo = getJobStatusIcon(job.status);
  const liveness = gpuLivenessCache.get(job.id) || {};
  const termWidth = process.stdout.columns || 80;
  const contentWidth = Math.max(termWidth - 6, 30);

  // Build list of sessions for navigation
  const sessionEntries: Array<{ label: string; session: string | null; color: string }> = [];

  if (job.dist_mode === "single") {
    for (let i = 0; i < job.gpus.length; i++) {
      const [node, gpu] = job.gpus[i];
      const key = `${node}:${gpu}`;
      const alive = liveness[key];
      const session = job.tmux_sessions[i] || null;
      let color: string;
      if (job.status !== "running") {
        color = job.status === "done" ? C.green : job.status === "failed" ? C.red : C.textDim;
      } else {
        color = alive === true ? C.green : alive === false ? C.red : C.yellow;
      }
      sessionEntries.push({ label: `${node}:GPU${gpu}`, session, color });
    }
  } else {
    for (let i = 0; i < job.commands.length; i++) {
      const [node, gpu] = job.gpus[i] || ["?", i];
      const key = `${node}:${gpu}`;
      const alive = liveness[key];
      const session = job.tmux_sessions[i] || null;
      let color: string;
      if (job.status !== "running") {
        color = job.status === "done" ? C.green : job.status === "failed" ? C.red : C.textDim;
      } else {
        color = alive === true ? C.green : alive === false ? C.red : C.yellow;
      }
      const cmdPreview = job.commands[i]?.slice(0, Math.max(contentWidth - 30, 20)) || "";
      sessionEntries.push({ label: `${node}:GPU${gpu} → ${cmdPreview}`, session, color });
    }
  }

  // Clamp selection
  if (sessionEntries.length > 0) {
    S.jobDetailSelectedCmd = Math.min(S.jobDetailSelectedCmd, sessionEntries.length - 1);
  }

  const rows: any[] = [];
  rows.push(
    Text({ content: t`${bold(fg(C.blue)(`Job ${job.id}`))} - ${job.command.slice(0, contentWidth - 16)}` })
  );
  rows.push(Text({ content: "" }));
  rows.push(Text({ content: t`Status:    ${fg(statusInfo.color)(statusInfo.icon + " " + job.status)}` }));
  rows.push(Text({ content: t`User:      ${fg(C.cyan)(job.user)}` }));

  if (job.started_at) {
    const runtime = formatJobDuration(job.started_at, job.status === "running" ? null : job.finished_at);
    rows.push(Text({ content: t`Runtime:   ${fg(job.status === "running" ? C.green : C.text)(runtime)}` }));
  }

  rows.push(Text({ content: t`Mode:      ${job.exec_mode} / ${job.dist_mode}  Queue: ${job.queue_mode}` }));
  rows.push(Text({ content: t`Restart:   ${job.restart_policy}${job.retry_count > 0 ? ` (${job.retry_count}/${job.max_retries})` : ""}` }));

  if (sessionEntries.length > 0) {
    rows.push(Text({ content: "" }));
    const liveCount = Object.values(liveness).filter(v => v).length;
    const totalCount = Object.keys(liveness).length;
    const livenessStr = totalCount > 0 ? ` (${liveCount}/${totalCount} active)` : "";
    rows.push(Text({ content: t`${fg(C.cyan)("Sessions:")}${livenessStr}` }));

    for (let i = 0; i < sessionEntries.length; i++) {
      const entry = sessionEntries[i];
      const selected = i === S.jobDetailSelectedCmd;
      const prefix = selected ? "▸ " : "  ";
      const statusDot = entry.session ? "●" : "○";
      const entryColor = selected ? C.yellow : entry.color;
      const hasLog = entry.session ? "" : fg(C.textDim)(" (no session)");
      rows.push(Text({ content: t`${fg(entryColor)(`${prefix}${statusDot} ${entry.label}`)}${hasLog}` }));
    }
  }

  if (job.dist_mode === "single" && job.command) {
    rows.push(Text({ content: "" }));
    rows.push(Text({ content: t`${fg(C.cyan)("Command:")}` }));
    rows.push(Text({ content: `  ${job.command}`, fg: C.textDim }));
  }

  rows.push(Text({ content: "" }));
  rows.push(Text({ content: t`Submitted: ${job.submitted_at}` }));
  if (job.started_at) rows.push(Text({ content: t`Started:   ${job.started_at}` }));
  if (job.finished_at) rows.push(Text({ content: t`Finished:  ${job.finished_at}` }));

  if (job.error) {
    rows.push(Text({ content: "" }));
    rows.push(Text({ content: t`${fg(C.red)("Error:")} ${job.error}`, fg: C.red }));
  }

  rows.push(Text({ content: "" }));
  rows.push(
    Text({
      content: t`${fg(C.textDim)("[↑↓]")} Select  ${fg(C.textDim)("[Enter]")} View log  ${fg(C.textDim)("[c]")} Cancel  ${fg(C.textDim)("[r]")} Retry selected  ${fg(C.textDim)("[Shift+r]")} Retry all  ${fg(C.textDim)("[x]")} Clean tmux  ${fg(C.textDim)("[Esc]")} Back`,
      fg: C.textDim,
    })
  );

  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg, padding: 2 },
    ...rows
  );
}
