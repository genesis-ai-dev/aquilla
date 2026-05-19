/* eslint-disable react-refresh/only-export-components */
// Shared theme-mode primitive for every Aquilla app.
//
// (eslint-disable: this file is a React-context module — the same
// reason the rule exists for fast-refresh doesn't apply because
// `useTheme`/`applyStoredTheme`/`THEME_STORAGE_KEY` ship alongside the
// `ThemeProvider` that consumes them. Splitting them would force
// callers to import from two files for one feature.)
//
// Coherence story (cross-app):
//   - All apps deploy under the same origin (`aquilla.app/*`), so localStorage
//     under the key `codex-theme` is shared. Setting the mode in any app
//     persists for every other app.
//   - To avoid FOUC, each app's index.html runs an inline pre-paint script
//     that mirrors `applyDarkClass` below. That script is duplicated by
//     design (it must execute before any module loads) — keep it in sync
//     with `STORAGE_KEY` and the resolution rule here.
//   - A `storage` event listener picks up changes made in other tabs and
//     in other apps' tabs, so toggling theme in one tab updates open
//     siblings without a refresh.
//
// API surface intentionally tiny: `ThemeProvider`, `useTheme`, `ThemeToggle`,
// `applyStoredTheme` (for non-React boot paths). The workspace's older
// `branding/ThemeMode.tsx` re-exports from here so existing imports keep
// working during the transition.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { Button } from "./button"

export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "codex-theme"

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (next: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system"
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system"
  } catch {
    return "system"
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function applyDarkClass(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return
  const html = document.documentElement
  if (resolved === "dark") html.classList.add("dark")
  else html.classList.remove("dark")
}

/**
 * Apply the stored theme synchronously. Safe to call from anywhere; the
 * inline pre-paint script in index.html is the production path that
 * avoids FOUC, but this is useful for SSR / Tauri / non-vite consumers.
 */
export function applyStoredTheme(): ResolvedTheme {
  const mode = readStoredMode()
  const resolved: ResolvedTheme = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode
  applyDarkClass(resolved)
  return resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode())
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark())

  // Watch OS-level preference flips while mode === "system".
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  // Cross-tab + cross-app sync. The `storage` event fires when another
  // document on the same origin updates localStorage. We re-read on any
  // hit so two open tabs (e.g. /projects and /w/<id>) stay in sync.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return
      setModeState(readStoredMode())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode

  useEffect(() => {
    applyDarkClass(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // ignore quota / private-mode storage errors — runtime stays
        // controlled by in-memory state for this tab.
      }
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider")
  return ctx
}

// Minimal inline-SVG icons so this primitive has no `lucide-react`
// dependency (the workspace pulls it in, but the auth apps don't and
// shouldn't have to). Sizing matches lucide's stroke conventions so
// these slot into a `<Button size="icon">` without visual drift.

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  )
}

interface ThemeToggleProps {
  className?: string
}

/**
 * Three-state toggle: light → dark → system → light. The cycle keeps
 * the control single-tap so it fits in any app's header without a
 * dropdown.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { mode, resolved, setMode } = useTheme()
  const next: ThemeMode = mode === "light" ? "dark" : mode === "dark" ? "system" : "light"
  const label =
    mode === "system"
      ? `Theme: system (${resolved}). Click for light.`
      : mode === "light"
        ? "Theme: light. Click for dark."
        : "Theme: dark. Click for system."
  const Icon = mode === "system" ? MonitorIcon : mode === "dark" ? MoonIcon : SunIcon
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => setMode(next)}
      className={className}
      data-testid="theme-toggle"
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}
