import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

/**
 * App-wide UI scale (AQU-1169). Sets the document root font-size so rem-based
 * chrome (sidebars, headers, dialogs, settings) scales together. Default leaves
 * the root unset so today's sizes stay exact. Per-file editor cell text is
 * pixel-based and is intentionally not scaled here (AQU-1170).
 *
 * Pixel map matches Linear's live Preferences client:
 * Small 14 / Default unset (16) / Large 18 / Extra Large 20.
 */

export const FONT_SIZE_SCALES = ["small", "default", "large", "extra-large"] as const
export type FontSizeScale = (typeof FONT_SIZE_SCALES)[number]

/** Root font-size in px. `null` means unset — the browser default (16px). */
export const FONT_SIZE_ROOT_PX: Record<FontSizeScale, number | null> = {
  small: 14,
  default: null,
  large: 18,
  "extra-large": 20,
}

export const FONT_SIZE_STORAGE_KEY = "aquilla-font-size"

interface FontSizeContextValue {
  scale: FontSizeScale
  setScale: (next: FontSizeScale) => void
}

const FontSizeContext = createContext<FontSizeContextValue | null>(null)

export function isFontSizeScale(raw: string | null): raw is FontSizeScale {
  return raw === "small" || raw === "default" || raw === "large" || raw === "extra-large"
}

export function readStoredFontSizeScale(): FontSizeScale {
  if (typeof window === "undefined") return "default"
  const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
  return isFontSizeScale(raw) ? raw : "default"
}

export function applyFontSizeScale(scale: FontSizeScale): void {
  if (typeof document === "undefined") return
  const html = document.documentElement
  const px = FONT_SIZE_ROOT_PX[scale]
  if (px == null) html.style.removeProperty("font-size")
  else html.style.fontSize = `${px}px`
}

export function FontSizeProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<FontSizeScale>(() => readStoredFontSizeScale())

  useEffect(() => {
    applyFontSizeScale(scale)
  }, [scale])

  const setScale = useCallback((next: FontSizeScale) => {
    setScaleState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next)
    }
    applyFontSizeScale(next)
  }, [])

  const value = useMemo<FontSizeContextValue>(
    () => ({ scale, setScale }),
    [scale, setScale],
  )

  return <FontSizeContext.Provider value={value}>{children}</FontSizeContext.Provider>
}

export function useFontSizeScale(): FontSizeContextValue {
  const ctx = useContext(FontSizeContext)
  if (!ctx) throw new Error("useFontSizeScale must be used within FontSizeProvider")
  return ctx
}
