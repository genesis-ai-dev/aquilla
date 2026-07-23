import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TimelineCellDetail } from "./TimelineCellDetail"
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
})
