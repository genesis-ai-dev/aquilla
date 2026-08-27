import { describe, it, expect } from "vitest"
import { exportVtt } from "./vtt"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { userLineOrigin } from "@/lib/timeline/user-lines"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "src", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }],
  castAssignments: { c1: "v-mary" }, // c2 has no explicit assignment
}

async function text(b: Blob) { return b.text() }

describe("exportVtt", () => {
  it("wraps explicitly-cast cells in <v Name> and leaves others plain", async () => {
    const cells = [
      cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 }),
      cell({ id: "c2", translated: "Salut", startTime: 2, endTime: 3 }),
    ]
    const out = await text(exportVtt(cells, SETTINGS))
    expect(out).toContain("WEBVTT")
    expect(out).toContain("00:00:01.000 --> 00:00:02.000")
    expect(out).toContain("<v Mary>Bonjour</v>")
    expect(out).toContain("Salut")
    expect(out).not.toContain("<v Mary>Salut")
  })

  it("skips cells with no timecodes", async () => {
    const out = await text(exportVtt([cell({ id: "c1", translated: "x" })], SETTINGS))
    expect(out.trim()).toBe("WEBVTT")
  })

  it("falls back to source text when target is empty", async () => {
    const out = await text(exportVtt([cell({ id: "c1", original: "orig", translated: "", startTime: 0, endTime: 1 })], {}))
    expect(out).toContain("orig")
  })
})

// ── The two shapes codex-editor offers as separate formats ────────────────
//
// Ported 2026-08-18. Both are off by default, and the first test here is the
// one that matters most: the file produced with no options set has to be
// exactly what this exporter has always written.

describe("cue splitting", () => {
  /** Two characters talking over each other — a scene, not a mistake. */
  const overlapping = [
    cell({ id: "c1", translated: "Rabbi, listen", startTime: 10, endTime: 14 }),
    cell({ id: "c2", translated: "I heard you", startTime: 12, endTime: 16 }),
  ]

  it("leaves the cues genuinely overlapping by default", async () => {
    const out = await text(exportVtt(overlapping, SETTINGS))
    expect(out).toContain("00:00:10.000 --> 00:00:14.000")
    expect(out).toContain("00:00:12.000 --> 00:00:16.000")
  })

  it("re-cuts them at every boundary so none of them overlap", async () => {
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true }))
    // 10–12 one speaker, 12–14 both, 14–16 the other.
    expect(out).toContain("00:00:10.000 --> 00:00:12.000")
    expect(out).toContain("00:00:12.000 --> 00:00:14.000")
    expect(out).toContain("00:00:14.000 --> 00:00:16.000")
    expect(out).not.toContain("00:00:10.000 --> 00:00:14.000")
  })

  it("stacks the simultaneous speakers in the shared cue", async () => {
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true }))
    const shared = out.split("\n\n").find((block) => block.includes("00:00:12.000 --> 00:00:14.000"))!
    expect(shared).toContain("<v Mary>Rabbi, listen</v>")
    expect(shared).toContain("I heard you")
  })

  it("never puts a blank line inside a cue", async () => {
    // A blank line terminates a cue per the WebVTT spec, so joining stacked
    // payloads with "\n\n" would silently truncate every shared cue to its
    // first speaker. This is the whole reason for the single newline.
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true }))
    const blocks = out.replace(/^WEBVTT\n\n/, "").trim().split("\n\n")
    for (const block of blocks) {
      expect(block.split("\n")[0]).toContain("-->")
    }
  })

  it("leaves a real silence between lines as a gap, not an empty cue", async () => {
    const apart = [
      cell({ id: "c1", translated: "One", startTime: 0, endTime: 1 }),
      cell({ id: "c2", translated: "Two", startTime: 5, endTime: 6 }),
    ]
    const out = await text(exportVtt(apart, SETTINGS, { cueSplitting: true }))
    expect(out).not.toContain("00:00:01.000 --> 00:00:05.000")
    expect(out).toContain("00:00:00.000 --> 00:00:01.000")
    expect(out).toContain("00:00:05.000 --> 00:00:06.000")
  })

  it("changes nothing when no cues overlap", async () => {
    const apart = [
      cell({ id: "c1", translated: "One", startTime: 0, endTime: 1 }),
      cell({ id: "c2", translated: "Two", startTime: 5, endTime: 6 }),
    ]
    const plain = await text(exportVtt(apart, SETTINGS))
    const split = await text(exportVtt(apart, SETTINGS, { cueSplitting: true }))
    expect(split).toBe(plain)
  })
})

