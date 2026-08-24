// The pairing review list. (AQU-646 stage 4)
//
// This is the ranking that decides what a person looks at, so the assertions
// that matter are about what it REFUSES to raise as much as what it raises.
// The last block runs it over The Chosen's real episode-101 pair and pins the
// measured shape — 28 amber chips reducing to a handful of rows — skipping
// itself when the sample files aren't on the machine.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect } from "vitest"

import { reviewCueLinks } from "./cue-link-review"
import { autoLinkable, planCueLinks, type LinkableCue } from "./cue-links"
import { applyTimebaseScale } from "@/lib/import/timebase"
import type { CueLink } from "@/lib/sync/cell-links-read"

const cue = (id: string, start: number, end: number, original: string): LinkableCue => ({
  id,
  startTime: start,
  endTime: end,
  original,
})

const link = (textCellId: string, cueCellId: string, confidence: number | null = 0.9): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence,
})

describe("finding the hole in the alignment", () => {
  // s1↔c1 and s3↔c3 are paired; c2 and s2 are the lone unpaired pair between
  // them. That is the shape the whole feature is built to notice.
  const textCells = [
    cue("s1", 0, 2, "One"),
    cue("s2", 4, 6, "No."),
    cue("s3", 8, 10, "Three"),
  ]
  const audioCues = [
    cue("c1", 0, 2, "One"),
    cue("c2", 3, 3.4, "No."),
    cue("c3", 8, 10, "Three"),
  ]
  const links = [link("s1", "c1"), link("s3", "c3")]

  it("proposes the pair the matcher could not make", () => {
    // c2 and s2 never overlap in time — 3.0-3.4 against 4.0-6.0 — so
    // planCueLinks cannot pair them however identical the words are.
    expect(planCueLinks({ textCells, audioCues }).some((p) => p.cueCellId === "c2")).toBe(false)
    const r = reviewCueLinks({ textCells, audioCues, links })
    expect(r.confident).toHaveLength(1)
    expect(r.confident[0]).toMatchObject({ cueCellId: "c2", textCellId: "s2", similarity: 1 })
  })

  it("separates a same-words match from a words-disagree one", () => {
    // Same evidence — the only candidate in the hole — but very different
    // confidence, so they must not sit three pixels apart in one ranked list.
    const r = reviewCueLinks({
      textCells: [cue("s1", 0, 2, "One"), cue("s2", 4, 6, "Right here."), cue("s3", 8, 10, "Three")],
      audioCues: [cue("c1", 0, 2, "One"), cue("c2", 3, 3.4, "Matthew! Psst."), cue("c3", 8, 10, "Three")],
      links,
    })
    expect(r.confident).toEqual([])
    expect(r.uncertain).toHaveLength(1)
    expect(r.uncertain[0].cueCellId).toBe("c2")
  })

  it("never proposes a pair a person has already rejected", () => {
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links,
      rejected: [{ fromCellId: "s2", toCellId: "c2" }],
    })
    expect(r.confident).toEqual([])
    expect(r.uncertain).toEqual([])
    // It falls back to being a plain unpaired cue, which is honest.
    expect(r.unpairedCues).toContain("c2")
  })

  it("calls a cue with nothing in the hole a real orphan, not a question", () => {
    // "Whoa!" — genuinely unsubtitled. A fact, not a problem.
    const r = reviewCueLinks({
      textCells: [cue("s1", 0, 2, "One"), cue("s3", 8, 10, "Three")],
      audioCues: [cue("c1", 0, 2, "One"), cue("c2", 4, 4.3, "Whoa!"), cue("c3", 8, 10, "Three")],
      links,
    })
    expect(r.confident).toEqual([])
    expect(r.uncertain).toEqual([])
    expect(r.unpairedCues).toEqual(["c2"])
  })

  it("declines to guess when the hole holds several candidates", () => {
    const r = reviewCueLinks({
      textCells: [
        cue("s1", 0, 2, "One"),
        cue("sa", 3, 4, "Maybe"),
        cue("sb", 5, 6, "Perhaps"),
        cue("s3", 8, 10, "Three"),
      ],
      audioCues: [cue("c1", 0, 2, "One"), cue("c2", 4, 4.5, "Hm"), cue("c3", 8, 10, "Three")],
      links,
    })
    expect(r.confident).toEqual([])
    expect(r.uncertain).toEqual([])
    expect(r.unpairedCues).toEqual(["c2"])
  })
})

