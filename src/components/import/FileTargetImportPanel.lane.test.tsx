/**
 * FileTargetImportPanel — choosing which language the import fills (AQU-1631).
 *
 * WHY: the import used to write into whatever lane the editor happened to have
 * open, with no picker. On a project with several target languages a translator
 * could pour a finished translation into the wrong language and not find out
 * until they switched lanes.
 *
 * The destination is now chosen before a file is picked, defaulted to the open
 * lane. Two of these are correctness, not UI: the picker must report the chosen
 * lane to the host (which points it at the editor's own lane setter, so the
 * cells the review matches against — their current translations and AD-2 event
 * heads — belong to the lane being filled), and while those cells load the file
 * picker must stay shut, or a match runs against the previous lane's heads and
 * commits onto the wrong chain.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("@/lib/import", () => ({ applyEBibleTargetImport: vi.fn() }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { FileTargetImportPanel } from "./FileTargetImportPanel"
import { laneComboboxOptions } from "@/components/lane-options"

const BASE_CELLS = [
  {
    cellId: "cell-gen-1-1",
    fileId: "file-1",
    canonicalRef: "GEN 1:1",
    sourceEventId: "se-1",
    translated: "",
    original: "In the beginning",
  },
]

const LANE_OPTIONS = laneComboboxOptions({
  lanes: ["", "fr", "pt-BR"],
  laneLabels: { fr: "French" },
  defaultLaneLabel: "Spanish",
})

function renderPanel(overrides: Partial<React.ComponentProps<typeof FileTargetImportPanel>> = {}) {
  const onTargetLangChange = vi.fn()
  const defaults: React.ComponentProps<typeof FileTargetImportPanel> = {
    projectId: "proj-1",
    username: "tester",
    fileName: "Genesis.usfm",
    cells: BASE_CELLS,
    getToken: vi.fn(async () => "tok"),
    onImported: vi.fn(),
    onCancel: vi.fn(),
    applyOptimisticTargetEdits: vi.fn(),
    laneOptions: LANE_OPTIONS,
    onTargetLangChange,
    targetLang: "",
  }
  render(<FileTargetImportPanel {...defaults} {...overrides} />)
  return { onTargetLangChange }
}

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement

describe("FileTargetImportPanel — destination language (AQU-1631)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("defaults the picker to the lane open in the editor", () => {
    renderPanel({ targetLang: "fr" })
    expect(screen.getByTestId("file-target-lane-trigger")).toHaveTextContent("French")
  })

  it("names the default lane with the project's target language, not an empty tag", () => {
    renderPanel({ targetLang: "" })
    expect(screen.getByTestId("file-target-lane-trigger")).toHaveTextContent("Spanish")
  })

  it("reports a chosen language to the host so the editor opens it", async () => {
    const user = userEvent.setup()
    const { onTargetLangChange } = renderPanel({ targetLang: "" })
    await user.click(screen.getByTestId("file-target-lane-trigger"))
    await user.click(await screen.findByRole("option", { name: "pt-BR" }))
    expect(onTargetLangChange).toHaveBeenCalledWith("pt-BR")
  })

  it("does not churn the editor's lane when the open one is re-picked", async () => {
    const user = userEvent.setup()
    const { onTargetLangChange } = renderPanel({ targetLang: "fr" })
    await user.click(screen.getByTestId("file-target-lane-trigger"))
    await user.click(await screen.findByRole("option", { name: "French" }))
    expect(onTargetLangChange).not.toHaveBeenCalled()
  })

  it("hides the picker when the project offers only one language to fill", () => {
    renderPanel({
      laneOptions: laneComboboxOptions({ lanes: [""], defaultLaneLabel: "Spanish" }),
    })
    expect(screen.queryByTestId("file-target-lane-picker")).not.toBeInTheDocument()
    // The import itself must still be reachable.
    expect(fileInput()).not.toBeDisabled()
  })

  it("holds the file picker shut while the chosen language's cells load", () => {
    renderPanel({ laneCellsLoading: true })
    expect(fileInput()).toBeDisabled()
  })

  it("opens the file picker once those cells have landed", () => {
    renderPanel({ laneCellsLoading: false })
    expect(fileInput()).not.toBeDisabled()
  })

  it("leaves the panel unchanged for a host that passes no lanes at all", () => {
    renderPanel({ laneOptions: undefined, onTargetLangChange: undefined })
    expect(screen.queryByTestId("file-target-lane-picker")).not.toBeInTheDocument()
  })
})
