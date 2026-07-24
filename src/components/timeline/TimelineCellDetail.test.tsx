import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

// AQU-646 round 3: keep the heavy audio components out of this module graph.
vi.mock("@/components/CellTtsButton", () => ({
  CellTtsButton: () => <button type="button" data-testid="mock-tts" />,
}))
vi.mock("@/components/CellAudioUploadButton", () => ({
  CellAudioUploadButton: () => <button type="button" data-testid="mock-upload" />,
}))

import { TimelineCellDetail, type TimelineDetailActions } from "./TimelineCellDetail"
import { setSkipReplaceConfirm } from "@/lib/store/replace-confirm-pref"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

function makeActions(over: Partial<TimelineDetailActions> = {}): TimelineDetailActions {
  return {
    isCompletionConfigured: true,
    isCompletionAvailable: true,
    isAnonymous: false,
    completing: new Map(),
    previews: new Map(),
    onCompleteSingle: vi.fn(async () => {}),
    onAiSetupNeeded: vi.fn(),
    onOpenComments: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenRecording: vi.fn(),
    openCommentCounts: new Map(),
    projectId: "p1",
    sourceLanguage: "en",
    targetLanguage: "fr",
    username: "tester",
    ...over,
  }
}

describe("TimelineCellDetail", () => {
  it("shows the selected clip's source text", () => {
    render(
      <TimelineCellDetail
        cell={cell({ original: "Go get the man", startTime: 1, endTime: 3 })}
        editable
        onCommitTarget={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-detail-source")).toHaveTextContent("Go get the man")
  })

  it("commits the target on blur when it changed", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ id: "x9", translated: "" })} editable onCommitTarget={onCommit} />)
    const ta = screen.getByTestId("tl-detail-target")
    fireEvent.change(ta, { target: { value: "Hola" } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith("x9", "Hola")
  })

  it("does not commit when unchanged", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ translated: "same" })} editable onCommitTarget={onCommit} />)
    fireEvent.blur(screen.getByTestId("tl-detail-target"))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("renders an empty state with no selection", () => {
    render(<TimelineCellDetail cell={null} editable onCommitTarget={() => {}} />)
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
  })

  it("renders no action row without detailActions (back-compat)", () => {
    render(<TimelineCellDetail cell={cell({ startTime: 1, endTime: 3 })} editable onCommitTarget={() => {}} />)
    expect(screen.queryByTestId("tl-detail-actions")).toBeNull()
  })
})

// ── AQU-646 round 3: the action row ─────────────────────────────────────────

const timedCell = (o: Partial<CellData> = {}) => cell({ startTime: 1, endTime: 3, ...o })

beforeEach(() => {
  setSkipReplaceConfirm(false)
})

