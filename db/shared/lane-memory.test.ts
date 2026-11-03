// AQU-2348: the lane → project resolution every prompt reader shares.
//
// The behaviour these lock down is the regression guard for the whole feature:
// an absent lane entry MUST read exactly as it did before per-lane memory
// existed (no migration, single-lane projects untouched), and a lane that owns
// a section must not leak into any other lane.

import { describe, expect, it } from "vitest"
import {
  laneOwnedRowProblem,
  laneRowApplies,
  laneRowFilterSql,
  laneScopedRows,
  targetLaneIdForTag,
  resolveLaneEntries,
  resolveLaneMemory,
  resolveLaneOverride,
  systemPromptByLaneProblem,
  translationBriefByLaneProblem,
  withLaneMemoryValue,
  withoutLaneMemoryValue,
} from "./lane-memory"
import { PROJECT_SETTINGS_KEY_SPECS, settingsKeyDocLines, validateSettingsKeyValue } from "./project-settings-keys"

const FR = "a1b2c3d4"
const ES = "0f0f0f0f"

describe("resolveLaneOverride", () => {
  it("falls back to the project value when the lane has no copy", () => {
    expect(resolveLaneOverride("project", { [ES]: "lane" }, FR)).toEqual({
      value: "project",
      source: "project",
    })
  })

  it("returns the lane's copy when it has one", () => {
    expect(resolveLaneOverride("project", { [ES]: "lane" }, ES)).toEqual({
      value: "lane",
      source: "lane",
    })
  })

  it("reads as the project value when the map is absent — the pre-AQU-2348 answer", () => {
    expect(resolveLaneOverride("project", undefined, ES)).toEqual({
      value: "project",
      source: "project",
    })
  })

  it("treats an undefined lane as a management surface asking project-wide", () => {
    expect(resolveLaneOverride("project", { [ES]: "lane" }, undefined)).toEqual({
      value: "project",
      source: "project",
    })
  })

  it("honours a lane copy that is deliberately empty, so Revert is not a no-op", () => {
    expect(resolveLaneOverride("project", { [ES]: "" }, ES)).toEqual({ value: "", source: "lane" })
  })
})

describe("resolveLaneEntries", () => {
  const entries = [
    { id: "p1", laneId: undefined },
    { id: "e1", laneId: ES },
    { id: "p2" },
    { id: "f1", laneId: FR },
  ]

  it("unions the project's entries with the lane's own, project first", () => {
    expect(resolveLaneEntries(entries, ES).map((e) => e.id)).toEqual(["p1", "p2", "e1"])
  })

  it("never shows another lane's entries", () => {
    expect(resolveLaneEntries(entries, FR).map((e) => e.id)).toEqual(["p1", "p2", "f1"])
  })

  it("shows only project entries when no lane is asked for", () => {
    expect(resolveLaneEntries(entries, undefined).map((e) => e.id)).toEqual(["p1", "p2"])
  })

  it("is empty, not undefined, when the project has no entries", () => {
    expect(resolveLaneEntries(undefined, ES)).toEqual([])
  })
})

describe("resolveLaneMemory", () => {
  const settings = {
    systemPrompt: "project prompt",
    systemPromptByLane: { [ES]: "es prompt" },
    translationBrief: { l1Summary: "project brief" },
    translationBriefByLane: { [ES]: { l1Summary: "es brief" } },
    livingMemoryEntries: [{ id: "p1" }, { id: "e1", laneId: ES }],
  }

  it("gives a customized lane its own prompt, brief and entries", () => {
    const got = resolveLaneMemory(settings, ES)
    expect(got.systemPrompt).toEqual({ value: "es prompt", source: "lane" })
    expect(got.brief).toEqual({ value: { l1Summary: "es brief" }, source: "lane" })
    expect(got.entries.map((e) => e.id)).toEqual(["p1", "e1"])
  })

  it("gives an uncustomized lane the project's values, every part sourced to the project", () => {
    const got = resolveLaneMemory(settings, FR)
    expect(got.systemPrompt).toEqual({ value: "project prompt", source: "project" })
    expect(got.brief).toEqual({ value: { l1Summary: "project brief" }, source: "project" })
    expect(got.entries.map((e) => e.id)).toEqual(["p1"])
  })

  it("answers a project that has no lane memory at all exactly as before", () => {
    const got = resolveLaneMemory({ systemPrompt: "p", translationBrief: { l1Summary: "b" } }, ES)
    expect(got.systemPrompt).toEqual({ value: "p", source: "project" })
    expect(got.brief).toEqual({ value: { l1Summary: "b" }, source: "project" })
  })

  it("tolerates absent settings", () => {
    const got = resolveLaneMemory(null, ES)
    expect(got.systemPrompt).toEqual({ value: undefined, source: "project" })
    expect(got.entries).toEqual([])
  })
})

