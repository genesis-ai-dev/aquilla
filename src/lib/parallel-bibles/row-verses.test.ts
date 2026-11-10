import { describe, expect, it } from "vitest"
import { rowScripture } from "./row-verses"

describe("rowScripture", () => {
  it.each([
    ["a verse", { type: "text", group: "JHN 3:16" }, undefined, { kind: "verses", book: "JHN", chapter: 3, from: 16, to: 16 }],
    ["a range", { type: "text", group: "GEN 1:1-3" }, undefined, { kind: "verses", book: "GEN", chapter: 1, from: 1, to: 3 }],
    ["the source ref when the row has none", { type: "text", group: null, globalReferences: ["MAL 4:1"] }, undefined, { kind: "verses", book: "MAL", chapter: 4, from: 1, to: 1 }],
    ["the first part of a split verse", { type: "text", group: "JHN 3:16" }, "16a", { kind: "verses", book: "JHN", chapter: 3, from: 16, to: 16 }],
    ["a later part of a split verse", { type: "text", group: null }, "16b", { kind: "continued" }],
    ["a heading", { type: "heading", group: "JHN 3:1" }, undefined, null],
    ["a chapter-only ref", { type: "text", group: "JHN 3" }, undefined, null],
    ["a non-scripture row", { type: "text", group: null }, undefined, null],
  ] as const)("%s", (_label, cell, versePart, expected) => {
    expect(rowScripture(cell, versePart)).toEqual(expected)
  })
})
