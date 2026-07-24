/**
 * p1-paragraph-ui-wiring / Task 1.
 *
 * The sync-worker `/import` route whitelists `metadata` through to the
 * `source.cell.create` payload but drops the top-level `paragraphStart`
 * field. Since we cannot touch sync-worker/db here, the fix folds
 * `paragraphStart` into the cell's `metadata` bag at import build time
 * (`buildBulkCellsWithSpeakers` in `src/lib/import.ts`) so it survives the
 * server round-trip via the existing extensible-metadata channel.
 *
 * Intent under test:
 *   - A real two-paragraph plaintext fixture, run through the actual parser
 *     + cell-building path, produces `BulkImportCell`s whose `metadata.
 *     paragraphStart === true` on exactly the paragraph-start cells (not
 *     continuations, not every cell).
 *   - A cell that already carries other metadata (e.g. OBS attachments)
 *     keeps those keys when `paragraphStart` is merged in — the merge must
 *     never clobber the existing bag.
 */

import { describe, it, expect } from "vitest"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { buildBulkCellsWithSpeakers } from "./import"
import type { TranslatableString } from "./parsers/types"

describe("buildBulkCellsWithSpeakers — paragraphStart folded into metadata (D1 client fix)", () => {
  it("real plaintext fixture: metadata.paragraphStart is true on exactly the paragraph-start cells", () => {
    const strings = extractPlaintextStrings("First paragraph.\n\nSecond paragraph.")
    const { cells } = buildBulkCellsWithSpeakers(strings)

    expect(cells).toHaveLength(2)
    // Both cells are paragraph starts (one short paragraph each) — both the
    // top-level field (existing behavior) and the metadata bag (the fix)
    // must agree.
    expect(cells[0].paragraphStart).toBe(true)
    expect(cells[0].metadata?.paragraphStart).toBe(true)
    expect(cells[1].paragraphStart).toBe(true)
    expect(cells[1].metadata?.paragraphStart).toBe(true)
  })

  it("over-long paragraph: only the first sub-cell's metadata carries paragraphStart", () => {
    const longParagraph = Array(30).fill("Sentence here.").join(" ")
    const strings = extractPlaintextStrings(longParagraph)
    const { cells } = buildBulkCellsWithSpeakers(strings)

    expect(cells.length).toBeGreaterThan(1)
    expect(cells[0].metadata?.paragraphStart).toBe(true)
    for (let i = 1; i < cells.length; i++) {
      expect(cells[i].metadata?.paragraphStart).toBeUndefined()
    }
  })

  it("scripture-style strings without paragraphStart get no metadata.paragraphStart key", () => {
    const strings: TranslatableString[] = [
      { id: "v1", original: "In the beginning", translated: "", context: "GEN 1:1", group: "g1", type: "verse" },
      { id: "v2", original: "The earth was formless", translated: "", context: "GEN 1:2", group: "g1", type: "verse" },
    ]
    const { cells } = buildBulkCellsWithSpeakers(strings)
    expect(cells[0].metadata?.paragraphStart).toBeUndefined()
    expect(cells[1].metadata?.paragraphStart).toBeUndefined()
  })

  it("preserves pre-existing metadata keys (e.g. OBS attachments) when merging paragraphStart", () => {
    const strings: TranslatableString[] = [
      {
        id: "frame-1",
        original: "Once upon a time.",
        translated: "",
        context: "frame-1",
        group: "frame-1",
        type: "text",
        paragraphStart: true,
        metadata: { attachments: [{ type: "image", url: "https://example.test/frame1.jpg", alt: "Frame 1" }] },
      },
    ]
    const { cells } = buildBulkCellsWithSpeakers(strings)

    expect(cells).toHaveLength(1)
    expect(cells[0].paragraphStart).toBe(true)
    expect(cells[0].metadata?.paragraphStart).toBe(true)
    // Pre-existing key survives the merge.
    expect(cells[0].metadata?.attachments).toEqual([
      { type: "image", url: "https://example.test/frame1.jpg", alt: "Frame 1" },
    ])
  })
})
