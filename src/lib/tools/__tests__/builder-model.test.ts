import { describe, expect, it } from "vitest"
import {
  EXAMPLE_PROMPTS,
  composeRequest,
  formatElapsed,
  groupScopes,
  parseWhere,
  primaryMount,
  progressSteps,
  provenanceOf,
  sentenceCase,
  shortList,
  stepFor,
  versionRequest,
} from "../builder-model"
import { extensions } from "../../i18n/namespaces/extensions"

const states = (phase: Parameters<typeof progressSteps>[0]) => progressSteps(phase).map((s) => `${s.id}:${s.state}`)

describe("parseWhere", () => {
  it("accepts the three placements and falls back to auto", () => {
    expect(parseWhere("editor")).toBe("editor")
    expect(parseWhere("panel")).toBe("panel")
    expect(parseWhere("page")).toBe("page")
    expect(parseWhere("inline")).toBe("auto")
    expect(parseWhere(null)).toBe("auto")
    expect(parseWhere(undefined)).toBe("auto")
  })
})

describe("composeRequest", () => {
  it("sends the user's words untouched when the AI chooses", () => {
    expect(composeRequest("  count words  ", "auto")).toBe("count words")
  })
  it("appends one placement sentence naming the mount", () => {
    expect(composeRequest("count words", "panel")).toBe("count words\n\nIt should appear in the editor's side panel (mount: panel).")
    expect(composeRequest("one verse at a time", "editor")).toMatch(/\(mount: editor\)\.$/)
    expect(composeRequest("a chart", "page")).toMatch(/\(mount: page\)\.$/)
  })
  it("never builds from a placement alone", () => {
    expect(composeRequest("   ", "editor")).toBe("")
  })
})

describe("example prompts", () => {
  it("are translation-specific catalog strings, including term consistency across books", () => {
    for (const ex of EXAMPLE_PROMPTS) {
      expect(extensions.keys[ex.prompt]).toBeTruthy()
      expect(String(extensions.keys[ex.title]).length).toBeLessThan(28)
    }
    expect(extensions.keys["extensions.examples.graceAcrossBooks"]).toBe("Check that my term for 'grace' is used consistently across all books")
  })
})

describe("progressSteps", () => {
  it("starts on writing the code", () => {
    expect(states(null)).toEqual(["write:active", "check:pending", "try:pending"])
    expect(states({ kind: "generating", attempt: 0 })).toEqual(["write:active", "check:pending", "try:pending"])
  })
  it("walks the real phases: safety check, then the sandbox", () => {
    expect(states({ kind: "linting", attempt: 0 })).toEqual(["write:done", "check:active", "try:pending"])
    expect(states({ kind: "smoke", attempt: 0 })).toEqual(["write:done", "check:done", "try:active"])
    expect(states({ kind: "done", attempts: 1 })).toEqual(["write:done", "check:done", "try:done"])
  })
  it("shows a fix step only once the model repairs its own attempt", () => {
    expect(states({ kind: "repairing", attempt: 1, failure: "x" })).toEqual(["write:done", "fix:active", "check:pending", "try:pending"])
    expect(states({ kind: "smoke", attempt: 1 })).toEqual(["write:done", "fix:done", "check:done", "try:active"])
  })
})

describe("formatElapsed", () => {
  it("formats m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(9_400)).toBe("0:09")
    expect(formatElapsed(65_000)).toBe("1:05")
    expect(formatElapsed(-5)).toBe("0:00")
  })
})

describe("groupScopes", () => {
  it("splits reads, changes and AI use", () => {
    expect(groupScopes(["read:cells", "write:target", "ai:draft", "read:terms", "write:validation"])).toEqual({
      reads: ["read:cells", "read:terms"],
      changes: ["write:target", "write:validation"],
      ai: ["ai:draft"],
    })
  })
})

describe("primaryMount", () => {
  it("prefers editor, then panel, then inline, then page", () => {
    expect(primaryMount(["page", "editor", "panel"])).toBe("editor")
    expect(primaryMount(["page", "panel"])).toBe("panel")
    expect(primaryMount(["page", "inline"])).toBe("inline")
    expect(primaryMount(["page"])).toBe("page")
  })
})

describe("provenanceOf", () => {
  it("names who made it", () => {
    expect(provenanceOf({ firstParty: "default-editor", upstreamToolId: null, origin: "starter" })).toBe("firstParty")
    expect(provenanceOf({ upstreamToolId: "t1", origin: "copy" })).toBe("copy")
    expect(provenanceOf({ upstreamToolId: null, origin: "starter" })).toBe("starter")
    expect(provenanceOf({ upstreamToolId: null, origin: "edit" })).toBe("edited")
    expect(provenanceOf({ upstreamToolId: null, origin: "builder" })).toBe("builder")
  })
})

describe("stepFor", () => {
  it("is Describe until a build starts, then Review & try", () => {
    expect(stepFor({ building: false, hasCandidate: false })).toBe("describe")
    expect(stepFor({ building: true, hasCandidate: false })).toBe("review")
    expect(stepFor({ building: false, hasCandidate: true })).toBe("review")
  })
})

describe("small text helpers", () => {
  it("sentenceCase capitalizes the first letter only", () => {
    expect(sentenceCase("edit translations, read the termbase")).toBe("Edit translations, read the termbase")
    expect(sentenceCase("")).toBe("")
  })
  it("shortList keeps the first items and counts the rest", () => {
    expect(shortList(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], more: 2 })
    expect(shortList(["a"])).toEqual({ shown: ["a"], more: 0 })
  })
  it("versionRequest reads a person's description from build metadata", () => {
    expect(versionRequest({ buildMeta: { request: "  count words " } })).toBe("count words")
    expect(versionRequest({ buildMeta: { request: 4 } })).toBeNull()
    expect(versionRequest({ buildMeta: null })).toBeNull()
  })
})