describe("what never ranks", () => {
  it("ignores unpaired cues at the head of the file — nothing brackets them", () => {
    // The opening screen cards, and anything before the first pairing. They
    // are excluded structurally rather than by a rule about screen text.
    const r = reviewCueLinks({
      textCells: [cue("s0", 0, 1, "THE CHOSEN IS BASED ON"), cue("s1", 20, 22, "One")],
      audioCues: [cue("c0", 0, 1, "?"), cue("c1", 20, 22, "One")],
      links: [link("s1", "c1")],
    })
    expect(r.confident).toEqual([])
    expect(r.uncertain).toEqual([])
    expect(r.unpairedCues).toEqual(["c0"])
    expect(r.unpairedText).toEqual(["s0"])
  })

  it("does not offer one subtitle to two different cues", () => {
    const textCells = [cue("s1", 0, 2, "One"), cue("s2", 4, 6, "Yes"), cue("s3", 20, 22, "Three")]
    const audioCues = [
      cue("c1", 0, 2, "One"),
      cue("c2", 3, 3.4, "Yes"),
      cue("c2b", 3.5, 3.9, "Yes"),
      cue("c3", 20, 22, "Three"),
    ]
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s1", "c1"), link("s3", "c3")],
    })
    const proposed = [...r.confident, ...r.uncertain].map((c) => c.textCellId)
    expect(new Set(proposed).size).toBe(proposed.length)
  })
})

describe("what the matcher declines to pair", () => {
  // Sam, 2026-08-15: these are FLAGGED rather than written. Nothing verified
  // what the two lines say, so the person decides.
  it("surfaces a cross-script match as a proposal, not a pairing", () => {
    const textCells = [
      cue("s0", 0, 2, "One"),
      cue("s1", 5, 7, "Messiah will destroy the Romans"),
      cue("s2", 20, 22, "Three"),
    ]
    const audioCues = [
      cue("c0", 0, 2, "One"),
      cue("c1", 5, 7, "המשיח יהרוס את הרומאים"),
      cue("c2", 20, 22, "Three"),
    ]
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s0", "c0"), link("s2", "c2")],
    })
    expect(r.crossScriptCandidates.map((c) => c.cueCellId)).toEqual(["c1"])
    // ...and it must not ALSO appear as a bracketing candidate. One question
    // per cue.
    expect(r.confident).toEqual([])
    expect(r.uncertain).toEqual([])
  })

  it("surfaces a weak-wording overlap as a different proposal", () => {
    // Two words in common out of five: 0.4 similarity — over the noise floor,
    // under the bar for pairing on its own. (A short cue fully contained in a
    // long line, like "boat" inside "the boat is over there", scores 1.00 on
    // containment and is a STRONG match, not a weak one.)
    const textCells = [
      cue("s0", 0, 2, "One"),
      cue("s1", 5, 9, "alpha beta gamma delta epsilon zeta"),
      cue("s2", 20, 22, "Three"),
    ]
    const audioCues = [
      cue("c0", 0, 2, "One"),
      cue("c1", 5, 9, "alpha beta theta iota kappa"),
      cue("c2", 20, 22, "Three"),
    ]
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s0", "c0"), link("s2", "c2")],
    })
    expect([...r.crossScriptCandidates, ...r.weakCandidates].map((c) => c.cueCellId)).toContain("c1")
  })

  it("never proposes one a person has rejected", () => {
    const textCells = [
      cue("s0", 0, 2, "One"),
      cue("s1", 5, 7, "Messiah will destroy the Romans"),
      cue("s2", 20, 22, "Three"),
    ]
    const audioCues = [
      cue("c0", 0, 2, "One"),
      cue("c1", 5, 7, "המשיח יהרוס את הרומאים"),
      cue("c2", 20, 22, "Three"),
    ]
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s0", "c0"), link("s2", "c2")],
      rejected: [{ fromCellId: "s1", toCellId: "c1" }],
    })
    expect(r.crossScriptCandidates).toEqual([])
  })

  it("never proposes one the matcher itself judged redundant", () => {
    // A pairing the claiming pass threw out is the matcher's own answer that
    // this is NOT a pair. Putting it in front of a person as a finding would
    // hand back the exact junk that was just removed — and the drawer's
    // else-branch would have filed it under weak wording, where it looks like
    // a judgement call rather than a rejected one.
    //
    // Two students each saying "Rabbi.", verbatim from 10:53.
    const textCells = [
      cue("s0", 0, 2, "One"),
      cue("student-1", 653.3, 654.2, "Rabbi."),
      cue("student-2", 654.2, 655.0, "Rabbi."),
      cue("s3", 900, 902, "Three"),
    ]
    const audioCues = [
      cue("c0", 0, 2, "One"),
      cue("c-rabbi", 653.279, 654.28, "Rabbi."),
      cue("c3", 900, 902, "Three"),
    ]
    // The redundant one is the only thing the matcher declined here.
    expect(
      planCueLinks({ textCells, audioCues }).filter((p) => p.basis === "redundant"),
    ).toHaveLength(1)

    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s0", "c0"), link("student-1", "c-rabbi"), link("s3", "c3")],
    })
    const proposed = [...r.crossScriptCandidates, ...r.weakCandidates].map((c) => c.textCellId)
    expect(proposed).not.toContain("student-2")
  })
})