describe("leaving out the character names", () => {
  it("drops the voice tags but keeps the words and the timing", async () => {
    const cells = [cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { excludeLabels: true }))
    expect(out).not.toContain("<v")
    expect(out).toContain("Bonjour")
    expect(out).toContain("00:00:01.000 --> 00:00:02.000")
  })

  it("combines with cue splitting", async () => {
    const overlapping = [
      cell({ id: "c1", translated: "Rabbi", startTime: 10, endTime: 14 }),
      cell({ id: "c2", translated: "Yes", startTime: 12, endTime: 16 }),
    ]
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true, excludeLabels: true }))
    expect(out).not.toContain("<v")
    expect(out).toContain("00:00:12.000 --> 00:00:14.000")
  })
})

// ── The bilingual review file ─────────────────────────────────────────────
//
// Added 2026-08-19. This shape is not a delivery subtitle — it is what someone
// plays against the picture to check the translation line by line against the
// original. Most of what is worth testing here is the untranslated line, which
// the monolingual export deliberately papers over.

describe("the bilingual review file", () => {
  it("writes the source line above the target line inside one cue", async () => {
    const cells = [cell({ id: "c2", original: "Bonjour", translated: "Hello", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    expect(out).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\nHello\n")
  })

  it("never leaves a blank line between the two languages", async () => {
    // A blank line ends the cue, so "\n\n" between source and target would
    // produce a file that looks bilingual in a text editor and plays as
    // source-only in a player — a whole reel subtitled in the wrong language,
    // with nothing in the export to show for it.
    const cells = [cell({ id: "c2", original: "Bonjour", translated: "Hello", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    expect(out.replace(/^WEBVTT\n\n/, "").trim().split("\n")).toEqual([
      "00:00:01.000 --> 00:00:02.000",
      "Bonjour",
      "Hello",
    ])
  })

  it("shows an untranslated line ONCE instead of repeating the source", async () => {
    // THE CASE THIS OPTION EXISTS FOR. Without a translation the exporter falls
    // back to the source text, which is right for a watchable file and wrong
    // here: the reviewer would see the same sentence twice, read it as a bug in
    // the export, and lose the one fact they opened this file to find — that
    // nobody has done this line yet.
    const cells = [cell({ id: "c2", original: "Bonjour", translated: "", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    expect(out).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n")
    expect(out).not.toContain("Bonjour\nBonjour")
  })

  it("still shows both lines when a translation legitimately equals its source", async () => {
    // A name, a number, "Amen". The untranslated case is decided from the field
    // being empty rather than from the two strings matching, so a line that was
    // genuinely worked on is never reported back as missing.
    const cells = [cell({ id: "c2", original: "Amen", translated: "Amen", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    expect(out).toContain("Amen\nAmen")
  })

  it("wraps both languages in the one voice tag", async () => {
    // One person said both lines. Closing the tag after the source would leave
    // the translation attributed to nobody.
    const cells = [cell({ id: "c1", original: "Bonjour", translated: "Hello", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    expect(out).toContain("<v Mary>Bonjour\nHello</v>")
    expect(out.match(/<v /g)).toHaveLength(1)
  })

  it("gives an untranslated line the source alone, tagged or not", async () => {
    // The first cut appended an empty target line. Inside a voice tag that was
    // harmless — the closing "</v>" filled the line — but on an untagged cue it
    // left a stray blank, and a blank line TERMINATES a cue, so the empty half
    // was never rendered by anything either way. Source-only already reads as
    // untranslated, and it now reads the same whether the line is cast or not.
    const untimedCast = [cell({ id: "c1", original: "Bonjour", translated: "", startTime: 1, endTime: 2 })]
    expect(await text(exportVtt(untimedCast, SETTINGS, { includeSource: true })))
      .toContain("<v Mary>Bonjour</v>")

    const plain = [cell({ id: "c2", original: "Bonjour", translated: "", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(plain, SETTINGS, { includeSource: true }))
    expect(out).toContain("00:00:01.000 --> 00:00:02.000\nBonjour\n")
    // …and no stray blank line before the file ends.
    expect(out).not.toContain("Bonjour\n\n\n")
  })

  it("adds no cues and drops none", async () => {
    // Which cells get a cue is still decided by the monolingual text alone. An
    // untranscribed media section has no source text by design, and it must not
    // start appearing in the export just because the option is on.
    const cells = [
      cell({ id: "c1", original: "clip-04.wav", medium: "media", transcription: "", startTime: 1, endTime: 2 }),
      cell({ id: "c2", original: "Bonjour", translated: "Hello", startTime: 3, endTime: 4 }),
    ]
    const plain = await text(exportVtt(cells, SETTINGS))
    const bilingual = await text(exportVtt(cells, SETTINGS, { includeSource: true }))
    const stamps = (vtt: string) => vtt.split("\n").filter((line) => line.includes("-->"))
    expect(stamps(bilingual)).toEqual(stamps(plain))
    expect(bilingual).not.toContain("clip-04.wav")
  })

  it("combines with leaving the character names out", async () => {
    const cells = [cell({ id: "c1", original: "Bonjour", translated: "Hello", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { includeSource: true, excludeLabels: true }))
    expect(out).not.toContain("<v")
    expect(out).toContain("Bonjour\nHello")
  })

  it("stacks both languages for every speaker sharing a split cue", async () => {
    const overlapping = [
      cell({ id: "c1", original: "Rabbi", translated: "Ravvi", startTime: 10, endTime: 14 }),
      cell({ id: "c2", original: "Yes", translated: "Kyllä", startTime: 12, endTime: 16 }),
    ]
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true, includeSource: true }))
    const lines = out.split("\n")
    const at = lines.indexOf("00:00:12.000 --> 00:00:14.000")
    expect(lines.slice(at + 1, at + 5)).toEqual(["<v Mary>Rabbi", "Ravvi</v>", "Yes", "Kyllä"])
  })

  it("does not lose the speakers underneath an untranslated line in a shared cue", async () => {
    // The empty target line is a cue TERMINATOR. Left in the middle of a stack
    // it cuts everything below it, so a reviewer would watch the second speaker
    // vanish from exactly the overlaps they were checking.
    const overlapping = [
      cell({ id: "c2", original: "Rabbi", translated: "", startTime: 10, endTime: 14 }),
      cell({ id: "c1", original: "Yes", translated: "Kyllä", startTime: 12, endTime: 16 }),
    ]
    const out = await text(exportVtt(overlapping, SETTINGS, { cueSplitting: true, includeSource: true }))
    const lines = out.split("\n")
    const at = lines.indexOf("00:00:12.000 --> 00:00:14.000")
    expect(lines.slice(at + 1, at + 4)).toEqual(["Rabbi", "<v Mary>Yes", "Kyllä</v>"])
  })

  it("is off unless it is asked for", async () => {
    // The default file is what this exporter has always written, byte for byte.
    const cells = [cell({ id: "c1", original: "Bonjour", translated: "Hello", startTime: 1, endTime: 2 })]
    expect(await text(exportVtt(cells, SETTINGS))).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Mary>Hello</v>\n",
    )
    expect(await text(exportVtt(cells, SETTINGS, { includeSource: false }))).toBe(
      await text(exportVtt(cells, SETTINGS)),
    )
  })
})

// ── What the adversarial review found (2026-08-19) ───────────────────────
//
// Three of these are data loss, which is the one failure a subtitle export is
// not allowed to have: a line that went in and did not come out.

describe("nothing goes missing", () => {
  it("keeps a zero-duration cue when the cues are re-cut", async () => {
    // Boundary spans are half-open, so a cue where start === end is active
    // across NONE of them. It used to simply vanish.
    const cells = [
      cell({ id: "z", original: "Zero", translated: "Nolla", startTime: 5, endTime: 5 }),
      cell({ id: "b", original: "B", translated: "Bee", startTime: 10, endTime: 12 }),
    ]
    const out = await text(exportVtt(cells, SETTINGS, { cueSplitting: true }))
    expect(out).toContain("00:00:05.000 --> 00:00:05.000")
    expect(out).toContain("Nolla")
  })

  it("keeps the re-cut cues in time order even so", async () => {
    const cells = [
      cell({ id: "b", original: "B", translated: "Bee", startTime: 10, endTime: 12 }),
      cell({ id: "z", original: "Zero", translated: "Nolla", startTime: 5, endTime: 5 }),
    ]
    const out = await text(exportVtt(cells, SETTINGS, { cueSplitting: true }))
    expect(out.indexOf("00:00:05.000")).toBeLessThan(out.indexOf("00:00:10.000"))
  })

  it("does not let a blank line delete the speakers stacked under it", async () => {
    // THE BLOCKER. A deliberately blank user-added line has an empty payload;
    // joining it into a stack put a blank line at the top of the cue, which
    // terminates the cue — so every speaker below it disappeared from the file.
    const blank = cell({
      id: "u1", original: "", translated: "", startTime: 10, endTime: 14,
      metadata: { aquillaOrigin: userLineOrigin() },
    })
    const spoken = cell({ id: "c9", original: "Yes", translated: "Kylla", startTime: 12, endTime: 16 })
    const out = await text(exportVtt([blank, spoken], SETTINGS, { cueSplitting: true }))
    expect(out).toContain("Kylla")
    // …and no cue begins with a blank line.
    for (const block of out.replace(/^WEBVTT\n\n/, "").trim().split("\n\n")) {
      expect(block.split("\n")[1] ?? "x").not.toBe("")
    }
  })
})

describe("timestamps a player will accept", () => {
  it("carries into the seconds instead of writing a four-digit millisecond", async () => {
    // `formatVttTime(1.9995)` used to return "00:00:01.1000", which the app's
    // own parser rejects. Parsed cues are exact; a cue somebody DRAGGED is an
    // arbitrary float and lands here.
    const cells = [cell({ id: "c1", original: "x", translated: "y", startTime: 1.9995, endTime: 59.9996 })]
    const out = await text(exportVtt(cells, SETTINGS))
    expect(out).toContain("00:00:02.000 --> 00:01:00.000")
    expect(out).not.toMatch(/\.\d{4}/)
  })
})


// ── Naming the speaker without a cast assignment (AQU-646, 2026-08-20) ──────
//
// THE TRAP THIS EXISTS FOR. Voice tags read `settings.castAssignments`, which
// is keyed by cell id — and an audio cue only appears there if the AUDIO
// character sheet was imported. Import only the SUBTITLE sheet and every cue
// looks anonymous to this exporter, while the app itself shows a name on each
// one (it resolves them across the cue↔text links). So an "audio VTT" of that
// project came out completely bare while every other surface named everybody.
// `audio-by-character.ts` carries the same parameter for the same reason.

describe("naming the speaker from outside the cast list", () => {
  it("tags a cell the cast assignments know nothing about", async () => {
    // `c9` is in no castAssignments entry — exactly an audio cue's situation.
    const cells = [cell({ id: "c9", translated: "Rabbi", startTime: 1, endTime: 2 })]
    const out = await text(
      exportVtt(cells, SETTINGS, { resolveName: () => "NICODEMUS" }),
    )
    expect(out).toContain("<v NICODEMUS>Rabbi</v>")
  })

  it("wins over the cast assignment when both have an answer", async () => {
    // Both name the speaker; the resolver is the one that walked the links and
    // agrees with what the chip strip and the recorder are showing.
    const cells = [cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { resolveName: () => "JESUS" }))
    expect(out).toContain("<v JESUS>")
    expect(out).not.toContain("<v Mary>")
  })

  it("falls back to the cast assignment when the resolver has no answer", async () => {
    // So passing a resolver can only ever ADD tags, never remove one the
    // settings would have produced.
    const cells = [cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { resolveName: () => null }))
    expect(out).toContain("<v Mary>")
  })

  it("treats a blank name as nobody rather than tagging an empty speaker", async () => {
    const cells = [cell({ id: "c9", translated: "Rabbi", startTime: 1, endTime: 2 })]
    const out = await text(exportVtt(cells, SETTINGS, { resolveName: () => "   " }))
    expect(out).not.toContain("<v")
    expect(out).toContain("Rabbi")
  })

  it("still obeys 'leave out character names'", async () => {
    // The checkbox means no tags at all — whichever source could name them.
    const cells = [cell({ id: "c9", translated: "Rabbi", startTime: 1, endTime: 2 })]
    const out = await text(
      exportVtt(cells, SETTINGS, { resolveName: () => "NICODEMUS", excludeLabels: true }),
    )
    expect(out).not.toContain("<v")
  })

  it("sanitises a resolved name the same way an assigned one is sanitised", async () => {
    // A name is not free text inside a voice tag: `<` and `>` would end the
    // annotation early and turn the rest of the name into markup. Both sources
    // of a name go through the same escaper, so neither can be the one that
    // gets it wrong.
    const cells = [cell({ id: "c9", translated: "Rabbi", startTime: 1, endTime: 2 })]
    const out = await text(
      exportVtt(cells, SETTINGS, { resolveName: () => "MARY <b>MAGDALENE" }),
    )
    expect(out).toContain("<v MARY bMAGDALENE>Rabbi</v>")
  })
})
