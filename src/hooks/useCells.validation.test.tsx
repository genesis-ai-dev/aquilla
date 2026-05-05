import { describe, it, expect } from "vitest"
import { render, act, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useCells } from "./useCells"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { toggleCellValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"

function Probe({ doc, username, out, required = 2 }: { doc: Y.Doc; username: string; out: { current?: ReturnType<typeof useCells> }; required?: number }) {
  const cells = useCells(doc, "test-file", username, required)
  out.current = cells
  return null
}

function setupCell(doc: Y.Doc, id: string) {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  const cell = new Y.Map<unknown>()
  cell.set("id", id)
  cell.set("original", "")
  cell.set("context", "")
  cell.set("group", "")
  cell.set("type", "text")
  const frag = new Y.XmlFragment()
  const p = new Y.XmlElement("p")
  p.insert(0, [new Y.XmlText("hello")])
  frag.insert(0, [p])
  cell.set("translatedXml", frag)
  cellsMap.set(id, cell)
  order.push([id])
}

describe("useCells — validation derivation from cell.edits", () => {
  it("shows 'self' after current user explicitly validates below the threshold", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    // required=2 so count=1 < threshold → "self" (not "full")
    render(<Probe doc={doc} username="alice" out={out} required={2} />)
    act(() => {
      commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
      toggleCellValidation(doc, "c1", "alice", true)
    })
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("self")
    })
    expect(out.current![0].activeValidators).toEqual(["alice"])
  })

  it("editing without explicit validation leaves the cell as 'none'", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="alice" out={out} required={2} />)
    act(() => { commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human") })
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("none")
    })
    expect(out.current![0].activeValidators).toEqual([])
  })

  it("shows 'full' when a single validator meets requiredValidations=1", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="alice" out={out} required={1} />)
    act(() => {
      commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
      toggleCellValidation(doc, "c1", "alice", true)
    })
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("full")
    })
    expect(out.current![0].activeValidators).toEqual(["alice"])
  })

  it("bob sees 'self' after his own edit + explicit validation (new session, prior validator on prior entry)", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="bob" out={out} required={2} />)
    const now = Date.now()
    act(() => {
      commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
      toggleCellValidation(doc, "c1", "alice", true)
    })
    // Force a new session: advance system clock past SESSION_GAP_MS.
    const originalNow = Date.now
    Date.now = () => now + 10 * 60_000
    try {
      act(() => {
        commitCellEdit(doc, "c1", "bob", ["value"], "hello edited", "human")
        toggleCellValidation(doc, "c1", "bob", true)
      })
    } finally { Date.now = originalNow }
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("self")
    })
    expect(out.current![0].activeValidators).toEqual(["bob"])
    expect(out.current![0].validationHistory.length).toBe(2)
  })

  it("shows 'full' when toggle adds a second validator meeting requiredValidations=2", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="alice" out={out} required={2} />)
    act(() => {
      commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
      toggleCellValidation(doc, "c1", "alice", true)
    })
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("self")
    })
    act(() => { toggleCellValidation(doc, "c1", "bob", true) })
    await waitFor(() => {
      expect(out.current![0].validationStatus).toBe("full")
    })
    expect(out.current![0].activeValidators.sort()).toEqual(["alice", "bob"])
  })
})
