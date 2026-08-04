import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

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
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord, RuleInfraction } from "@/lib/parsers/types"

// AQU-659: the media detail pane now mounts the SHARED TranslatedEditor rather
// than a bespoke textarea. TranslatedEditor has its own comprehensive suite;
// here we assert the timeline's integration of it — that cell content, the
// editable flag, terminology concepts, and infractions are forwarded, and that
// its commit (value + rich-text valueHtml) reaches onCommitTarget unchanged.
vi.mock("@/components/TranslatedEditor", () => ({
  TranslatedEditor: (props: {
    editable?: boolean
    initialHtml?: string
    initialPlain: string
    terminologyConcepts?: unknown[]
    infractions?: unknown[]
    onCommit: (snap: { value: string; valueHtml: string }) => void
  }) => (
    <div
      data-testid="mock-translated-editor"
      data-editable={String(props.editable)}
      data-initial-html={props.initialHtml ?? ""}
      data-initial-plain={props.initialPlain}
      data-terminology-count={String(props.terminologyConcepts?.length ?? 0)}
      data-infractions-count={String(props.infractions?.length ?? 0)}
    >
      <button
        type="button"
        data-testid="mock-commit"
        onClick={() => props.onCommit({ value: "Hola", valueHtml: "<p>Hola</p>" })}
      >
        commit
      </button>
    </div>
  ),
}))

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

  it("mounts the shared editor and forwards cell content, editability, terminology, and infractions", () => {
    const concepts = [{ id: "k1" }] as unknown as Concept[]
    const infractions = [{ ruleId: "r1", cellId: "x9", fileId: "f1", message: "m", spans: [] }] as RuleInfraction[]
    render(
      <TimelineCellDetail
        cell={cell({ id: "x9", translated: "Hi", translatedHtml: "<p>Hi</p>" })}
        editable
        terminologyConcepts={concepts}
        infractions={infractions}
        onCommitTarget={() => {}}
      />,
    )
    const editor = screen.getByTestId("mock-translated-editor")
    expect(editor).toHaveAttribute("data-initial-html", "<p>Hi</p>")
    expect(editor).toHaveAttribute("data-initial-plain", "Hi")
    expect(editor).toHaveAttribute("data-editable", "true")
    expect(editor).toHaveAttribute("data-terminology-count", "1")
    expect(editor).toHaveAttribute("data-infractions-count", "1")
    // No <textarea> parity fallback remains.
    expect(document.querySelector("textarea")).toBeNull()
  })

  it("forwards a rich-text commit (value + valueHtml) to onCommitTarget", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ id: "x9" })} editable onCommitTarget={onCommit} />)
    fireEvent.click(screen.getByTestId("mock-commit"))
    expect(onCommit).toHaveBeenCalledWith("x9", "Hola", "<p>Hola</p>")
  })

  it("does not commit when the pane is read-only", () => {
    const onCommit = vi.fn()
    render(<TimelineCellDetail cell={cell({ id: "x9" })} editable={false} onCommitTarget={onCommit} />)
    fireEvent.click(screen.getByTestId("mock-commit"))
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

  it("shows a source-audio play control for an audio-source clip", () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <TimelineCellDetail
          cell={cell({
            id: "aud",
            original: "clip.mp3",
            selectedAudioId: "a1",
            attachments: { a1: { url: "https://cdn/clip.mp3", type: "audio/mpeg" } },
          })}
          editable
          project={{ id: "p1" } as unknown as ProjectRecord}
          onCommitTarget={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText("Play source audio")).toBeInTheDocument()
  })

  it("shows no source-audio control when the clip has no recording", () => {
    render(<TimelineCellDetail cell={cell({ original: "plain subtitle" })} editable onCommitTarget={() => {}} />)
    expect(screen.queryByTestId("tl-detail-source-audio")).toBeNull()
  })

  it("shows a calm non-retryable missing-audio badge only when audioMissing is set", () => {
    const { rerender } = render(
      <TimelineCellDetail cell={cell({})} editable onCommitTarget={() => {}} />,
    )
    expect(screen.queryByTestId("tl-detail-audio-missing")).not.toBeInTheDocument()

    rerender(<TimelineCellDetail cell={cell({})} editable onCommitTarget={() => {}} audioMissing />)
    const badge = screen.getByTestId("tl-detail-audio-missing")
    expect(badge).toHaveTextContent("This clip's audio is missing.")
    // Permanent deletion — a status, not an actionable retry control.
    expect(badge.querySelector("button")).toBeNull()
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
  it("generating: status line + streaming preview beside the editor", () => {
    const actions = makeActions({
      completing: new Map([["c1", "generating"]]),
      previews: new Map([["c1", "bonjour le mo"]]),
    })
    render(<TimelineCellDetail cell={timedCell()} editable onCommitTarget={() => {}} detailActions={actions} />)
    expect(screen.getByTestId("tl-detail-generating")).toHaveTextContent("Generating…")
    // AQU-659 parity: the target is the shared rich editor, so the streamed
    // chunks render in a dedicated preview block, not inside the surface.
    expect(screen.getByTestId("tl-detail-preview")).toHaveTextContent("bonjour le mo")
    expect(screen.getByTestId("mock-translated-editor")).toBeInTheDocument()
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

  it("AQU-785: a recorded take is playable in the media target card (and the source clip stays playable)", () => {
    const qc = new QueryClient()
    // After recording, the take (cellId-seeded) is the selected recording, but
    // the imported source clip (fileId-seeded) is still attached. Both must be
    // independently playable — the source in its card, the take in the target.
    const sourceId = "audio-f1-1700000000-abcdefgh.mp3"
    const takeId = "audio-c1-1700000000-ijklmnop.webm"
    render(
      <QueryClientProvider client={qc}>
        <TimelineCellDetail
          cell={cell({
            selectedAudioId: takeId,
            attachments: {
              [sourceId]: { type: "audio", url: `frontier-audio://${sourceId}` },
              [takeId]: { type: "audio", url: `frontier-audio://${takeId}` },
            },
          } as Partial<CellData>)}
          editable
          project={{ id: "p1" } as unknown as ProjectRecord}
          onCommitTarget={() => {}}
          detailActions={makeActions()}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("tl-detail-take-audio")).toBeInTheDocument()
    expect(screen.getByLabelText("Play recorded take")).toBeInTheDocument()
    // The imported source clip is still reachable in its own card, not hijacked
    // by the selection flipping to the take.
    expect(screen.getByTestId("tl-detail-source-audio")).toBeInTheDocument()
    // Once a take exists the record affordance is gone (its playback replaces it).
    expect(screen.queryByTestId("tl-detail-record")).toBeNull()
  })

  it("AQU-785: no take-playback control on a section that only has its imported source clip", () => {
    const qc = new QueryClient()
    const sourceId = "audio-f1-1700000000-abcdefgh.mp3"
    render(
      <QueryClientProvider client={qc}>
        <TimelineCellDetail
          cell={cell({
            selectedAudioId: sourceId,
            attachments: { [sourceId]: { type: "audio", url: `frontier-audio://${sourceId}` } },
          } as Partial<CellData>)}
          editable
          project={{ id: "p1" } as unknown as ProjectRecord}
          onCommitTarget={() => {}}
          detailActions={makeActions()}
        />
      </QueryClientProvider>,
    )
    expect(screen.queryByTestId("tl-detail-take-audio")).toBeNull()
    expect(screen.getByTestId("tl-detail-source-audio")).toBeInTheDocument()
    expect(screen.getByTestId("tl-detail-record")).toBeInTheDocument()
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
