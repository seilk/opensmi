# Tabbed Navigation System Design

## Overview
This design document outlines the architecture for implementing an extensible tabbed navigation framework in the opensmi TUI.

## Goals
1. **Extensibility**: Plugin-style tab registration for future extensions
2. **Consistent UX**: Unified tab switching with keyboard shortcuts
3. **State Preservation**: Each tab maintains its own state when switching
4. **Backwards Compatibility**: Existing screens (dashboard, detail, help, alloc, kill) integrate seamlessly

## Architecture

### Core Interfaces

```typescript
interface Tab {
  id: string;                           // Unique identifier (e.g., "dashboard", "my-gpu-view")
  label: string;                        // Display name (e.g., "Dashboard", "My GPUs")
  shortcut?: string;                    // Optional shortcut key (e.g., "d", "g")
  render: () => BoxRenderable;          // Render function
  onEnter?: () => void | Promise<void>; // Called when tab becomes active
  onExit?: () => void | Promise<void>;  // Called when tab becomes inactive
  canExit?: () => boolean;              // Prevent navigation if unsaved changes
  hidden?: boolean;                     // Hide from tab switcher (for modals like alloc, kill)
}

interface TabRegistry {
  tabs: Map<string, Tab>;
  activeTabId: string;
  
  register(tab: Tab): void;
  unregister(tabId: string): void;
  switchTo(tabId: string): Promise<boolean>;
  getActive(): Tab | null;
  getAllVisible(): Tab[];
}
```

### State Management

Current state variables will be refactored into tab-specific contexts:

```typescript
// Current approach: Global state
let screen: "dashboard" | "detail" | "help" | "alloc" | "kill" | "launch" = "dashboard";
let selectedNodeIdx = 0;
let selectedGpuIdx = 0;

// New approach: Tab-specific state
interface DashboardState {
  selectedNodeIdx: number;
  selectedGpuIdx: number;
}

interface MyGpuViewState {
  selectedBundleIdx: number;
  pinnedGpus: Array<{ node: string; gpu: number }>;
  expandedGpu: { node: string; gpu: number } | null;
}

const tabStates: Record<string, any> = {
  dashboard: { selectedNodeIdx: 0, selectedGpuIdx: 0 },
  detail: { selectedNodeIdx: 0, selectedGpuIdx: 0 },
  "my-gpu-view": { selectedBundleIdx: 0, pinnedGpus: [], expandedGpu: null },
};
```

### Tab Registry Implementation

```typescript
class TabRegistryImpl implements TabRegistry {
  tabs = new Map<string, Tab>();
  activeTabId = "dashboard";
  
  register(tab: Tab): void {
    if (this.tabs.has(tab.id)) {
      console.warn(`Tab ${tab.id} already registered, overwriting`);
    }
    this.tabs.set(tab.id, tab);
  }
  
  unregister(tabId: string): void {
    this.tabs.delete(tabId);
  }
  
  async switchTo(tabId: string): Promise<boolean> {
    const nextTab = this.tabs.get(tabId);
    if (!nextTab) {
      console.error(`Tab ${tabId} not found`);
      return false;
    }
    
    const currentTab = this.tabs.get(this.activeTabId);
    
    // Check if current tab allows exit
    if (currentTab?.canExit && !currentTab.canExit()) {
      setStatus("Cannot leave tab: unsaved changes");
      return false;
    }
    
    // Call exit hook
    if (currentTab?.onExit) {
      await currentTab.onExit();
    }
    
    // Switch active tab
    const prevTabId = this.activeTabId;
    this.activeTabId = tabId;
    
    // Call enter hook
    if (nextTab.onEnter) {
      await nextTab.onEnter();
    }
    
    return true;
  }
  
  getActive(): Tab | null {
    return this.tabs.get(this.activeTabId) || null;
  }
  
  getAllVisible(): Tab[] {
    return Array.from(this.tabs.values()).filter(t => !t.hidden);
  }
}

const tabRegistry = new TabRegistryImpl();
```

### Keyboard Shortcut System

**Ctrl+X+T**: Tab switcher overlay

```
┌────────────────────────────────────────┐
│  Select Tab                            │
│                                        │
│  [D] Dashboard                         │
│  [G] My GPU View          ◄ Selected   │
│  [H] Help                              │
│                                        │
│  [Esc] Cancel  [Enter] Switch          │
└────────────────────────────────────────┘
```

