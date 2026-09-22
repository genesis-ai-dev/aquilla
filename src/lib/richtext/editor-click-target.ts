/**
 * editor-click-target.ts — AQU-205: click precedence inside the target editor.
 *
 * A terminology-origin infraction paints TWO overlapping decorations over the
 * same run of text: the managed-term marker (`.term-chip-host[data-source-term]`,
 * AQU-204) and the violation blot (`[data-rule-id]`, `violation-blot-term`).
 * The violation owns the click, so a translator who clicks a flagged managed
 * term lands on the infraction detail — which carries the term's guidance —
 * rather than on the read-only lookup popover.
 *
 * Extracted from `TranslatedEditor`'s click handler so the precedence rule is
 * unit-testable without mounting TipTap.
 */

/** What a click inside the editor resolved to, in precedence order. */
export type EditorClickTarget =
  | { kind: "rule"; ruleId: string; element: HTMLElement }
  | { kind: "term"; term: string; element: HTMLElement }
  | null

/**
 * Resolve a click's originating element to the affordance that should handle
 * it. `handlers` mirrors which callbacks the editor was actually given — a
 * decoration with no handler is transparent, so the click falls through to the
 * next candidate.
 */
export function resolveEditorClickTarget(
  target: HTMLElement | null,
  handlers: { rule: boolean; term: boolean },
): EditorClickTarget {
  if (!target) return null

  if (handlers.rule) {
    const blot = target.closest<HTMLElement>("[data-rule-id]")
    if (blot) {
      return { kind: "rule", ruleId: blot.getAttribute("data-rule-id") ?? "", element: blot }
    }
  }

  if (handlers.term) {
    const termHighlight = target.closest<HTMLElement>(".term-chip-host[data-source-term]")
    const term = termHighlight?.getAttribute("data-source-term")
    if (termHighlight && term) {
      return { kind: "term", term, element: termHighlight }
    }
  }

  return null
}
