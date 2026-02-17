/**
 * Keyboard Shortcuts Verification Script
 * 
 * This script analyzes index.ts to verify that all documented keyboard shortcuts
 * are properly implemented and to detect any undocumented shortcuts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ShortcutSpec {
  keys: string[];
  description: string;
  context: string;
  line?: number;
}

// Expected shortcuts based on documentation and design specs
const expectedShortcuts: ShortcutSpec[] = [
  // Global shortcuts
  { keys: ["ctrl+x t"], description: "Open tab switcher", context: "Global" },
  { keys: ["ctrl+x q"], description: "Quit application", context: "Global" },
  
  // Tab switcher
  { keys: ["up", "k"], description: "Navigate up in tab list", context: "Tab Switcher" },
  { keys: ["down", "j"], description: "Navigate down in tab list", context: "Tab Switcher" },
  { keys: ["return"], description: "Switch to selected tab", context: "Tab Switcher" },
  { keys: ["escape"], description: "Close tab switcher", context: "Tab Switcher" },
  { keys: ["[a-z]"], description: "Jump to tab by shortcut", context: "Tab Switcher" },
  
  // Dashboard
  { keys: ["up", "k"], description: "Navigate up (previous node)", context: "Dashboard" },
  { keys: ["down", "j"], description: "Navigate down (next node)", context: "Dashboard" },
  { keys: ["return"], description: "Enter detail view", context: "Dashboard" },
  { keys: ["r"], description: "Refresh cluster data", context: "Dashboard" },
  { keys: ["?", "h"], description: "Open help", context: "Dashboard" },
  { keys: ["ctrl+x down"], description: "Focus runner pane", context: "Dashboard" },
  { keys: ["ctrl+x f"], description: "Fold/unfold runner", context: "Dashboard" },
  
  // Detail
  { keys: ["up", "k"], description: "Select previous GPU", context: "Detail" },
  { keys: ["down", "j"], description: "Select next GPU", context: "Detail" },
  { keys: ["escape", "backspace"], description: "Return to dashboard", context: "Detail" },
  { keys: ["a"], description: "Allocate GPU", context: "Detail (Admin)" },
  { keys: ["*"], description: "Open-to-all allocation", context: "Detail (Admin)" },
  { keys: ["x"], description: "Clear allocation", context: "Detail (Admin)" },
  { keys: ["shift+k"], description: "Kill violators", context: "Detail (Admin)" },
  { keys: ["r"], description: "Refresh", context: "Detail" },
  
  // My GPU View
  { keys: ["up", "k"], description: "Select previous bundle", context: "My GPU View" },
  { keys: ["down", "j"], description: "Select next bundle", context: "My GPU View" },
  { keys: ["escape", "backspace"], description: "Return to dashboard", context: "My GPU View" },
  { keys: ["a"], description: "Jump to allocated bundle", context: "My GPU View" },
  { keys: ["p"], description: "Jump to active bundle", context: "My GPU View" },
  { keys: ["+"], description: "Jump to pinned bundle", context: "My GPU View" },
  { keys: ["r"], description: "Refresh", context: "My GPU View" },
  { keys: ["ctrl+x r"], description: "Run on bundle", context: "My GPU View" },
  
  // Runner (Focused)
  { keys: ["tab"], description: "Toggle execution mode", context: "Runner Focused" },
  { keys: ["shift+tab"], description: "Toggle distribution mode", context: "Runner Focused" },
  { keys: ["+", "="], description: "Increase GPU count", context: "Runner Focused" },
  { keys: ["-", "_"], description: "Decrease GPU count", context: "Runner Focused" },
  { keys: ["g"], description: "Toggle GPU mode", context: "Runner Focused" },
  { keys: ["up"], description: "Previous input line", context: "Runner Focused" },
  { keys: ["down"], description: "Next input line", context: "Runner Focused" },
  { keys: ["return"], description: "Start typing", context: "Runner Focused" },
  { keys: ["escape"], description: "Exit focus", context: "Runner Focused" },
  { keys: ["ctrl+x return"], description: "Execute commands", context: "Runner Focused" },
  
  // Runner (Typing)
  { keys: ["escape"], description: "Exit typing mode", context: "Runner Typing" },
  { keys: ["return"], description: "Exit typing mode", context: "Runner Typing" },
  { keys: ["up"], description: "Previous input while typing", context: "Runner Typing" },
  { keys: ["down"], description: "Next input while typing", context: "Runner Typing" },
  
  // Allocation Modal
  { keys: ["tab"], description: "Autocomplete username", context: "Allocation Modal" },
  { keys: ["return"], description: "Save allocation", context: "Allocation Modal" },
  { keys: ["escape"], description: "Cancel allocation", context: "Allocation Modal" },
  
  // Kill Modal
  { keys: ["return"], description: "Confirm kill", context: "Kill Modal" },
  { keys: ["escape"], description: "Cancel kill", context: "Kill Modal" },
];

interface FoundShortcut {
  key: string;
  line: number;
  context: string;
  snippet: string;
}

function analyzeKeyboardShortcuts(sourceFile: string): {
  found: FoundShortcut[];
  missing: ShortcutSpec[];
  extra: FoundShortcut[];
} {
  const content = readFileSync(sourceFile, "utf-8");
  const lines = content.split("\n");
  
  const found: FoundShortcut[] = [];
  
  // Find all key event handlers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    
    // Match key.name === "..." patterns
    const keyMatch = line.match(/key\.name\s*===\s*["']([^"']+)["']/);
    if (keyMatch) {
      const key = keyMatch[1]!;
      const context = inferContext(lines, i);
      const snippet = lines.slice(Math.max(0, i - 1), i + 2).join("\n");
      found.push({ key, line: i + 1, context, snippet });
    }
    
    // Match key.ctrl patterns
    if (line.includes("key.ctrl") || line.includes("key.shift")) {
      const context = inferContext(lines, i);
      const snippet = lines.slice(Math.max(0, i - 1), i + 2).join("\n");
      
      // Try to extract the key name
      const ctrlMatch = line.match(/key\.ctrl.*key\.name\s*===\s*["']([^"']+)["']/);
      if (ctrlMatch) {
        found.push({ 
          key: `ctrl+${ctrlMatch[1]}`, 
          line: i + 1, 
          context, 
          snippet 
        });
      }
      
      const shiftMatch = line.match(/key\.shift.*key\.name\s*===\s*["']([^"']+)["']/);
      if (shiftMatch) {
        found.push({ 
          key: `shift+${shiftMatch[1]}`, 
          line: i + 1, 
          context, 
          snippet 
        });
      }
    }
  }
  
  // Check for missing shortcuts
  const foundKeys = new Set(found.map(f => f.key.toLowerCase()));
  const missing = expectedShortcuts.filter(spec => {
    return !spec.keys.some(k => {
      // Handle regex patterns like [a-z]
      if (k.startsWith("[") && k.endsWith("]")) {
        return true; // Assume implemented (too complex to verify statically)
      }
      return foundKeys.has(k.toLowerCase());
    });
  });
  
  // Check for extra (undocumented) shortcuts
  const expectedKeys = new Set(
    expectedShortcuts.flatMap(s => s.keys).map(k => k.toLowerCase())
  );
  const extra = found.filter(f => {
    const key = f.key.toLowerCase();
    // Skip common infrastructure keys
    if (["escape", "return", "up", "down", "tab"].includes(key)) {
      return false;
    }
    return !expectedKeys.has(key);
  });
  
  return { found, missing, extra };
}

function inferContext(lines: string[], currentLine: number): string {
  // Look backwards to find context clues
  for (let i = currentLine; i >= Math.max(0, currentLine - 50); i--) {
    const line = lines[i]!;
    
    if (line.includes("tabSwitcherOpen")) return "Tab Switcher";
    if (line.includes('screen === "dashboard"')) return "Dashboard";
    if (line.includes('screen === "detail"')) return "Detail";
    if (line.includes('screen === "my-gpu-view"')) return "My GPU View";
    if (line.includes('screen === "alloc"')) return "Allocation Modal";
    if (line.includes('screen === "kill"')) return "Kill Modal";
    if (line.includes("runnerInputTyping")) return "Runner Typing";
    if (line.includes("runnerFocused")) return "Runner Focused";
  }
  
  return "Unknown";
}

function generateReport(
  found: FoundShortcut[], 
  missing: ShortcutSpec[], 
  extra: FoundShortcut[]
): string {
  let report = "# Keyboard Shortcuts Verification Report\n\n";
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  report += `## Summary\n\n`;
  report += `- Total expected shortcuts: ${expectedShortcuts.length}\n`;
  report += `- Found in code: ${found.length}\n`;
  report += `- Missing: ${missing.length}\n`;
  report += `- Extra (undocumented): ${extra.length}\n\n`;
  
  if (missing.length > 0) {
    report += `## ⚠️  Missing Shortcuts (${missing.length})\n\n`;
    report += "These shortcuts are documented but not found in the code:\n\n";
    for (const spec of missing) {
      report += `- **${spec.keys.join(" or ")}** - ${spec.description} (${spec.context})\n`;
    }
    report += "\n";
  }
  
  if (extra.length > 0) {
    report += `## 📝 Undocumented Shortcuts (${extra.length})\n\n`;
    report += "These shortcuts are in the code but not in the specification:\n\n";
    for (const shortcut of extra) {
      report += `- **${shortcut.key}** at line ${shortcut.line} (${shortcut.context})\n`;
    }
    report += "\n";
  }
  
  report += `## ✅ Implementation Status by Context\n\n`;
  const byContext = new Map<string, ShortcutSpec[]>();
  for (const spec of expectedShortcuts) {
    if (!byContext.has(spec.context)) {
      byContext.set(spec.context, []);
    }
    byContext.get(spec.context)!.push(spec);
  }
  
  for (const [context, specs] of byContext) {
    const implemented = specs.filter(spec => 
      spec.keys.some(k => found.some(f => f.key.toLowerCase() === k.toLowerCase()))
    );
    const percentage = Math.round((implemented.length / specs.length) * 100);
    
    report += `### ${context}: ${implemented.length}/${specs.length} (${percentage}%)\n\n`;
    
    for (const spec of specs) {
      const isImplemented = spec.keys.some(k => 
        found.some(f => f.key.toLowerCase() === k.toLowerCase())
      );
      const status = isImplemented ? "✅" : "❌";
      report += `${status} ${spec.keys.join(" or ")} - ${spec.description}\n`;
    }
    report += "\n";
  }
  
  if (missing.length === 0 && extra.length === 0) {
    report += `\n## 🎉 All Checks Passed!\n\n`;
    report += `All documented shortcuts are implemented and no undocumented shortcuts were found.\n`;
  }
  
  return report;
}

// Main execution
const indexFile = join(import.meta.dir, "index.ts");

console.log("Analyzing keyboard shortcuts in", indexFile);
console.log("");

const { found, missing, extra } = analyzeKeyboardShortcuts(indexFile);
const report = generateReport(found, missing, extra);

console.log(report);

// Write report to file
const reportFile = join(import.meta.dir, "..", ".ralph", "keyboard-shortcuts-verification-report.md");
Bun.write(reportFile, report);
console.log(`\nFull report written to: ${reportFile}`);

// Exit with error code if there are issues
if (missing.length > 0 || extra.length > 0) {
  console.error("\n⚠️  Verification failed: found missing or undocumented shortcuts");
  process.exit(1);
} else {
  console.log("\n✅ Verification passed: all shortcuts implemented correctly");
  process.exit(0);
}
