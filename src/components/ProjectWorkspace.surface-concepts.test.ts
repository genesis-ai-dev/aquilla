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
import { editorConceptsForLane, workspaceTerminology } from "./project-workspace-helpers"
import { conceptsForLaneTag, mapSubscribedConceptLanes } from "@/lib/terminology/rendering-lane"
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

// AQU-1777: Check file and the lookup popover read the active lane's slice of
// the editor list. A subscribed rendering reaches that list stamped with THIS
// project's lane id (route #8 maps it from its termbase lane by language), so
// the one lane rule puts it in the matching lane and nowhere else.
describe("editorConceptsForLane (AQU-1777)", () => {
  const laneRow = (id: string, legacyTag: string, language: string) => ({
    id,
    role: "target" as const,
    legacyTag,
    language,
    name: null,
    langCode: null,
  })
  // This project: a Spanish `''` lane and a French lane.
  const laneRows = [laneRow("50000e5a", "", "Spanish"), laneRow("50000f7a", "fr", "French")]
  // The termbase: a Spanish `''` lane (as a code) and a French lane.
  const termbaseLanes = [laneRow("t0000e5a", "", "es"), laneRow("t0000f7a", "fr", "French")]

  it("hands Check file and the lookup popover a subscribed rendering in the matching lane only", () => {
    const local = [concept("own")]
    const subscribed = mapSubscribedConceptLanes(
      [
        {
          ...concept("grace", "tb"),
          renderings: [
            { rendering: "gracia", status: "preferred" as const }, // unstamped: the termbase's `''` lane
            { rendering: "grâce", status: "preferred" as const, laneId: "t0000f7a" },
          ],
        },
      ],
      termbaseLanes,
      laneRows,
    )
    const editor = workspaceTerminology(local, subscribed).editor
    const slice = (lane: string) =>
      editorConceptsForLane(editor, local, conceptsForLaneTag(local, lane, laneRows), lane, laneRows).map((c) => [
        c.id,
        c.renderings.map((r) => r.rendering),
      ])

    expect(slice("")).toEqual([
      ["grace", ["gracia"]],
      ["own", ["r-own"]],
    ])
    expect(slice("fr")).toEqual([
      ["grace", ["grâce"]],
      ["own", []],
    ])
  })

  it("reuses the local slice when there are no subscriptions", () => {
    const local = [concept("own")]
    const laneLocal = conceptsForLaneTag(local, "", laneRows)
    expect(editorConceptsForLane(local, local, laneLocal, "", laneRows)).toBe(laneLocal)
  })
})
