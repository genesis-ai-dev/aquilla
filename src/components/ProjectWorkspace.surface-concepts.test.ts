/**
 * AQU-1721 — which concepts each workspace surface reads.
 *
 * The editor surfaces (source highlights, the term-lookup popover, Check file)
 * must apply the termbases a project subscribes to ahead of its own concepts,
 * in the order useRules compiles them. The glossary must never receive a
 * subscribed concept: it edits what it lists, and an edit to an upstream
 * concept is a term.* event that the server drops while the glossary shows it
 * saved. Tested at the helper — the same extract-the-helper pattern as
 * buildGlosserSeeds — since rendering the full ProjectWorkspace isn't needed
 * to prove the split.
 */
import { describe, it, expect } from "vitest"
import { workspaceTerminology } from "./project-workspace-helpers"
import type { Concept } from "@/lib/terminology/types"

function concept(id: string, termbaseProjectId?: string): Concept {
  return {
    id,
    sourceTerm: id,
    renderings: [{ rendering: `r-${id}`, status: "preferred" }],
    status: "active",
    createdAt: "2026-10-01T00:00:00Z",
    ...(termbaseProjectId ? { termbaseProjectId } : {}),
  }
}

describe("workspaceTerminology (AQU-1721)", () => {
  it("gives the editor the subscribed termbases first, then the project's own concepts", () => {
    const local = [concept("own")]
    const subscribed = [concept("org-1", "tb-org"), concept("org-2", "tb-org")]

    expect(workspaceTerminology(local, subscribed).editor.map((c) => c.id)).toEqual(["org-1", "org-2", "own"])
  })

  it("never gives the glossary a subscribed concept", () => {
    const local = [concept("own")]

    const { glossary } = workspaceTerminology(local, [concept("org-1", "tb-org")])

    expect(glossary.map((c) => c.id)).toEqual(["own"])
    expect(glossary.some((c) => c.termbaseProjectId !== undefined)).toBe(false)
  })

  it("hands the editor the project's own array when there are no subscriptions", () => {
    // Same identity, so the editor record and every memo keyed on it stay put.
    const local = [concept("own")]

    expect(workspaceTerminology(local, []).editor).toBe(local)
  })
})
