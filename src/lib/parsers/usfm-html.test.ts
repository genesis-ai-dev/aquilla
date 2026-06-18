import { describe, it, expect } from "vitest"
import {
  usfmSpanToHtml,
  htmlSpanToUsfm,
  inlineMarkersInHtml,
  diffInlineMarkers,
  restoreFormattingToTarget,
  markMismatchedSourceMarkers,
  usfmSpanBlocks,
  extractTargetBlocks,
} from "./usfm-html"

describe("usfmSpanToHtml", () => {
  it("passes plain prose through (escaped)", () => {
    expect(usfmSpanToHtml("In the beginning.")).toBe("In the beginning.")
    expect(usfmSpanToHtml("a < b & c")).toBe("a &lt; b &amp; c")
  })

  it("maps emphasis markers to semantic tags carrying data-usfm", () => {
    expect(usfmSpanToHtml("\\bd bold\\bd*")).toBe('<strong data-usfm="bd">bold</strong>')
    expect(usfmSpanToHtml("\\it italic\\it*")).toBe('<em data-usfm="it">italic</em>')
  })

  it("maps other inline character markers to span+data-usfm", () => {
    expect(usfmSpanToHtml("\\nd LORD\\nd*")).toBe('<span data-usfm="nd">LORD</span>')
    expect(usfmSpanToHtml("\\wj Jesus said\\wj*")).toBe('<span data-usfm="wj">Jesus said</span>')
  })

  it("encodes a footnote as a single <sup> carrying the body verbatim", () => {
    const html = usfmSpanToHtml("text\\f + \\fr 1:1 \\ft A note.\\f*")
    expect(html).toBe(
      'text<sup data-usfm="f" data-usfm-body=" + \\fr 1:1 \\ft A note.">+</sup>',
    )
  })

  it("encodes a cross-reference the same way", () => {
    const html = usfmSpanToHtml("light\\x + \\xo 1:4 \\xt John 1:5\\x*")
    expect(html).toBe(
      'light<sup data-usfm="x" data-usfm-body=" + \\xo 1:4 \\xt John 1:5">+</sup>',
    )
  })

  it("maps intra-verse poetry/paragraph markers to <br>", () => {
    const html = usfmSpanToHtml("Blessed is the man\n\\q1 who walks not\n\\q2 nor stands")
    expect(html).toBe(
      'Blessed is the man<br data-usfm="q1">who walks not<br data-usfm="q2">nor stands',
    )
  })
})

describe("htmlSpanToUsfm (inverse)", () => {
  const roundtrips: [string, string][] = [
    ["plain prose", "In the beginning."],
    ["bold", "\\bd bold\\bd*"],
    ["italic", "\\it italic\\it*"],
    ["divine name", "\\nd LORD\\nd*"],
    ["words of Jesus", "\\wj Jesus said\\wj*"],
    ["mixed inline", "the \\nd LORD\\nd* is \\bd good\\bd* indeed"],
    ["footnote", "text\\f + \\fr 1:1 \\ft A note.\\f*"],
    ["cross-ref", "light\\x + \\xo 1:4 \\xt John 1:5\\x* shone"],
    ["footnote then prose", "before\\f + \\ft note\\f* after"],
  ]
  for (const [label, usfm] of roundtrips) {
    it(`round-trips ${label}`, () => {
      expect(htmlSpanToUsfm(usfmSpanToHtml(usfm))).toBe(usfm)
    })
  }

  it("round-trips poetry with normalized whitespace after break markers", () => {
    const usfm = "Blessed is the man\n\\q1 who walks not\n\\q2 nor stands"
    // <br> reconstruction normalizes to "\n\\qN " — same markers, same text.
    expect(htmlSpanToUsfm(usfmSpanToHtml(usfm))).toBe(usfm)
  })

  it("recovers emphasis even when data-usfm is stripped (semantic-tag fallback)", () => {
    expect(htmlSpanToUsfm("<strong>bold</strong>")).toBe("\\bd bold\\bd*")
    expect(htmlSpanToUsfm("<em>italic</em>")).toBe("\\it italic\\it*")
    expect(htmlSpanToUsfm("<b>x</b> and <i>y</i>")).toBe("\\bd x\\bd* and \\it y\\it*")
  })

  it("treats a wrapping <p> as transparent (no spurious \\p)", () => {
    expect(htmlSpanToUsfm("<p>just prose</p>")).toBe("just prose")
    expect(htmlSpanToUsfm("<p>the <span data-usfm=\"nd\">LORD</span></p>")).toBe(
      "the \\nd LORD\\nd*",
    )
  })

  it("preserves the footnote body through an edit of the surrounding prose", () => {
    // Simulate a translator editing the prose around a footnote in the HTML
    // (the <sup> structure rides along, which is the whole point).
    const original = "In the beginning\\f + \\fr 1:1 \\ft Some note.\\f*"
    const html = usfmSpanToHtml(original)
    // Translator replaces the prose but the editor keeps the <sup>.
    const edited = html.replace("In the beginning", "Au commencement")
    expect(htmlSpanToUsfm(edited)).toBe("Au commencement\\f + \\fr 1:1 \\ft Some note.\\f*")
  })
})

