import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useRef, type ComponentProps } from "react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import { btColumnStorageKey, resolveBtColumnShown } from "@/lib/completion/bt-column-pref"
import {
  BacktranslationColumnHeader,
  BacktranslationColumnProvider,
  BacktranslationColumnToggle,
  BacktranslationRowCell,
  BacktranslationRowStack,
  backtranslationColumnLayout,
  useEditorBacktranslationColumn,
  type EditorBacktranslationConfig,
} from "./BacktranslationColumn"

const PROJECT = "p1"

function cell(over: Partial<CellData> = {}): CellData {
  return {
    id: "c1", fileId: "f1", original: "his house", translated: "maison de lui", targetEventId: "evt-1",
    type: "text", status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [], waivers: [], hasPendingEdit: false, ...over,
  } as CellData
}

function config(over: Partial<EditorBacktranslationConfig> = {}): EditorBacktranslationConfig {
  return {
    projectId: PROJECT, live: false, canSetLive: true, onSetLive: vi.fn(),
    waiting: new Set(), pending: 0, onBacktranslateMany: vi.fn(), onStop: vi.fn(), ...over,
  }
}

type RowProps = ComponentProps<typeof BacktranslationRowCell>

/** The editor's wiring in miniature: one header, one row, a 1200px-wide table. */
function Harness({ cfg, row, missing = [], canWrite = true, configured = true, width = 1200 }: {
  cfg: EditorBacktranslationConfig
  row?: Partial<RowProps>
  missing?: string[]
  canWrite?: boolean
  configured?: boolean
  width?: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const value = useEditorBacktranslationColumn({
    config: cfg, enabled: true, configured, canWrite, sourceLanguage: "en",
    widthRef: ref, gutterPx: 84, collectMissing: () => missing,
  })
  const rowProps: RowProps = {
    cell: cell(), visibleTranslated: "maison de lui", stale: false, generating: false, error: undefined,
    editable: true, dir: "ltr", fontSize: 14, onBacktranslate: vi.fn(), onSave: vi.fn(), onOpenDetails: vi.fn(),
    ...row,
  }
  return (
    <I18nProvider>
      <TooltipProvider delay={0}>
        <BacktranslationColumnProvider value={value}>
          <div
            ref={(el) => {
              ref.current = el
              if (el) el.getBoundingClientRect = () => ({ width } as DOMRect)
            }}
          >
            <BacktranslationColumnToggle />
            <BacktranslationColumnHeader />
            <BacktranslationRowCell {...rowProps} />
            <BacktranslationRowStack {...rowProps} />
          </div>
        </BacktranslationColumnProvider>
      </TooltipProvider>
    </I18nProvider>
  )
}

afterEach(() => window.localStorage.clear())

describe("Back-translation column: where it shows", () => {
  it("is a column when three text tracks fit, stacked when they do not, and nothing when closed", () => {
    expect(backtranslationColumnLayout(1200, 84, true)).toBe("column")
    // Each of the three text tracks needs 200px: the wider character gutter
    // leaves too little at this width, the plain one still fits.
    expect(backtranslationColumnLayout(775, 132, true)).toBe("stacked")
    expect(backtranslationColumnLayout(775, 84, true)).toBe("column")
    // Phones always stack.
    expect(backtranslationColumnLayout(600, 84, true)).toBe("stacked")
    expect(backtranslationColumnLayout(1200, 84, false)).toBe("none")
  })

  it("follows the project until the person chooses, then their choice wins", () => {
    expect(resolveBtColumnShown(null, false)).toBe(false)
    expect(resolveBtColumnShown(null, true)).toBe(true)
    expect(resolveBtColumnShown("hidden", true)).toBe(false)
    expect(resolveBtColumnShown("shown", false)).toBe(true)
  })

  it("opens from the Target header, remembers it, and closes from its own header", () => {
    render(<Harness cfg={config()} />)
    expect(screen.queryByTestId("bt-column-header")).toBeNull()
    expect(screen.queryByTestId("bt-cell")).toBeNull()

    fireEvent.click(screen.getByTestId("bt-column-show"))
    expect(screen.getByTestId("bt-column-header")).toBeTruthy()
    expect(screen.getByTestId("bt-cell")).toBeTruthy()
    expect(window.localStorage.getItem(btColumnStorageKey(PROJECT))).toBe("shown")

    fireEvent.click(screen.getByTestId("bt-column-hide"))
    expect(screen.queryByTestId("bt-cell")).toBeNull()
    expect(window.localStorage.getItem(btColumnStorageKey(PROJECT))).toBe("hidden")
  })

  it("is open without asking on a project that back-translates live", () => {
    render(<Harness cfg={config({ live: true })} />)
    expect(screen.getByTestId("bt-column-header")).toBeTruthy()
    expect(screen.getByTestId("bt-column-live-badge")).toBeTruthy()
  })

  it("stacks the reading under the target when there is no room for a column", () => {
    window.localStorage.setItem(btColumnStorageKey(PROJECT), "shown")
    render(<Harness cfg={config()} width={700} row={{ cell: cell({ backtranslation: "house of him" }) }} />)
    expect(screen.queryByTestId("bt-cell")).toBeNull()
    expect(within(screen.getByTestId("bt-stack")).getByText("house of him")).toBeTruthy()
    // No column heading to hold them, so the options and close live on the Target header.
    expect(screen.getByTestId("bt-column-options")).toBeTruthy()
    expect(screen.getByTestId("bt-column-hide")).toBeTruthy()
  })
})

describe("Back-translation column: options", () => {
  const open = (props: ComponentProps<typeof Harness>) => {
    window.localStorage.setItem(btColumnStorageKey(PROJECT), "shown")
    render(<Harness {...props} />)
    fireEvent.click(screen.getByTestId("bt-column-options"))
  }

  it("back-translates the page's rows that have no current reading", () => {
    const cfg = config()
    open({ cfg, missing: ["c1", "c2", "c3"] })
    fireEvent.click(screen.getByRole("button", { name: "Back-translate 3 rows" }))
    expect(cfg.onBacktranslateMany).toHaveBeenCalledWith(["c1", "c2", "c3"])
  })

  it("says so when there is nothing to do, and offers no button", () => {
    open({ cfg: config(), missing: [] })
    expect(screen.getByText(/has a current back-translation/)).toBeTruthy()
    expect(screen.queryByTestId("bt-column-fill")).toBeNull()
  })

  it("shows progress with a Stop while rows are being read", () => {
    const cfg = config({ pending: 4 })
    open({ cfg, missing: ["c9"] })
    expect(screen.getAllByText("4 rows left").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(cfg.onStop).toHaveBeenCalled()
  })

  it("lets a maintainer turn live on, and only shows it to everyone else", () => {
    const cfg = config()
    open({ cfg })
    fireEvent.click(screen.getByRole("switch", { name: "Update as translations change" }))
    expect(cfg.onSetLive).toHaveBeenCalledWith(true)
  })

  it("does not let a non-maintainer change live, or a reader back-translate", () => {
    open({ cfg: config({ canSetLive: false }), missing: ["c1"], canWrite: false })
    expect(screen.getByRole("switch", { name: "Update as translations change" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText("Only a maintainer can change this.")).toBeTruthy()
    expect(screen.queryByTestId("bt-column-fill")).toBeNull()
  })
})

describe("Back-translation column: a row's cell", () => {
  const show = (row: Partial<RowProps>, cfg = config()) => {
    window.localStorage.setItem(btColumnStorageKey(PROJECT), "shown")
    const utils = render(<Harness cfg={cfg} row={row} />)
    return { ...utils, bt: screen.getByTestId("bt-cell") }
  }

  it.each([
    ["empty", { visibleTranslated: "" }, undefined],
    ["missing", {}, undefined],
    ["current", { cell: cell({ backtranslation: "house of him", backtranslationForText: "maison de lui" }) }, undefined],
    ["stale", { cell: cell({ backtranslation: "house of him" }), stale: true }, undefined],
    ["generating", { generating: true }, undefined],
    ["failed", { error: "no credits" }, undefined],
    ["waiting", {}, config({ waiting: new Set(["c1"]) })],
  ] as const)("is %s", (state, row, cfg) => {
    const { bt } = show(row as Partial<RowProps>, cfg)
    expect(bt.getAttribute("data-state")).toBe(state)
  })

  it("back-translates one row from its empty cell", () => {
    const onBacktranslate = vi.fn()
    show({ onBacktranslate })
    fireEvent.click(screen.getByTestId("bt-cell-generate"))
    expect(onBacktranslate).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", translated: "maison de lui" }), "read-back")
  })

  it("offers nothing to write on a row this person cannot edit", () => {
    const { bt } = show({ editable: false, cell: cell({ backtranslation: "house of him" }) })
    expect(screen.queryByTestId("bt-cell-generate")).toBeNull()
    expect(within(bt).queryByRole("button", { name: "Edit the back-translation" })).toBeNull()
    expect(within(bt).getByText("house of him")).toBeTruthy()
  })

  it("saves a hand correction as a human reading, and marks it", () => {
    const onSave = vi.fn()
    const { bt, rerender } = show({ onSave, cell: cell({ backtranslation: "house of him" }) })
    fireEvent.click(within(bt).getByRole("button", { name: "Edit the back-translation" }))
    const box = within(bt).getByRole("textbox", { name: "Back-translation text" })
    fireEvent.change(box, { target: { value: "his house" } })
    fireEvent.click(within(bt).getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), "his house", false)

    rerender(<Harness cfg={config()} row={{ cell: cell({ backtranslation: "his house", backtranslationPolished: false }) }} />)
    expect(within(screen.getByTestId("bt-cell")).getByText("Hand-corrected")).toBeTruthy()
  })

  it("does not save an unchanged or emptied reading", () => {
    const onSave = vi.fn()
    const { bt } = show({ onSave, cell: cell({ backtranslation: "house of him" }) })
    fireEvent.click(within(bt).getByRole("button", { name: "Edit the back-translation" }))
    fireEvent.keyDown(within(bt).getByRole("textbox"), { key: "Enter", metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("updates an out-of-date reading as a refresh, and retries a failed one", () => {
    const onBacktranslate = vi.fn()
    const { bt, rerender } = show({ onBacktranslate, stale: true, cell: cell({ backtranslation: "house of him" }) })
    fireEvent.click(within(bt).getByRole("button", { name: "Update this back-translation" }))
    expect(onBacktranslate).toHaveBeenLastCalledWith(expect.anything(), "refresh")

    rerender(<Harness cfg={config()} row={{ onBacktranslate, error: "no credits" }} />)
    fireEvent.click(within(screen.getByTestId("bt-cell")).getByRole("button", { name: "Try again" }))
    expect(onBacktranslate).toHaveBeenLastCalledWith(expect.anything(), "read-back")
  })
})
