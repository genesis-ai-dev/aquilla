import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { SETTING_HIGHLIGHT_PARAM } from "@/lib/settings/setting-highlight"

/** How long the highlight stays; matches `[data-setting-highlight]` in index.css. */
const HIGHLIGHT_MS = 2400
/** The page may still be loading the setting; look for it this long. */
const WAIT_MS = 5000
const POLL_MS = 100

/**
 * AQU-2265: when the address carries `?highlight=<id>`, scroll the element with
 * that id into view once it renders and flash it briefly. Mounted once for the
 * whole app, so a link to any page can point at one setting.
 *
 * An attribute rather than a class, for the reason row flashes use one
 * (src/lib/editor/row-flash.ts): React rewrites className whole.
 */
export function useSettingHighlight(): void {
  const location = useLocation()
  const target = new URLSearchParams(location.search).get(SETTING_HIGHLIGHT_PARAM)
  useEffect(() => {
    if (!target) return
    let pollTimer: number | undefined
    let clearTimer: number | undefined
    let highlighted: HTMLElement | null = null
    const startedAt = Date.now()
    const look = () => {
      const el = document.getElementById(target)
      if (!el) {
        if (Date.now() - startedAt < WAIT_MS) pollTimer = window.setTimeout(look, POLL_MS)
        return
      }
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" })
      el.setAttribute("data-setting-highlight", "")
      highlighted = el
      clearTimer = window.setTimeout(() => el.removeAttribute("data-setting-highlight"), HIGHLIGHT_MS)
    }
    look()
    return () => {
      window.clearTimeout(pollTimer)
      window.clearTimeout(clearTimer)
      highlighted?.removeAttribute("data-setting-highlight")
    }
  }, [location.key, target])
}

/** Mount point for {@link useSettingHighlight}; renders nothing. */
export function SettingHighlighter(): null {
  useSettingHighlight()
  return null
}
