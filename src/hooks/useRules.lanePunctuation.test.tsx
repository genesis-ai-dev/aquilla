import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useRules } from "./useRules"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * AQU-1906 — what the EDITOR's rule set carries for its active lane:
 *
 *   * the lane's punctuation conventions, stamped on the two punctuation
 *     checks so the underline, the Issues tab, the health ribbon and Check
 *     file all judge the target by the same marks;
 *   * the lane's own on/off and severity overrides, laid over the
 *     project-wide ones.
 */

vi.mock("@/lib/store/project-index", () => ({
  patchProject: vi.fn(async (_id: string, updater: (p: ProjectRecord) => ProjectRecord) => updater(base())),
}))

type LaneRow = NonNullable<ProjectRecord["lanes"]>[number]

const laneRow = (over: Partial<LaneRow>): LaneRow => ({
  id: "l",
  role: "target",
  language: null,
  name: null,
  langCode: null,
  legacyTag: null,
  position: 0,
  archivedAt: null,
  ...over,
})

function base(): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "English",
    targetLanguage: "Spanish",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    lanes: [
      laneRow({ id: "s", role: "source", language: "English" }),
      laneRow({ id: "a", language: "Spanish", legacyTag: "" }),
      laneRow({ id: "b", language: "Thai", legacyTag: "th-lane" }),
    ],
  } as ProjectRecord
}

const noop = () => {}

const punctuationOf = (rules: TranslationRule[], checkId: string) => {
  const rule = rules.find((r) => r.id === `builtin:${checkId}`)
  return rule?.check.type === "builtin" ? rule.check.punctuation : undefined
}

describe("useRules — the active lane's punctuation conventions", () => {
  it("stamps the lane's conventions onto the two punctuation checks only", () => {
    const { result } = renderHook(() => useRules(base(), noop, undefined, undefined, undefined, "th-lane"))
    expect(punctuationOf(result.current.rules, "end-punctuation-mismatch")?.noTerminalMark).toBe(true)
    expect(punctuationOf(result.current.rules, "punctuation-integrity")?.noTerminalMark).toBe(true)
    expect(punctuationOf(result.current.rules, "double-space")).toBeUndefined()
  })

  it("stamps nothing for a lane whose language the table does not know", () => {
    const { result } = renderHook(() => useRules(base(), noop, undefined, undefined, undefined, ""))
    expect(punctuationOf(result.current.rules, "end-punctuation-mismatch")).toBeUndefined()
  })

  it("stamps nothing on a management surface, which asks for no lane", () => {
    const { result } = renderHook(() => useRules(base(), noop))
    expect(punctuationOf(result.current.rules, "end-punctuation-mismatch")).toBeUndefined()
  })

  it("keeps one identity for the rule set across renders, so consumer memos do not re-run", () => {
    const project = base()
    const { result, rerender } = renderHook(() =>
      useRules(project, noop, undefined, undefined, undefined, "th-lane"),
    )
    const first = result.current.rules
    rerender()
    expect(result.current.rules).toBe(first)
  })
})

describe("useRules — per-lane built-in check overrides", () => {
  const withOverrides = (): ProjectRecord => ({
    ...base(),
    algorithmicChecks: { "double-space": { enabled: false } },
    algorithmicChecksByLane: { "th-lane": { "end-punctuation-mismatch": { enabled: false } } },
  })

  const enabled = (rules: TranslationRule[], checkId: string) =>
    rules.find((r) => r.id === `builtin:${checkId}`)?.enabled

  it("applies the lane's switch in that lane and leaves the other lane alone", () => {
    const off = renderHook(() => useRules(withOverrides(), noop, undefined, undefined, undefined, "th-lane"))
    expect(enabled(off.result.current.builtinRules, "end-punctuation-mismatch")).toBe(false)
    const on = renderHook(() => useRules(withOverrides(), noop, undefined, undefined, undefined, ""))
    expect(enabled(on.result.current.builtinRules, "end-punctuation-mismatch")).toBe(true)
    // The project-wide override still applies in both.
    expect(enabled(off.result.current.builtinRules, "double-space")).toBe(false)
    expect(enabled(on.result.current.builtinRules, "double-space")).toBe(false)
  })

  it("writes a lane override to algorithmicChecksByLane, never to the project-wide key", async () => {
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() => useRules(base(), noop, patchShared))
    await act(async () => {
      await result.current.setBuiltinOverride("end-punctuation-mismatch", { enabled: false }, "th-lane")
    })
    const sent = patchShared.mock.calls[0][0]
    expect(sent.algorithmicChecksByLane).toEqual({
      "th-lane": { "end-punctuation-mismatch": { enabled: false } },
    })
    expect(sent.algorithmicChecks).toBeUndefined()
  })

  it("still writes the project-wide key when no lane is named (a single-lane project)", async () => {
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() => useRules(base(), noop, patchShared))
    await act(async () => {
      await result.current.setBuiltinOverride("end-punctuation-mismatch", { enabled: false })
    })
    const sent = patchShared.mock.calls[0][0]
    expect(sent.algorithmicChecks?.["end-punctuation-mismatch"]).toEqual({ enabled: false })
    expect(sent.algorithmicChecksByLane).toBeUndefined()
  })
})
