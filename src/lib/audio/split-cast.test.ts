import { describe, expect, it } from "vitest"
import { castNameFromCellMetadata, copyCastsOntoSplitPieces, splitPieceBelongsTo } from "./split-cast"
import { laneTtsSettings } from "./lane-cast"
import { assignedCastVoiceId } from "./voices"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

describe("copyCastsOntoSplitPieces", () => {
  const splits = [{ cellId: "line-1", sameKindAsFirst: ["line-3"] }]

  it("copies each map's voice onto the new same-kind pieces and leaves the rest", () => {
    const next = copyCastsOntoSplitPieces({
      provider: "inworld",
      castAssignments: { "line-1": "narrator", other: "jesus" },
      laneCastAssignments: {
        sm: { "line-1": "sina" },
        ar: { "line-1": "layla", "line-3": "omar" },
        fr: { "line-1": "" },
        de: { other: "hans" },
      },
    }, splits)

    expect(next?.provider).toBe("inworld")
    expect(next?.castAssignments).toEqual({
      "line-1": "narrator",
      other: "jesus",
      "line-3": "narrator",
    })
    expect(next?.laneCastAssignments).toEqual({
      sm: { "line-1": "sina", "line-3": "sina" },
      ar: { "line-1": "layla", "line-3": "omar" },
      fr: { "line-1": "", "line-3": "" },
      de: { other: "hans" },
    })
    expect(copyCastsOntoSplitPieces({ castAssignments: {} }, splits)).toBeNull()
    expect(copyCastsOntoSplitPieces(undefined, splits)).toBeNull()
    expect(copyCastsOntoSplitPieces({ castAssignments: { "line-1": "narrator" } }, [
      { cellId: "line-1", sameKindAsFirst: [] },
    ])).toBeNull()
  })

  it("copies a lane's default sentinel so the new piece does not inherit the project voice", () => {
    const next = copyCastsOntoSplitPieces({
      voices: [{ id: "narrator", name: "Narrator", color: "#475569" }],
      castAssignments: { "line-1": "narrator" },
      laneCastAssignments: { fr: { "line-1": "" } },
    }, splits) as ProjectTtsSettings

    expect(next.laneCastAssignments).toEqual({ fr: { "line-1": "", "line-3": "" } })
    expect(assignedCastVoiceId(laneTtsSettings(next, "fr"), "line-3")).toBeUndefined()
    expect(assignedCastVoiceId(laneTtsSettings(next, "sm"), "line-3")).toBe("narrator")
  })

  it("copies a character's voice when the row has no entry of its own, and a line's own entry still wins", () => {
    const named = [{ cellId: "line-1", sameKindAsFirst: ["line-3"], castName: "JESUS" }]
    const spoken = copyCastsOntoSplitPieces({
      castAssignments: { "character:JESUS": "jesus" },
      laneCastAssignments: { es: { "character:JESUS": "es-jesus" }, de: { "character:MARY": "mary" } },
    }, named)
    expect(spoken?.castAssignments).toEqual({ "character:JESUS": "jesus", "line-3": "jesus" })
    expect(spoken?.laneCastAssignments).toEqual({
      es: { "character:JESUS": "es-jesus", "line-3": "es-jesus" },
      de: { "character:MARY": "mary" },
    })

    const ownWins = copyCastsOntoSplitPieces({
      castAssignments: { "line-1": "", "character:JESUS": "jesus" },
      laneCastAssignments: { fr: { "character:JESUS": "" } },
    }, named)
    expect(ownWins?.castAssignments).toEqual({ "line-1": "", "character:JESUS": "jesus", "line-3": "" })
    expect(ownWins?.laneCastAssignments).toEqual({ fr: { "character:JESUS": "", "line-3": "" } })

    expect(copyCastsOntoSplitPieces({ castAssignments: { "character:JESUS": "jesus" } }, splits)).toBeNull()
  })
})

describe("castNameFromCellMetadata", () => {
  it("reads a trimmed character name from object or JSON metadata", () => {
    expect(castNameFromCellMetadata({ cast_name: " Guide " })).toBe("Guide")
    expect(castNameFromCellMetadata(JSON.stringify({ cast_name: "Guide" }))).toBe("Guide")
    expect(castNameFromCellMetadata({ cast_name: "  " })).toBeUndefined()
    expect(castNameFromCellMetadata(null)).toBeUndefined()
  })
})

describe("splitPieceBelongsTo", () => {
  const origin = { aquillaOrigin: { version: 1, kind: "user-insert", splitFrom: "line-1" } }

  it("accepts only a piece split from the named row", () => {
    expect(splitPieceBelongsTo(origin, "line-1")).toBe(true)
    expect(splitPieceBelongsTo(JSON.stringify(origin), "line-1")).toBe(true)
    expect(splitPieceBelongsTo(origin, "other")).toBe(false)
    expect(splitPieceBelongsTo({ aquillaOrigin: { kind: "user-insert" } }, "line-1")).toBe(false)
    expect(splitPieceBelongsTo(null, "line-1")).toBe(false)
    expect(splitPieceBelongsTo("not json", "line-1")).toBe(false)
  })
})