Implementation:
```typescript
let tabSwitcherOpen = false;
let tabSwitcherIdx = 0;

if (prefixKeyPressed && key.name === "t") {
  // ctrl+x+t: Open tab switcher
  prefixKeyPressed = false;
  if (prefixKeyTimeout) clearTimeout(prefixKeyTimeout);
  
  tabSwitcherOpen = true;
  tabSwitcherIdx = tabRegistry.getAllVisible().findIndex(t => t.id === tabRegistry.activeTabId);
  render();
  return;
}

if (tabSwitcherOpen) {
  if (key.name === "escape") {
    tabSwitcherOpen = false;
    render();
  } else if (key.name === "return") {
    const tabs = tabRegistry.getAllVisible();
    const selectedTab = tabs[tabSwitcherIdx];
    if (selectedTab) {
      await tabRegistry.switchTo(selectedTab.id);
      tabSwitcherOpen = false;
      render();
    }
  } else if (key.name === "up" || key.name === "k") {
    const tabs = tabRegistry.getAllVisible();
    tabSwitcherIdx = (tabSwitcherIdx - 1 + tabs.length) % tabs.length;
    render();
  } else if (key.name === "down" || key.name === "j") {
    const tabs = tabRegistry.getAllVisible();
    tabSwitcherIdx = (tabSwitcherIdx + 1) % tabs.length;
    render();
  }
  // Direct shortcut (press "d" to jump to Dashboard)
  else if (key.name.length === 1) {
    const tabs = tabRegistry.getAllVisible();
    const matchedTab = tabs.find(t => t.shortcut === key.name);
    if (matchedTab) {
      await tabRegistry.switchTo(matchedTab.id);
      tabSwitcherOpen = false;
      render();
    }
  }
}
```

### Refactoring Existing Screens

Current screens will be registered as tabs:

```typescript
// Dashboard tab
tabRegistry.register({
  id: "dashboard",
  label: "Dashboard",
  shortcut: "d",
  render: renderDashboard,
  onEnter: async () => {
    // Ensure data is fresh when entering dashboard
    await Promise.all([pollCluster(), loadAllocations()]);
  },
});

// Detail tab (or make it part of dashboard state)
tabRegistry.register({
  id: "detail",
  label: "Node Detail",
  shortcut: "n",
  render: renderDetail,
  hidden: true, // Not shown in tab switcher, accessed via Enter from dashboard
});

// Help tab
tabRegistry.register({
  id: "help",
  label: "Help",
  shortcut: "h",
  render: renderHelp,
});

// Modal screens (alloc, kill) stay as overlays, not tabs
// They render on top of the active tab
```

### Rendering Flow

```typescript
function renderRoot(): BoxRenderable {
  // Render modal overlays (alloc, kill)
  if (screen === "alloc") {
    return Box(
      { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
      tabRegistry.getActive()?.render() || Text({ content: "No tab selected" }),
      renderAllocModal() // Overlay
    );
  }
  
  if (screen === "kill") {
    return Box(
      { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
      tabRegistry.getActive()?.render() || Text({ content: "No tab selected" }),
      renderKillModal() // Overlay
    );
  }
  
  // Tab switcher overlay
  if (tabSwitcherOpen) {
    return Box(
      { position: "relative", width: "100%", height: "100%", backgroundColor: C.bg },
      tabRegistry.getActive()?.render() || Text({ content: "No tab selected" }),
      renderTabSwitcher() // Overlay
    );
  }
  
  // Normal tab rendering
  return tabRegistry.getActive()?.render() || Text({ content: "No tab selected" });
}
```

## Migration Plan

1. **Phase 1**: Implement tab registry and interfaces (this iteration)
2. **Phase 2**: Register existing screens as tabs, maintain backward compatibility
3. **Phase 3**: Add "My GPU View" tab
4. **Phase 4**: Refactor state management to be tab-scoped

## Benefits

1. **Plugin Architecture**: New tabs can be added without modifying core code
2. **Clean Separation**: Each tab is self-contained with its own state and lifecycle
3. **Consistent UX**: Unified tab switching mechanism (ctrl+x+t)
4. **Future-Proof**: Easy to add tabs for experiments, logs, settings, etc.

## Implementation Notes

- `screen` variable will be deprecated in favor of `tabRegistry.activeTabId`
- Modal screens (alloc, kill) remain as overlays on top of active tab
- Tab state is preserved when switching (no re-initialization)
- Tabs can have async enter/exit hooks for data loading/cleanup
