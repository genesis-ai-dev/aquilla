import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"

export type ColorTheme = "blue" | "warm" | "sage" | "rose"

const STORAGE_KEY = "codex-color-theme"
const DEFAULT: ColorTheme = "blue"

export const COLOR_THEMES: { id: ColorTheme; label: string; swatch: string }[] = [
  { id: "blue", label: "Blue", swatch: "oklch(0.72 0.12 250)" },
  { id: "warm", label: "Warm", swatch: "oklch(0.80 0.085 85)" },
  { id: "sage", label: "Sage", swatch: "oklch(0.78 0.07 150)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.78 0.08 20)" },
]

interface Ctx {
  theme: ColorTheme
  setTheme: (next: ColorTheme) => void
}

const ColorThemeContext = createContext<Ctx | null>(null)

function read(): ColorTheme {
  if (typeof window === "undefined") return DEFAULT
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === "blue" || raw === "warm" || raw === "sage" || raw === "rose" ? raw : DEFAULT
}

function apply(theme: ColorTheme): void {
  // Always set the attribute — including for the "blue" default. Blue now has an
  // explicit tinted preset in index.css; if we removed the attribute for blue it
  // would fall through to the near-neutral base :root chrome and read grey. (AQU-362)
  document.documentElement.setAttribute("data-color-theme", theme)
}

export function ColorThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ColorTheme>(() => read())

  useEffect(() => {
    apply(theme)
  }, [theme])

  const setTheme = useCallback((next: ColorTheme) => {
    setThemeState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  const value = useMemo<Ctx>(() => ({ theme, setTheme }), [theme, setTheme])
  return <ColorThemeContext.Provider value={value}>{children}</ColorThemeContext.Provider>
}

export function useColorTheme(): Ctx {
  const ctx = useContext(ColorThemeContext)
  if (!ctx) throw new Error("useColorTheme must be used within ColorThemeProvider")
  return ctx
}

export function ColorThemePicker() {
  const { theme, setTheme } = useColorTheme()
  return (
    <div className="flex items-center gap-1">
      {COLOR_THEMES.map((t) => {
        const active = t.id === theme
        return (
          <AppTooltip key={t.id} content={t.label}>
            <button
              type="button"
              onClick={() => setTheme(t.id)}
              aria-label={`Color theme: ${t.label}`}
              aria-pressed={active}
              className="relative grid h-6 w-6 place-items-center rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: t.swatch }}
            >
              {active && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
            </button>
          </AppTooltip>
        )
      })}
    </div>
  )
}
