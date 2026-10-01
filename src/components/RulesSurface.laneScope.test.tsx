/**
 * AQU-1509: the Rules page always views ONE lane and says so. WHY: with
 * lane-scoped rules, users edited or trusted the wrong lane's rules because
 * the page was a filter over "all rules" with no statement of which lane was
 * active. These tests pin the contract: the viewed lane is the editor's active
 * lane, only rules enforced there are listed by default, and every card names
 * its scope (All lanes / This lane / Other lane).
 */
import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RulesSurface } from "./RulesSurface"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"

vi.mock("@/components/rules/OrgRulesPanel", () => ({ OrgRulesPanel: () => null }))
vi.mock("./BuiltinChecksList", () => ({ BuiltinChecksList: () => null }))

const lane = (legacyTag: string, name: string, position: number): NonNullable<ProjectRecord["lanes"]>[number] => ({
  id: `lane-${position}`, role: "target", name, langCode: null, legacyTag, position, archivedAt: null,
})

const project = {
  id: "p1",
  name: "P",
  sourceLanguage: "en",
  targetLanguage: "es",
  targetLanes: ["fr"],
  lanes: [lane("", "Spanish", 0), lane("fr", "French", 1)],
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
  members: [],
} as unknown as ProjectRecord

const rule = (id: string, name: string, extra: Partial<TranslationRule>): TranslationRule => ({
  id, name, description: "", severity: "minor", source: "user", scope: "project", enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z", check: { type: "target-forbids", targetPattern: "x" }, ...extra,
})

const rules = [
  rule("all", "Everywhere rule", {}),
  rule("es", "Spanish rule", { scope: "lane", lane: "" }),
  rule("fr", "French rule", { scope: "lane", lane: "fr" }),
]

function renderSurface(props: { activeLane?: string; onActiveLaneChange?: (lane: string) => void } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <RulesSurface
        project={project}
        projectId="p1"
        userRules={rules}
        builtinRules={[]}
        addRule={vi.fn()}
        updateRule={vi.fn()}
        deleteRule={vi.fn()}
        setBuiltinOverride={vi.fn()}
        infractions={new Map()}
        cells={[]}
        editingRuleId={null}
        setEditingRuleId={vi.fn()}
        {...props}
      />
    </MemoryRouter>
    </QueryClientProvider>,
  )
}

const card = (name: string) => screen.getByText(name).closest("li") as HTMLElement

describe("RulesSurface lane scope (AQU-1509)", () => {
  // Child widgets ping the API health endpoint; nothing here needs a server.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
  })

  it("names the viewed lane and lists only the rules enforced in it", () => {
    renderSurface({ activeLane: "fr", onActiveLaneChange: vi.fn() })
    const panel = screen.getByTestId("rules-lane-scope")
    expect(within(panel).getByRole("combobox")).toHaveTextContent("French")
    expect(panel).toHaveTextContent("Switching lanes here also switches the editor.")

    expect(within(card("Everywhere rule")).getByText("All lanes")).toBeInTheDocument()
    expect(within(card("French rule")).getByText("This lane: French")).toBeInTheDocument()
    // The Spanish lane's rule is not enforced in French, so it is not listed.
    expect(screen.queryByText("Spanish rule")).not.toBeInTheDocument()
  })

  it("reveals other lanes' rules marked as not applied here", async () => {
    const user = userEvent.setup()
    renderSurface({ activeLane: "fr", onActiveLaneChange: vi.fn() })
    await user.click(screen.getByRole("button", { name: "Show 1 rule from other lanes" }))
    const spanish = card("Spanish rule")
    expect(within(spanish).getByText("Other lane: Spanish")).toBeInTheDocument()
    expect(spanish).toHaveTextContent("Not applied in French.")
  })

  it("switching the lane here reports it to the workspace (shared with the editor)", async () => {
    const user = userEvent.setup()
    const onActiveLaneChange = vi.fn()
    renderSurface({ activeLane: "fr", onActiveLaneChange })
    await user.click(within(screen.getByTestId("rules-lane-scope")).getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "Spanish" }))
    expect(onActiveLaneChange).toHaveBeenCalledWith("")
  })

  it("falls back to the default lane when the active lane no longer exists", () => {
    renderSurface({ activeLane: "gone", onActiveLaneChange: vi.fn() })
    expect(within(screen.getByTestId("rules-lane-scope")).getByRole("combobox")).toHaveTextContent("Spanish")
    expect(within(card("Spanish rule")).getByText("This lane: Spanish")).toBeInTheDocument()
  })
})
