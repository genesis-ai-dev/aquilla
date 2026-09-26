/**
 * AQU-205 — a terminology-origin infraction must stay clickable through to the
 * infraction detail even though the managed-term marker (AQU-204) paints the
 * same run of text. Without the precedence rule guarded here, a flagged term
 * opens the read-only lookup popover and the translator never sees why the
 * rendering was rejected.
 */

import { describe, it, expect } from "vitest"
import { resolveEditorClickTarget } from "./editor-click-target"

const BOTH = { rule: true, term: true }

/** Renders `html` and returns the innermost element carrying `data-hit`. */
function clickTargetFrom(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  const hit = host.querySelector<HTMLElement>("[data-hit]")
  if (!hit) throw new Error("fixture must mark the click origin with data-hit")
  return hit
}

describe("resolveEditorClickTarget", () => {
  it("gives the violation blot precedence over an overlapping managed-term marker", () => {
    const target = clickTargetFrom(`
      <span class="term-chip-host" data-source-term="grace">
        <span class="violation-blot violation-blot-major violation-blot-term"
              data-rule-id="term:concept-42:forbidden:forbidden" data-hit>gracia</span>
      </span>`)

    const hit = resolveEditorClickTarget(target, BOTH)

    expect(hit?.kind).toBe("rule")
    expect(hit).toMatchObject({ ruleId: "term:concept-42:forbidden:forbidden" })
  })

  it("opens the term lookup for a managed term with no infraction", () => {
    const target = clickTargetFrom(
      `<span class="term-chip-host terminology-highlight" data-source-term="grace" data-hit>gracia</span>`,
    )

    const hit = resolveEditorClickTarget(target, BOTH)

    expect(hit?.kind).toBe("term")
    expect(hit).toMatchObject({ term: "grace" })
  })

  it("resolves a generic (non-terminology) violation to the rule detail", () => {
    const target = clickTargetFrom(
      `<span class="violation-blot violation-blot-minor" data-rule-id="rule-7" data-hit>oops</span>`,
    )

    expect(resolveEditorClickTarget(target, BOTH)).toMatchObject({ kind: "rule", ruleId: "rule-7" })
  })

  it("falls through to the term marker when the editor has no rule handler", () => {
    const target = clickTargetFrom(`
      <span class="term-chip-host" data-source-term="grace">
        <span class="violation-blot violation-blot-term" data-rule-id="term:c1:forbidden" data-hit>gracia</span>
      </span>`)

    expect(resolveEditorClickTarget(target, { rule: false, term: true })).toMatchObject({
      kind: "term",
      term: "grace",
    })
  })

  it("ignores a term host with an empty source term", () => {
    const target = clickTargetFrom(`<span class="term-chip-host" data-source-term="" data-hit>x</span>`)

    expect(resolveEditorClickTarget(target, BOTH)).toBeNull()
  })

  it("returns null for plain text and for a missing target", () => {
    expect(resolveEditorClickTarget(clickTargetFrom(`<span data-hit>plain</span>`), BOTH)).toBeNull()
    expect(resolveEditorClickTarget(null, BOTH)).toBeNull()
  })
})
