// AQU-1531: "Choose file" in the Agent workbench did nothing whenever the
// sidebar's Files panel was already showing — which is its state on every entry
// to the Agent surface, so the first click a user made was almost always the
// dead one. Its only effect was "show the Files panel", and asking for a panel
// that is already up changes nothing visible.
//
// Decided behaviour: the click always lands the keyboard cursor in the panel's
// "Filter files…" box. The regression escaped at the seam between the workbench
// button and the sidebar's file list — two components that never meet in a unit
// test — so this covers them composed, through the real `useFileFilterFocus`
// handoff and the dock's rule that only the ACTIVE panel is mounted.

import { useState } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import { ExpandableFileList } from "@/components/ExpandableFileList"
import { useFileFilterFocus } from "@/hooks/useFileFilterFocus"
import { AgentDocumentContext } from "./AgentDocumentContext"
import type { FileReference } from "@/lib/parsers/types"

type DockTab = "files" | "search" | null

const FILES: FileReference[] = [
  { id: "f1", name: "Genesis", type: "usfm", createdAt: "2026-01-01T00:00:00.000Z", cellCount: 0, bookCode: "GEN" },
  { id: "f2", name: "Mark", type: "usfm", createdAt: "2026-01-01T00:00:00.000Z", cellCount: 0, bookCode: "MRK" },
]

/**
 * The live wiring, minus the surfaces that don't participate: ProjectWorkspace
 * owns the handle, the workbench's button asks for the Files panel and the
 * cursor, and LeftDock mounts only the active panel (`{activeTab && panels[…]}`).
 */
function Workbench({ initialTab }: { initialTab: DockTab }) {
  const [tab, setTab] = useState<DockTab>(initialTab)
  const filterFocus = useFileFilterFocus()
  const chooseFile = () => {
    setTab("files")
    filterFocus.request()
  }
  return (
    <I18nProvider>
      <EditorScrollProvider>
        <div>
          {tab === "files" && (
            <ExpandableFileList
              projectId="p1"
              files={FILES}
              activeFileId={null}
              fileProgress={new Map()}
              suggestionFileIds={new Set()}
              validationCount={0}
              getTokenForFile={async () => null}
              onSelectFile={vi.fn()}
              onRename={vi.fn()}
              onMove={vi.fn()}
              filterFocus={filterFocus}
            />
          )}
          {tab === "search" && <div>Search panel</div>}
          <AgentDocumentContext
            workspace={{ cells: [], scopeAvailable: false }}
            onChooseFile={chooseFile}
          />
        </div>
      </EditorScrollProvider>
    </I18nProvider>
  )
}

const chooseFileButton = () => screen.getByRole("button", { name: "Choose file" })
const fileFilter = () => screen.getByRole("searchbox", { name: "Filter files" })
const fileRow = (name: string) => screen.queryByRole("button", { name })

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe("AQU-1531 — Agent workbench \"Choose file\"", () => {
  it("puts the cursor in the file filter when the Files panel is ALREADY showing", async () => {
    const user = userEvent.setup()
    render(<Workbench initialTab="files" />)
    // The dead click: the panel is up, so nothing used to change.
    expect(fileFilter()).not.toHaveFocus()
    await user.click(chooseFileButton())
    expect(fileFilter()).toHaveFocus()
  })

  it("lets the user type straight away, with no extra click", async () => {
    const user = userEvent.setup()
    render(<Workbench initialTab="files" />)
    await user.click(chooseFileButton())
    await user.keyboard("Gen")
    expect(fileFilter()).toHaveValue("Gen")
    expect(fileRow("Genesis")).toBeInTheDocument()
    expect(fileRow("Mark")).not.toBeInTheDocument()
  })

  it("opens the Files panel and focuses the filter when the sidebar is collapsed", async () => {
    const user = userEvent.setup()
    render(<Workbench initialTab={null} />)
    expect(screen.queryByRole("searchbox", { name: "Filter files" })).not.toBeInTheDocument()
    await user.click(chooseFileButton())
    expect(fileFilter()).toHaveFocus()
  })

  it("switches a different panel to Files and focuses the filter", async () => {
    const user = userEvent.setup()
    render(<Workbench initialTab="search" />)
    await user.click(chooseFileButton())
    expect(screen.queryByText("Search panel")).not.toBeInTheDocument()
    expect(fileFilter()).toHaveFocus()
  })

  it("answers keyboard activation of the button the same way", async () => {
    const user = userEvent.setup()
    render(<Workbench initialTab="files" />)
    chooseFileButton().focus()
    await user.keyboard("{Enter}")
    expect(fileFilter()).toHaveFocus()
  })
})
