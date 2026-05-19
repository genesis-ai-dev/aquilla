/* eslint-disable react-refresh/only-export-components */
// Workspace re-export of the shared theme primitive from @aquilla/ui.
//
// The provider, hook, toggle, and storage key all live in
// `packages/ui/src/theme-mode.tsx` so every app on aquilla.app participates
// in the same theme state. Keep this re-export shim so existing workspace
// imports (`@/branding/ThemeMode`) continue to resolve.
//
// Local alias `ThemeModeProvider` is preserved because that's what
// `apps/workspace/src/main.tsx` already imports.

import {
  ThemeProvider,
  ThemeToggle,
  useTheme,
  applyStoredTheme,
  THEME_STORAGE_KEY,
} from "@aquilla/ui"
import type { ThemeMode, ResolvedTheme } from "@aquilla/ui"

export {
  ThemeProvider as ThemeModeProvider,
  ThemeToggle,
  useTheme as useThemeMode,
  applyStoredTheme,
  THEME_STORAGE_KEY,
}
export type { ThemeMode, ResolvedTheme }
