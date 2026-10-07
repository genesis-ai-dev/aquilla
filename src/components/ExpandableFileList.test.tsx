// AQU-1084: one-click jump to a Testament in the editor sidebar file list, and
// OT/NT grouping that survives a fresh device (bookCode fallback when the
// client-local corpusMarker is missing). UI-only journey — covered here in RTL,
// no smoke spec (AGENTS.md "Testing" rule 4).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { ExpandableFileList } from "./ExpandableFileList"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import type { FileReference } from "@/lib/parsers/types"

const PROJECT_ID = "p1"
const COLLAPSE_KEY = `aquilla:sidebar:corpus-collapsed:${PROJECT_ID}`

function file(name: string, extra: Partial<FileReference> = {}): FileReference {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    type: "usfm",
    createdAt: "2026-01-01T00:00:00.000Z",
    cellCount: 0,
    ...extra,
  }
}

// A "fresh device" Bible: every file carries the server-backed bookCode and
// none carries the client-local corpusMarker.
const FRESH_BIBLE = [
  file("Matthew", { bookCode: "MAT" }),
  file("Genesis", { bookCode: "GEN" }),
  file("Revelation", { bookCode: "REV" }),
  file("Exodus", { bookCode: "EXO" }),
]

function renderList(files: FileReference[], props: Partial<React.ComponentProps<typeof ExpandableFileList>> = {}) {
  return render(
    <I18nProvider>
      <EditorScrollProvider>
        <ExpandableFileList
          projectId={PROJECT_ID}
          files={files}
          activeFileId={null}
          fileProgress={new Map()}
          suggestionFileIds={new Set()}
          validationCount={0}
          getTokenForFile={async () => null}
          onSelectFile={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          {...props}
        />
      </EditorScrollProvider>
    </I18nProvider>,
  )
}

const jumpGroup = () => screen.getByRole("group", { name: "Jump to Testament" })
const jumpButton = (name: "Old Testament" | "New Testament") =>
  within(jumpGroup()).getByRole("button", { name })
// Group headers expose their state through the accessible name of their toggle.
const headerToggle = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${label}$`) })
const fileRow = (name: string) => screen.queryByRole("button", { name })

let scrollSpy: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>

beforeEach(() => {
  localStorage.clear()
  // happy-dom has no layout; the jump only has to ask the right element to scroll.
  scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>()
  HTMLElement.prototype.scrollIntoView = scrollSpy
})

function scrolledGroup(): HTMLElement {
  expect(scrollSpy).toHaveBeenCalledTimes(1)
  expect(scrollSpy).toHaveBeenCalledWith({ block: "start" })
  return scrollSpy.mock.contexts[0] as HTMLElement
}

describe("ExpandableFileList — OT/NT grouping on a fresh device (AQU-1084)", () => {
  it("exposes a named corpus rename field outside the collapse button", () => {
    const onRenameCorpus = vi.fn()
    renderList([file("Intro", { corpusMarker: "Season 1" })], { onRenameCorpus })
    const rename = screen.getByRole("button", { name: "Rename Season 1" })
    expect(rename).not.toHaveClass("opacity-0")
    fireEvent.click(rename)
    const input = screen.getByRole("textbox", { name: "Rename Season 1" })
    expect(input.closest("button")).toBeNull()
    fireEvent.change(input, { target: { value: "Season 2" } })
    fireEvent.blur(input)
    expect(onRenameCorpus).toHaveBeenCalledWith("Season 1", "Season 2")
    expect(headerToggle("Season 1")).toHaveAttribute("aria-expanded", "true")
  })

  it("groups book-coded files into OT and NT when corpusMarker is missing", () => {
    renderList(FRESH_BIBLE)
    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "true")
    expect(headerToggle("NT")).toHaveAttribute("aria-expanded", "true")
    const names = screen.getAllByRole("button", { name: /^(Genesis|Exodus|Matthew|Revelation)$/ })
      .map((b) => b.textContent)
    expect(names).toEqual(["Genesis", "Exodus", "Matthew", "Revelation"])
    expect(screen.queryByText("Ungrouped")).toBeNull()
  })

  it("groups a migrated project (bare-code names, no bookCode, kind codex) and offers the jump", () => {
    // The migrator stamps "codex" (outside the FileType union) and sets no
    // bookCode; the rename banner skips that type, so no corpusMarker either.
    const migrated = ["1CH", "MAT", "GEN", "REV"].map((code) =>
      file(code, { type: "codex" as FileReference["type"] }),
    )
    renderList(migrated, { onRenameCorpus: vi.fn() })
    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "true")
    expect(headerToggle("NT")).toHaveAttribute("aria-expanded", "true")
    expect(screen.queryByText("Ungrouped")).toBeNull()
    expect(jumpButton("Old Testament")).toBeEnabled()
    expect(jumpButton("New Testament")).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Rename OT" })).toBeNull()
  })

  it("keeps files without a book code visible in Ungrouped", () => {
    renderList([...FRESH_BIBLE, file("readme", { type: "txt" })])
    expect(screen.getByText("Ungrouped")).toBeInTheDocument()
    expect(fileRow("readme")).toBeInTheDocument()
  })

  it("hides the rename pencil on a derived group but keeps it on a marker-authored one", () => {
    renderList(
      [file("Genesis", { bookCode: "GEN" }), file("Matthew", { bookCode: "MAT" }), file("Intro", { corpusMarker: "Season 1" })],
      { onRenameCorpus: vi.fn() },
    )
    expect(screen.getByRole("button", { name: "Rename Season 1" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Rename OT" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Rename NT" })).toBeNull()
  })
})

describe("ExpandableFileList — Jump to Testament control (AQU-1084)", () => {
  it("renders the control only when both testaments are present", () => {
    const { unmount } = renderList(FRESH_BIBLE)
    expect(jumpButton("Old Testament")).toBeEnabled()
    expect(jumpButton("New Testament")).toBeEnabled()
    unmount()

    renderList([file("notes", { type: "txt" }), file("Season 1 ep 1", { corpusMarker: "Season 1" })])
    expect(screen.queryByRole("group", { name: "Jump to Testament" })).toBeNull()
    unmount()

    renderList([file("Matthew", { bookCode: "MAT" }), file("Mark", { bookCode: "MRK" })])
    expect(screen.queryByRole("group", { name: "Jump to Testament" })).toBeNull()
  })

  it("scrolls the chosen group's header into view without touching the other group", () => {
    renderList(FRESH_BIBLE)
    fireEvent.click(jumpButton("New Testament"))

    const target = scrolledGroup()
    expect(within(target).getByRole("button", { name: "Collapse NT" })).toBeInTheDocument()
    expect(within(target).queryByRole("button", { name: /OT$/ })).toBeNull()
    // Nothing was hidden or collapsed on the user's behalf.
    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "true")
    expect(headerToggle("NT")).toHaveAttribute("aria-expanded", "true")
    expect(fileRow("Genesis")).toBeInTheDocument()
    expect(fileRow("Matthew")).toBeInTheDocument()
  })

  it("expands a collapsed target group before scrolling and persists that", () => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(["NT"]))
    renderList(FRESH_BIBLE)
    expect(headerToggle("NT")).toHaveAttribute("aria-expanded", "false")
    expect(fileRow("Matthew")).toBeNull()

    fireEvent.click(jumpButton("New Testament"))

    expect(headerToggle("NT")).toHaveAttribute("aria-expanded", "true")
    expect(fileRow("Matthew")).toBeInTheDocument()
    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "true")
    expect(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]")).toEqual([])
    scrolledGroup()
  })

  it("leaves a collapsed sibling collapsed — the user decides what stays open", () => {
    renderList(FRESH_BIBLE)
    fireEvent.click(headerToggle("OT"))
    expect(fileRow("Genesis")).toBeNull()

    fireEvent.click(jumpButton("New Testament"))

    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "false")
    expect(fileRow("Genesis")).toBeNull()
    expect(fileRow("Matthew")).toBeInTheDocument()
  })

  it("lets a manual header click after a jump win", () => {
    renderList(FRESH_BIBLE)
    fireEvent.click(jumpButton("Old Testament"))
    fireEvent.click(headerToggle("OT"))
    expect(headerToggle("OT")).toHaveAttribute("aria-expanded", "false")
    expect(fileRow("Genesis")).toBeNull()
    expect(fileRow("Matthew")).toBeInTheDocument()
  })

  it("composes with the name filter: rows narrow, and a filtered-out testament disables its button", () => {
    renderList([...FRESH_BIBLE, file("readme", { type: "txt" })])
    const box = screen.getByRole("searchbox", { name: "Filter files" })

    fireEvent.change(box, { target: { value: "gen" } })
    expect(fileRow("Genesis")).toBeInTheDocument()
    expect(fileRow("Matthew")).toBeNull()
    expect(fileRow("readme")).toBeNull()
    expect(jumpButton("Old Testament")).toBeEnabled()
    expect(jumpButton("New Testament")).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }))
    expect(fileRow("Matthew")).toBeInTheDocument()
    expect(fileRow("readme")).toBeInTheDocument()
    expect(jumpButton("New Testament")).toBeEnabled()
  })

  it("does not act on the Ungrouped bucket", () => {
    renderList([...FRESH_BIBLE, file("readme", { type: "txt" })])
    fireEvent.click(jumpButton("Old Testament"))
    fireEvent.click(jumpButton("New Testament"))
    expect(fileRow("readme")).toBeInTheDocument()
    expect(screen.getByText("Ungrouped")).toBeInTheDocument()
  })
})

describe("ExpandableFileList — on-demand chapter health", () => {
  it("does no projection work while collapsed and reads current health on each reopen", () => {
    let label = "Initial chapter"
    const getActiveChapterHealth = vi.fn(() => [{
      key: "chapter", label, translated: 0, validated: 0, total: 1, cells: [],
    }])
    renderList([file("Genesis", { bookCode: "GEN" })], {
      activeFileId: "genesis", hasActiveChapters: true,
      getActiveChapterHealth, deferSectionProgress: true,
    })
    expect(getActiveChapterHealth).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    expect(getActiveChapterHealth).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Initial chapter")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    label = "Updated chapter"
    expect(getActiveChapterHealth).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    expect(getActiveChapterHealth).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Updated chapter")).toBeInTheDocument()
    expect(screen.queryByText("Initial chapter")).not.toBeInTheDocument()
  })

  it("does not build an expanded active file's health while its corpus is hidden", () => {
    localStorage.setItem("sidebar:expanded:p1", JSON.stringify(["genesis"]))
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(["OT"]))
    const getActiveChapterHealth = vi.fn(() => [])
    renderList([file("Genesis", { bookCode: "GEN" })], {
      activeFileId: "genesis", hasActiveChapters: true,
      getActiveChapterHealth, deferSectionProgress: true,
    })
    expect(getActiveChapterHealth).not.toHaveBeenCalled()
    fireEvent.click(headerToggle("OT"))
    expect(getActiveChapterHealth).toHaveBeenCalledTimes(1)
  })
})

// AQU-894: "make mine obvious" in a project with many files. The list decides
// WHETHER to de-emphasise; FileRow.test.tsx covers what a de-emphasised row
// looks like.
describe("ExpandableFileList — AQU-894 assigned-file emphasis", () => {
  const rowEl = (name: string) =>
    fileRow(name)?.closest('[data-showcase="sidebar.file"]') as HTMLElement | null

  it("dims the files the reader does not hold, and leaves theirs alone", () => {
    renderList(FRESH_BIBLE, { assignedFileIds: new Set(["genesis", "exodus"]) })
    expect(rowEl("Genesis")?.dataset.unassigned).toBeUndefined()
    expect(rowEl("Exodus")?.dataset.unassigned).toBeUndefined()
    expect(rowEl("Matthew")?.dataset.unassigned).toBe("true")
    expect(rowEl("Revelation")?.dataset.unassigned).toBe("true")
  })

  it("dims NOTHING when the reader holds no assignment in this project", () => {
    // The no-assignments-team case, and equally a member of an assigning team
    // who hasn't been given anything yet: neither may be shown a project where
    // every file is greyed out. This is why the treatment needs no setting to
    // be safe — it switches itself off for the people it can't help.
    renderList(FRESH_BIBLE, { assignedFileIds: new Set() })
    for (const name of ["Genesis", "Exodus", "Matthew", "Revelation"]) {
      expect(rowEl(name)?.dataset.unassigned).toBeUndefined()
    }
  })

  it("dims nothing when assignments were never read at all", () => {
    // Prop omitted: the read is still in flight, or the caller doesn't wire it.
    // Unknown must look like "nothing to say", never like "none are yours".
    renderList(FRESH_BIBLE)
    for (const name of ["Genesis", "Matthew"]) {
      expect(rowEl(name)?.dataset.unassigned).toBeUndefined()
    }
  })

  it("keeps a dimmed file openable", () => {
    const onSelectFile = vi.fn()
    renderList(FRESH_BIBLE, { assignedFileIds: new Set(["genesis"]), onSelectFile })
    fireEvent.click(fileRow("Matthew")!)
    expect(onSelectFile).toHaveBeenCalledWith("matthew")
  })
})
