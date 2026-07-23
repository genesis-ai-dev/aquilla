/**
 * RulesPage.test.tsx — AQU-186 regression guard + AQU-291 delete-confirm guard.
 *
 * AQU-186: Verifies that the "Harmonize all (N)" trigger in BuiltinChecksList renders
 * with N > 0 when validated project cells contain real violations.
 * AQU-291: Verifies that rule delete is gated by checkbox-confirm dialog.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { RulesPage } from "./RulesPage"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"

// ── router ─────────────────────────────────────────────────────────────────

// react-router-dom itself is real; we just wrap in a MemoryRouter.

// ── store ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(),
  patchProject: vi.fn(),
}))

// ── hooks ──────────────────────────────────────────────────────────────────

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    patch: vi.fn(),
    settings: { harmonize_min_role: "project_lead" },
  }),
}))

// Controlled stub — tests override cellsStub before each render.
let cellsStub: LivingMemoryCell[] = []
vi.mock("@/hooks/useLivingMemory", () => ({
  useLivingMemory: () => ({
    cells: cellsStub,
    isLoading: false,
    isEmpty: cellsStub.length === 0,
    isTruncated: false,
    fileCount: 1,
  }),
}))

// Expose a project stub so useRules sees a real builtinRules array.
// We use the real resolveBuiltinRules path, but short-circuit the hook's
// refresh / patch helpers so they don't need IDB.
// userRulesStub and deleteRuleMock are controllable per-test for AQU-291 tests.
let userRulesStub: TranslationRule[] = []
const deleteRuleMock = vi.fn()
vi.mock("@/hooks/useRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useRules")>()
  const { resolveBuiltinRules } = await import("@/lib/lqa/builtin-resolver")
  const builtins = resolveBuiltinRules(undefined)
  return {
    ...actual,
    useRules: (_project: unknown) => ({
      rules: builtins,
      // Read userRulesStub dynamically so per-test assignments take effect.
      get userRules() { return userRulesStub },
      builtinRules: builtins,
      penalties: { major: 15, minor: 5 },
      addRule: vi.fn(),
      updateRule: vi.fn(),
      get deleteRule() { return deleteRuleMock },
      updatePenalties: vi.fn(),
      setBuiltinOverride: vi.fn(),
    }),
  }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

// Child components that open modals or need their own hooks — stub to avoid
// pulling in more dependencies. We only care that BuiltinChecksList renders
// (which is NOT mocked).
vi.mock("./RuleCreateDialog", () => ({
  RuleCreateDialog: () => null,
}))
vi.mock("./RuleSuggestDialog", () => ({
  RuleSuggestDialog: () => null,
}))
vi.mock("./FixReviewPanel", () => ({
  FixReviewPanel: () => null,
}))

// ── helpers ────────────────────────────────────────────────────────────────

function makeLivingMemoryCell(overrides: Partial<CellData> & { id: string }): LivingMemoryCell {
  return {
    original: "test source",
    translated: "",
    fileId: "f1",
    context: "",
    group: "",
    type: "text",
    status: "validated",
    validationStatus: "full",
    activeValidators: ["tester"],
    validationHistory: [],
    history: [],
    threads: [],
    fileName: "chapter-01.txt",
    ...overrides,
  }
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    files: [{ id: "f1", name: "chapter-01.txt" }],
    syncRole: { level: 700, source: "creator" },
    origin: undefined,
    ...overrides,
  } as unknown as ProjectRecord
}

function renderRulesPage() {
  return render(
    <MemoryRouter initialEntries={["/project/proj-1/rules"]}>
      <Routes>
        <Route path="/project/:id/rules" element={<RulesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("RulesPage infraction derivation (AQU-186)", () => {
  beforeEach(async () => {
    cellsStub = []
    userRulesStub = []
    deleteRuleMock.mockReset()
    const { getProject } = await import("@/lib/store/project-index")
    vi.mocked(getProject).mockResolvedValue(makeProject())
  })

  it("shows explicit progress while the rules project is unresolved", async () => {
    const { getProject } = await import("@/lib/store/project-index")
    vi.mocked(getProject).mockImplementationOnce(() => new Promise(() => {}))

    renderRulesPage()

    const status = screen.getByRole("status", { name: "Loading rules" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
  })

  it("does NOT render 'Harmonize all' when no cells violate any builtin check", async () => {
    // All cells are clean — empty-target fires only when source has content
    // and target is blank; here we give a good translation.
    cellsStub = [
      makeLivingMemoryCell({ id: "c1", original: "Hello world", translated: "Bonjour monde", status: "validated" }),
    ]
    renderRulesPage()
    // Give the async getProject call a tick to resolve.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("harmonize-all-btn")).toBeNull()
  })

  it("renders 'Harmonize all (N)' via real derivation when cells have violations", async () => {
    // empty-target check fires when original has content but translated is blank.
    // We need N ≥ 2 to confirm N is accumulated, not just 1.
    cellsStub = [
      makeLivingMemoryCell({ id: "c1", original: "Hello world", translated: "", status: "validated" }),
      makeLivingMemoryCell({ id: "c2", original: "Goodbye world", translated: "", status: "validated" }),
    ]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    // The "Harmonize all (N)" button should appear for at least one builtin check.
    const btns = screen.getAllByTestId("harmonize-all-btn")
    expect(btns.length).toBeGreaterThan(0)
    // The first button should have a count > 0 encoded in its text.
    expect(btns[0].textContent).toMatch(/Harmonize all \([1-9]\d*\)/)
  })

  it("infraction count equals number of violating cells (N = 2 for 2 blank cells)", async () => {
    cellsStub = [
      makeLivingMemoryCell({ id: "c1", original: "Chapter one", translated: "", status: "validated" }),
      makeLivingMemoryCell({ id: "c2", original: "Chapter two", translated: "", status: "validated" }),
    ]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    // Find the "Empty translation" row and confirm count is exactly 2.
    const row = screen.getByText("Empty translation").closest("[data-testid='builtin-row']")!
    expect(row.textContent).toMatch(/2/)
    // And the button shows (2).
    expect(row.textContent).toMatch(/Harmonize all \(2\)/)
  })
})

// ── AQU-291: rule delete confirmation guard ────────────────────────────────

function makeUserRule(overrides: Partial<TranslationRule> = {}): TranslationRule {
  return {
    id: "rule-1",
    name: "Test rule",
    description: "A test rule",
    pattern: "foo",
    severity: "minor",
    enabled: true,
    ...overrides,
  } as TranslationRule
}

describe("RulesPage rule delete confirm (AQU-291)", () => {
  beforeEach(async () => {
    cellsStub = []
    userRulesStub = []
    deleteRuleMock.mockReset()
    const { getProject } = await import("@/lib/store/project-index")
    vi.mocked(getProject).mockResolvedValue(makeProject())
  })

  it("does NOT call deleteRule immediately when trash button is clicked", async () => {
    userRulesStub = [makeUserRule()]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    fireEvent.click(deleteBtn)

    // deleteRule must NOT have been called yet — confirm dialog should be open
    expect(deleteRuleMock).not.toHaveBeenCalled()
  })

  it("shows the confirm dialog with consequence copy when trash button is clicked", async () => {
    userRulesStub = [makeUserRule()]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })
    expect(screen.getByRole("heading", { name: /Delete rule/i })).toBeInTheDocument()
    expect(screen.getAllByText(/everyone in the project/i).length).toBeGreaterThan(0)
  })

  it("cancel closes the dialog without calling deleteRule", async () => {
    userRulesStub = [makeUserRule()]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    fireEvent.click(deleteBtn)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(deleteRuleMock).not.toHaveBeenCalled()
  })

  it("calls deleteRule only after checkbox is checked and confirm is clicked", async () => {
    userRulesStub = [makeUserRule()]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))

    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    fireEvent.click(deleteBtn)
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Confirm button is disabled until checkbox is checked
    const confirmBtn = screen.getByRole("button", { name: /^Delete rule$/i })
    expect(confirmBtn).toBeDisabled()

    // Check the checkbox (click via its label: jsdom double-fires clicks
    // dispatched directly on a labelable control inside a <label>)
    const checkbox = screen.getByRole("checkbox")
    fireEvent.click(checkbox.closest("label")!)
    expect(confirmBtn).not.toBeDisabled()

    // Now confirm
    fireEvent.click(confirmBtn)
    expect(deleteRuleMock).toHaveBeenCalledWith("rule-1")
  })
})

// ── AQU-480: rule management is gated at MAINTAINER (600) ────────────────────

describe("RulesPage rule-management gating (AQU-480)", () => {
  beforeEach(() => {
    cellsStub = []
    userRulesStub = []
    deleteRuleMock.mockReset()
  })

  async function renderAtRole(level: number) {
    const { getProject } = await import("@/lib/store/project-index")
    vi.mocked(getProject).mockResolvedValue(
      makeProject({ syncRole: { level, source: "creator" } } as Partial<ProjectRecord>),
    )
    userRulesStub = [makeUserRule()]
    renderRulesPage()
    await new Promise((r) => setTimeout(r, 0))
  }

  it("shows a read-only banner and disables the delete control for a contributor (400)", async () => {
    await renderAtRole(400)
    expect(
      screen.getByText(/Only maintainers and owners can add or change translation rules/i),
    ).toBeInTheDocument()
    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    expect(deleteBtn).toBeDisabled()
  })

  it("shows no banner and leaves the delete control enabled for an owner (700)", async () => {
    await renderAtRole(700)
    expect(
      screen.queryByText(/Only maintainers and owners can add or change translation rules/i),
    ).toBeNull()
    const deleteBtn = await screen.findByRole("button", { name: /Delete rule Test rule/i })
    expect(deleteBtn).not.toBeDisabled()
  })
})
