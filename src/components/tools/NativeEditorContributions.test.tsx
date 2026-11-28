import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useRef } from "react"
import { NativeEditorStore } from "@/lib/tools/native-editor-store"
import type { ToolSummary } from "@/lib/tools/tools-api"

const store = new NativeEditorStore()
const runAction = vi.fn()
const openInPanel = vi.fn()
const setColumnPref = vi.fn()

const TOOL: ToolSummary = {
  id: "ext-checker",
  name: "Scripture Checker",
  manifest: {
    name: "Scripture Checker",
    description: "Checks terms and adds notes",
    scopes: ["read:cells"],
    mounts: ["page", "panel"],
    apiRev: 8,
    sdk: 1,
    actions: [
      { id: "check-verse", label: "Check verse", where: ["cell"] },
      { id: "lookup-selection", label: "Look up phrase", where: ["selection"] },
    ],
    columns: [{ id: "notes", label: "Notes", placement: "after" }],
  },
} as unknown as ToolSummary

let columnPrefs: Record<string, "shown" | "hidden"> = {}

vi.mock("./ToolsMountContext", () => ({
  useToolsMount: () => ({
    projectId: "p1",
    tools: [TOOL],
    nativeEditor: store,
    runAction,
    openInPanel,
    columnPrefs,
    setColumnPref: (key: string, pref: "shown" | "hidden") => {
      columnPrefs = { ...columnPrefs, [key]: pref }
      setColumnPref(key, pref)
    },
  }),
}))

const {
  ExtensionColumnHeaders,
  ExtensionColumnsProvider,
  ExtensionColumnToggles,
  ExtensionRowAnnotations,
  ExtensionRowColumns,
  SelectionExtensionActions,
  useNativeExtensionColumns,
} = await import("./NativeEditorContributions")

function ColumnHarness() {
  const ref = useRef<HTMLDivElement | null>(null)
  // Simulate a wide desktop viewport so layout === "columns"
  if (ref.current) {
    Object.defineProperty(ref.current, "getBoundingClientRect", { value: () => ({ width: 1200 }) })
  }
  const cols = useNativeExtensionColumns({ widthRef: ref, gutterPx: 84, extraTracks: 0 })
  return (
    <ExtensionColumnsProvider value={cols}>
      <div ref={ref}>
        <ExtensionColumnToggles />
        <ExtensionColumnHeaders placement="after" />
        <ExtensionRowColumns fileId="f1" cellId="c1" placement="after" />
      </div>
    </ExtensionColumnsProvider>
  )
}

describe("NativeEditorContributions", () => {
  beforeEach(() => {
    store.clearAnnotations(TOOL.id)
    runAction.mockClear()
    openInPanel.mockClear()
    setColumnPref.mockClear()
    columnPrefs = {}
  })

  it("renders declarative row badges and spans, runs badge actions, and applies span quick-fixes", async () => {
    const onApply = vi.fn()
    store.annotate(TOOL.id, TOOL.name, {
      fileId: "f1",
      layer: "default",
      cells: {
        c1: {
          badges: [{ label: "Check needed", tone: "warn", actionId: "check-verse" }],
          spans: [
            {
              side: "target",
              start: 0,
              end: 5,
              tone: "error",
              label: "Spelling",
              message: "Prefer Libro over Lirbo",
              fix: { label: "Use Libro", replacement: "Libro" },
              openPanel: true,
            },
          ],
        },
      },
    })

    render(
      <ExtensionRowAnnotations
        fileId="f1"
        cellId="c1"
        cellRef="MAT 1:1"
        sourceText="The book of the genealogy"
        targetText="Lirbo de la genealogía"
        editable
        onApplyTargetFix={onApply}
      />,
    )

    // Clicking the badge triggers the extension's cell action.
    await userEvent.click(screen.getByTestId("extension-row-badge"))
    expect(runAction).toHaveBeenCalledWith(TOOL.id, "check-verse", "cell", { cell: { fileId: "f1", cellId: "c1", ref: "MAT 1:1" } })

    // Clicking the span opens its popover and applies the quick-fix splice.
    await userEvent.click(screen.getByTestId("extension-row-span"))
    expect(await screen.findByText("Prefer Libro over Lirbo")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("extension-span-apply-fix"))
    expect(onApply).toHaveBeenCalledWith("Libro de la genealogía")

    // Clearing annotations removes the row strip completely.
    act(() => {
      store.clearAnnotations(TOOL.id, "f1")
    })
    expect(screen.queryByTestId("extension-row-annotations")).toBeNull()
  })

  it("renders selection actions with cell + selected text context", async () => {
    render(
      <SelectionExtensionActions
        fileId="f1"
        cellId="c1"
        cellRef="MAT 1:1"
        selectionText="genealogy"
      />,
    )
    await userEvent.click(screen.getByTestId("selection-extension-lookup-selection"))
    expect(runAction).toHaveBeenCalledWith(TOOL.id, "lookup-selection", "selection", {
      cell: { fileId: "f1", cellId: "c1", ref: "MAT 1:1" },
      selection: { fileId: "f1", cellId: "c1", side: "source", text: "genealogy" },
    })
  })

  it("renders extension column toggles and populated native column cells", async () => {
    store.annotate(TOOL.id, TOOL.name, {
      fileId: "f1",
      layer: "default",
      cells: {
        c1: { columns: { notes: { text: "Check parallel in Luke 3", badge: "TN", tone: "info" } } },
      },
    })
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1200, height: 600, top: 0, left: 0, bottom: 600, right: 1200, x: 0, y: 0, toJSON: () => {} })
    try {
      render(<ColumnHarness />)
      expect(screen.getByTestId("extension-column-toggle-notes")).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("extension-column-header-notes")).toHaveTextContent("Notes")
      expect(screen.getByTestId("extension-column-cell-notes")).toHaveTextContent("Check parallel in Luke 3")
      expect(screen.getByTestId("extension-column-cell-notes")).toHaveTextContent("TN")
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })
})
