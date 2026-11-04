// AQU-2342: every check the project runs is ONE list — project, lane, org and
// built-in checks side by side, each naming its scope with a chip — and one
// "Add check" button starts every kind of new check.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RulesSurface } from "./RulesSurface"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"

vi.mock("@/lib/completion/frontier-health", () => ({ useFrontierHealth: () => ({ available: true }) }))

const project = {
  id: "p1",
  name: "P",
  sourceLanguage: "en",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
  members: [],
} as unknown as ProjectRecord

function rule(id: string, name: string, extra: Partial<TranslationRule> = {}): TranslationRule {
  return {
    id, name, description: "", severity: "minor", source: "user", scope: "project",
    enabled: true, createdAt: "2026-01-01T00:00:00.000Z", check: { type: "target-forbids", targetPattern: "x" },
    ...extra,
  }
}

const builtin = rule("builtin:empty-target", "Empty translation", {
  source: "algorithmic",
  check: { type: "builtin", checkId: "empty-target" },
})

function renderSurface(extra: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RulesSurface
          project={project}
          projectId="p1"
          userRules={[rule("r1", "No loanwords")]}
          builtinRules={[builtin]}
          orgRules={[rule("o1", "Org spelling", { scope: "org" })]}
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

describe("RulesSurface — one Checks list", () => {
  it("lists project, org and built-in checks in one list, most specific first, each with its scope", () => {
    renderSurface()
    const list = screen.getByTestId("checks-list")
    const rows = within(list).getAllByRole("listitem").filter((li) => li.querySelector("[data-scope]"))
    expect(rows.map((li) => li.querySelector("[data-scope]")?.getAttribute("data-scope"))).toEqual([
      "project",
      "org",
      "builtin",
    ])
    expect(within(rows[0]).getByText("No loanwords")).toBeInTheDocument()
    expect(within(rows[1]).getByText("Org spelling")).toBeInTheDocument()
    expect(within(rows[2]).getByText("Empty translation")).toBeInTheDocument()
    // No separate cards any more.
    expect(screen.queryByText(/Project Rules \(/)).toBeNull()
    expect(screen.queryByText(/Org Rules \(/)).toBeNull()
  })

  it("starts every new check from one Add check button", () => {
    const setEditingRuleId = vi.fn()
    renderSurface({ setEditingRuleId, canEditOrgRules: true, patchOrgSettings: vi.fn() })
    fireEvent.click(screen.getByRole("button", { name: "Add check" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Write a check")).toBeInTheDocument()
    expect(within(dialog).getByText("Import from a style guide")).toBeInTheDocument()
    expect(within(dialog).getByText("Write an organization check")).toBeInTheDocument()
    fireEvent.click(within(dialog).getByText("Write a check"))
    expect(setEditingRuleId).toHaveBeenCalledWith("new")
  })

  it("offers the organization choice only to org maintainers", () => {
    renderSurface()
    fireEvent.click(screen.getByRole("button", { name: "Add check" }))
    expect(within(screen.getByRole("dialog")).queryByText("Write an organization check")).toBeNull()
  })

  it("shows a read-only org row to someone who cannot edit org rules", () => {
    renderSurface()
    const orgRow = screen.getByText("Org spelling").closest("li") as HTMLElement
    expect(within(orgRow).getByText("Read-only")).toBeInTheDocument()
    expect(within(orgRow).queryByRole("switch")).toBeNull()
  })
})
