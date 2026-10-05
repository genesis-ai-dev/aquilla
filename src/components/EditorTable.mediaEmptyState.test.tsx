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
import { fireEvent, render, screen } from "@testing-library/react"
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
  /** AQU-1565 follow-up: false = the workspace withheld the upload handlers,
   *  as it does below Project Lead (the source-audio floor). */
  withAttach?: boolean
  /** AQU-1566: present = the workspace offers the caption-rows actions (a
   *  maintainer on an empty linked video whose rows have loaded). */
  onAttachCaptions?: () => void
  onUseCaptionTrackAsRows?: (trackId: string) => void
  /** Sam's D3: "media" = the Media view's Text pane, under the timeline. */
  placement?: "text" | "media"
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
          onAttachMediaFile={opts.withAttach === false ? undefined : async () => {}}
          onAttachMediaUrl={opts.withAttach === false ? undefined : async () => {}}
          linkedVideoEmptyState={opts.linkedVideoEmptyState ?? null}
          linkedVideoEmptyPlacement={opts.placement}
          onOpenMediaView={opts.onOpenMediaView}
          onAttachCaptions={opts.onAttachCaptions}
          onUseCaptionTrackAsRows={opts.onUseCaptionTrackAsRows}
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
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTracks: [] } })
    expect(await screen.findByTestId("linked-video-empty")).toBeInTheDocument()
    expect(screen.getByText("Linked to a YouTube video")).toBeInTheDocument()
    expect(screen.getByText("When a maintainer attaches captions, they become this file's rows.")).toBeInTheDocument()
    expect(screen.queryByText("No media on this file yet")).toBeNull()
    expect(screen.queryByLabelText("Media URL")).toBeNull()
  })

  it("offers Open Media view, and the original recording with its timing caveat on the next step", async () => {
    const onOpenMediaView = vi.fn()
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
      onOpenMediaView,
    })
    const open = await screen.findByRole("button", { name: "Open Media view" })
    open.click()
    expect(onOpenMediaView).toHaveBeenCalledTimes(1)
    // Sam's D1: the recording, and its explanation, wait behind a quiet link.
    expect(screen.queryByText("Choose media file")).toBeNull()
    expect(screen.queryByText(/same timing as the video/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "or use the original recording" }))
    expect(screen.getByText("Use the original recording")).toBeInTheDocument()
    expect(screen.getByText("Choose media file")).toBeInTheDocument()
    // AQU-1565 follow-up: the caveat says the video keeps its own sound and
    // where to switch to the recording (the sound menu on the video).
    expect(screen.getByText(/same timing as the video/)).toBeInTheDocument()
    expect(screen.getByText(/keeps playing with its own sound/)).toBeInTheDocument()
    expect(screen.getByText(/sound menu on the video/)).toBeInTheDocument()
  })

  it("a non-YouTube picture's caveat has no sound menu to point to", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: false, captionTracks: [] } })
    // With no caption action above it, the link stands on its own.
    fireEvent.click(await screen.findByRole("button", { name: "Add the original recording" }))
    expect(screen.getByText(/same timing as the linked video/)).toBeInTheDocument()
    expect(screen.queryByText(/sound menu/)).toBeNull()
  })

  // AQU-1565 follow-up: the upload is stored as the file's source audio, which
  // the server takes only from Project Lead up, so the workspace withholds the
  // handlers below that. Nothing that would fail may be offered.
  it("offers no upload when the workspace withholds it (a contributor)", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTracks: [] }, withAttach: false })
    await screen.findByTestId("linked-video-empty")
    expect(screen.queryByText("Choose media file")).toBeNull()
    expect(screen.queryByRole("button", { name: /original recording/ })).toBeNull()
  })

  it("a file with no linked video offers no attach prompt either, without the handlers", async () => {
    renderTable({ withAttach: false })
    await screen.findByText("No media segments yet")
    expect(screen.queryByLabelText("Media URL")).toBeNull()
    // Someone who cannot add the recording is not told to import or record:
    // with no rows there is nothing to record on, and no import to make.
    expect(screen.getByText("This file's recording hasn't been added yet. A project lead can add it.")).toBeInTheDocument()
    expect(screen.queryByText(/Import an audio or video file/)).toBeNull()
  })

  it("lets a long caption track name wrap instead of spilling out of the column", async () => {
    const name = "Episode 12: The Wedding at Cana (English captions, final)"
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [{ id: "t1", name, canBecomeRows: true }] },
      onUseCaptionTrackAsRows: () => {},
    })
    const button = await screen.findByRole("button", { name: `Use "${name}" as this file's rows` })
    expect(button.className).toContain("whitespace-normal")
  })

  // Repro step 6: under the timeline, "open the Media view" is a button to
  // where the user already is, so the workspace withholds the handler.
  it("drops the Open Media view action when the table renders under the timeline", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTracks: [] } })
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
        captionTracks: [
          { id: "t-en", name: "English captions", canBecomeRows: true },
          { id: "t-my", name: "Burmese captions", canBecomeRows: true },
        ],
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
    renderTable({ linkedVideoEmptyState: { isYouTube: false, captionTracks: [] } })
    expect(await screen.findByText("Linked to a video")).toBeInTheDocument()
  })

  it("a Viewer gets the sentence and nothing to click", async () => {
    renderTable({
      project: viewerProject,
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
    })
    await screen.findByTestId("linked-video-empty")
    expect(screen.getByText("Linked to a YouTube video")).toBeInTheDocument()
    expect(screen.queryByText("Choose media file")).toBeNull()
    expect(screen.queryByRole("button", { name: /original recording/ })).toBeNull()
    expect(screen.queryByLabelText("Media URL")).toBeNull()
  })

  // ── AQU-1566 (Sam's option b): the first captions become this file's rows ──

  it("offers a maintainer Attach captions in place, and says the captions become rows", async () => {
    const onAttachCaptions = vi.fn()
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
      onAttachCaptions,
      onOpenMediaView: () => {},
    })
    await screen.findByTestId("linked-video-empty")
    expect(screen.getByText(
      "Attach its captions (VTT, SRT or SBV) and they become this file's rows, ready to translate.",
    )).toBeInTheDocument()
    // The old pointer to the timeline is for people who cannot attach here.
    expect(screen.queryByText(/When a maintainer attaches captions/)).toBeNull()
    screen.getByRole("button", { name: "Attach captions" }).click()
    expect(onAttachCaptions).toHaveBeenCalledTimes(1)
    // Sam's D1: one primary action. Open Media view would compete with it, so
    // it is kept only for people who cannot attach captions.
    expect(screen.queryByRole("button", { name: "Open Media view" })).toBeNull()
  })

  it("offers no Attach captions when the workspace withholds it (below maintainer)", async () => {
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTracks: [] } })
    await screen.findByTestId("linked-video-empty")
    expect(screen.queryByRole("button", { name: "Attach captions" })).toBeNull()
    expect(screen.getByText("When a maintainer attaches captions, they become this file's rows.")).toBeInTheDocument()
  })

  it("offers one Use-as-rows button per source caption track, and never for a target-text track", async () => {
    const onUse = vi.fn()
    renderTable({
      linkedVideoEmptyState: {
        isYouTube: true,
        captionTracks: [
          { id: "t-a", name: "Track A", canBecomeRows: true },
          { id: "t-b", name: "Track B", canBecomeRows: true },
          { id: "target-subtitles", name: "Target text", canBecomeRows: false },
        ],
      },
      onAttachCaptions: () => {},
      onUseCaptionTrackAsRows: onUse,
    })
    await screen.findByTestId("linked-video-empty")
    expect(screen.getByText(
      "Its captions are on the Media view's timeline, in Track A, Track B, Target text.",
    )).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /as this file's rows/ })).toHaveLength(2)
    expect(screen.queryByRole("button", { name: 'Use "Target text" as this file\'s rows' })).toBeNull()
    expect(screen.getByText("Other caption tracks stay on the timeline.")).toBeInTheDocument()
    screen.getByRole("button", { name: 'Use "Track B" as this file\'s rows' }).click()
    expect(onUse).toHaveBeenCalledWith("t-b")
  })

  it("says nothing about other tracks when there is only one", async () => {
    renderTable({
      linkedVideoEmptyState: {
        isYouTube: true,
        captionTracks: [{ id: "t-a", name: "Episode captions", canBecomeRows: true }],
      },
      onUseCaptionTrackAsRows: () => {},
    })
    expect(await screen.findByRole("button", { name: 'Use "Episode captions" as this file\'s rows' }))
      .toBeInTheDocument()
    expect(screen.queryByText("Other caption tracks stay on the timeline.")).toBeNull()
  })

  // The viewer decision (AQU-1565 follow-up): a Viewer may open the Media view
  // and watch, and is offered nothing that writes, even if a caller passed
  // every handler.
  it("a Viewer keeps Open Media view and gets nothing else, whatever the caller passed", async () => {
    const onOpenMediaView = vi.fn()
    renderTable({
      project: viewerProject,
      linkedVideoEmptyState: {
        isYouTube: true,
        captionTracks: [{ id: "t-a", name: "Episode captions", canBecomeRows: true }],
      },
      onOpenMediaView,
      onAttachCaptions: () => {},
      onUseCaptionTrackAsRows: () => {},
    })
    await screen.findByTestId("linked-video-empty")
    screen.getByRole("button", { name: "Open Media view" }).click()
    expect(onOpenMediaView).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByText("Choose media file")).toBeNull()
  })

  // ── Sam's D1 and D3 (2026-10-05) ──

  it("hides the column-header bar while an empty linked video has no rows, and only then", async () => {
    const { unmount } = renderTable()
    await screen.findByText("No media on this file yet")
    expect(screen.getByTestId("table-column-headers")).toBeInTheDocument()
    unmount()
    renderTable({ linkedVideoEmptyState: { isYouTube: true, captionTracks: [] } })
    await screen.findByTestId("linked-video-empty")
    expect(screen.queryByTestId("table-column-headers")).toBeNull()
  })

  it("is one card for a maintainer: title, one sentence, Attach captions, and a quiet link to the recording", async () => {
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
      onAttachCaptions: () => {},
      onOpenMediaView: () => {},
    })
    const card = await screen.findByTestId("linked-video-empty")
    expect(card).toHaveAttribute("data-placement", "text")
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual([
      "Attach captions", "or use the original recording",
    ])
    expect(screen.getByRole("button", { name: "Attach captions" })).toHaveAttribute("data-variant", "default")
    expect(screen.getByRole("button", { name: "or use the original recording" })).toHaveAttribute("data-variant", "link")
    // The recording's explanation waits on its own step...
    expect(screen.queryByText(/same timing as the video/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "or use the original recording" }))
    expect(screen.getByText(/same timing as the video/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Attach captions" })).toBeNull()
    // ...and the way back is right there.
    fireEvent.click(screen.getByRole("button", { name: "Back to captions" }))
    expect(screen.getByRole("button", { name: "Attach captions" })).toBeInTheDocument()
  })

  it("is one line in the Media view's Text pane, pointing at the Source text lane", async () => {
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
      onAttachCaptions: () => {},
      placement: "media",
    })
    const card = await screen.findByTestId("linked-video-empty")
    expect(card).toHaveAttribute("data-placement", "media")
    expect(card).toHaveTextContent(
      "No rows yet. Attach captions on the timeline's Source text lane, and they become this file's rows.",
    )
    // The prompt itself is on the lane, so it is not repeated here.
    expect(screen.queryByRole("button", { name: "Attach captions" })).toBeNull()
    expect(screen.queryByText("Linked to a YouTube video")).toBeNull()
    expect(screen.queryByText("Choose media file")).toBeNull()
    expect(screen.queryByTestId("table-column-headers")).toBeNull()
    // The timeline has no upload of its own, so the recording stays reachable.
    fireEvent.click(screen.getByRole("button", { name: "Add the original recording" }))
    expect(screen.getByText("Choose media file")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back to captions" }))
    expect(screen.getByTestId("linked-video-empty")).toHaveAttribute("data-placement", "media")
  })

  it("tells someone below maintainer, in the Media view, who will attach the captions", async () => {
    renderTable({
      linkedVideoEmptyState: { isYouTube: true, captionTracks: [] },
      withAttach: false,
      placement: "media",
    })
    const card = await screen.findByTestId("linked-video-empty")
    expect(card).toHaveTextContent("When a maintainer attaches captions, they become this file's rows.")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
