import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"

export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

const STORAGE_KEY = "codex-theme"

interface ThemeModeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (next: ThemeMode) => void
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null)

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system"
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system"
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function applyDarkClass(resolved: ResolvedTheme): void {
  const html = document.documentElement
  if (resolved === "dark") html.classList.add("dark")
  else html.classList.remove("dark")
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode())
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark())

  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode

  useEffect(() => {
    applyDarkClass(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  const value = useMemo<ThemeModeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  )

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>
}

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext)
  if (!ctx) throw new Error("useThemeMode must be used within ThemeModeProvider")
  return ctx
}

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, resolved, setMode } = useThemeMode()
  const next: ThemeMode = mode === "light" ? "dark" : mode === "dark" ? "system" : "light"
  const label =
    mode === "system"
      ? `Theme: system (${resolved}). Click for light.`
      : mode === "light"
        ? "Theme: light. Click for dark."
        : "Theme: dark. Click for system."
  const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun
  return (
    <AppTooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={() => setMode(next)}
        className={className}
      >
        <Icon />
      </Button>
    </AppTooltip>
  )
}
