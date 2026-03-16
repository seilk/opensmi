import { S } from '../state/global';
import { pollAllClusters, loadAllocations, loadJobsFromCLI } from '../state/api';
import { dispatchQueuedJobs, watchRunningJobs, cleanupOldJobs } from '../views/jobs';
import { loadSlurmData } from '../views/dashboard';

type RenderFn = () => void;

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let _renderFn: RenderFn | null = null;

export async function runRefreshCycle(): Promise<void> {
  if (S.runnerFocused || S.runnerInputTyping) return;
  S.isRefreshing = true;
  _renderFn?.();
  try {
    await Promise.all([pollAllClusters(), loadAllocations(), loadSlurmData()]);
    if (S.screen === "jobs") {
      await loadJobsFromCLI();
    }
    await dispatchQueuedJobs();
    await watchRunningJobs();
  } finally {
    S.isRefreshing = false;
    if (S.screen === "dashboard" || S.screen === "detail" || S.screen === "jobs") {
      _renderFn?.();
    }
  }
}

export function restartRefreshInterval(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (S.autoRefreshSec === 0) return;
  refreshInterval = setInterval(() => { void runRefreshCycle(); }, S.autoRefreshSec * 1000);
}

export function cycleAutoRefresh(): void {
  const cycle: Array<0 | 30 | 60 | 300 | 600 | 1800> = [30, 60, 300, 600, 1800, 0];
  const next = cycle[(cycle.indexOf(S.autoRefreshSec) + 1) % cycle.length]!;
  S.autoRefreshSec = next;
  restartRefreshInterval();
  _renderFn?.();
}

export function startIntervals(renderFn: RenderFn): void {
  _renderFn = renderFn;
  restartRefreshInterval();
  cleanupInterval = setInterval(async () => {
    await cleanupOldJobs();
    await loadJobsFromCLI();
    S.requestRender?.();
  }, 60 * 60 * 1000); // every hour
}

export function stopIntervals(): void {
  if (refreshInterval !== null) { clearInterval(refreshInterval); refreshInterval = null; }
  if (cleanupInterval !== null) { clearInterval(cleanupInterval); cleanupInterval = null; }
}
