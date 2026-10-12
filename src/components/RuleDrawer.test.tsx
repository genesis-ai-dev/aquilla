/**
 * RuleDrawer tests — AQU-1805.
 *
 * WHY: the drawer's whole job is to let a reviewer act on the cells a rule
 * flags. Both halves of that were dead: the example rows were wired to a
 * no-op `onNavigateToCell`, and the AI fix buttons were hardcoded `disabled`
 * from the Y.Doc era, so the list was a read-only wall of text.
 *
 * These tests pin the contracts so neither can silently rot back:
 *  1. a flagged example is clickable and names the cell it goes to;
 *  2. the per-cell AI fix asks for a proposal and hands the reviewed previews
 *     to the host's commit path;
 *  3. a rule's saved regex autofix proposes WITHOUT a model call;
 *  4. a disabled fix button always says why it is disabled;
 *  5. the passing examples and the no-violations case still render.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RuleDrawer } from "./RuleDrawer"
import type { CellData } from "@/hooks/useCells"
import type { CompletionSettings, ProjectRecord, RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { t as en } from "@/lib/i18n/standalone"

vi.mock("@/lib/rules/autofix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rules/autofix")>()
  return {
    ...actual,
    requestSurgicalFix: vi.fn(),
    requestBatchFix: vi.fn(),
  }
})

import { requestSurgicalFix, requestBatchFix, type FixPreview } from "@/lib/rules/autofix"

function makeCell(id: string, original: string, translated: string): CellData {
  return {
    id, fileId: "f1",
    original, translated,
    context: "", group: "g", type: "text",
    status: "unvalidated", validationStatus: { validated: false },
    targetEventId: `ev-${id}`,
  } as unknown as CellData
}

const rule: TranslationRule = {
  id: "rule-god",
  name: "Each God in the source needs an approved rendering",
  severity: "major",
  enabled: true,
  source: "manual",
} as unknown as TranslationRule

const project = { id: "p1" } as unknown as ProjectRecord

// provider "frontier" is configured by the presence of a session JWT, which
// keeps the fixture free of endpoints and keys.
const settings = { provider: "frontier", endpoint: "", model: "", maxTokens: 1024, temperature: 0.2, systemPrompt: "" } as CompletionSettings
const session = { jwt: "jwt-abc" } as unknown as FrontierSession

const breaking = [makeCell("c1", "God said", "allah said"), makeCell("c2", "God saw", "allah saw")]
const passing = makeCell("c3", "He went", "he went")

const infractions: RuleInfraction[] = [
  { ruleId: rule.id, cellId: "c1" } as unknown as RuleInfraction,
  { ruleId: rule.id, cellId: "c2" } as unknown as RuleInfraction,
]

function renderDrawer(props: Partial<React.ComponentProps<typeof RuleDrawer>> = {}) {
  const onNavigateToCell = vi.fn()
  const onApplyFix = vi.fn().mockResolvedValue(undefined)
  render(
    <MemoryRouter>
      <TooltipProvider delay={0}>
      <RuleDrawer
        rule={rule}
        infractions={infractions}
        cells={[...breaking, passing]}
        onClose={vi.fn()}
        onNavigateToCell={onNavigateToCell}
        project={project}
        username="dev"
        completionSettings={settings}
        session={session}
        onApplyFix={onApplyFix}
        {...props}
      />
      </TooltipProvider>
    </MemoryRouter>,
  )
  return { onNavigateToCell, onApplyFix }
}

beforeEach(() => {
  vi.mocked(requestSurgicalFix).mockReset()
  vi.mocked(requestBatchFix).mockReset()
})

describe("RuleDrawer — jumping to a flagged cell (AQU-1805)", () => {
  it("takes the editor to the cell behind a 'not followed' example", () => {
    const { onNavigateToCell } = renderDrawer()
    fireEvent.click(screen.getByLabelText(en("rules.drawer.openCellAriaLabel", { cellId: "c2" })))
    expect(onNavigateToCell).toHaveBeenCalledWith("c2")
  })

  it("takes the editor to a 'followed' example too", () => {
    const { onNavigateToCell } = renderDrawer()
    fireEvent.click(screen.getByLabelText(en("rules.drawer.openCellAriaLabel", { cellId: "c3" })))
    expect(onNavigateToCell).toHaveBeenCalledWith("c3")
  })

  it("names every flagged cell, so each row is reachable rather than one shared control", () => {
    renderDrawer()
    for (const id of ["c1", "c2"]) {
      expect(screen.getByLabelText(en("rules.drawer.openCellAriaLabel", { cellId: id }))).toBeTruthy()
    }
  })
})

describe("RuleDrawer — AI fix on one example (AQU-1805)", () => {
  const preview: FixPreview = {
    cellId: "c1", fileId: "f1",
    before: "allah said", after: "God said",
    find: "allah", replace: "God",
    source: "llm",
  }

  it("asks for a surgical proposal for the cell whose button was pressed", async () => {
    vi.mocked(requestSurgicalFix).mockResolvedValue({ kind: "per-cell", previews: [preview] })
    renderDrawer()
    fireEvent.click(screen.getAllByLabelText(en("rules.drawer.fixCellAriaLabel"))[0])
    await waitFor(() => expect(requestSurgicalFix).toHaveBeenCalled())
    expect(vi.mocked(requestSurgicalFix).mock.calls[0][0].cell.id).toBe("c1")
  })

  it("hands the reviewed preview to the host's commit path as a per-cell fix", async () => {
    vi.mocked(requestSurgicalFix).mockResolvedValue({ kind: "per-cell", previews: [preview] })
    const { onApplyFix } = renderDrawer()
    fireEvent.click(screen.getAllByLabelText(en("rules.drawer.fixCellAriaLabel"))[0])
    // A single-cell fix is not a sweep, so Apply is not behind the AQU-186
    // typed-confirmation gate and is live as soon as the sheet opens.
    const apply = await screen.findByRole("button", {
      name: en("rules.fixReview.applyButton", { count: 1 }),
    })
    fireEvent.click(apply)
    await waitFor(() => expect(onApplyFix).toHaveBeenCalled())
    expect(onApplyFix).toHaveBeenCalledWith([preview], "per-cell")
  })

  it("shows the model's reason instead of silently doing nothing", async () => {
    vi.mocked(requestSurgicalFix).mockResolvedValue({ kind: "none", reason: "No safe rendering found" })
    const { onApplyFix } = renderDrawer()
    fireEvent.click(screen.getAllByLabelText(en("rules.drawer.fixCellAriaLabel"))[0])
    expect(await screen.findByText("No safe rendering found")).toBeTruthy()
    expect(onApplyFix).not.toHaveBeenCalled()
  })
})

describe("RuleDrawer — fix all (AQU-1805)", () => {
  it("uses a saved regex autofix without calling the model", async () => {
    const withFix = {
      ...rule,
      autofix: { kind: "regex-replace", pattern: "allah", replacement: "God", flags: "gi" },
    } as unknown as TranslationRule
    renderDrawer({ rule: withFix })
    fireEvent.click(screen.getByRole("button", { name: en("rules.surface.tryToFixAllButton") }))
    // Two cells change, so this one IS a sweep: the typed-confirmation gate
    // stands between the preview and Apply.
    expect(
      await screen.findByText(en("rules.fixReview.previewsReady", { count: 2 })),
    ).toBeTruthy()
    expect(requestBatchFix).not.toHaveBeenCalled()
    expect(screen.getByLabelText(en("rules.fixReview.confirmInputAriaLabel"))).toBeTruthy()
  })

  it("asks the model for a batch proposal when the rule has no saved autofix", async () => {
    vi.mocked(requestBatchFix).mockResolvedValue({ kind: "none", reason: "nothing to do" })
    renderDrawer()
    fireEvent.click(screen.getByRole("button", { name: en("rules.surface.tryToFixAllButton") }))
    await waitFor(() => expect(requestBatchFix).toHaveBeenCalled())
    const call = vi.mocked(requestBatchFix).mock.calls[0][0]
    expect(call.violatingCells.map((c) => c.id)).toEqual(["c1", "c2"])
  })
})

describe("RuleDrawer — a disabled fix always says why (AQU-1805)", () => {
  // The reason rides on the wrapping span, because a disabled button has
  // pointer-events: none and would never fire a tooltip of its own.
  async function reasonOn(button: HTMLElement): Promise<string> {
    const trigger = button.parentElement!
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)
    const tip = await screen.findByRole("tooltip")
    return tip.textContent ?? ""
  }

  it("is disabled, with the permission reason, when the host offers no commit path", async () => {
    renderDrawer({ onApplyFix: undefined })
    const fix = screen.getAllByLabelText(en("rules.drawer.fixCellAriaLabel"))[0]
    expect(fix).toBeDisabled()
    expect(await reasonOn(fix)).toContain(en("rules.drawer.fixNotPermitted"))
  })

  it("is disabled, with the setup reason, when AI is not configured", async () => {
    renderDrawer({ session: null })
    const fix = screen.getAllByLabelText(en("rules.drawer.fixCellAriaLabel"))[0]
    expect(fix).toBeDisabled()
    expect(await reasonOn(fix)).toContain(en("rules.drawer.aiNotConfigured"))
  })

  it("still offers fix-all on a saved regex autofix when AI is unconfigured", () => {
    const withFix = {
      ...rule,
      autofix: { kind: "regex-replace", pattern: "allah", replacement: "God", flags: "gi" },
    } as unknown as TranslationRule
    renderDrawer({ rule: withFix, session: null })
    expect(
      screen.getByRole("button", { name: en("rules.surface.tryToFixAllButton") }),
    ).not.toBeDisabled()
  })
})

describe("RuleDrawer — no regression on a rule nothing breaks (AQU-1805)", () => {
  it("renders the empty breaking list and keeps fix-all disabled", () => {
    renderDrawer({ infractions: [] })
    expect(screen.getByText(en("rules.drawer.breakingThisRule", { count: 0 }))).toBeTruthy()
    expect(
      screen.getByRole("button", { name: en("rules.surface.tryToFixAllButton") }),
    ).toBeDisabled()
  })

  it("still lists the cells that follow the rule", () => {
    renderDrawer({ infractions: [] })
    // With nothing flagged, every non-empty cell passes.
    for (const id of ["c1", "c2", "c3"]) {
      expect(screen.getByLabelText(en("rules.drawer.openCellAriaLabel", { cellId: id }))).toBeTruthy()
    }
  })
})
