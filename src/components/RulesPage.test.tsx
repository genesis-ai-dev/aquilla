/**
 * RulesPage.test.tsx — FRO-186 regression guard.
 *
 * Verifies that the "Harmonize all (N)" trigger in BuiltinChecksList renders
 * with N > 0 when validated project cells contain real violations. The test
 * exercises the REAL derivation path (checkRulesForCell in rule-engine.ts) — no
 * injected infractions map. Mocked: data-loading hooks and router; the rule
 * engine, builtin registry, and BuiltinChecksList receive zero mocking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { RulesPage } from "./RulesPage"
import type { ProjectRecord } from "@/lib/parsers/types"
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
vi.mock("@/hooks/useRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useRules")>()
  const { resolveBuiltinRules } = await import("@/lib/lqa/builtin-resolver")
  return {
    ...actual,
    useRules: (_project: unknown) => ({
      rules: resolveBuiltinRules(undefined),
      userRules: [],
      builtinRules: resolveBuiltinRules(undefined),
      penalties: { major: 15, minor: 5 },
      addRule: vi.fn(),
      updateRule: vi.fn(),
      deleteRule: vi.fn(),
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

describe("RulesPage infraction derivation (FRO-186)", () => {
  beforeEach(async () => {
    cellsStub = []
    const { getProject } = await import("@/lib/store/project-index")
    vi.mocked(getProject).mockResolvedValue(makeProject())
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
