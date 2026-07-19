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

  it("adds violation-blot-term class for terminology-origin rule ids", () => {
    const doc = makeDoc("some forbidden word here")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "term:concept-42:forbidden:forbidden", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "target", start: 5, end: 13, matchedText: "forbidden" }],
    }]
    const ruleSeverity = new Map([["term:concept-42:forbidden:forbidden", "major" as const]])
    const set = buildViolationDecorationSet(state.doc, infractions, ruleSeverity, new Set())
    const decorations = set.find()
    expect(decorations).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cls: string = (decorations[0] as any).type.attrs.class
    expect(cls).toContain("violation-blot-term")
    expect(cls).toContain("violation-blot-major")
  })

  it("does NOT add violation-blot-term class for generic rule ids", () => {
    const doc = makeDoc("some generic error here")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "rule-abc", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "target", start: 5, end: 12, matchedText: "generic" }],
    }]
    const ruleSeverity = new Map([["rule-abc", "minor" as const]])
    const set = buildViolationDecorationSet(state.doc, infractions, ruleSeverity, new Set())
    const decorations = set.find()
    expect(decorations).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cls: string = (decorations[0] as any).type.attrs.class
    expect(cls).not.toContain("violation-blot-term")
  })

  it("does not create inline decorations for zero-width target spans", () => {
    const doc = makeDoc("missing punctuation")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "builtin:end-punctuation-mismatch", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "target", start: 19, end: 19, matchedText: "" }],
    }]
    const set = buildViolationDecorationSet(state.doc, infractions, new Map(), new Set())
    expect(set.find()).toHaveLength(0)
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
