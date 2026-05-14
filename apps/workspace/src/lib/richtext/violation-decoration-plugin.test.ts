import { describe, it, expect } from "vitest"
import { EditorState } from "@tiptap/pm/state"
import { schema as basicSchema } from "@tiptap/pm/schema-basic"
import { buildViolationDecorationSet } from "./violation-decoration-plugin"
import type { RuleInfraction } from "@/lib/parsers/types"

function makeDoc(text: string) {
  return basicSchema.node("doc", null, [basicSchema.node("paragraph", null, [basicSchema.text(text)])])
}

describe("buildViolationDecorationSet", () => {
  it("creates one inline decoration per target span", () => {
    const doc = makeDoc("this is bad text")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "r1", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "target", start: 8, end: 11, matchedText: "bad" }],
    }]
    const ruleSeverity = new Map([["r1", "major" as const]])
    const set = buildViolationDecorationSet(state.doc, infractions, ruleSeverity, new Set())
    const decorations = set.find()
    expect(decorations).toHaveLength(1)
    // ProseMirror text inside a paragraph starts at pos 1, so doc offset 8 → pm pos 9.
    expect(decorations[0].from).toBe(9)
    expect(decorations[0].to).toBe(12)
  })

  it("ignores source-side spans", () => {
    const doc = makeDoc("anything")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "r1", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "source", start: 0, end: 4, matchedText: "xxxx" }],
    }]
    const set = buildViolationDecorationSet(state.doc, infractions, new Map(), new Set())
    expect(set.find()).toHaveLength(0)
  })
})
