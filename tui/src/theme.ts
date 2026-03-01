/**
 * src/theme.ts
 * Shared color palette for the opensmi TUI.
 * Extracted from the top-level `const C` in index.ts so all modules can import it.
 */

export const C = {
  bg: "#1a1b26",
  bgAlt: "#24283b",
  border: "#565f89",
  text: "#c0caf5",
  textDim: "#565f89",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
} as const;