describe("inline marker integrity", () => {
  it("extracts formatting vs notes from HTML (data-usfm + semantic tags)", () => {
    const html = usfmSpanToHtml("the \\nd LORD\\nd* said\\f + \\ft note\\f* and \\bd bold\\bd*")
    const m = inlineMarkersInHtml(html)
    expect(m.format.sort()).toEqual(["bd", "nd"])
    expect(m.note).toEqual(["f"])
  })

  it("counts bare editor emphasis tags as formatting", () => {
    expect(inlineMarkersInHtml("<strong>x</strong> and <em>y</em>").format.sort()).toEqual(["bd", "it"])
    expect(inlineMarkersInHtml("<b>x</b>").format).toEqual(["bd"])
  })

  it("reports markers the target dropped", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd* said\\f + \\ft note\\f*")
    const target = "the LORD said" // plain prose — lost both
    const diff = diffInlineMarkers(source, target)
    expect(diff.missingFormat).toEqual(["nd"])
    expect(diff.missingNote).toEqual(["f"])
  })

  it("reports no drift when the target preserved the markers", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd*")
    const target = '<span data-usfm="nd">SEIGNEUR</span>'
    expect(diffInlineMarkers(source, target)).toEqual({ missingFormat: [], missingNote: [] })
  })

  it("restores dropped formatting by wrapping the matching word in the target", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd* is good")
    const target = "the LORD is good"
    const fixed = restoreFormattingToTarget(source, target)
    expect(fixed).toBe('the <span data-usfm="nd">LORD</span> is good')
    // And the diff is clean afterward.
    expect(diffInlineMarkers(source, fixed).missingFormat).toEqual([])
  })

  it("never fabricates footnotes during a formatting restore", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd*\\f + \\ft note\\f*")
    const target = "the LORD"
    const fixed = restoreFormattingToTarget(source, target)
    expect(fixed).not.toContain("data-usfm-body")
    expect(fixed).not.toContain("<sup")
  })

  it("leaves the target untouched when the formatted word is not present", () => {
    const source = usfmSpanToHtml("\\nd LORD\\nd*")
    const target = "Seigneur" // translated — no verbatim match to wrap
    expect(restoreFormattingToTarget(source, target)).toBe("Seigneur")
  })

  it("marks mismatched styling in the source for underlining", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd* said")
    const marked = markMismatchedSourceMarkers(source, ["nd"])
    expect(marked).toContain('class="usfm-mismatch"')
    expect(marked).toContain('data-usfm-mismatch="nd"')
  })

  it("does not mark styling that matched", () => {
    const source = usfmSpanToHtml("the \\nd LORD\\nd* said")
    expect(markMismatchedSourceMarkers(source, [])).toBe(source)
  })
})

