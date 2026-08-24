/**
 * Source-edit affordance wiring (linked-projects Come-and-See workflow).
 *
 * The editor gained a per-cell "Edit source text" affordance so a project_lead+
 * can fix a SOURCE line (emitting source.cell.commit) instead of a raw
 * POST /events. It is gated by useProjectPermissions.canEditSource: cloud
 * project_lead (500+) on a non-live-linked project. These tests render the real
 * EditorTable and assert the pencil appears exactly where editing is permitted
 * and that clicking it mounts an editable source editor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import type { DcsCursor } from "@/lib/dcs/types"

// DCS lockdown state (AQU-615). The real hook goes through useProjectSettings
// → network; in tests there is no session, so `loading` would stay true forever
// and default-lock every project. Mock the cursor hook with a mutable bag: the
// default (loading=false, no cursor) restores the pre-DCS behavior these tests
// pin, and individual tests flip it to exercise the lockdown + mid-edit flip.
let dcsState: { cursor: DcsCursor | null; loading: boolean } = { cursor: null, loading: false }
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => dcsState,
}))

const DCS_CURSOR: DcsCursor = {
  owner: "unfoldingWord",
  repo: "en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  trackMode: "release",
  ref: "v88",
  commitSha: "aaa111",
  released: "2026-05-01T00:00:00Z",
  importedAt: "2026-07-01T00:00:00Z",
}

beforeEach(() => {
  dcsState = { cursor: null, loading: false }
})

// happy-dom has no layout engine — replace the virtualized list with a trivial
// "render every row" stand-in (same shim as EditorTable.editorActions.test).
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: CellData[]
      renderItem: (props: { item: CellData; index: number }) => ReactNode
      keyExtractor?: (item: CellData, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item.id },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    ...overrides,
  }
}

function withRole(level: number, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return makeProject({
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    ...overrides,
  })
}

function makeCell(id: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: "hello",
    translated: "bonjour",
    context: "GEN 1:1",
    group: "GEN 1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

// Build a CellStore from CellData[] the way EditorTable now expects it
// (the component moved from a `cells` prop to a `cellStore`). Same shape as
// EditorTable.selectionTargeting.test's helper.
function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const canonicalRef = cell.context || cell.group || null
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    return [
      {
        cellId: cell.id,
        side: "source",
        value: cell.original,
        valueHtml: cell.originalHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
        wordCount: cell.original.trim().split(/\s+/).filter(Boolean).length,
      },
      {
        cellId: cell.id,
        side: "target",
        value: cell.translated,
        valueHtml: cell.translatedHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`,
        lastEditor: "lead",
        lastEditAt: 2,
        validated: false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

function makeStore(cells: CellData[], projectId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId,
    fileId: "file-1",
    username: "lead",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(project: ProjectRecord) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore([makeCell("cell-1")], project.id)}
          username="lead"
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={new Map()}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — source-edit affordance", () => {
  it("shows the Edit source affordance for a project_lead on a self-contained project", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD))
    await screen.findByText("bonjour")
    expect(screen.getByRole("button", { name: "Edit source text" })).toBeInTheDocument()
  })

  it("hides the affordance for a contributor (below the 500 floor)", async () => {
    renderTable(withRole(ROLE.CONTRIBUTOR))
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Edit source text" })).not.toBeInTheDocument()
  })

  it("hides the affordance on a live-linked downstream (mirrored source is locked)", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD, { sourceProjectId: "up", sourceLinkMode: "live" }))
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Edit source text" })).not.toBeInTheDocument()
  })

  it("shows the affordance on a clone-linked project (clone is independent)", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD, { sourceProjectId: "up", sourceLinkMode: "clone" }))
    await screen.findByText("bonjour")
    expect(screen.getByRole("button", { name: "Edit source text" })).toBeInTheDocument()
  })

  it("clicking the affordance mounts an editable source editor", async () => {
    renderTable(withRole(ROLE.PROJECT_LEAD))
    const pencil = await screen.findByRole("button", { name: "Edit source text" })
    fireEvent.click(pencil)
    // The inline source editor is a TranslatedEditor with the source aria-label.
    const editor = await screen.findByRole("textbox", { name: "Edit source text" })
    expect(editor).toBeInTheDocument()
    expect(editor.className).toContain("ProseMirror")
  })
})

describe("EditorTable — media source edits are transcript corrections (AQU-646)", () => {
  // For imported media the stored source VALUE is the audio filename — an
  // import record, not prose. The display already preferred the transcript,
  // but the editor used to open on the raw value: the filename appeared in the
  // edit box, and saving it (now with valueHtml attached) flipped the display
  // onto the rich-HTML branch permanently — the transcript was gone from
  // screen for good. These pin the editor half; the payload/projection halves
  // live in events-emit.test and the sync-worker's event-projection.test.
  function renderMedia(over: Partial<CellRow> = {}) {
    const project = withRole(ROLE.PROJECT_LEAD)
    const store = new CellStore()
    store.setRuntime({
      projectId: project.id,
      fileId: "file-1",
      username: "lead",
      requiredValidations: 1,
      auditStats: new Map(),
    })
    store.replaceRows(
      [
        {
          cellId: "m1", side: "source", value: "episode-12.mp3", valueHtml: null, type: "text",
          canonicalRef: null, anchorCellId: null, eventId: "m1-source", sourceEventId: null,
          lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
          medium: "media", transcription: "let the peace of Christ rule",
          ...over,
        } as CellRow,
        {
          cellId: "m1", side: "target", value: "que la paix règne", valueHtml: null, type: "text",
          canonicalRef: null, anchorCellId: null, eventId: "m1-target", sourceEventId: "m1-source",
          lastEditor: "lead", lastEditAt: 2, validated: false, wordCount: 4,
        } as CellRow,
      ],
      { full: true, maxServerSeq: 1 },
    )
    const qc = new QueryClient()
    return render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={store}
            username="lead"
            isCompletionConfigured={false}
            isCompletionAvailable={false}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={() => {}}
            onCompleteBatch={() => {}}
            healthMap={new Map()}
            lineNumbersEnabled={false}
            cellLabelsEnabled={false}
            sourceTextDirection="ltr"
            targetTextDirection="ltr"
          />
        </EditorActionsProvider>
      </QueryClientProvider>,
    )
  }

  it("the editor opens on the transcript — never the filename", async () => {
    renderMedia()
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))
    const editor = await screen.findByRole("textbox", { name: "Edit source text" })
    await waitFor(() => expect(editor.textContent).toContain("let the peace of Christ rule"))
    expect(editor.textContent).not.toContain("episode-12.mp3")
  })

  it("an untranscribed cell opens BLANK — typing creates the first transcript", async () => {
    // The filename placeholder is display-only. Putting it in the editor would
    // invite exactly the overwrite this guards against.
    renderMedia({ transcription: null })
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))
    const editor = await screen.findByRole("textbox", { name: "Edit source text" })
    await waitFor(() => expect(editor.textContent ?? "").not.toContain("episode-12.mp3"))
  })
})

describe("EditorTable — DCS source lockdown (AQU-615)", () => {
  it("hides the pencil while the linked-state is unknown (loading = default-locked)", async () => {
    dcsState = { cursor: null, loading: true }
    renderTable(withRole(ROLE.PROJECT_LEAD))
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Edit source text" })).not.toBeInTheDocument()
  })

  it("replaces the pencil with an explained lock hint on a DCS-pinned project", async () => {
    dcsState = { cursor: DCS_CURSOR, loading: false }
    renderTable(withRole(ROLE.PROJECT_LEAD))
    await screen.findByText("bonjour")
    // No pencil — but the affordance does not just vanish: a lock hint carrying
    // sourceReadOnlyReason stands in its place.
    expect(screen.queryByRole("button", { name: "Edit source text" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Source is locked")).toBeInTheDocument()
  })

  it("force-closes an OPEN source editor when canEditSource flips false mid-edit, and says why", async () => {
    // BLOCKER scenario: the pencil was gated on canEditSource but a mounted
    // editor was not. A settings revalidate that delivers a DCS cursor mid-edit
    // used to leave the editor mounted while handleSourceCommit silently
    // dropped every commit — the user typed into a void.
    const project = withRole(ROLE.PROJECT_LEAD)
    const view = renderTable(project)
    const pencil = await screen.findByRole("button", { name: "Edit source text" })
    fireEvent.click(pencil)
    await screen.findByRole("textbox", { name: "Edit source text" })

    // The settings revalidate lands a cursor → capability flips false.
    dcsState = { cursor: DCS_CURSOR, loading: false }
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeStore([makeCell("cell-1")], project.id)}
            username="lead"
            isCompletionConfigured={false}
            isCompletionAvailable={false}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={() => {}}
            onCompleteBatch={() => {}}
            healthMap={new Map()}
            lineNumbersEnabled={false}
            cellLabelsEnabled={false}
            sourceTextDirection="ltr"
            targetTextDirection="ltr"
          />
        </EditorActionsProvider>
      </QueryClientProvider>,
    )

    // The editor unmounts…
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Edit source text" })).not.toBeInTheDocument()
    })
    // …and the WHY is surfaced through the row's write-error banner (the DCS
    // lock reason), not silently.
    expect(screen.getByText(/synced from Door43/i)).toBeInTheDocument()
  })
})
