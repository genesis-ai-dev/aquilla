// AQU-1694 — Who's Who tints on the target column, painted as CSS highlights.
//
// What matters to the translator: hovering a participant lights their words
// in the draft too, on the right words, dotted when the bridges are unsure,
// and never on the wrong words when the rendered text is not the aligned one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tokenize } from "@/lib/completion/tokenize"
import { createMentionHighlightStore } from "./mention-highlight-store"
import { collectRanges, registerTargetTints, type TintRun } from "./target-tint-layer"

const DRAFT = "Yesus berkata kepadanya, “Berilah Aku minum.”"
// Yesus (0) → Jesus; kepadanya (2) → the woman; Aku (4) → Jesus.
const RUNS: TintRun[] = [
  { firstToken: 0, lastToken: 0, entity: "person:Jesus.2", slot: 1, approximate: false },
  { firstToken: 2, lastToken: 2, entity: "local:JHN:n43004007002", slot: 2, approximate: true },
  { firstToken: 4, lastToken: 4, entity: "person:Jesus.2", slot: 1, approximate: false },
]

function renderDraft(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const texts = (ranges: Map<string, Range[]>, name: string) => (ranges.get(name) ?? []).map((range) => range.toString())

afterEach(() => {
  document.body.innerHTML = ""
})

describe("which target words light up", () => {
  it("lights the hovered participant's words, solid, and nobody else's", () => {
    const store = createMentionHighlightStore()
    const root = renderDraft(`<span>Yesus berkata <b>kepadanya</b>, “Berilah Aku minum.”</span>`)
    store.light("person:Jesus.2", "hover")
    const ranges = collectRanges([{ root, tokens: tokenize(DRAFT), runs: RUNS, store, always: false }])
    expect(texts(ranges, "aq-mention-lit")).toEqual(["Yesus", "Aku"])
    expect(ranges.has("aq-mention-lit-approx")).toBe(false)
    expect(ranges.has("aq-mention-slot-2-approx")).toBe(false)
  })

  it("draws an unsure word dotted (its own highlight), across markup", () => {
    const store = createMentionHighlightStore()
    const root = renderDraft(`Yesus berkata <b>kepada</b>nya, “Berilah Aku minum.”`)
    store.light("local:JHN:n43004007002", "focus")
    const ranges = collectRanges([{ root, tokens: tokenize(DRAFT), runs: RUNS, store, always: false }])
    expect(texts(ranges, "aq-mention-lit-approx")).toEqual(["kepadanya"])
  })

  it("in 'always' mode tints every run in its thread colour, the lit one apart", () => {
    const store = createMentionHighlightStore()
    const root = renderDraft(DRAFT)
    store.light("person:Jesus.2", "hover")
    const ranges = collectRanges([{ root, tokens: tokenize(DRAFT), runs: RUNS, store, always: true }])
    expect(texts(ranges, "aq-mention-lit")).toEqual(["Yesus", "Aku"])
    expect(texts(ranges, "aq-mention-slot-2-approx")).toEqual(["kepadanya"])
  })

  it("tints nothing when the rendered words are not the aligned words", () => {
    // A footnote chip, a remote draft or an edit since the alignment: the
    // tokens differ, so a tint could land on the wrong word. It lands nowhere.
    const store = createMentionHighlightStore()
    const root = renderDraft(`Yesus berkata kepadanya<sup>1</sup>, “Berilah Aku minum.”`)
    store.light("person:Jesus.2", "hover")
    expect(collectRanges([{ root, tokens: tokenize(DRAFT), runs: RUNS, store, always: false }]).size).toBe(0)
  })

  it("ignores text the presence overlay ignores", () => {
    const store = createMentionHighlightStore()
    const root = renderDraft(`<span data-presence-ignore>Rina is typing</span>${DRAFT}`)
    store.light("person:Jesus.2", "hover")
    const ranges = collectRanges([{ root, tokens: tokenize(DRAFT), runs: RUNS, store, always: false }])
    expect(texts(ranges, "aq-mention-lit")).toEqual(["Yesus", "Aku"])
  })
})

describe("painting", () => {
  const set = vi.fn()
  const remove = vi.fn()
  class FakeHighlight {
    ranges: Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }

  beforeEach(() => {
    set.mockClear()
    remove.mockClear()
    vi.stubGlobal("CSS", { highlights: { set, delete: remove } })
    vi.stubGlobal("Highlight", FakeHighlight)
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("repaints when the lit participant changes, and clears when the row goes", () => {
    const store = createMentionHighlightStore()
    const root = renderDraft(DRAFT)
    const unregister = registerTargetTints("cell-4-7", { root, tokens: tokenize(DRAFT), runs: RUNS, store, always: false })
    expect(set).not.toHaveBeenCalled()

    store.light("person:Jesus.2", "hover")
    const painted = set.mock.calls.find(([name]) => name === "aq-mention-lit")?.[1] as FakeHighlight
    expect(painted.ranges.map((range) => range.toString())).toEqual(["Yesus", "Aku"])

    store.unlight("person:Jesus.2", "hover")
    expect(remove).toHaveBeenCalledWith("aq-mention-lit")

    store.light("person:Jesus.2", "hover")
    remove.mockClear()
    unregister()
    expect(remove).toHaveBeenCalledWith("aq-mention-lit")
  })
})