describe("TimelineCellDetail — Translate with AI", () => {
  it("empty target → completes immediately, no confirm", () => {
    const actions = makeActions()
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    fireEvent.click(screen.getByTestId("tl-detail-ai"))
    expect(actions.onCompleteSingle).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }))
  })

  it("non-empty target → overwrite dialog; confirm fires the completion", () => {
    const actions = makeActions()
    render(
      <TimelineCellDetail cell={timedCell({ translated: "bonjour" })} editable onCommitTarget={() => {}} detailActions={actions} />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-ai"))
    expect(actions.onCompleteSingle).not.toHaveBeenCalled()
    expect(screen.getByText("Replace existing translation?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(actions.onCompleteSingle).toHaveBeenCalledTimes(1)
  })

  it("validated cell escalates the confirm copy", () => {
    render(
      <TimelineCellDetail
        cell={timedCell({ translated: "bonjour", status: "validated" })}
        editable
        onCommitTarget={() => {}}
        detailActions={makeActions()}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-ai"))
    expect(screen.getByText("Replace validated translation?")).toBeInTheDocument()
  })

  it("honors the AQU-591 skip-confirm opt-out for non-validated cells", () => {
    setSkipReplaceConfirm(true)
    const actions = makeActions()
    render(
      <TimelineCellDetail cell={timedCell({ translated: "bonjour" })} editable onCommitTarget={() => {}} detailActions={actions} />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-ai"))
    expect(actions.onCompleteSingle).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Replace existing translation?")).toBeNull()
  })

  it("unconfigured completion routes to AI setup", () => {
    const actions = makeActions({ isCompletionConfigured: false })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    fireEvent.click(screen.getByTestId("tl-detail-ai"))
    expect(actions.onAiSetupNeeded).toHaveBeenCalled()
    expect(actions.onCompleteSingle).not.toHaveBeenCalled()
  })

  it("anonymous session disables the AI button", () => {
    render(
      <TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={makeActions({ isAnonymous: true })} />,
    )
    expect(screen.getByTestId("tl-detail-ai")).toBeDisabled()
  })
})

describe("TimelineCellDetail — Regenerate", () => {
  it("shown for a non-validated cell with a draft; passes regenerate", () => {
    const actions = makeActions()
    render(
      <TimelineCellDetail cell={timedCell({ translated: "bonjour" })} editable onCommitTarget={() => {}} detailActions={actions} />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-regenerate"))
    expect(actions.onCompleteSingle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
      { regenerate: true },
    )
  })

  it("hidden for validated cells and for empty targets", () => {
    const { rerender } = render(
      <TimelineCellDetail
        cell={timedCell({ translated: "bonjour", status: "validated" })}
        editable
        onCommitTarget={() => {}}
        detailActions={makeActions()}
      />,
    )
    expect(screen.queryByTestId("tl-detail-regenerate")).toBeNull()
    rerender(
      <TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={makeActions()} />,
    )
    expect(screen.queryByTestId("tl-detail-regenerate")).toBeNull()
  })
})

describe("TimelineCellDetail — streaming state", () => {
  it("generating: status line + disabled textarea showing the preview", () => {
    const actions = makeActions({
      completing: new Map([["c1", "generating"]]),
      previews: new Map([["c1", "bonjour le mo"]]),
    })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    expect(screen.getByTestId("tl-detail-generating")).toHaveTextContent("Generating…")
    const ta = screen.getByTestId("tl-detail-target")
    expect(ta).toBeDisabled()
    expect(ta).toHaveValue("bonjour le mo")
  })

  it("searching shows the example-finding phase", () => {
    const actions = makeActions({ completing: new Map([["c1", "searching"]]) })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    expect(screen.getByTestId("tl-detail-generating")).toHaveTextContent("Finding examples…")
  })

  it("error tints the AI affordance and stays clickable", () => {
    const actions = makeActions({ completing: new Map([["c1", "error"]]) })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    expect(screen.getByTestId("tl-detail-ai")).toHaveAttribute("aria-label", "Generation failed — try again")
    expect(screen.getByTestId("tl-detail-ai")).not.toBeDisabled()
  })
})

describe("TimelineCellDetail — audio, comments, history, footnote", () => {
  it("Record fires onOpenRecording; hidden when the cell already has audio", () => {
    const actions = makeActions()
    const { rerender } = render(
      <TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-record"))
    expect(actions.onOpenRecording).toHaveBeenCalledWith("c1")
    // SUB-29: hiding requires a recorded TAKE (cellId-seeded audioId) — an
    // ambiguous/source-clip id keeps the mic visible on media cells.
    const takeId = "audio-c1-1700000000-abcdefgh.webm"
    rerender(
      <TimelineCellDetail
        cell={timedCell({
          selectedAudioId: takeId,
          attachments: { [takeId]: { type: "audio", url: `frontier-audio://${takeId}` } },
        } as Partial<CellData>)}
        editable
        onCommitTarget={() => {}}
        detailActions={actions}
      />,
    )
    expect(screen.queryByTestId("tl-detail-record")).toBeNull()
  })

  it("Comments and History fire with the cell id; comment label counts open threads", () => {
    const actions = makeActions({ openCommentCounts: new Map([["c1", 2]]) })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    fireEvent.click(screen.getByTestId("tl-detail-comments"))
    expect(actions.onOpenComments).toHaveBeenCalledWith("c1")
    expect(screen.getByTestId("tl-detail-comments")).toHaveAttribute("aria-label", "Comments (2 open)")
    fireEvent.click(screen.getByTestId("tl-detail-history"))
    expect(actions.onOpenHistory).toHaveBeenCalledWith("c1")
  })

  it("footnote appends the USFM marker to the target and commits", () => {
    const onCommitTarget = vi.fn()
    render(
      <TimelineCellDetail
        cell={timedCell({ translated: "bonjour" })}
        editable
        onCommitTarget={onCommitTarget}
        detailActions={makeActions()}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-detail-footnote"))
    fireEvent.change(screen.getByPlaceholderText(/footnote text/i), { target: { value: "a note" } })
    fireEvent.click(screen.getByRole("button", { name: /^Add footnote$/i }))
    expect(onCommitTarget).toHaveBeenCalledTimes(1)
    const committed = onCommitTarget.mock.calls[0] as [string, string]
    expect(committed[0]).toBe("c1")
    expect(committed[1].startsWith("bonjour")).toBe(true)
    expect(committed[1]).toContain("a note")
    expect(committed[1]).toContain("\\f")
  })

  it("read-only: mutating actions hidden, Comments/History remain", () => {
    render(
      <TimelineCellDetail cell={timedCell()} editable={false} onCommitTarget={() => {}} detailActions={makeActions()} />,
    )
    expect(screen.queryByTestId("tl-detail-ai")).toBeNull()
    expect(screen.queryByTestId("tl-detail-record")).toBeNull()
    expect(screen.queryByTestId("tl-detail-footnote")).toBeNull()
    expect(screen.getByTestId("tl-detail-comments")).toBeInTheDocument()
    expect(screen.getByTestId("tl-detail-history")).toBeInTheDocument()
  })
})

describe("TimelineCellDetail — SUB-29 mic gate + error message", () => {
  it("mic/upload VISIBLE on an imported section (source clip in the recording slot)", () => {
    const sourceId = "audio-file-9-1700000000-abcdefgh.mp3"
    render(
      <TimelineCellDetail
        cell={timedCell({
          selectedAudioId: sourceId,
          attachments: { [sourceId]: { type: "audio", url: `frontier-audio://${sourceId}` } },
        } as Partial<CellData>)}
        editable
        onCommitTarget={() => {}}
        detailActions={makeActions()}
      />,
    )
    expect(screen.getByTestId("tl-detail-record")).toBeInTheDocument()
    expect(screen.getByTestId("mock-upload")).toBeInTheDocument()
  })

  it("mic hidden once a TAKE (cellId-seeded) is selected", () => {
    const takeId = "audio-c1-1700000000-abcdefgh.webm"
    render(
      <TimelineCellDetail
        cell={timedCell({
          selectedAudioId: takeId,
          attachments: { [takeId]: { type: "audio", url: `frontier-audio://${takeId}` } },
        } as Partial<CellData>)}
        editable
        onCommitTarget={() => {}}
        detailActions={makeActions()}
      />,
    )
    expect(screen.queryByTestId("tl-detail-record")).toBeNull()
  })

  it("error state surfaces the drilled message, not the generic tooltip", () => {
    const actions = makeActions({
      completing: new Map([["c1", "error"]]),
      errors: new Map([["c1", "No source text yet — transcribe this section first."]]),
    })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    expect(screen.getByTestId("tl-detail-ai")).toHaveAttribute(
      "aria-label",
      "No source text yet — transcribe this section first.",
    )
  })
})
