/**
 * AQU-1565: what the editor's empty table says on a time-ordered file with no
 * rows. Three different files land on that branch and they want three
 * different things said to them:
 *
 *  - no media at all      → the attach-media prompt, direct-URL field and all
 *  - a linked video       → "linked to a YouTube video", pointing at the Media
 *                           view's timeline where captions are attached
 *  - a linked video + captions on the timeline → name the tracks, and never
 *                           claim the file has no media
 *
 * Driven through the real EditorTable rather than the two empty-state
 * components, because the bug was the BRANCH: a linked-video file fell through
 * to the prompt meant for a file with nothing on it.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { LinkedVideoEmptyState } from "@/lib/editor/linked-video-empty-state"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

const viewerProject: ProjectRecord = {
  ...project,
  syncRole: { level: 100, name: "viewer", source: "test", fetchedAt: "2026-01-01T00:00:00Z" },
}

/** An empty store: the file projects no rows of its own, which is the whole
 *  premise of every case here. */
function emptyStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows([], { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(opts: {
  linkedVideoEmptyState?: LinkedVideoEmptyState | null
  onOpenMediaView?: () => void
  project?: ProjectRecord
} = {}) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={opts.project ?? project}
          cellStore={emptyStore()}
          username="tester"
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
          orderedBy="time"
          onAttachMediaFile={async () => {}}
          onAttachMediaUrl={async () => {}}
          linkedVideoEmptyState={opts.linkedVideoEmptyState ?? null}
          onOpenMediaView={opts.onOpenMediaView}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — empty time-ordered file", () => {
  // The regression guard for everything below: a file that genuinely has no
  // media must keep the prompt, URL field included.
  it("a file with NO linked video still gets the attach-media prompt and its URL field", async () => {
    renderTable()
    expect(await screen.findByText("No media on this file yet")).toBeInTheDocument()
    expect(screen.getByLabelText("Media URL")).toBeInTheDocument()
    expect(screen.queryByTestId("linked-video-empty")).toBeNull()
  })

  it("a linked-video file says so instead, with no attach-media prompt and no URL field", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTrackNames: [] } })
    expect(await screen.findByTestId("linked-video-empty")).toBeInTheDocument()
    expect(screen.getByText("Linked to a YouTube video")).toBeInTheDocument()
    expect(screen.getByText(/Caption tracks are added on the Media view's timeline/)).toBeInTheDocument()
    expect(screen.queryByText("No media on this file yet")).toBeNull()
    expect(screen.queryByLabelText("Media URL")).toBeNull()
  })

  it("offers Open Media view, and the original recording with its timing caveat", async () => {
    const onOpenMediaView = vi.fn()
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTrackNames: [] },
      onOpenMediaView,
    })
    const open = await screen.findByRole("button", { name: "Open Media view" })
    open.click()
    expect(onOpenMediaView).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Have the original recording\?/)).toBeInTheDocument()
    expect(screen.getByText(/same timing as the linked video/)).toBeInTheDocument()
  })

  // Repro step 6: under the timeline, "open the Media view" is a button to
  // where the user already is, so the workspace withholds the handler.
  it("drops the Open Media view action when the table renders under the timeline", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTrackNames: [] } })
    await screen.findByTestId("linked-video-empty")
    expect(screen.queryByRole("button", { name: "Open Media view" })).toBeNull()
  })

  // Repro step 7: captions attached with the timeline's "Attach captions" live
  // in their own content file, so the table still has no rows — but the file
  // plainly does have captions, and must never be told otherwise.
  it("names the attached caption tracks rather than claiming there are none", async () => {
    renderTable({
      linkedVideoEmptyState: {
        isYouTube: true,
        captionTrackNames: ["English captions", "Burmese captions"],
      },
    })
    await screen.findByTestId("linked-video-empty")
    expect(screen.getByText(
      "Its captions are on the Media view's timeline, in English captions, Burmese captions.",
    )).toBeInTheDocument()
    expect(screen.queryByText(/No captions on this video yet/)).toBeNull()
    expect(screen.queryByText("No media on this file yet")).toBeNull()
  })

  it("a non-YouTube linked picture is called a video, not a YouTube video", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: false, captionTrackNames: [] } })
    expect(await screen.findByText("Linked to a video")).toBeInTheDocument()
  })

  it("a Viewer gets the sentence and nothing to click", async () => {
    renderTable({
      project: viewerProject,
      linkedVideoEmptyState: { isYouTube: true, captionTrackNames: [] },
    })
    await screen.findByTestId("linked-video-empty")
    expect(screen.getByText("Linked to a YouTube video")).toBeInTheDocument()
    expect(screen.queryByText("Choose media file")).toBeNull()
    expect(screen.queryByText(/Have the original recording\?/)).toBeNull()
    expect(screen.queryByLabelText("Media URL")).toBeNull()
  })
})
