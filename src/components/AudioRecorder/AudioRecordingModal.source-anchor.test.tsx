// AQU-1407: the source text must stay anchored while the audio panel is open.
//
// Josseline Aguilar (Biblica ETT field trainer, Pattani Malay) on the 2026-09-24
// sync: "if we could find a way to prevent the source from hiding that could be
// helpful (a way to potentially anchor source)." Two separate things hid it:
//
//   1. The source block was an ordinary first child of the panel's scrollable
//      region. Scrolling down to reach the record button — which every laptop
//      viewport requires once the takes drawer is open — carried the source off
//      the top, and it stayed gone through the countdown and the whole take.
//   2. It was `line-clamp-2`, so a verse longer than two lines was cut with no
//      way to see the rest.
//
// These are the structural guards. jsdom/happy-dom cannot measure what is
// actually on screen, so what is asserted here is the contract that makes it
// so: the block is sticky at the top of its own scroller, it renders the whole
// of `original` in a scrollable (never clamped) strip, it survives the phase
// flips, and it re-points at the new line when the performer navigates.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { useState } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

/** Flipped by the one test that needs the modal to believe a take is rolling.
 *  The modal derives `phase: "recording"` from the recorder's own state, so
 *  handing it a recording recorder is the whole of the setup. */
let recorderKind: "idle" | "recording" = "idle"

vi.mock("@/hooks/useOnline", () => ({ useOnline: () => true }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: recorderKind === "recording" ? { kind: "recording" } : { kind: "idle" },
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    prewarm: vi.fn(),
  }),
}))
vi.mock("./probeMicPermission", () => ({ probeMicPermission: vi.fn(async () => "granted" as const) }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: new Map(), isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({ generateCellVoice: vi.fn(async () => true) }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioRemove: vi.fn(),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: vi.fn(async () => "evt"),
  emitCellAudioAttach: vi.fn(async () => "evt"),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioValidate: vi.fn(async () => "evt"),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: vi.fn(async () => ({ audioId: "a", ext: "webm", url: "frontier-audio://a.webm" })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

/** Longer than two lines at the panel's 12px type in a 400px column — i.e. the
 *  shape of verse that `line-clamp-2` used to amputate. */
const LONG_SOURCE =
  "In the beginning God created the heavens and the earth. Now the earth was " +
  "formless and empty, darkness was over the surface of the deep, and the Spirit " +
  "of God was hovering over the waters."

const cellOne = {
  id: "c1",
  fileId: "f1",
  original: LONG_SOURCE,
  translated: "Pada mulanya",
  medium: "text",
} as unknown as CellData

const cellTwo = {
  id: "c2",
  fileId: "f1",
  original: "And God said, Let there be light: and there was light.",
  translated: "Maka jadilah terang",
  medium: "text",
} as unknown as CellData

function renderModal(cells: CellData[] = [cellOne]) {
  return renderWithTooltips(
    <AudioRecordingModal
      open
      project={project}
      cells={cells}
      activeCellId={cells[0].id}
      username="sam"
      onActiveCellChange={() => {}}
      onClose={() => {}}
    />,
  )
}

/** The modal is a controlled component: `gotoIndex` reports the new line and
 *  the workspace feeds it back as `activeCellId`. This is that workspace. */
function ControlledModal({ cells }: { cells: CellData[] }) {
  const [activeCellId, setActiveCellId] = useState(cells[0].id)
  return (
    <AudioRecordingModal
      open
      project={project}
      cells={cells}
      activeCellId={activeCellId}
      username="sam"
      onActiveCellChange={setActiveCellId}
      onClose={() => {}}
    />
  )
}

describe("AQU-1407 — the source stays anchored while the audio panel is open", () => {
  beforeEach(() => {
    localStorage.clear()
    recorderKind = "idle"
  })

  it("pins the source to the top of the panel's scroller", () => {
    // The anchor itself. Without `sticky top-0` the block is just the first
    // thing to scroll away, which is the reported bug.
    renderModal()
    const anchor = screen.getByTestId("rec-source")
    expect(anchor.className).toContain("sticky")
    expect(anchor.className).toContain("top-0")
  })

  it("shows the whole source rather than clamping it to two lines", () => {
    renderModal()
    const text = screen.getByTestId("rec-source-text")
    expect(text).toHaveTextContent(LONG_SOURCE)
    // The regression guard proper: a re-introduced clamp would silently cut the
    // tail off again, and the assertion above cannot see it (clamping is CSS —
    // the text stays in the DOM either way).
    expect(text.className).not.toContain("line-clamp")
    // …and the overflow that replaces it must be reachable, not hidden.
    expect(text.className).toContain("overflow-y-auto")
  })

  it("keeps the source on screen once the countdown is running", async () => {
    // The 3-2-1 is exactly when losing the source hurts most: there is no time
    // left to go looking for it.
    renderModal()
    fireEvent.click(screen.getByTestId("rec-start"))
    await waitFor(() => expect(screen.queryByTestId("rec-start")).not.toBeInTheDocument())
    expect(screen.getByTestId("rec-source-text")).toHaveTextContent(LONG_SOURCE)
  })

  it("keeps the source on screen while a take is rolling", async () => {
    recorderKind = "recording"
    renderModal()
    await waitFor(() => expect(screen.getByTestId("rec-stop")).toBeInTheDocument())
    expect(screen.getByTestId("rec-source-text")).toHaveTextContent(LONG_SOURCE)
  })

  it("re-points the pinned source at the new line when the performer navigates", async () => {
    renderWithTooltips(<ControlledModal cells={[cellOne, cellTwo]} />)
    expect(screen.getByTestId("rec-source-text")).toHaveTextContent(LONG_SOURCE)
    fireEvent.click(screen.getByTestId("rec-next"))
    await waitFor(() =>
      expect(screen.getByTestId("rec-source-text")).toHaveTextContent(
        "And God said, Let there be light: and there was light.",
      ),
    )
  })

  it("still says so when the line has no source at all", () => {
    // The empty state is the one case where nothing can be pinned — it must
    // read as "this line has no source", never as the block having vanished.
    renderModal([{ ...cellOne, original: "" } as CellData])
    expect(screen.getByTestId("rec-source")).toBeInTheDocument()
    expect(screen.getByTestId("rec-source-text")).toHaveTextContent(/empty/i)
  })
})
