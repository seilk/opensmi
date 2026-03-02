/**
 * Tab interface defining the contract for all tabs in the TUI.
 *
 * Each tab is a self-contained view with its own render function and lifecycle hooks.
 */
export interface Tab {
  /** Unique identifier (e.g., "dashboard", "my-gpu-view") */
  id: string;

  /** Display name shown in tab switcher (e.g., "Dashboard", "My GPUs") */
  label: string;

  /** Optional single-character shortcut for quick switching (e.g., "d", "g") */
  shortcut?: string;

  /**
   * Render function for the tab.
   *
   * Note: OpenTUI render nodes are VNode-like values (Box/Text/Input...), not strict BoxRenderable.
   * Keep this broad to avoid forcing every tab to return a Box root.
   */
  render: () => any;

  /** Called when tab becomes active (for data loading, setup) */
  onEnter?: () => void | Promise<void>;

  /** Called when tab becomes inactive (for cleanup, saving state) */
  onExit?: () => void | Promise<void>;

  /** Return false to prevent navigation (e.g., unsaved changes warning) */
  canExit?: () => boolean;

  /** Hide from tab switcher (for modal-like screens: alloc, kill) */
  hidden?: boolean;
}

/**
 * Tab registry interface for managing tabs and navigation.
 */
export interface TabRegistry {
  tabs: Map<string, Tab>;
  activeTabId: string;

  register(tab: Tab): void;
  unregister(tabId: string): void;
  switchTo(tabId: string): Promise<boolean>;
  getActive(): Tab | null;
  getAllVisible(): Tab[];
}

/**
 * Implementation of TabRegistry.
 *
 * Manages tab registration, switching, and lifecycle hooks.
 * Ensures only one tab is active at a time and handles enter/exit hooks.
 */
export class TabRegistryImpl implements TabRegistry {
  tabs = new Map<string, Tab>();
  activeTabId = "dashboard"; // Default to dashboard
  onMessage?: (msg: string) => void;
  private _switchInProgress: boolean = false;

  private _notify(msg: string): void {
    if (this.onMessage) this.onMessage(msg);
  }

  /**
   * Register a new tab. If a tab with the same ID already exists, it will be overwritten.
   */
  register(tab: Tab): void {
    if (this.tabs.has(tab.id)) {
      this._notify(`Tab "${tab.id}" already registered. Overwriting.`);
    }
    this.tabs.set(tab.id, tab);
  }

  /**
   * Unregister a tab by ID. If the tab is currently active, this will fail.
   */
  unregister(tabId: string): void {
    if (tabId === this.activeTabId) {
      this._notify(`Cannot unregister active tab "${tabId}"`);
      return;
    }
    this.tabs.delete(tabId);
  }

  /**
   * Switch to a different tab by ID.
   *
   * @param tabId - The ID of the tab to switch to
   * @returns true if switch succeeded, false otherwise
   */
  async switchTo(tabId: string): Promise<boolean> {
    // Reject concurrent switches (prevent state thrashing)
    if (this._switchInProgress) {
      return false;
    }
    // No-op if already on this tab
    if (tabId === this.activeTabId) {
      return true;
    }
    
    this._switchInProgress = true;

    const nextTab = this.tabs.get(tabId);
    if (!nextTab) {
      this._notify(`Tab "${tabId}" not found`);
      return false;
    }

    const currentTab = this.tabs.get(this.activeTabId);

    // Check if current tab allows exit
    if (currentTab?.canExit && !currentTab.canExit()) {
      this._notify(`Cannot leave tab "${this.activeTabId}"`);
      return false;
    }

    // Call exit hook on current tab
    if (currentTab?.onExit) {
      try {
        await currentTab.onExit();
      } catch {
        this._notify(`Error while leaving tab "${this.activeTabId}"`);
      }
    }

    // Switch active tab
    this.activeTabId = tabId;

    try {
      // Call enter hook on new tab
      if (nextTab.onEnter) {
        try {
          await nextTab.onEnter();
        } catch {
          this._notify(`Error while entering tab "${tabId}"`);
        }
      }
    } finally {
      this._switchInProgress = false;
    }

    return true;
  }

  /**
   * Get the currently active tab.
   */
  getActive(): Tab | null {
    return this.tabs.get(this.activeTabId) || null;
  }

  /**
   * Get all visible tabs (not hidden).
   * Used for rendering the tab switcher overlay.
   */
  getAllVisible(): Tab[] {
    return Array.from(this.tabs.values()).filter((t) => !t.hidden);
  }
}

/**
 * Global tab registry instance.
 * Import this in index.ts to register tabs and switch between them.
 */
export const tabRegistry = new TabRegistryImpl();
