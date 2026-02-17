# My GPU View - Design Specification

## Purpose
A focused, user-centric view showing only GPUs assigned to or being used by the current operator. Unlike the dashboard (cluster-wide overview), this view provides a personalized workspace for managing GPU-intensive workloads.

## Core Concepts

### GPU Bundle
A "GPU bundle" is a collection of GPUs that the user cares about:
- GPUs currently allocated to the user
- GPUs with active processes from the user
- Manually pinned GPUs (persistent across sessions)

### Workflow Focus
The view optimizes for the common workflow:
1. **Select** GPU bundle (auto-detected or manual)
2. **Run** command(s) on selected GPUs
3. **Monitor** logs and resource usage
4. **Stop** processes if needed

## UI Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ My GPUs · Operator: alice                          Poll: 12:34:56  │
├────────────────────────────────────────────────────────────────────┤
│ GPU Bundles (3)                                                    │
│ ▸ My Allocated GPUs (2)          [A]                               │
│   My Active Processes (3)        [P]                               │
│   Pinned GPUs (1)                [+] Add                           │
├────────────────────────────────────────────────────────────────────┤
│ My Allocated GPUs (2 GPUs)                                         │
│                                                                    │
│ ▸ node-01:GPU0  |  RTX 4090  |  24G / 24G  |  Load 0%  |  idle 2h│
│   node-02:GPU1  |  RTX 4090  |  20G / 24G  |  Load 85% |  active │
│     PID 12345   alice   python train.py   4G   2h15m              │
│     PID 12346   alice   python eval.py    1G   45m                │
│                                                                    │
│ [r] Run Command   [l] View Logs   [k] Kill Processes   [d] Detail │
├────────────────────────────────────────────────────────────────────┤
│ Quick Actions                                                      │
│ [ctrl+r] Run on Bundle   [ctrl+l] Stream Logs   [ctrl+k] Kill All │
│ [ctrl+x t] Switch Tab    [Esc] Back to Dashboard                  │
└────────────────────────────────────────────────────────────────────┘
```

## State Management

```typescript
interface MyGpuViewState {
  selectedBundleIdx: number;
  bundles: GpuBundle[];
  expandedGpuKeys: Set<string>;
  pinnedGpus: Array<{ node: string; gpu: number }>;
}

interface GpuBundle {
  id: string;
  label: string;
  type: "allocated" | "active" | "pinned";
  gpus: Array<{ node: string; gpu: number }>;
  shortcut?: string;
}

const myGpuViewState: MyGpuViewState = {
  selectedBundleIdx: 0,
  bundles: [],
  expandedGpuKeys: new Set(),
  pinnedGpus: [],
};

