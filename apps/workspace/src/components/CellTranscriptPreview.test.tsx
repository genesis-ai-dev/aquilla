import { describe, expect, it, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import * as Y from "yjs"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import type { WordTiming } from "@/lib/codex-editor/types"

function makeDoc(cellId: string, initialText = ""): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  const yCell = new Y.Map()
  const frag = new Y.XmlFragment()
  if (initialText) {
    const para = new Y.XmlElement("paragraph")
    para.insert(0, [new Y.XmlText(initialText)])
    frag.insert(0, [para])
  }
  yCell.set("translatedXml", frag)
  cellsMap.set(cellId, yCell)
  return doc
}

const TIMINGS: WordTiming[] = [
  { word: "hello", t0: 0, t1: 0.4, start: 0, end: 5 },
  { word: "world", t0: 0.4, t1: 0.9, start: 6, end: 11 },
]

afterEach(cleanup)

describe("CellTranscriptPreview", () => {
  it("renders the transcript and a positive label when it matches the cell text", () => {
    const doc = makeDoc("c1", "hello world")
    const { container } = render(
      <CellTranscriptPreview
        timings={TIMINGS}
        cellText="hello world"
        cellId="c1"
        doc={doc}
        alignedToCellText
        editable
      />
    )
    expect(container.textContent).toMatch(/Whisper heard the cell exactly/)
    expect(container.textContent).toMatch(/2 words/)
    expect(container.textContent).toMatch(/"hello world"/)
    // No "Replace" button when matching
    expect(container.querySelector("button")).toBeNull()
  })

  it("offers 'Use as cell text' when the cell is empty", () => {
    const doc = makeDoc("c1", "")
    const { container } = render(
      <CellTranscriptPreview
        timings={TIMINGS}
        cellText=""
        cellId="c1"
        doc={doc}
        alignedToCellText={false}
        editable
      />
    )
    const btn = container.querySelector("button")
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toMatch(/Use as cell text/)
  })

  it("clicking Replace writes the transcript into the cell's translatedXml", () => {
    // cellText is longer than the timings' last offset, so it's a content
    // mismatch (Whisper heard different words) rather than a stale-edits case.
    const cellText = "completely different sentence"
    const doc = makeDoc("c1", cellText)
    const { container } = render(
      <CellTranscriptPreview
        timings={TIMINGS}
        cellText={cellText}
        cellId="c1"
        doc={doc}
        alignedToCellText={false}
        editable
      />
    )
    const btn = container.querySelector("button")
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toMatch(/Replace cell text/)
    fireEvent.click(btn!)

    const yCell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const frag = yCell.get("translatedXml") as Y.XmlFragment
    const text = frag.toJSON()
    expect(text).toContain("hello world")
  })

  it("hides the Replace button for read-only cells", () => {
    const doc = makeDoc("c1", "wrong text")
    const { container } = render(
      <CellTranscriptPreview
        timings={TIMINGS}
        cellText="wrong text"
        cellId="c1"
        doc={doc}
        alignedToCellText
        editable={false}
      />
    )
    expect(container.querySelector("button")).toBeNull()
  })

  it("flags stale timings when the cell text was edited shorter than the last word's offset", () => {
    const doc = makeDoc("c1", "hi")
    const onRetranscribe = (): void => {}
    const { container } = render(
      <CellTranscriptPreview
        timings={TIMINGS}
        cellText="hi"
        cellId="c1"
        doc={doc}
        alignedToCellText
        editable
        onRetranscribe={onRetranscribe}
      />
    )
    expect(container.textContent).toMatch(/Cell text was edited/)
    expect(container.textContent).toMatch(/out of date/)
    const btn = container.querySelector("button")
    expect(btn?.textContent).toMatch(/Re-transcribe/)
  })

  it("returns null when there are no timings", () => {
    const doc = makeDoc("c1")
    const { container } = render(
      <CellTranscriptPreview
        timings={[]}
        cellText=""
        cellId="c1"
        doc={doc}
        alignedToCellText
        editable
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