describe("existing pairings worth a second look", () => {
  const textCells = [cue("s1", 0, 2, "Messiah will destroy the Romans"), cue("s2", 5, 7, "Hello there")]
  const audioCues = [cue("c1", 0, 2, "המשיח יהרוס את הרומאים"), cue("c2", 5, 7, "Hi")]

  it("groups a cross-script pairing apart — nothing compared its words", () => {
    const r = reviewCueLinks({
      textCells,
      audioCues,
      links: [link("s1", "c1", 0.8), link("s2", "c2", 0.9)],
    })
    expect(r.crossScript.map((p) => p.cueCellId)).toEqual(["c1"])
    expect(r.lowConfidence).toEqual([])
  })

  it("lists a pairing that barely cleared the bar, worst first", () => {
    const r = reviewCueLinks({
      textCells: [cue("s1", 0, 2, "One"), cue("s2", 5, 7, "Two")],
      audioCues: [cue("c1", 0, 2, "Uno"), cue("c2", 5, 7, "Dos")],
      links: [link("s1", "c1", 0.4), link("s2", "c2", 0.25)],
    })
    expect(r.lowConfidence.map((p) => p.confidence)).toEqual([0.25, 0.4])
  })

  it("counts everything actionable as one number — the size of the job", () => {
    const r = reviewCueLinks({
      textCells: [cue("s1", 0, 2, "One"), cue("s2", 5, 7, "Two")],
      audioCues: [cue("c1", 0, 2, "Uno"), cue("c2", 5, 7, "Dos")],
      links: [link("s1", "c1", 0.4), link("s2", "c2", 0.25)],
    })
    expect(r.actionable).toBe(2)
  })
})

it("survives empty input", () => {
  const r = reviewCueLinks({ textCells: [], audioCues: [], links: [] })
  expect(r.actionable).toBe(0)
  expect(r.unpairedCues).toEqual([])
})

// ── The real episode ─────────────────────────────────────────────────────
const DL = path.join(os.homedir(), "Code", "aquilla-app", "the-chosen-media", "101")
const TEXT_VTT = path.join(DL, "TheChosen_101_en_5&2.vtt")
const AUDIO_VTT = path.join(DL, "TheChosen_101_en_AUDIO_ONLY_5&2.vtt")
const haveSamples = fs.existsSync(TEXT_VTT) && fs.existsSync(AUDIO_VTT)

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})/
function parseVtt(file: string, prefix: string): LinkableCue[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  const toSec = (h: string | undefined, m: string, s: string, ms: string) =>
    (+(h ?? 0)) * 3600 + +m * 60 + +s + +ms / 1000
  const out: LinkableCue[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(TS)
    if (!m) continue
    const text: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t === "" || TS.test(t)) break
      text.push(t)
    }
    out.push({
      id: `${prefix}${out.length}`,
      startTime: toSec(m[1], m[2], m[3], m[4]),
      endTime: toSec(m[5], m[6], m[7], m[8]),
      original: text.join(" "),
    })
  }
  return out
}

describe.skipIf(!haveSamples)("against The Chosen episode 101", () => {
  const NTSC = 24 / (24000 / 1001)
  // skipIf still runs this callback to collect the tests, so nothing here may
  // touch the disk when the samples are absent.
  const textCells = haveSamples ? parseVtt(TEXT_VTT, "s") : []
  const audioCues = (haveSamples ? parseVtt(AUDIO_VTT, "c") : []).map((c) => ({
    ...c,
    startTime: applyTimebaseScale(c.startTime!, NTSC),
    endTime: applyTimebaseScale(c.endTime!, NTSC),
  }))
  // Only what the matcher would actually WRITE — cross-script and weak-wording
  // matches are proposals now, not pairings.
  const links: CueLink[] = autoLinkable(planCueLinks({ textCells, audioCues })).map((p) =>
    link(p.textCellId, p.cueCellId, p.confidence),
  )
  const r = reviewCueLinks({ textCells, audioCues, links })

  it("turns a wall of amber into a list you can finish", () => {
    // ~28 unpaired cells on the timeline; a handful of rows here.
    expect(r.confident.length + r.uncertain.length).toBeLessThan(12)
    expect(r.actionable).toBeLessThan(30)
  })

  it("no longer auto-pairs anything the matcher could not verify", () => {
    // Cross-script and weak-wording matches are proposals now, so the links
    // that DO exist all rest on wording agreement.
    expect(links.every((l) => (l.confidence ?? 0) >= 0.5)).toBe(true)
  })

  it("finds the identical-wording misses the matcher structurally cannot make", () => {
    // "No." against "No." and "We?" against "We?" — same words, under a second
    // apart, and never overlapping, so planCueLinks can never pair them.
    expect(r.confident.length).toBeGreaterThanOrEqual(2)
    for (const c of r.confident) expect(c.similarity).toBeGreaterThanOrEqual(0.6)
    const paired = new Set(links.map((l) => l.toCellId))
    for (const c of r.confident) expect(paired.has(c.cueCellId)).toBe(false)
  })

  it("leaves the genuinely unsubtitled utterances alone", () => {
    // "Whoa!", "Nah.", "Mm-hmm." — no candidate, so no question asked.
    expect(r.unpairedCues.length).toBeGreaterThan(0)
    const byId = new Map(audioCues.map((c) => [c.id, c]))
    for (const id of r.unpairedCues) {
      expect((byId.get(id)?.original ?? "").length).toBeLessThan(60)
    }
  })
})
