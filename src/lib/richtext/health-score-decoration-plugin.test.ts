import { describe, expect, it } from "vitest"
import { EditorState } from "@tiptap/pm/state"
import { buildHealthScoreDecorationSet } from "./health-score-decoration-plugin"
import { basicSchema } from "./test-schema"

function makeDoc(text: string) {
  return basicSchema.node("doc", null, [basicSchema.node("paragraph", null, [basicSchema.text(text)])])
}

describe("buildHealthScoreDecorationSet", () => {
  it("creates one inline decoration per span", () => {
    const doc = makeDoc("Espiritu Santo came")
    const state = EditorState.create({ schema: basicSchema, doc })
    const set = buildHealthScoreDecorationSet(state.doc, [
      { start: 0, end: 14, kind: "supported", title: "Holy Spirit → Espiritu Santo" },
      { start: 15, end: 19, kind: "guessed" },
    ])
    const decorations = set.find()
    expect(decorations).toHaveLength(2)
    // ProseMirror text inside a paragraph starts at pos 1.
    expect(decorations[0].from).toBe(1)
    expect(decorations[0].to).toBe(15)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attrs = (decorations[0] as any).type.attrs
    expect(attrs["data-health-span"]).toBe("supported")
    expect(attrs.title).toBe("Holy Spirit → Espiritu Santo")
  })

  it("returns empty when there are no spans", () => {
    const doc = makeDoc("anything")
    const set = buildHealthScoreDecorationSet(doc, [])
    expect(set.find()).toHaveLength(0)
  })

  it("skips zero-width spans", () => {
    const doc = makeDoc("text")
    const set = buildHealthScoreDecorationSet(doc, [{ start: 2, end: 2, kind: "guessed" }])
    expect(set.find()).toHaveLength(0)
  })
})
