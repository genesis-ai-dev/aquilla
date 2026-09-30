// Pure and dependency-free so the auth-worker and sync-worker can import it
// directly via a relative path (like src/lib/lanes/read-wall).

/**
 * Structural USFM markers that carry no text of their own: \p \m \b \nb, plus
 * \q, \pi and \li with an optional level digit (\q, \q1..\q4, \pi1, \li2).
 * Anything else (\pn, \pc, \q1 with text after it) is not matched.
 */
const BARE_MARKER_LINE = /^\\(?:p|m|b|nb|q\d?|pi\d?|li\d?)$/

/**
 * Strip bare structural markers that sit alone on the final line(s) of a cell
 * value. In-app USFM import leaves a trailing `\p` on verse cells
 * ("First verse.\n\p"); AI drafts copy it. Only whole trailing lines made of a
 * listed marker are removed, so a mid-text `\p`, `\q1 text` and footnotes are
 * untouched. Surrounding whitespace is trimmed only when something was
 * stripped; other text is returned as given.
 */
export function stripTrailingBareMarkers(text: string): string {
  const lines = text.split(/\r?\n/)
  let end = lines.length
  let stripped = false
  while (end > 0) {
    const line = lines[end - 1].trim()
    if (line === "" || BARE_MARKER_LINE.test(line)) {
      if (line !== "") stripped = true
      end--
      continue
    }
    break
  }
  if (!stripped) return text
  return lines.slice(0, end).join("\n").trimEnd()
}
