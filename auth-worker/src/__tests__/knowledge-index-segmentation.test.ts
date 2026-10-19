import { describe, it, expect } from "vitest"
import { segmentText, MAX_NODES } from "../lib/knowledge/segment"
import type { KnowledgeNode } from "../../../db/shared/knowledge"

// AQU-2033: past MAX_NODES the cap used to truncate, so the last node ran to
// the end of the text. VanDyck_OT_1_Law_History.txt on dev (1.9M chars, no
// headings) got 199 blocks of ~2,000 chars and a node 200 holding 83% of the
// document, and its doc summary described only Genesis and Exodus.

function flatNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return nodes.flatMap((n) => [n, ...flatNodes(n.children ?? [])])
}

/** Siblings meet end to end, the last ends where its parent does, and a
 *  parent's children start inside it, so the roots tile [0, length). */
function expectTiles(nodes: KnowledgeNode[], start: number, end: number): void {
  expect(nodes[0].charStart).toBe(start)
  nodes.forEach((n, i) => {
    expect(n.charEnd).toBe(i + 1 < nodes.length ? nodes[i + 1].charStart : end)
    if (n.children?.length) {
      expect(n.children[0].charStart).toBeGreaterThanOrEqual(n.charStart)
      expectTiles(n.children, n.children[0].charStart, n.charEnd)
    }
  })
}

/** Chars each node holds before the next node in document order begins: a
 *  parent's own text, not its children's. */
function ownLengths(tree: KnowledgeNode[], length: number): number[] {
  const flat = flatNodes(tree)
  return flat.map((n, i) => (i + 1 < flat.length ? flat[i + 1].charStart : length) - n.charStart)
}

function expectEven(tree: KnowledgeNode[], length: number): void {
  const lengths = ownLengths(tree, length)
  expect(lengths.length).toBeLessThanOrEqual(MAX_NODES)
  expect(Math.max(...lengths)).toBeLessThanOrEqual(2 * (length / lengths.length))
  expect(Math.min(...lengths)).toBeGreaterThan(0)
}

/** The dev document's shape: chapters of 20–44 verse lines, one blank line
 *  between chapters, no markdown headings. */
function bibleLikeText(chapters: number): string {
  return Array.from({ length: chapters }, (_, c) =>
    Array.from({ length: 20 + ((c * 7) % 25) }, (_, v) =>
      `${c + 1}:${v + 1} ${"وَقَالَ ٱللهُ لِيَكُنْ نُورٌ ".repeat(5)}`.trim()).join("\n")).join("\n\n")
}

describe("segmentText — headingless text past the cap (AQU-2033)", () => {
  const text = bibleLikeText(470)

  it("tiles a 1.9M-char document with at most 200 blocks of comparable length", () => {
    expect(text.length).toBeGreaterThan(1_850_000)
    const tree = segmentText(text)

    expect(tree).toHaveLength(MAX_NODES)
    expect(tree.every((n) => !n.children)).toBe(true)
    expectTiles(tree, 0, text.length)
    expectEven(tree, text.length)
  })

  it("still cuts at paragraph breaks when blocks grow past BLOCK_TARGET", () => {
    for (const n of segmentText(text).slice(1)) {
      expect(text.slice(n.charStart - 2, n.charStart)).toBe("\n\n")
    }
  })

  it("falls back to line breaks, then spaces, then a hard cut", () => {
    const lines = bibleLikeText(150).replaceAll("\n\n", "\n")
    for (const n of segmentText(lines).slice(1)) expect(lines[n.charStart - 1]).toBe("\n")

    const words = "lorem ipsum ".repeat(50_000)
    const byWord = segmentText(words)
    expectTiles(byWord, 0, words.length)
    for (const n of byWord.slice(1)) expect(words[n.charStart - 1]).toBe(" ")

    const solid = "x".repeat(600_000)
    const hard = segmentText(solid)
    expect(hard).toHaveLength(MAX_NODES)
    expectTiles(hard, 0, solid.length)
    expectEven(hard, solid.length)
  })

  it("keeps ~2,000-char paragraph blocks below the cap", () => {
    const small = Array.from({ length: 30 }, (_, i) => `para ${i} ${"x".repeat(1400)}`).join("\n\n")
    const tree = segmentText(small)

    expect(tree).toHaveLength(Math.ceil(small.length / 2000))
    expectTiles(tree, 0, small.length)
    for (const n of tree.slice(1)) expect(small.slice(n.charStart - 2, n.charStart)).toBe("\n\n")
    for (const n of tree) expect(n.charEnd - n.charStart).toBeLessThanOrEqual(4000)
  })
})

describe("segmentText — more than 200 headings (AQU-2033)", () => {
  it("groups 500 headings into at most 200 contiguous, even nodes that each open on a heading", () => {
    const text = "Preface before any heading.\n" +
      Array.from({ length: 500 }, (_, i) => `# H${i}\n${"body text ".repeat(30 + (i % 7))}`).join("\n")
    const tree = segmentText(text)

    expectTiles(tree, 0, text.length)
    expectEven(tree, text.length)
    expect(tree[0].title).toMatch(/^Introduction – H\d+$/)
    for (const n of tree.slice(1)) expect(text.slice(n.charStart, n.charStart + 3)).toBe("# H")
    // Every heading is accounted for, the last one included.
    expect(tree[tree.length - 1].title).toMatch(/H499$/)
  })

  it("keeps higher-level headings as the outline when lower levels are grouped", () => {
    const body = "verse text ".repeat(40)
    const text = Array.from({ length: 20 }, (_, b) =>
      [`# Book ${b + 1}`, ...Array.from({ length: 25 }, (_, c) => `## Book ${b + 1} chapter ${c + 1}\n${body}`)]
        .join("\n")).join("\n")
    const tree = segmentText(text)

    // Each book still opens a root, with its grouped chapters nested inside.
    expect(tree).toHaveLength(20)
    tree.forEach((root, b) => {
      expect(root.title.startsWith(`Book ${b + 1}`)).toBe(true)
      expect(text.slice(root.charStart).startsWith(`# Book ${b + 1}\n`)).toBe(true)
      expect(root.children?.length).toBeGreaterThan(0)
    })
    expectTiles(tree, 0, text.length)
    expectEven(tree, text.length)
  })

  it("leaves a document at the cap with one node per heading", () => {
    const text = Array.from({ length: MAX_NODES }, (_, i) => `# Section ${i + 1}\nbody ${i + 1}`).join("\n")
    const tree = segmentText(text)

    expect(tree.map((n) => n.title)).toEqual(Array.from({ length: MAX_NODES }, (_, i) => `Section ${i + 1}`))
    expectTiles(tree, 0, text.length)
  })
})
