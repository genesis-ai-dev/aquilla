import { describe, it, expect } from "vitest"
import { detectPreAcceptanceWarnings } from "./preacceptance"
import type { Concept } from "./types"

function concept(partial: Partial<Concept> & Pick<Concept, "id" | "sourceTerm" | "renderings">): Concept {
  return {
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  }
}

const grace = concept({
  id: "c-grace",
  sourceTerm: "charis",
  renderings: [
    { rendering: "grace", status: "preferred" },
    { rendering: "favor", status: "admitted" },
    { rendering: "luck", status: "forbidden" },
  ],
})

describe("detectPreAcceptanceWarnings", () => {
  // WHY: a forbidden rendering slipping into a completion is the loudest signal —
  // the translator chose (via AI) wording the term owner explicitly banned.
  it("fires forbidden-present when a forbidden rendering appears in the completion", () => {
    const w = detectPreAcceptanceWarnings("It was pure luck", "the charis of God", [grace])
    const forbidden = w.find((x) => x.kind === "forbidden-present")
    expect(forbidden).toBeDefined()
    expect(forbidden?.conceptId).toBe("c-grace")
    expect(forbidden?.offendingText).toBe("luck")
  })

  // WHY: if the source bears a controlled term but the completion uses none of the
  // approved renderings, the required terminology is silently missing — that is the
  // core "preferred-absent" coordination failure we want to surface pre-commit.
  it("fires preferred-absent when no approved rendering is present", () => {
    const w = detectPreAcceptanceWarnings("It was a blessing", "the charis of God", [grace])
    expect(w.some((x) => x.kind === "preferred-absent" && x.conceptId === "c-grace")).toBe(true)
    // and no false forbidden warning, since "luck" is absent
    expect(w.some((x) => x.kind === "forbidden-present")).toBe(false)
  })

  // WHY: when the translator (or AI) used an approved rendering, there is nothing to
  // warn about — the band must stay silent or it becomes noise the user learns to ignore.
  it("stays silent when an approved rendering is present", () => {
    const w = detectPreAcceptanceWarnings("the grace of God", "the charis of God", [grace])
    expect(w).toHaveLength(0)
  })

  it("accepts an admitted rendering as satisfying the requirement", () => {
    const w = detectPreAcceptanceWarnings("the favor of God", "the charis of God", [grace])
    expect(w).toHaveLength(0)
  })

  // WHY: a concept whose source term is not in THIS source is irrelevant; warning on it
  // would flood every cell with warnings for the whole termbase.
  it("never warns on a concept whose source term is absent from the source", () => {
    const w = detectPreAcceptanceWarnings("nothing relevant here", "a plain sentence", [grace])
    expect(w).toHaveLength(0)
  })

  // WHY: matching must be case/whitespace-insensitive so trivial casing differences
  // don't cause false misses (forbidden slips through) or false absent warnings.
  it("matches case-insensitively and collapses whitespace", () => {
    const w = detectPreAcceptanceWarnings("It was pure   LUCK", "The  CHARIS of God", [grace])
    expect(w.some((x) => x.kind === "forbidden-present")).toBe(true)
  })

  // WHY: draft/deprecated concepts are not enforced terminology yet; they must not warn.
  it("ignores non-active concepts", () => {
    const draft = concept({ ...grace, id: "c-draft", status: "draft" })
    const w = detectPreAcceptanceWarnings("It was pure luck", "the charis of God", [draft])
    expect(w).toHaveLength(0)
  })

  // WHY: a concept with only a forbidden rendering has nothing "approved" to require,
  // so absence of an approved rendering must not manufacture a preferred-absent warning.
  it("does not fire preferred-absent when the concept has no approved renderings", () => {
    const forbiddenOnly = concept({
      id: "c-fonly",
      sourceTerm: "mammon",
      renderings: [{ rendering: "cash", status: "forbidden" }],
    })
    const clean = detectPreAcceptanceWarnings("riches deceive", "love of mammon", [forbiddenOnly])
    expect(clean).toHaveLength(0)
    const dirty = detectPreAcceptanceWarnings("cold hard cash", "love of mammon", [forbiddenOnly])
    expect(dirty.some((x) => x.kind === "forbidden-present")).toBe(true)
    expect(dirty.some((x) => x.kind === "preferred-absent")).toBe(false)
  })
})
