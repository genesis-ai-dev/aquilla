import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { TranslationRule } from "@/lib/parsers/types"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

vi.mock("@/lib/rules/rule-suggester", () => ({ suggestRulesFromCandidates: vi.fn() }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt" } }) }))
vi.mock("@/lib/completion/frontier-health", () => ({ useFrontierHealth: () => ({ available: true }) }))

import { suggestRulesFromCandidates } from "@/lib/rules/rule-suggester"
import { useRuleSuggestions } from "./useRuleSuggestions"

const cells = [
  { id: "c1", original: "Jesus wept.", translated: "Jésus pleura.", status: "validated" as const },
  { id: "c2", original: "In the beginning", translated: "Au commencement", status: "validated" as const },
]

const suggestion = (name: string): RuleSuggestion => ({
  name,
  description: "",
  severity: "minor",
  check: { type: "target-forbids", targetPattern: name },
})

function setup(userRules: TranslationRule[] = []) {
  const addRule = vi.fn().mockResolvedValue(undefined)
  const hook = renderHook(
    ({ rules }) =>
      useRuleSuggestions({
        projectId: "p1",
        completionSettings: undefined,
        cells,
        cellsLoading: false,
        cellsError: undefined,
        userRules: rules,
        addRule,
      }),
    { initialProps: { rules: userRules } },
  )
  return { ...hook, addRule }
}

describe("useRuleSuggestions", () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.mocked(suggestRulesFromCandidates).mockReset()
  })

  // The whole point of moving out of the modal: suggestions accumulate in the
  // list across asks, and a second ask must not re-propose what's there.
  it("suggest more appends a new batch and excludes rules already saved, drafted or dismissed", async () => {
    vi.mocked(suggestRulesFromCandidates)
      .mockResolvedValueOnce({ suggestions: [suggestion("A"), suggestion("B")], evidence: ["", ""] })
      .mockResolvedValueOnce({ suggestions: [suggestion("C")], evidence: [""] })
    const saved = { id: "r1", name: "Saved", createdAt: "", severity: "minor", source: "user", scope: "project", enabled: true, check: { type: "target-forbids", targetPattern: "x" } } as TranslationRule
    const { result } = setup([saved])

    await act(() => result.current.suggest(""))
    act(() => result.current.dismiss(result.current.drafts[1].id))
    await act(() => result.current.suggest("punctuation"))

    expect(result.current.drafts.map((d) => d.suggestion.name)).toEqual(["A", "C"])
    const second = vi.mocked(suggestRulesFromCandidates).mock.calls[1][4]
    expect(second).toMatchObject({ focus: "punctuation", offset: 20 })
    expect(second?.exclude).toEqual(expect.arrayContaining(["Saved", "A", "B"]))
  })

  it("drops a suggestion the model repeats despite being told not to", async () => {
    vi.mocked(suggestRulesFromCandidates)
      .mockResolvedValueOnce({ suggestions: [suggestion("A")], evidence: [""] })
      .mockResolvedValueOnce({ suggestions: [suggestion("a")], evidence: [""] })
    const { result } = setup()
    await act(() => result.current.suggest(""))
    await act(() => result.current.suggest(""))
    expect(result.current.drafts).toHaveLength(1)
    expect(result.current.message?.kind).toBe("info")
  })

  // Approving saves the rule as an LLM-sourced project rule, and the draft row
  // hands over to the saved rule's row the moment that rule shows up.
  it("approve saves the rule and the draft gives way to the saved row", async () => {
    vi.mocked(suggestRulesFromCandidates).mockResolvedValueOnce({ suggestions: [suggestion("A")], evidence: [""] })
    let resolveAdd!: () => void
    const { result, rerender, addRule } = setup()
    addRule.mockImplementation(() => new Promise<void>((r) => { resolveAdd = r }))
    await act(() => result.current.suggest(""))
    const draft = result.current.drafts[0]

    act(() => { void result.current.approve(draft.id) })
    expect(addRule).toHaveBeenCalledWith(expect.objectContaining({ name: "A", source: "llm", scope: "project", enabled: true }))

    const savedRule = { id: "new", name: "A", createdAt: "", severity: "minor", source: "llm", scope: "project", enabled: true, check: suggestion("A").check } as TranslationRule
    rerender({ rules: [savedRule] })
    expect(result.current.drafts).toHaveLength(0)
    expect(result.current.adoptedDraftId(savedRule)).toBe(draft.id)

    await act(async () => resolveAdd())
    expect(result.current.adoptedDraftId(savedRule)).toBeUndefined()
  })

  it("keeps drafts when the page is left and reopened", async () => {
    vi.mocked(suggestRulesFromCandidates).mockResolvedValueOnce({ suggestions: [suggestion("A")], evidence: ["why"] })
    const first = setup()
    await act(() => first.result.current.suggest(""))
    first.unmount()

    const second = setup()
    expect(second.result.current.drafts.map((d) => d.suggestion.name)).toEqual(["A"])
    expect(second.result.current.hasSuggested).toBe(true)
  })
})
