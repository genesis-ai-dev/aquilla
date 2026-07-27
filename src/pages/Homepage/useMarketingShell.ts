import { useEffect, useState } from "react"

/**
 * Shared theme chrome for the standalone marketing pages (/homepage, /beta,
 * the case studies, the unlisted BT landing).
 *
 * Initial read is saved choice → OS preference → dark; the page follows the OS
 * until the visitor explicitly toggles, then their choice wins for the session
 * (sessionStorage, key `aq-home-theme` — the same key the inline pre-paint
 * script in the *.html entries and the prerendered shell's theme stamp read).
 *
 * Display/script faces used to be injected here on mount; they now live in each
 * marketing page's <head> so the prerendered markup paints in its real
 * typeface. See scripts/prerender-marketing.ts.
 */

/** Saved choice wins; otherwise follow the OS color scheme; else dark. */
function readInitialTheme(): "light" | "dark" {
  try {
    const saved = sessionStorage.getItem("aq-home-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch { /* no storage */ }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch { return "dark" }
}

export function useMarketingShell() {
  const [theme, setTheme] = useState<"light" | "dark">(readInitialTheme)
  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark"
      try { sessionStorage.setItem("aq-home-theme", next) } catch { /* no storage */ }
      return next
    })

  // Follow the OS theme while the visitor hasn't explicitly toggled. Once they
  // pick a theme (saved in sessionStorage) their choice wins and system changes
  // are ignored.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => {
      try {
        const saved = sessionStorage.getItem("aq-home-theme")
        if (saved === "light" || saved === "dark") return
      } catch { /* no storage */ }
      setTheme(e.matches ? "dark" : "light")
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  return { theme, toggleTheme }
}
