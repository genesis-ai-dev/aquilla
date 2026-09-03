/**
 * FRO perf cleanup: onInfractionClick/onOpenComments/onOpenHistory/
 * onAiSetupNeeded/onOpenRecording moved from EditorTable's prop bag into
 * EditorActionsContext (pure pass-through openers, never consumed between
 * EditorTable and the row). This test wires the real EditorTable through the
 * real provider and clicks a real row affordance to prove the context
 * actually reaches EditorRow — a prop-plumbing mistake here would silently
 * disable the "Add comment" button (it only renders when onOpenComments is
 * truthy) rather than throwing a type error.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"
import { MemoryRouter } from "react-router-dom"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in —
// good enough for a single-cell wiring test and independent of layout.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")

  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[]
      renderItem: (props: { item: string; index: number }) => ReactNode
      keyExtractor?: (item: string, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))

      return React.createElement(
        "div",
        null,
        data.map((item, index) => (
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          )
        )),
      )
    }),
  }
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeRows(id: string): CellRow[] {
  return [
    {
      cellId: id,
      side: "source",
      value: "hello",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
    },
    {
      cellId: id,
      side: "target",
      value: "bonjour",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ]
}

function makeStore(cellId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellId), { full: true, maxServerSeq: 1 })
  return store
}

// AQU-618: a cell with an EMPTY target so the AI-generate sparkle skips the
// overwrite-confirm dialog and calls onCompleteSingle directly.
function makeEmptyTargetStore(cellId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const rows = makeRows(cellId)
  const target = rows.find((r) => r.side === "target")
  if (target) target.value = ""
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function makeTwoCellStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const first = makeRows("cell-1")
  const firstTarget = first.find((row) => row.side === "target")
  if (firstTarget) firstTarget.value = ""
  const second = makeRows("cell-2").map((row) => ({
    ...row,
    canonicalRef: "GEN 1:2",
  }))
  store.replaceRows([...first, ...second], { full: true, maxServerSeq: 1 })
  return store
}

function makeEmptyIdmlTargetStore(cellId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const sourceHtml = '<p data-idml-version="2"><span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">hello</span></p>'
  const targetHtml = '<p data-idml-version="2"><span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot"></span></p>'
  const metadata = {
    idml: {
      version: 2,
      slotCount: 1,
      editableSlotIndexes: [0],
      protectedTokenCount: 0,
      anchorSequenceHash: createHash("sha256")
        .update("slot:0:editable:CharacterStyle/Body")
        .digest("hex"),
    },
  }
  const rows = makeRows(cellId)
  for (const row of rows) {
    row.metadata = metadata
    if (row.side === "source") row.valueHtml = sourceHtml
    else {
      row.value = ""
      row.valueHtml = targetHtml
    }
  }
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  actions: Partial<EditorActionsContextValue>,
  completing: Map<string, string> = new Map(),
) {
  const qc = new QueryClient()
  return render(
    // AQU-646 stage 4c: the synth badge's recovery action navigates to voice
    // setup, so it calls `useNavigate()` and cannot mount outside a router.
    // Harmless for every case that never renders the badge.
    <MemoryRouter>
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
        <EditorTable
          project={project}
          cellStore={makeStore("cell-1")}
          username="tester"
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={completing}
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

describe("EditorTable — EditorActionsContext wiring", () => {
  it("clicking the row's comment affordance calls the context's onOpenComments with the cell id", async () => {
    const onOpenComments = vi.fn()
    renderTable({ onOpenComments })

    const button = await screen.findByRole("button", { name: "Add comment" })
    fireEvent.click(button)

    expect(onOpenComments).toHaveBeenCalledTimes(1)
    expect(onOpenComments).toHaveBeenCalledWith("cell-1")
  })

  it("does not render the comment affordance when onOpenComments is absent from context", async () => {
    renderTable({})

    // A moment for the row to mount before asserting absence.
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument()
  })

  it("clicking the row's history affordance calls the context's onOpenHistory with the cell id", async () => {
    const onOpenHistory = vi.fn()
    renderTable({ onOpenHistory })

    const button = await screen.findByRole("button", { name: "Edit history" })
    fireEvent.click(button)

    expect(onOpenHistory).toHaveBeenCalledTimes(1)
    expect(onOpenHistory).toHaveBeenCalledWith("cell-1")
  })

  it("does not render the history affordance when onOpenHistory is absent from context", async () => {
    renderTable({})

    // A moment for the row to mount before asserting absence.
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Edit history" })).not.toBeInTheDocument()
  })

  it("shows a Saved confirmation after a single-cell AI generate/Replace resolves (AQU-618)", async () => {
    // AQU-670: `true` = the draft committed; "Saved" is now gated on that signal.
    const onCompleteSingle = vi.fn().mockResolvedValue(true)
    const onClaimCell = vi.fn()
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeEmptyTargetStore("cell-1")}
            confirmedEditCellId={null}
            onClaimCell={onClaimCell}
            username="tester"
            isCompletionConfigured={true}
            isCompletionAvailable={true}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={onCompleteSingle}
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

    const sparkle = await screen.findByRole("button", { name: "Translate with AI" })
    fireEvent.click(sparkle)

    // Empty target → no overwrite dialog; onCompleteSingle runs directly.
    expect(onCompleteSingle).toHaveBeenCalledTimes(1)
    expect(onCompleteSingle).toHaveBeenCalledWith(expect.objectContaining({ id: "cell-1" }))
    // The "Saved" confirmation appears only AFTER the completion promise
    // resolves — proving the flow returns the user to the cell with a signal
    // that the change landed (the strand-after-Replace bug this fixes).
    expect(await screen.findByText("Saved")).toBeInTheDocument()
    // Returning from AI completion is an activation path too: request the
    // human editing lease, but keep input paused until it is acknowledged.
    expect(onClaimCell).toHaveBeenCalledWith("cell-1")
    expect(screen.getByText("Waiting for an editing connection and lock — editing paused.")).toHaveAttribute("role", "status")
  })

  it("does not steal focus back when another cell is activated before AI save resolves (AQU-618)", async () => {
    let resolveCompletion!: (saved: boolean) => void
    const onCompleteSingle = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveCompletion = resolve
    }))
    const qc = new QueryClient()
    const { container } = render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeTwoCellStore()}
            username="tester"
            isCompletionConfigured={true}
            isCompletionAvailable={true}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={onCompleteSingle}
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

    const firstRow = container.querySelector<HTMLElement>('[data-cell-id="cell-1"]')
    const secondRow = container.querySelector<HTMLElement>('[data-cell-id="cell-2"]')
    expect(firstRow).not.toBeNull()
    expect(secondRow).not.toBeNull()

    fireEvent.click(within(firstRow!).getByRole("button", { name: "Translate with AI" }))
    await waitFor(() => expect(onCompleteSingle).toHaveBeenCalledTimes(1))

    fireEvent.click(secondRow!.querySelector<HTMLElement>("[data-target-read-view]")!)
    await waitFor(() => expect(secondRow!.querySelector(".ProseMirror")).not.toBeNull())
    expect(secondRow).toContainElement(document.activeElement as HTMLElement)

    await act(async () => resolveCompletion(true))
    expect(await screen.findByText("Saved")).toBeInTheDocument()
    expect(secondRow!.querySelector(".ProseMirror")).not.toBeNull()
    expect(firstRow!.querySelector(".ProseMirror")).toBeNull()
  })

  it("keeps AI drafting enabled for protected IDML cells", async () => {
    const onCompleteSingle = vi.fn().mockResolvedValue(true)
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeEmptyIdmlTargetStore("idml-cell")}
            username="tester"
            isCompletionConfigured={true}
            isCompletionAvailable={true}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={onCompleteSingle}
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

    const sparkle = await screen.findByRole("button", { name: "Translate with AI" })
    expect(sparkle).toBeEnabled()
    fireEvent.click(sparkle)
    await waitFor(() => expect(onCompleteSingle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "idml-cell" }),
    ))
  })

  // AQU-618 regression, dialog path: a NON-empty target routes the sparkle
  // through GenerateOverwriteDialog. Confirming "Replace" must also end in the
  // Saved confirmation — the AQU-591 merge rewired the dialog's onConfirm back
  // to the bare onCompleteSingle and silently dropped it (only the empty-cell
  // path above was covered, so CI stayed green).
  it("shows a Saved confirmation after confirming Replace in the overwrite dialog (AQU-618)", async () => {
    // AQU-670: `true` = the draft committed; "Saved" is now gated on that signal.
    const onCompleteSingle = vi.fn().mockResolvedValue(true)
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeStore("cell-1")}
            username="tester"
            isCompletionConfigured={true}
            isCompletionAvailable={true}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={onCompleteSingle}
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

    const sparkle = await screen.findByRole("button", { name: "Translate with AI" })
    fireEvent.click(sparkle)

    // Non-empty target → the overwrite confirm dialog opens first.
    expect(onCompleteSingle).not.toHaveBeenCalled()
    const replace = await screen.findByRole("button", { name: "Replace" })
    fireEvent.click(replace)

    expect(onCompleteSingle).toHaveBeenCalledTimes(1)
    expect(onCompleteSingle).toHaveBeenCalledWith(expect.objectContaining({ id: "cell-1" }))
    expect(await screen.findByText("Saved")).toBeInTheDocument()
  })

  // AQU-670: a draft that failed to queue (completeSingle resolves `false`) must
  // NOT render the "Saved" confirmation — showing it alongside the failure error
  // gave the translator directly contradictory signals for a lost draft.
  it("does NOT show a Saved confirmation when the single-cell draft fails to queue (AQU-670)", async () => {
    const onCompleteSingle = vi.fn().mockResolvedValue(false)
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeEmptyTargetStore("cell-1")}
            username="tester"
            isCompletionConfigured={true}
            isCompletionAvailable={true}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={onCompleteSingle}
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

    const sparkle = await screen.findByRole("button", { name: "Translate with AI" })
    fireEvent.click(sparkle)

    // The completion was attempted...
    await waitFor(() => expect(onCompleteSingle).toHaveBeenCalledTimes(1))
    // ...but it reported failure, so the "Saved" confirmation must never appear.
    // Give the (unwanted) async confirmation a chance to render, then assert absence.
    await Promise.resolve()
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
  })
  // AQU-590: an in-progress AI translation must be evident ON the cell, even
  // when the cell already has a translation (the sparkle regenerate/replace
  // case). Before the fix the target-column overlay was suppressed once the
  // cell had text, leaving only the easy-to-miss Queued→Synced status chip.
  it("marks the row as AI-translating while a completion is in progress, even when the cell already has text", async () => {
    renderTable({}, new Map([["cell-1", "generating"]]))

    const cellText = await screen.findByText("bonjour")
    const row = cellText.closest("[data-grid-row]")
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute("data-ai-translating", "true")
    expect(row?.className).toContain("animate-pulse")
  })

  it("does not mark the row as AI-translating when no completion is running", async () => {
    renderTable({})

    const cellText = await screen.findByText("bonjour")
    const row = cellText.closest("[data-grid-row]")
    expect(row).not.toBeNull()
    expect(row).not.toHaveAttribute("data-ai-translating")
  })

  it("raises and unclamps the row while microphone-permission help is open", async () => {
    renderTable({ onOpenRecording: vi.fn() })

    const micButton = await screen.findByRole("button", {
      name: "Microphone access blocked — click for help",
    })
    fireEvent.click(micButton)

    expect(screen.getByText("Microphone blocked")).toBeInTheDocument()
    expect(micButton.closest("[data-grid-row]")).toHaveClass("z-30", "overflow-visible")
  })
  // ── 2026-08-07 (wire b): a plain row click points the timeline at the cell ──

  it("a plain row click calls the context's onMediaRowActivate with the cell id", async () => {
    const onMediaRowActivate = vi.fn()
    renderTable({ onMediaRowActivate })
    const row = (await screen.findByText("bonjour")).closest("[data-grid-row]")!
    fireEvent.click(row)
    expect(onMediaRowActivate).toHaveBeenCalledWith("cell-1")
  })

  it("cmd-click is multi-select, never a timeline activate", async () => {
    const onMediaRowActivate = vi.fn()
    renderTable({ onMediaRowActivate })
    const row = (await screen.findByText("bonjour")).closest("[data-grid-row]")!
    fireEvent.click(row, { metaKey: true })
    expect(onMediaRowActivate).not.toHaveBeenCalled()
  })

  it("clicking an interactive control inside the row does not activate the timeline", async () => {
    const onMediaRowActivate = vi.fn()
    renderTable({ onOpenComments: vi.fn(), onMediaRowActivate })
    const button = await screen.findByRole("button", { name: "Add comment" })
    fireEvent.click(button)
    expect(onMediaRowActivate).not.toHaveBeenCalled()
  })
})

// ── AQU-646 stage 4c ─────────────────────────────────────────────────────────
//
// The row's synth badge — the one carrying the popover with "Open audio setup",
// which is the richest failure surface in the app — watched the WRONG CELL on
// every file with an audio-cue sibling.
//
// Stage 3f moved the voice button beside it to the heard line that performs the
// subtitle, because that is where the audio belongs. The badge stayed on the
// row's own id, so the button wrote its failure to `synth:<cue>` while the
// badge listened on `synth:<subtitle>` and the two never met. On the dubbing
// workflow — every episode The Chosen ships — a voice failure was therefore
// invisible in the table.
describe("EditorTable — the synth badge watches where the audio lives (stage 4c)", () => {
  const CUE_ID = "cue-for-cell-1"
  afterEach(() => {
    setTtsStatus(ttsStatusKey(CUE_ID), { kind: "idle" })
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "idle" })
  })

  /** The arrangement that broke: this row's audio lives on a cue in the sibling
   *  file, which is what `audioHomeFor` reports. */
  const cueHome: Partial<EditorActionsContextValue> = {
    audioHomeFor: () => [{ id: CUE_ID, fileId: "f1-cues" } as never],
    // Not under test — it is the affordance these cases wait on to know the
    // row has settled, and it only renders when its callback exists.
    onOpenComments: () => {},
  }

  it("lights up for a failure filed under the cue that performs the line", async () => {
    setTtsStatus(ttsStatusKey(CUE_ID), {
      kind: "error",
      message: "voice/tts failed (503): TTS not configured",
    })
    renderTable(cueHome)
    // Before the fix this badge never appeared, however loudly the generation
    // had failed — the failure was filed one cell away from the only thing
    // watching for it.
    expect(await screen.findByTestId("synth-status-error")).toBeInTheDocument()
  })

  // …AND STILL FOR ONE FILED UNDER THE ROW ITSELF, which is the half an
  // adversarial review caught me getting wrong. Stage 3f moved only the rail's
  // voice button to the cue; three producers still write under the row's own
  // cell — the audio lens's CellVoicePanel, a voice dropped from the dock, and
  // "Voice together" — and none of them has an error surface of its own. A
  // badge pointed only at the cue trades one blind spot for three.
  it("lights up for a failure filed under the row's own cell too", async () => {
    setTtsStatus(ttsStatusKey("cell-1"), {
      kind: "error",
      message: "voice/tts failed (503): TTS not configured",
    })
    renderTable(cueHome)
    expect(await screen.findByTestId("synth-status-error")).toBeInTheDocument()
  })

  // A run in flight outranks a stale failure on the other key — otherwise the
  // badge announces the outcome of something that is still running.
  it("shows a run in progress rather than the failure it may be replacing", async () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "error", message: "voice/tts failed (503): x" })
    setTtsStatus(ttsStatusKey(CUE_ID), { kind: "synthesizing" })
    renderTable(cueHome)
    expect(await screen.findByTestId("synth-status-busy")).toBeInTheDocument()
    expect(screen.queryByTestId("synth-status-error")).toBeNull()
  })

  // …and the ordinary arrangement is untouched: with no cue sibling the audio
  // home IS the row, so the badge reads exactly the key it always did.
  it("still reads the row's own cell on a file with no cues", async () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "error", message: "voice/tts failed (503): x" })
    renderTable({ onOpenComments: () => {} })
    expect(await screen.findByTestId("synth-status-error")).toBeInTheDocument()
  })
})
