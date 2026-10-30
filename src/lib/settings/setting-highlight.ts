// A link can ask the page it opens to scroll to one setting and briefly
// highlight it: `?highlight=<element id>`. Used by the "This setting moved"
// notes (AQU-2265); any link may use it. The work is done once, app-wide, by
// useSettingHighlight.

export const SETTING_HIGHLIGHT_PARAM = "highlight"

/** `to` with a request to highlight the element whose id is `elementId`. */
export function settingHighlightHref(to: string, elementId: string): string {
  const [path, hash] = to.split("#", 2)
  const joiner = path.includes("?") ? "&" : "?"
  return `${path}${joiner}${SETTING_HIGHLIGHT_PARAM}=${encodeURIComponent(elementId)}${hash ? `#${hash}` : ""}`
}