function computeBundles(): GpuBundle[] {
  const bundles: GpuBundle[] = [];
  
  const allocatedGpus = allocations
    .filter(a => a.target === OPERATOR || a.target.split(',').includes(OPERATOR))
    .map(a => ({ node: a.node_alias, gpu: a.gpu_index }));
  
  if (allocatedGpus.length > 0) {
    bundles.push({
      id: "allocated",
      label: `My Allocated GPUs (${allocatedGpus.length})`,
      type: "allocated",
      gpus: allocatedGpus,
      shortcut: "a",
    });
  }
  
  const activeGpus = new Set<string>();
  if (snapshot) {
    for (const node of snapshot.nodes) {
      for (const proc of node.processes) {
        if (proc.user === OPERATOR) {
          activeGpus.add(`${node.node_alias}:${proc.gpu_uuid}`);
        }
      }
    }
  }
  
  const activeGpuList: Array<{ node: string; gpu: number }> = [];
  if (snapshot) {
    for (const node of snapshot.nodes) {
      for (const gpu of node.gpus) {
        if (activeGpus.has(`${node.node_alias}:${gpu.uuid}`)) {
          activeGpuList.push({ node: node.node_alias, gpu: gpu.index });
        }
      }
    }
  }
  
  if (activeGpuList.length > 0) {
    bundles.push({
      id: "active",
      label: `My Active Processes (${activeGpuList.length})`,
      type: "active",
      gpus: activeGpuList,
      shortcut: "p",
    });
  }
  
  if (myGpuViewState.pinnedGpus.length > 0) {
    bundles.push({
      id: "pinned",
      label: `Pinned GPUs (${myGpuViewState.pinnedGpus.length})`,
      type: "pinned",
      gpus: myGpuViewState.pinnedGpus,
      shortcut: "+",
    });
  }
  
  return bundles;
}
```

## Interactions

### Bundle Selection
- **↑/↓ or j/k**: Navigate between bundles
- **Enter**: Expand/collapse bundle
- **Shortcut key**: Jump directly to bundle (e.g., 'a' for allocated)

### GPU Selection within Bundle
- **Tab**: Cycle through GPUs in expanded bundle
- **Double-click GPU**: Open detailed view

### Quick Actions
- **r**: Run command on selected bundle's GPUs
- **l**: View logs from processes on selected GPU
- **k**: Kill processes on selected GPU
- **d**: Jump to detailed node view for selected GPU

### Pinning
- **+**: Add current GPU to pinned bundle
- **-**: Remove selected GPU from pinned bundle
- **p**: Toggle pin on current GPU

## Integration with Command Runner

When "Run Command" is triggered from My GPU View:
1. Auto-populate `launchGpuMode = "selected"`
2. Pre-select GPUs from the current bundle
3. Open command runner in focused mode
4. After execution, stay in My GPU View to monitor

## Persistent State

Pinned GPUs are saved to `~/.opensmi/my_gpu_view.json`:

```json
{
  "pinned_gpus": [
    { "node": "node-01", "gpu": 0 },
    { "node": "node-03", "gpu": 2 }
  ],
  "expanded_bundles": ["allocated", "active"]
}
```

## Benefits

1. **Reduced Cognitive Load**: Only shows relevant GPUs, not entire cluster
2. **Workflow Optimization**: Run → Monitor → Stop cycle is streamlined
3. **Context Persistence**: Pinned GPUs survive across sessions
4. **Quick Navigation**: Bundle shortcuts for keyboard-driven workflow

## Implementation Notes

### Render Function Structure

```typescript
function renderMyGpuView(): BoxRenderable {
  const bundles = computeBundles();
  
  if (bundles.length === 0) {
    return Box(
      { flexDirection: "column", padding: 2 },
      Text({ content: "No GPUs found", fg: C.textDim }),
      Text({ content: "• No allocations to you", fg: C.textDim }),
      Text({ content: "• No active processes from you", fg: C.textDim }),
      Text({ content: "• No pinned GPUs", fg: C.textDim }),
      Text({ content: "", fg: C.textDim }),
      Text({ content: "[+] Pin a GPU from dashboard", fg: C.cyan }),
      Text({ content: "[Esc] Back to dashboard", fg: C.textDim })
    );
  }
  
  const header = renderMyGpuHeader();
  const bundleList = renderBundleList(bundles);
  const gpuDetails = renderSelectedBundleGpus(bundles);
  const footer = renderMyGpuFooter();
  
  return Box(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg },
    header,
    bundleList,
    gpuDetails,
    footer
  );
}
```

### State Persistence

```typescript
async function loadMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  try {
    const raw = await Bun.file(stateFile).text();
    const data = JSON.parse(raw);
    myGpuViewState.pinnedGpus = data.pinned_gpus || [];
    myGpuViewState.expandedGpuKeys = new Set(data.expanded_bundles || []);
  } catch {
    myGpuViewState.pinnedGpus = [];
    myGpuViewState.expandedGpuKeys = new Set();
  }
}

async function saveMyGpuViewState(): Promise<void> {
  const stateFile = `${getStateDir()}/my_gpu_view.json`;
  const data = {
    pinned_gpus: myGpuViewState.pinnedGpus,
    expanded_bundles: Array.from(myGpuViewState.expandedGpuKeys),
  };
  try {
    await Bun.write(stateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to save My GPU View state:", e);
  }
}
```

## Future Enhancements

1. **Log Streaming**: Real-time log tail from tmux sessions
2. **Resource Graphs**: Historical GPU utilization charts
3. **Notifications**: Alert when process finishes or GPU becomes idle
4. **Batch Operations**: Run different commands on each GPU in bundle
5. **Templates**: Save common command patterns for quick reuse
