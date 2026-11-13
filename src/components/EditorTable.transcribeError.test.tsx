/**
 * AQU-1619: a refused transcription belongs on the line that was refused.
 *
 * The failure was always recorded (`transcribe-status.ts`), but the only thing
 * reading it was the Recording tab's badge inside cell details — so a hosted
 * run that hit the per-user rate limit left every refused row in the
 * source/target table under the media timeline looking exactly like a line
 * nobody had tried yet. "Too many requests right now", and the Retry that goes
 * with it, were a panel-open away.
 *
 * Real EditorTable, real rows, mocked list virtualiser (happy-dom has no
 * layout) and a mocked per-file audio read so the clip ids can be shaped.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { clearTranscribeStatus, setTranscribeStatus } from "@/lib/audio/transcribe-status"
import { __resetFileAudioMemoryForTests } from "@/lib/audio/file-has-audio"

vi.mock("@/hooks/useMicPermission", () => ({ useMicPermission: () => ({ micDenied: true }) }))
// A resolved upstream cursor, so the table does not read project settings over
// the network for a question none of these tests turn on.
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList(
      { data, renderItem, keyExtractor }: { data: string[]; renderItem: (p: { item: string; index: number }) => ReactNode; keyExtractor?: (i: string, n: number) => string },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined, scrollToOffset: async () => undefined,
      }))
      return React.createElement("div", null, data.map((item, index) =>
        React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index }))))
    }),
  }
})

// The takes, shaped per test. Everything else in that module stays real.
const audioState = vi.hoisted(() => ({ byCellId: new Map<string, CellAudioEntry>(), hasLoaded: true }))
vi.mock("@/hooks/useFileAudioAttachments", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFileAudioAttachments: () => ({
    byCellId: audioState.byCellId, isLoading: false, hasLoaded: audioState.hasLoaded, revalidate: vi.fn(),
  }),
}))
// Retry must be OFFERED, which takes a session; the real hook has none here.
vi.mock("@/hooks/useFrontierSession", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFrontierSession: () => ({ session: { username: "tester", jwt: "jwt" }, loading: false }),
}))
// Retry is proven by what it ASKS FOR: the transcriber itself is the seam.
const transcribeCell = vi.hoisted(() => vi.fn(async (_args: unknown) => 3))
vi.mock("@/lib/audio/transcribe", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  transcribeCell,
}))

const SOURCE_CLIP = "audio-file-1-1700000000000-abc123"

const project = {
  id: "proj-1", name: "Test Project", sourceLanguage: "en", targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z", files: [], members: [],
  lanes: [{ id: "lane-src", role: "source", language: "English", name: null, langCode: null, legacyTag: null }],
} as unknown as ProjectRecord

/** A media section, as the TEXT lens under the timeline draws it. */
function mediaRow(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId, side: "source", value: "episode.mp3", valueHtml: null, type: "text",
    canonicalRef: null, anchorCellId: null, eventId: `${cellId}-source`,
    sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    medium: "media", startMs: 0, endMs: 5_000,
    ...over,
  } as CellRow
}

function store(rows: CellRow[]): CellStore {
  const s = new CellStore()
  s.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  s.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return s
}

/** The clip a media file's rows share, selected on this cell. */
function entry(audioId: string): CellAudioEntry {
  return {
    attachments: {
      [audioId]: {
        audioId, url: `frontier-audio://${audioId}.mp3`, slot: "recording", mimeType: "audio/mpeg",
        voiceId: null, referenceAudioId: null, durationMs: 5_000, label: null,
        trimStartMs: 0, trimEndMs: 5_000, role: "source", validatorCount: 0, validators: [],
      },
    },
    selectedBySlot: { recording: audioId },
    selectedAudioId: audioId,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
}

function renderTable(rows: CellRow[]) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <EditorActionsProvider value={{ onOpenRecording: vi.fn(), myScopes: [] }}>
          <EditorTable
            project={project}
            cellStore={store(rows)}
            username="tester"
            activeLane=""
            orderedBy="time"
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
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const rowOf = async (text: string) =>
  (await screen.findByText(text)).closest("[data-grid-row]") as HTMLElement

// A signed-in table reads the project's settings. Nothing here turns on them,
// and the suite blocks off-machine requests (AQU-1277), so they answer empty.
const fetchMock = vi.fn(async () => new Response("{}", {
  status: 200, headers: { "content-type": "application/json" },
}))

beforeEach(() => {
  __resetFileAudioMemoryForTests()
  transcribeCell.mockClear()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  audioState.byCellId = new Map([["m1", entry(SOURCE_CLIP)]])
})
afterEach(() => {
  clearTranscribeStatus(SOURCE_CLIP)
  vi.unstubAllGlobals()
})

describe("EditorTable — a refused transcription on the source/target row (AQU-1619)", () => {
  it("shows the failure on the row, with cell details never opened", async () => {
    setTranscribeStatus(SOURCE_CLIP, { kind: "error", message: "hosted transcription failed (429): too many requests" })
    renderTable([mediaRow("m1"), mediaRow("m2", { value: "second section" })])

    const refused = await rowOf("episode.mp3")
    expect(within(refused).getByTestId("transcribe-status-error")).toBeInTheDocument()
    // The panel that used to be the only way to see this stays shut.
    expect(screen.queryByRole("tab", { name: /recording/i })).toBeNull()
  })

  it("opens the rate-limit heading, its explanation and a Retry", async () => {
    setTranscribeStatus(SOURCE_CLIP, { kind: "error", message: "hosted transcription failed (429): too many requests" })
    renderTable([mediaRow("m1")])

    fireEvent.click(within(await rowOf("episode.mp3")).getByTestId("transcribe-status-error"))
    expect(await screen.findByText("Too many requests right now")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("Retry transcribes THAT line's clip again, straight from the row", async () => {
    setTranscribeStatus(SOURCE_CLIP, { kind: "error", message: "hosted transcription failed (429): too many requests" })
    renderTable([mediaRow("m1")])

    fireEvent.click(within(await rowOf("episode.mp3")).getByTestId("transcribe-status-error"))
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))

    expect(transcribeCell).toHaveBeenCalledTimes(1)
    const args = transcribeCell.mock.calls[0]?.[0] as
      { cell: { id: string; selectedAudioId?: string }; language?: string }
    expect(args.cell.id).toBe("m1")
    expect(args.cell.selectedAudioId).toBe(SOURCE_CLIP)
    // Source speech is recognised in the source lane's language, not the lane
    // the reader happens to be working in.
    expect(args.language).toBe("English")
  })

  it("leaves a line that was transcribed in the same run unmarked", async () => {
    setTranscribeStatus(SOURCE_CLIP, { kind: "done", wordCount: 6, durationMs: 900 })
    renderTable([mediaRow("m1")])

    await rowOf("episode.mp3")
    expect(screen.queryByTestId("transcribe-status-error")).toBeNull()
  })
})
