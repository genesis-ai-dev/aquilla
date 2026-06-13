import { describe, it, expect } from "vitest"
import {
  segmentUsfmForDisplay,
  usfmDisplayText,
  clipRangesToSegment,
  hasUsfmMarkers,
  type UsfmNoteSegment,
  type UsfmTextSegment,
} from "./usfm-display"

// Real Suvali cell (1 John 2:1) from the imported corpus that surfaced the
// bug: footnote + word-level marker rendered as raw tags in the editor.
const SUVALI_1JN_2_1 =
  "میڈے بالو! مَیں تُہاکُوں ایہ گالھیں اِیں واسطے لِکھدا پِیاں ہاں جو تُساں گُناہ نہ کرو۔ پر جے کوئی گُناہ کرے تاں خُدا باپ دے حضُور ءچ ساڈی سفارش کرݨ آلا\\f + \\fr 2‏:1 \\ft یعنی ساڈے حق ءچ بُولیندے جو ساڈے گُناہاں دا کفارہ تھی گِیا ہے اِیں واسطے اساں خُدا دے حضُور ءچ آ سگدے ہیں۔\\f* ہِک موجود ہے یعنی یسُوع \\w مسیح\\w* جیہڑا راستباز ہے۔"

describe("segmentUsfmForDisplay", () => {
  it("returns null for marker-free text (zero-cost fast path)", () => {
    expect(segmentUsfmForDisplay("In the beginning God created")).toBeNull()
    expect(hasUsfmMarkers("plain text")).toBe(false)
  })

  it("hides footnote + \\w markers in the real Suvali cell — WHY: a translator must never read raw markup mid-verse", () => {
    const segments = segmentUsfmForDisplay(SUVALI_1JN_2_1)!
    const display = segments.filter((s) => s.kind === "text").map((s) => (s as UsfmTextSegment).text).join("")
    expect(display).not.toContain("\\")
    expect(display).toContain("یسُوع مسیح جیہڑا") // \w unwrapped, word kept
    expect(display).not.toContain("یعنی ساڈے حق") // footnote body NOT inline

    const notes = segments.filter((s) => s.kind === "note") as UsfmNoteSegment[]
    expect(notes).toHaveLength(1)
    expect(notes[0].noteKind).toBe("footnote")
    expect(notes[0].caller).toBe("+")
    expect(notes[0].ref).toBe("2‏:1") // RTL mark preserved
    expect(notes[0].text).toContain("کفارہ")
    expect(notes[0].text).not.toContain("\\")
  })

  it("parses crossrefs \\x…\\x* as xref note segments", () => {
    const raw = "He went up\\x - \\xo 3:4 \\xt Gen 14:14; Heb 2:3\\x* to the city"
    const segments = segmentUsfmForDisplay(raw)!
    const notes = segments.filter((s) => s.kind === "note") as UsfmNoteSegment[]
    expect(notes).toHaveLength(1)
    expect(notes[0].noteKind).toBe("xref")
    expect(notes[0].ref).toBe("3:4")
    expect(notes[0].text).toBe("Gen 14:14; Heb 2:3")
    expect(usfmDisplayText(raw)).toBe("He went up to the city")
  })

  it("drops USFM 3 attribute payloads but keeps the wrapped word", () => {
    expect(usfmDisplayText('grace\\w favor|lemma="khen" strong="H2580"\\w* upon')).toBe(
      "gracefavor upon", // raw had no space before \w — display mirrors the raw spacing
    )
    expect(usfmDisplayText('the \\w gift|grace\\w* given')).toBe("the gift given")
  })

  it("unwraps nested character markers (\\+nd inside \\add)", () => {
    expect(usfmDisplayText("\\add the \\+nd Lord\\+nd* spoke\\add*")).toBe("the Lord spoke")
  })

  it("renders structural markers as breaks with poetry indent levels", () => {
    const raw = "start \\q1 line one \\q2 line two \\b \\p resumed"
    const segments = segmentUsfmForDisplay(raw)!
    const breaks = segments.filter((s) => s.kind === "break")
    expect(breaks.map((b) => (b.kind === "break" ? b.indent : -1))).toEqual([1, 2, 0, 0])
    expect(breaks.some((b) => b.kind === "break" && b.blank)).toBe(true)
    expect(usfmDisplayText(raw)).toBe("start \nline one \nline two \n\nresumed")
  })

  it("drops the bare milestone terminator and unknown markers but keeps their content", () => {
    expect(usfmDisplayText('\\qt-s |who="Pilate"\\*You are the king\\qt-e\\*')).toBe(
      "You are the king",
    )
    expect(usfmDisplayText("kept \\zunknown content stays")).toBe("kept content stays")
  })

  it("degrades safely on an unterminated footnote (drops opener, keeps text)", () => {
    const out = usfmDisplayText("before \\f + \\ft dangling note")
    expect(out).not.toContain("\\f")
    expect(out).toContain("before")
  })

  it("text segments are verbatim raw slices (round-trip invariant)", () => {
    const segments = segmentUsfmForDisplay(SUVALI_1JN_2_1)!
    for (const seg of segments) {
      if (seg.kind === "text") {
        expect(SUVALI_1JN_2_1.slice(seg.rawStart, seg.rawEnd)).toBe(seg.text)
      }
    }
  })
})

describe("clipRangesToSegment", () => {
  it("shifts raw-offset violation ranges into segment-local coordinates — WHY: check spans are computed against stored text, display must not misplace them", () => {
    const raw = "abc \\w def\\w* ghi"
    const segments = segmentUsfmForDisplay(raw)!
    const textSegs = segments.filter((s): s is UsfmTextSegment => s.kind === "text")
    // Range over "def" in RAW coordinates (after "abc \\w " = index 7..10).
    const ranges = [{ start: 7, end: 10, ruleId: "r1" }]
    const all = textSegs.flatMap((seg) => clipRangesToSegment(ranges, seg))
    expect(all).toHaveLength(1)
    const seg = textSegs.find((s) => s.text === "def")!
    expect(seg.text.slice(all[0].start, all[0].end)).toBe("def")
  })
})