describe("per-block extraction (source blocks ⇄ target blocks)", () => {
  it("keeps inline content (styles + notes) INSIDE one block — splits only at block markers", () => {
    const span = "the \\nd LORD\\nd* said\\f + \\ft note\\f* today"
    const blocks = usfmSpanBlocks(span)
    expect(blocks).toHaveLength(1)
    expect(span.slice(blocks[0].start, blocks[0].end)).toBe(
      "the \\nd LORD\\nd* said\\f + \\ft note\\f* today",
    )
  })

  it("splits at poetry/paragraph block markers", () => {
    const span = "Now the earth\n\\q1 darkness\n\\q2 spirit"
    const blocks = usfmSpanBlocks(span)
    expect(blocks.map((b) => span.slice(b.start, b.end))).toEqual([
      "Now the earth",
      "darkness",
      "spirit",
    ])
  })

  it("splits target HTML into inline segments at <br>/<p>/<div>", () => {
    const html = '<p>Or la terre</p><p>ténèbres</p>'
    expect(extractTargetBlocks(html).map((s) => s.trim()).filter(Boolean)).toEqual([
      "Or la terre",
      "ténèbres",
    ])
    expect(
      extractTargetBlocks('a<br data-usfm="q1">b').map((s) => s.trim()).filter(Boolean),
    ).toEqual(["a", "b"])
  })

  it("source and target block counts align when structure is preserved", () => {
    const span = "Now the earth\n\\q1 darkness\n\\q2 spirit"
    const html = "Or la terre<br data-usfm=\"q1\">ténèbres<br data-usfm=\"q2\">esprit"
    const tBlocks = extractTargetBlocks(html).map((s) => s.trim()).filter(Boolean)
    expect(usfmSpanBlocks(span).length).toBe(tBlocks.length)
  })
})

describe("codex-web TipTap footnote node interop (data-usfm-footnote)", () => {
  it("htmlSpanToUsfm reconstructs the raw \\f…\\f* from data-usfm-footnote", () => {
    const html = 'Au commencement<span data-usfm-footnote="\\f + \\ft note\\f*" class="usfm-footnote-marker">+</span> Dieu'
    expect(htmlSpanToUsfm(html)).toBe("Au commencement\\f + \\ft note\\f* Dieu")
  })

  it("unescapes HTML entities inside the raw footnote attribute", () => {
    const html = '<span data-usfm-footnote="\\f + \\ft a &amp; b\\f*"></span>'
    expect(htmlSpanToUsfm(html)).toBe("\\f + \\ft a & b\\f*")
  })

  it("inlineMarkersInHtml counts a data-usfm-footnote span as a note", () => {
    const set = inlineMarkersInHtml('x<span data-usfm-footnote="\\f + \\ft n\\f*">+</span>')
    expect(set.note).toEqual(["f"])
  })

  it("does NOT flag a footnote the target kept via the TipTap node", () => {
    // Source uses the mapper's <sup> form; target uses codex-web's node form.
    const sourceHtml = usfmSpanToHtml("In the beginning\\f + \\ft note\\f*")
    const targetHtml = 'Au commencement<span data-usfm-footnote="\\f + \\ft note\\f*">+</span>'
    expect(diffInlineMarkers(sourceHtml, targetHtml).missingNote).toEqual([])
  })
})

describe("Phase 2 restore → export chain", () => {
  it("restores a dropped non-emphasis style and it reconstructs to USFM on export", () => {
    const source = "the \\nd LORD\\nd* said"
    const sourceHtml = usfmSpanToHtml(source)
    const target = "the LORD said" // translator dropped the styling
    // drift is detected
    expect(diffInlineMarkers(sourceHtml, target).missingFormat).toEqual(["nd"])
    // one-click restore wraps the matching word with the generic data-usfm span
    const restored = restoreFormattingToTarget(sourceHtml, target)
    expect(restored).toContain('<span data-usfm="nd">LORD</span>')
    // after restore, no drift remains
    expect(diffInlineMarkers(sourceHtml, restored).missingFormat).toEqual([])
    // and export reconstructs the marker
    expect(htmlSpanToUsfm(restored)).toBe("the \\nd LORD\\nd* said")
  })

  it("restore is generic over marker names (not a hard-coded set)", () => {
    const sourceHtml = usfmSpanToHtml("\\wj Come\\wj* to me")
    const restored = restoreFormattingToTarget(sourceHtml, "Come to me")
    expect(restored).toContain('<span data-usfm="wj">Come</span>')
    expect(htmlSpanToUsfm(restored)).toBe("\\wj Come\\wj* to me")
  })
})