describe("targetLaneIdForTag", () => {
  const lanes = [
    { id: "11111111", role: "source" as const, legacyTag: null },
    { id: FR, role: "target" as const, legacyTag: "fr" },
    { id: ES, role: "target" as const, legacyTag: "" },
  ]

  it("maps a legacy tag to the lane id lane memory is keyed by", () => {
    expect(targetLaneIdForTag("fr", lanes)).toBe(FR)
  })

  it("maps the default lane's empty tag", () => {
    expect(targetLaneIdForTag("", lanes)).toBe(ES)
  })

  it("also accepts the id itself, for a caller holding either", () => {
    expect(targetLaneIdForTag(FR, lanes)).toBe(FR)
  })

  it("never resolves a source lane", () => {
    expect(targetLaneIdForTag("11111111", lanes)).toBeUndefined()
  })

  it("resolves to no lane — which reads as inherit — when no row carries the tag", () => {
    expect(targetLaneIdForTag("de", lanes)).toBeUndefined()
    expect(targetLaneIdForTag("fr", undefined)).toBeUndefined()
  })
})

describe("customize / revert writers", () => {
  it("stores a lane's copy without disturbing the others", () => {
    expect(withLaneMemoryValue({ [FR]: "fr" }, ES, "es")).toEqual({ [FR]: "fr", [ES]: "es" })
  })

  it("stores a copy equal to the project value — the lanes have still stopped sharing", () => {
    expect(withLaneMemoryValue(undefined, ES, "project prompt")).toEqual({ [ES]: "project prompt" })
  })

  it("removes only the reverted lane's copy", () => {
    expect(withoutLaneMemoryValue({ [FR]: "fr", [ES]: "es" }, ES)).toEqual({ [FR]: "fr" })
  })

  it("deletes the key rather than leaving an empty map behind", () => {
    expect(withoutLaneMemoryValue({ [ES]: "es" }, ES)).toBeUndefined()
  })

  it("is a no-op for a lane that was never customized", () => {
    expect(withoutLaneMemoryValue({ [FR]: "fr" }, ES)).toEqual({ [FR]: "fr" })
    expect(withoutLaneMemoryValue(undefined, ES)).toBeUndefined()
  })
})

describe("settings-key validation", () => {
  it("accepts a map keyed by lane id", () => {
    expect(systemPromptByLaneProblem({ [ES]: "es prompt" })).toBeNull()
    expect(translationBriefByLaneProblem({ [ES]: { l1Summary: "x" } })).toBeNull()
  })

  it("refuses a language or a legacy tag as the key, naming the rule", () => {
    expect(systemPromptByLaneProblem({ es: "x" })).toMatch(/not a lane id/)
    expect(translationBriefByLaneProblem({ "": {} })).toMatch(/not a lane id/)
  })

  it("refuses a value of the wrong shape", () => {
    expect(systemPromptByLaneProblem({ [ES]: 1 })).toMatch(/must be a string/)
    expect(translationBriefByLaneProblem({ [ES]: "not an object" })).toMatch(/must be a brief object/)
    expect(systemPromptByLaneProblem("nope")).toMatch(/keyed by lane id/)
  })

  it("is registered so an agent may write it through PatchSettings", () => {
    expect(PROJECT_SETTINGS_KEY_SPECS.systemPromptByLane).toBeDefined()
    expect(PROJECT_SETTINGS_KEY_SPECS.translationBriefByLane).toBeDefined()
    expect(validateSettingsKeyValue("systemPromptByLane", { [ES]: "x" })).toBeNull()
    expect(validateSettingsKeyValue("systemPromptByLane", { es: "x" })).not.toBeNull()
    expect(validateSettingsKeyValue("translationBriefByLane", { [ES]: {} })).toBeNull()
  })

  it("is discoverable in describe_command's key list", () => {
    const lines = settingsKeyDocLines()
    expect(lines.some((line) => line.startsWith("systemPromptByLane:"))).toBe(true)
    expect(lines.some((line) => line.startsWith("translationBriefByLane:"))).toBe(true)
  })
})

