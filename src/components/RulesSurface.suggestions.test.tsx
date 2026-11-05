// AQU-1754: "suggest rules from my edits" is reviewed IN the checks list — no
// modal, an optional topic, draft rows that are visually their own thing, and
// a row that hands over to the saved rule (animated by the list's FLIP keys).
// The modal this replaced (AQU-198) threw every suggestion away on close.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/rules/rule-suggester", () => ({ suggestRulesFromCandidates: vi.fn() }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt" } }) }))
vi.mock("@/lib/completion/frontier-health", () => ({ useFrontierHealth: () => ({ available: true }) }))

import { suggestRulesFromCandidates } from "@/lib/rules/rule-suggester"
import { RulesSurface } from "./RulesSurface"

const project = {
  id: "p1",
  name: "P",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
  members: [],
} as unknown as ProjectRecord

const rule: TranslationRule = {
  id: "r1",
  name: "No loanwords",
  description: "",
  severity: "minor",
  source: "user",
  scope: "project",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  check: { type: "target-forbids", targetPattern: "x" },
}

// Human-written translations, so the miner's human-authored pass has something
// to rank (AQU-820) without needing validation state.
const cells = [
  { id: "c1", original: "Jesus wept.", translated: "Jésus pleura." },
  { id: "c2", original: "In the beginning", translated: "Au commencement" },
] as unknown as CellData[]

function renderSurface(addRule = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RulesSurface
          project={project}
          projectId="p1"
          userRules={[rule]}
          builtinRules={[]}
          orgRules={[]}
          addRule={addRule}
          updateRule={vi.fn()}
          deleteRule={vi.fn()}
          setBuiltinOverride={vi.fn()}
          infractions={new Map()}
          cells={cells}
          editingRuleId={null}
          setEditingRuleId={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { addRule }
}

describe("RulesSurface — suggestions live in the checks list", () => {
  beforeEach(() => {
    // Drafts are kept per project in sessionStorage, so each case starts clean.
    sessionStorage.clear()
    vi.mocked(suggestRulesFromCandidates).mockReset()
  })

  it("asks for suggestions from the last row of the list, scoped to the typed topic, without opening a dialog", async () => {
    vi.mocked(suggestRulesFromCandidates).mockResolvedValue({
      suggestions: [
        {
          name: "Keep the serial comma",
          description: "Match the source punctuation",
          severity: "minor",
          check: { type: "target-forbids", targetPattern: "," },
        },
      ],
      evidence: ["two cells changed the same way"],
    })
    renderSurface()

    const list = screen.getByTestId("checks-list")
    const items = within(list).getAllByRole("listitem")
    // The ask-row is the list's last row, after every existing check.
    expect(items[items.length - 1].getAttribute("data-flip-key")).toBe("suggestions-footer")

    fireEvent.change(within(list).getByLabelText("What the suggested rules should be about"), {
      target: { value: "punctuation" },
    })
    fireEvent.click(within(list).getByRole("button", { name: "Suggest rules from my edits" }))

    const draft = await within(list).findByTestId("rule-suggestion")
    // AQU-1754 AC3: the free-text topic scopes the analysis.
    expect(vi.mocked(suggestRulesFromCandidates).mock.calls[0][4]).toMatchObject({ focus: "punctuation" })
    // AQU-1754 AC1: reviewed in place — nothing modal in sight.
    expect(screen.queryByRole("dialog")).toBeNull()
    // AQU-1754 AC4: its own row, marked a draft and animatable by the list.
    expect(within(draft).getByText("Suggestion")).toBeInTheDocument()
    expect(draft.getAttribute("data-flip-key")).toMatch(/^draft-/)
    expect(within(draft).getByText("Keep the serial comma")).toBeInTheDocument()
    // Asking again says "more", so the row reads as a repeatable ask.
    expect(within(list).getByRole("button", { name: "Suggest more" })).toBeInTheDocument()
  })

  it("adds the drafted rule as a project rule when it is approved", async () => {
    vi.mocked(suggestRulesFromCandidates).mockResolvedValue({
      suggestions: [
        {
          name: "Keep the serial comma",
          description: "",
          severity: "minor",
          check: { type: "target-forbids", targetPattern: "," },
        },
      ],
      evidence: [""],
    })
    const { addRule } = renderSurface()
    const list = screen.getByTestId("checks-list")

    fireEvent.click(within(list).getByRole("button", { name: "Suggest rules from my edits" }))
    const draft = await within(list).findByTestId("rule-suggestion")
    fireEvent.click(within(draft).getByRole("button", { name: "Add rule" }))

    await waitFor(() =>
      expect(addRule).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Keep the serial comma", source: "llm", scope: "project", enabled: true }),
      ),
    )
  })
})
