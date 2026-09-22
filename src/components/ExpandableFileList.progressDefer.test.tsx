// AQU-1326: the sidebar's per-file `/progress` reads must not go out ahead of
// the editor's first cell page.
//
// QA round 2 (`ea0755c4`) confirmed source-first and the audit-stats / comments
// / audio deferrals, but measured `/progress` still starting ~8–12 ms BEFORE
// the first `cells?side=source` on every cold open. The cause was here, outside
// ProjectWorkspace's gate: this list prefetches file progress for the active
// file (and every expanded one) in a mount effect, and the active file is
// expanded on open.
//
// `prefetchFileProgress` is the network call; this pins that the gate actually
// suppresses it, and that lifting the gate still issues it (deferred, not lost).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import type { FileReference } from "@/lib/parsers/types"

const prefetchMock = vi.fn()
vi.mock("@/lib/progress/file-progress-resource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/progress/file-progress-resource")>()
  return {
    ...actual,
    prefetchFileProgress: (...args: unknown[]) => prefetchMock(...args),
  }
})

import { ExpandableFileList } from "./ExpandableFileList"

const PROJECT_ID = "p1"

const FILES: FileReference[] = [
  {
    id: "gen",
    name: "Genesis",
    type: "usfm",
    createdAt: "2026-01-01T00:00:00.000Z",
    cellCount: 10,
    bookCode: "GEN",
  },
]

function renderList(props: Partial<React.ComponentProps<typeof ExpandableFileList>> = {}) {
  return render(
    <I18nProvider>
      <EditorScrollProvider>
        <ExpandableFileList
          projectId={PROJECT_ID}
          files={FILES}
          activeFileId="gen"
          fileProgress={new Map()}
          suggestionFileIds={new Set()}
          validationCount={0}
          getTokenForFile={async () => "jwt"}
          onSelectFile={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          {...props}
        />
      </EditorScrollProvider>
    </I18nProvider>,
  )
}

beforeEach(() => {
  prefetchMock.mockClear()
})

describe("ExpandableFileList — file-progress deferral (AQU-1326)", () => {
  it("does NOT prefetch file progress while the editor's first cell page is pending", () => {
    renderList({ deferSectionProgress: true })
    expect(prefetchMock).not.toHaveBeenCalled()
  })

  it("prefetches once the gate lifts — the read is deferred, not dropped", () => {
    const { rerender } = renderList({ deferSectionProgress: true })
    expect(prefetchMock).not.toHaveBeenCalled()

    rerender(
      <I18nProvider>
        <EditorScrollProvider>
          <ExpandableFileList
            projectId={PROJECT_ID}
            files={FILES}
            activeFileId="gen"
            fileProgress={new Map()}
            suggestionFileIds={new Set()}
            validationCount={0}
            getTokenForFile={async () => "jwt"}
            onSelectFile={vi.fn()}
            onRename={vi.fn()}
            onMove={vi.fn()}
            deferSectionProgress={false}
          />
        </EditorScrollProvider>
      </I18nProvider>,
    )
    expect(prefetchMock).toHaveBeenCalledWith(PROJECT_ID, "gen", expect.any(Function))
  })

  it("prefetches at mount when nothing is being deferred (default behaviour)", () => {
    renderList()
    expect(prefetchMock).toHaveBeenCalledWith(PROJECT_ID, "gen", expect.any(Function))
  })
})
