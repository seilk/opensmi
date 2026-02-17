import type { BoxRenderable } from "@opentui/core";

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
  
  /** Render function that returns the tab's UI */
  render: () => BoxRenderable;
  
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
  
  /**
   * Register a new tab. If a tab with the same ID already exists, it will be overwritten.
   */
  register(tab: Tab): void {
    if (this.tabs.has(tab.id)) {
      console.warn(`[TabRegistry] Tab "${tab.id}" already registered, overwriting`);
    }
    this.tabs.set(tab.id, tab);
  }
  
  /**
   * Unregister a tab by ID. If the tab is currently active, this will fail.
   */
  unregister(tabId: string): void {
    if (tabId === this.activeTabId) {
      console.error(`[TabRegistry] Cannot unregister active tab "${tabId}"`);
      return;
    }
    this.tabs.delete(tabId);
  }
  
  /**
   * Switch to a different tab by ID.
   * 
   * @param tabId - The ID of the tab to switch to
   * @returns true if switch succeeded, false otherwise
   * 
   * Steps:
   * 1. Check if target tab exists
   * 2. Check if current tab allows exit (canExit hook)
   * 3. Call current tab's onExit hook
   * 4. Update activeTabId
   * 5. Call new tab's onEnter hook
   */
  async switchTo(tabId: string): Promise<boolean> {
    // No-op if already on this tab
    if (tabId === this.activeTabId) {
      return true;
    }
    
    const nextTab = this.tabs.get(tabId);
    if (!nextTab) {
      console.error(`[TabRegistry] Tab "${tabId}" not found`);
      return false;
    }
    
    const currentTab = this.tabs.get(this.activeTabId);
    
    // Check if current tab allows exit
    if (currentTab?.canExit && !currentTab.canExit()) {
      console.log(`[TabRegistry] Tab "${this.activeTabId}" blocked exit`);
      return false;
    }
    
    // Call exit hook on current tab
    if (currentTab?.onExit) {
      try {
        await currentTab.onExit();
      } catch (e) {
        console.error(`[TabRegistry] Error in onExit for "${this.activeTabId}":`, e);
      }
    }
    
    // Switch active tab
    const prevTabId = this.activeTabId;
    this.activeTabId = tabId;
    console.log(`[TabRegistry] Switched from "${prevTabId}" to "${tabId}"`);
    
    // Call enter hook on new tab
    if (nextTab.onEnter) {
      try {
        await nextTab.onEnter();
      } catch (e) {
        console.error(`[TabRegistry] Error in onEnter for "${tabId}":`, e);
      }
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
    return Array.from(this.tabs.values()).filter(t => !t.hidden);
  }
}

/**
 * Global tab registry instance.
 * Import this in index.ts to register tabs and switch between them.
 */
export const tabRegistry = new TabRegistryImpl();