// ── lane-OWNED rows (knowledge documents, style rules) ──────────────────────
//
// Rows union rather than override, and the SQL filter and the in-memory filter
// must answer identically — a rule the database hands the health check must be
// the same rule the prompt builder compiles.

describe("laneRowApplies", () => {
  it("puts a project-wide row in force in every lane", () => {
    expect(laneRowApplies(null, FR)).toBe(true)
    expect(laneRowApplies(undefined, ES)).toBe(true)
    expect(laneRowApplies(null, undefined)).toBe(true)
  })

  it("puts a lane's own row in force only in that lane", () => {
    expect(laneRowApplies(ES, ES)).toBe(true)
    expect(laneRowApplies(ES, FR)).toBe(false)
    expect(laneRowApplies(ES, undefined)).toBe(false)
  })

  it("reads an empty owner as project-wide rather than as a lane nobody can name", () => {
    expect(laneRowApplies("", FR)).toBe(true)
  })
})

describe("laneScopedRows", () => {
  const rows = [
    { id: "p", laneId: null },
    { id: "es", laneId: ES },
    { id: "fr", laneId: FR },
    { id: "legacy", laneId: undefined },
  ]

  it("keeps the project's rows plus this lane's, in the order given", () => {
    expect(laneScopedRows(rows, ES).map((r) => r.id)).toEqual(["p", "es", "legacy"])
  })

  it("never leaks another lane's row", () => {
    expect(laneScopedRows(rows, FR).map((r) => r.id)).not.toContain("es")
  })

  it("keeps only the project's rows when no lane resolved — the pre-AQU-2348 set", () => {
    expect(laneScopedRows(rows, undefined).map((r) => r.id)).toEqual(["p", "legacy"])
  })

  it("is the whole list for a project where no row belongs to a lane", () => {
    const projectOnly = [{ id: "a", laneId: null }, { id: "b" }]
    expect(laneScopedRows(projectOnly, ES)).toEqual(projectOnly)
    expect(laneScopedRows(projectOnly, undefined)).toEqual(projectOnly)
  })
})

describe("laneRowFilterSql", () => {
  it("binds the lane and keeps the project's rows alongside it", () => {
    const { sql, binds } = laneRowFilterSql("lane_id", ES)
    expect(binds).toEqual([ES])
    expect(sql).toBe("((lane_id IS NULL OR lane_id = '') OR lane_id = ?)")
  })

  it("asks for project-wide rows only, with no binds, when no lane resolved", () => {
    expect(laneRowFilterSql("lane_id", undefined)).toEqual({
      sql: "(lane_id IS NULL OR lane_id = '')",
      binds: [],
    })
  })

  it("agrees with the in-memory predicate on every case", () => {
    // The pair is the contract: whatever the DB filters out, the client filter
    // must also drop, or a rule reaches the prompt that the health check
    // never lints (and the other way round).
    for (const lane of [ES, FR, undefined]) {
      const { binds } = laneRowFilterSql("lane_id", lane)
      for (const owner of [null, "", ES, FR]) {
        const sqlKeeps = owner == null || owner === "" || binds.includes(owner)
        expect(laneRowApplies(owner, lane)).toBe(sqlKeeps)
      }
    }
  })
})

describe("laneOwnedRowProblem", () => {
  it("accepts a project row with no lane — what every row was before", () => {
    expect(laneOwnedRowProblem(null, { orgOwned: false })).toBeNull()
    expect(laneOwnedRowProblem(undefined, { orgOwned: false })).toBeNull()
    expect(laneOwnedRowProblem("", { orgOwned: false })).toBeNull()
  })

  it("accepts a lane id on a project row", () => {
    expect(laneOwnedRowProblem(ES, { orgOwned: false })).toBeNull()
  })

  it("refuses a language or a legacy tag, naming the rule", () => {
    expect(laneOwnedRowProblem("es", { orgOwned: false })).toMatch(/not a lane id/)
  })

  it("refuses a lane on an org-shared row, because lane ids are project-local", () => {
    expect(laneOwnedRowProblem(ES, { orgOwned: true })).toMatch(/organization-wide/)
  })
})
