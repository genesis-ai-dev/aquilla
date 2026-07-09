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

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

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

function renderTable(project: ProjectRecord) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cells={[makeCell("cell-1")]}
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
