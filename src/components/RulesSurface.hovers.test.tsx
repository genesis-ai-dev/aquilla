// AQU-2260 (Sam, Oct 29): on the Rules page, labelled buttons say nothing on
// hover, and the usage line says what it counts on a click.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { RulesSurface } from "./RulesSurface"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"

vi.mock("@/components/rules/OrgRulesPanel", () => ({ OrgRulesPanel: () => null }))
vi.mock("./BuiltinChecksList", () => ({ BuiltinChecksList: () => null }))
vi.mock("@/lib/completion/frontier-health", () => ({ useFrontierHealth: () => ({ available: true }) }))

const project = {
  id: "p1",
  name: "P",
  sourceLanguage: "en",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
  members: [],
  usage: { fixesApplied: 3, llmCalls: { fix: { total: 7 } } },
} as unknown as ProjectRecord

const rule: TranslationRule = {
  id: "r1", name: "No loanwords", description: "", severity: "minor", source: "user", scope: "project",
  enabled: true, createdAt: "2026-01-01T00:00:00.000Z", check: { type: "target-forbids", targetPattern: "x" },
}

function renderSurface(extra: Record<string, unknown> = {}) {
  return renderWithTooltips(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RulesSurface
          project={project}
          projectId="p1"
          userRules={[rule]}
          builtinRules={[]}
          addRule={vi.fn()}
          updateRule={vi.fn()}
          deleteRule={vi.fn()}
          setBuiltinOverride={vi.fn()}
          infractions={new Map()}
          cells={[]}
          editingRuleId={null}
          setEditingRuleId={vi.fn()}
          {...extra}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("RulesSurface hovers", () => {
  it("the usage line says what it counts on click", async () => {
    renderSurface()
    await expectClickNote(screen.getByRole("button", { name: /3 fixes applied/ }), "LLM usage on this project")
  })

  it("Try to fix all and Promote to org say nothing on hover", async () => {
    renderSurface({ canEditOrgRules: true, patchOrgSettings: vi.fn() })
    const user = userEvent.setup()
    for (const name of [/Try to fix all/, /Promote to org/]) {
      await user.hover(screen.getByRole("button", { name }))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByRole("tooltip")).toBeNull()
    }
  })

  it("Request promotion says nothing on hover", async () => {
    renderSurface({ canRequestPromotion: true, requestPromotion: vi.fn() })
    await userEvent.setup().hover(screen.getByRole("button", { name: /Request promotion/ }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
