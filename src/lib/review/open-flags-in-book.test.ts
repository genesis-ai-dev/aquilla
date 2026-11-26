import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import type { MemberScope } from "@/lib/sync/member-scopes"
import { openFlagsInBook } from "./open-flags-in-book"

const ME = "me"

function cell(over: Partial<CellData> & { id: string }): CellData {
  return {
    original: "source",
    translated: "clean text",
    fileId: "exo",
    context: "",
    group: "",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    targetEventId: "evt",
    ...over,
  }
}

function rule(id: string, pattern: string, enabled = true): TranslationRule {
  return {
    id,
    name: id,
    description: "",
    severity: "major",
    source: "user",
    scope: "project",
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    check: { type: "target-forbids", targetPattern: pattern },
  }
}

const wrong = rule("wrong", "wrong")
const library = rule("library", "library")
const quiet = rule("quiet", "quiet", false)

describe("openFlagsInBook", () => {
  it("runs project and library rules only on cells this run would sign off", async () => {
    const checked: string[] = []
    const flags = await openFlagsInBook({
      cells: [
        cell({ id: "wrong", translated: "has wrong" }),
        cell({ id: "library", translated: "has library" }),
        cell({ id: "clean", translated: "clean text" }),
        cell({ id: "waived", translated: "has wrong", waivers: [{ ruleId: "wrong", waivedAt: "2026-01-01T00:00:00.000Z" }] }),
        cell({ id: "empty", translated: "", status: "empty" }),
        cell({ id: "signed", translated: "has wrong", activeValidators: [ME] }),
        cell({ id: "draft", translated: "has wrong", aiDrafted: true }),
        cell({ id: "mine", translated: "has wrong", lastEditor: ME }),
        cell({ id: "other-file", translated: "has wrong", fileId: "lev" }),
        cell({ id: "quiet", translated: "has quiet" }),
      ],
      username: ME,
      myScopes: [{ kind: "file", value: "exo" }],
      activeLane: "",
      allowSelfValidation: false,
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      projectRules: [wrong, quiet],
      libraryMayLint: true,
      rulesForCell: (item, _fileId, enabled) => {
        checked.push(item.id)
        expect(enabled.map((entry) => entry.id)).toEqual(["wrong"])
        return [...enabled, library]
      },
    })

    expect(checked.sort()).toEqual(["clean", "library", "quiet", "waived", "wrong"])
    expect([...flags].sort()).toEqual(["library", "wrong"])
  })

  it("skips a cell that already has enough signatures when that box is off", async () => {
    const rulesForCell = vi.fn(() => [wrong])
    const flags = await openFlagsInBook({
      cells: [cell({ id: "done", translated: "has wrong", activeValidators: ["joy"] })],
      username: ME,
      myScopes: [],
      activeLane: "",
      includeReadyCells: true,
      includeSignedByOthers: false,
      validationCount: 1,
      includeUntouchedAiDrafts: false,
      projectRules: [wrong],
      libraryMayLint: false,
      rulesForCell,
    })
    expect(flags.size).toBe(0)
    expect(rulesForCell).not.toHaveBeenCalled()
  })

  it("leaves a ready cell unchecked when that box is off", async () => {
    const rulesForCell = vi.fn(() => [wrong])
    const flags = await openFlagsInBook({
      cells: [cell({ id: "ready", translated: "has wrong" })],
      username: ME,
      myScopes: [] as MemberScope[],
      activeLane: "",
      includeReadyCells: false,
      includeUntouchedAiDrafts: false,
      projectRules: [wrong],
      libraryMayLint: false,
      rulesForCell,
    })
    expect(flags.size).toBe(0)
    expect(rulesForCell).not.toHaveBeenCalled()
  })

  it("skips the walk when no enabled rule and no library rule can flag a cell", async () => {
    const rulesForCell = vi.fn(() => [quiet])
    const flags = await openFlagsInBook({
      cells: [cell({ id: "a", translated: "has quiet" })],
      username: ME,
      myScopes: [],
      activeLane: "",
      includeReadyCells: true,
      includeUntouchedAiDrafts: true,
      projectRules: [quiet],
      libraryMayLint: false,
      rulesForCell,
    })
    expect(flags.size).toBe(0)
    expect(rulesForCell).not.toHaveBeenCalled()
  })

  it("yields once a slice of checks has used its time", async () => {
    let clock = 0
    const yields: number[] = []
    await openFlagsInBook({
      cells: [
        cell({ id: "a", translated: "has wrong" }),
        cell({ id: "b", translated: "has wrong" }),
        cell({ id: "c", translated: "clean text" }),
      ],
      username: ME,
      myScopes: [],
      activeLane: "",
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      projectRules: [wrong],
      libraryMayLint: false,
      rulesForCell: (_cell, _fileId, enabled) => {
        clock += 10
        return enabled
      },
      now: () => clock,
      yieldNow: async () => {
        yields.push(clock)
      },
      sliceMs: 8,
    })
    expect(yields).toEqual([10, 20, 30])
  })
})
