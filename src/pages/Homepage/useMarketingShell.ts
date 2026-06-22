import { useEffect, useState } from "react"

/**
 * Shared chrome for the standalone marketing pages (/homepage, /beta).
 *
 * Owns the two concerns both pages need identically:
 *  - theme: initial read (saved choice → OS preference → dark), follow the OS
 *    until the visitor explicitly toggles, then persist their choice for the
 *    session (sessionStorage, key `aq-home-theme` — same key the inline
 *    pre-paint script in the *.html entries reads).
 *  - fonts: load the Fraunces display face + Noto faces for the rarer scripts
 *    only while a marketing page is mounted.
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

  // Load the Fraunces display face only while a marketing page is mounted.
  useEffect(() => {
    const id = "aq-fonts"
    if (!document.getElementById(id)) {
      const pre1 = document.createElement("link")
      pre1.rel = "preconnect"; pre1.href = "https://fonts.googleapis.com"
      const pre2 = document.createElement("link")
      pre2.rel = "preconnect"; pre2.href = "https://fonts.gstatic.com"; pre2.crossOrigin = "anonymous"
      const link = document.createElement("link")
      link.id = id
      link.rel = "stylesheet"
      link.href =
        "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..620;1,9..144,300..560&display=swap"
      // Noto faces for the less-common scripts in the language reel (Coptic,
      // Geʻez, Tibetan) so they render instead of falling back to tofu boxes.
      const noto = document.createElement("link")
      noto.rel = "stylesheet"
      noto.href =
        "https://fonts.googleapis.com/css2?family=Noto+Sans+Coptic&family=Noto+Serif+Ethiopic:wght@400..600&family=Noto+Serif+Tibetan:wght@400..600&display=swap"
      document.head.append(pre1, pre2, link, noto)
    }
  }, [])

  return { theme, toggleTheme }
}
