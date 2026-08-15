// The auto-linker. (AQU-646 stage 4)
//
// The synthetic cases below pin the rules. The last block runs the linker over
// The Chosen's REAL episode-101 pair and asserts the numbers this design was
// chosen from — it skips itself when the sample files aren't on the machine,
// so it is a genuine check locally and harmless anywhere else.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect } from "vitest"

import { planCueLinks, cueSimilarity, dominantScript, type LinkableCue } from "./cue-links"
import { applyTimebaseScale } from "@/lib/import/timebase"

const cue = (id: string, startTime: number, endTime: number, original: string): LinkableCue => ({
  id,
  startTime,
  endTime,
  original,
})

describe("cueSimilarity", () => {
  it("strips punctuation before comparing — the whole point of not reusing sourceSimilarity", () => {
    // "Two." against "Two, please." is the single most characteristic
    // difference between these two files, and it scores ZERO under
    // lib/analysis/buckets.ts's normalisation, which keeps punctuation.
    expect(cueSimilarity("Two.", "Two, please.")).toBeGreaterThanOrEqual(0.5)
  })

  it("rescues a condensed subtitle through containment", () => {
    // Dice punishes the length mismatch that a condensed subtitle IS.
    const spoken = "Sometimes, I wonder if what we can know of Adonai is enough"
    expect(cueSimilarity(spoken, "Sometimes...")).toBe(1)
  })

  it("scores genuinely different lines at nothing", () => {
    expect(cueSimilarity("No! No!", "What is that?")).toBe(0)
  })

  it("is zero when either side has no words", () => {
    expect(cueSimilarity("", "anything")).toBe(0)
    expect(cueSimilarity("...", "anything")).toBe(0)
  })
})

describe("dominantScript", () => {
  it("names the script a cue is mostly in", () => {
    expect(dominantScript("Messiah will destroy the Romans")).toBe("latin")
    expect(dominantScript("המשיח יהרוס את הרומאים")).toBe("hebrew")
  })

  it("commits to nothing when there are no letters to judge by", () => {
    // A cue of digits or punctuation must not trigger the cross-script path.
    expect(dominantScript("123 —")).toBeNull()
  })
})

describe("planCueLinks", () => {
  it("pairs a plain one-to-one line", () => {
    const plans = planCueLinks({
      textCells: [cue("sub-1", 10, 12, "I see him.")],
      audioCues: [cue("cue-1", 10.1, 11.9, "I see him.")],
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ textCellId: "sub-1", cueCellId: "cue-1" })
  })

  it("splits one subtitle across the cues that perform it", () => {
    // The case that forces takes onto cue cells rather than subtitle cells.
    const plans = planCueLinks({
      textCells: [cue("sub-1", 10, 16, "Pay me, pay me, let's go.")],
      audioCues: [cue("cue-1", 10, 12, "Pay me, pay me"), cue("cue-2", 14, 16, "let's go!")],
    })
    expect(plans.map((p) => p.cueCellId).sort()).toEqual(["cue-1", "cue-2"])
    expect(new Set(plans.map((p) => p.textCellId))).toEqual(new Set(["sub-1"]))
  })

  it("merges several subtitle rows under one heard line", () => {
    const plans = planCueLinks({
      textCells: [cue("sub-1", 10, 12, "You're lucky"), cue("sub-2", 12, 14, "to not be in jail")],
      audioCues: [cue("cue-1", 10, 14, "You're lucky to not be in jail")],
    })
    expect(plans.map((p) => p.textCellId).sort()).toEqual(["sub-1", "sub-2"])
  })

  it("refuses two speakers who merely overlap in time", () => {
    const plans = planCueLinks({
      textCells: [cue("sub-1", 10, 12, "What is that?")],
      audioCues: [cue("cue-1", 10, 12, "No! No!")],
    })
    expect(plans).toHaveLength(0)
  })

  it("links across scripts on timing alone — words cannot be compared", () => {
    // Foreign dialogue is subtitled even for English viewers. Similarity here
    // is structurally zero, so the spans have to decide.
    const plans = planCueLinks({
      textCells: [cue("sub-1", 984, 987, '"Messiah will destroy the Romans"')],
      audioCues: [cue("cue-1", 984.2, 986.8, "המשיח יהרוס את הרומאים")],
    })
    expect(plans).toHaveLength(1)
    expect(plans[0].confidence).toBeGreaterThan(0.5)
  })

  it("does not link across scripts when the spans barely touch", () => {
    const plans = planCueLinks({
      textCells: [cue("sub-1", 10, 20, '"Messiah will destroy the Romans"')],
      audioCues: [cue("cue-1", 19.5, 30, "המשיח יהרוס את הרומאים")],
    })
    expect(plans).toHaveLength(0)
  })

  it("ignores cues with no usable timing rather than filing them at zero", () => {
    const plans = planCueLinks({
      textCells: [{ id: "sub-1", original: "hello" }, cue("sub-2", 5, 6, "hello")],
      audioCues: [cue("cue-1", 5, 6, "hello"), { id: "cue-2", original: "hello" }],
    })
    expect(plans).toEqual([
      { textCellId: "sub-2", cueCellId: "cue-1", confidence: 1, basis: "words" },
    ])
  })

  it("survives empty input", () => {
    expect(planCueLinks({ textCells: [], audioCues: [] })).toEqual([])
  })
})

// ── The real episode ─────────────────────────────────────────────────────
const DL = path.join(os.homedir(), "Downloads")
const TEXT_VTT = path.join(DL, "TheChosen_101_en_5&2.vtt")
const AUDIO_VTT = path.join(DL, "TheChosen_101_en_AUDIO_ONLY_5&2.vtt")
const haveSamples = fs.existsSync(TEXT_VTT) && fs.existsSync(AUDIO_VTT)

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})/
function parseVtt(file: string): LinkableCue[] {
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
      id: `c${out.length}`,
      startTime: toSec(m[1], m[2], m[3], m[4]),
      endTime: toSec(m[5], m[6], m[7], m[8]),
      original: text.join(" "),
    })
  }
  return out
}

describe.skipIf(!haveSamples)("against The Chosen episode 101", () => {
  const NTSC = 24 / (24000 / 1001)
  const texts = parseVtt(TEXT_VTT)
  // The audio VTT ships at 24fps against a 23.976 master; the importer corrects
  // it, so the linker sees corrected cues and this must too.
  const cues = parseVtt(AUDIO_VTT).map((c) => ({
    ...c,
    startTime: applyTimebaseScale(c.startTime!, NTSC),
    endTime: applyTimebaseScale(c.endTime!, NTSC),
  }))
  const plans = planCueLinks({ textCells: texts, audioCues: cues })
  const linkedCues = new Set(plans.map((p) => p.cueCellId))
  const linkedTexts = new Set(plans.map((p) => p.textCellId))

  it("reads both files", () => {
    expect(texts).toHaveLength(650)
    expect(cues).toHaveLength(548)
  })

  it("links the overwhelming majority of heard lines", () => {
    // Measured at 654 edges over 538 of the 548 cues. Bands, not exact numbers:
    // this is an assertion about the RULE's behaviour, and a small tuning change
    // that moved these by a handful would not be a regression.
    expect(plans.length).toBeGreaterThan(600)
    expect(linkedCues.size).toBeGreaterThan(520)
  })

  it("leaves only a handful of heard lines with no subtitle behind them", () => {
    // These are the genuinely unsubtitled utterances — "Whoa!", "Nah.",
    // "Mm-hmm." Before the timebase fix this number was 71, and chasing it was
    // what made cross-linking look like a much harder problem than it is.
    const unlinked = cues.length - linkedCues.size
    expect(unlinked).toBeLessThan(20)
  })

  it("never links a screen-text card — nobody speaks them", () => {
    // The 12 ALL-CAPS production cards ("THE CHOSEN IS BASED ON THE TRUE
    // STORIES…") overlap no audio cue at all, so they need no rule. One turning
    // up linked is a bug, not a judgement call.
    const isCard = (c: LinkableCue) => {
      const letters = (c.original ?? "").replace(/[^\p{L}]/gu, "")
      return letters.length > 3 && letters === letters.toUpperCase()
    }
    const cards = texts.filter(isCard)
    expect(cards.length).toBeGreaterThan(8)
    expect(cards.filter((c) => linkedTexts.has(c.id))).toEqual([])
  })

  it("links the Hebrew cue to its quoted English subtitle", () => {
    // The cross-script case, on the real data: zero word overlap, correct pair.
    const hebrew = cues.find((c) => /[֐-׿]/.test(c.original ?? ""))!
    expect(hebrew).toBeDefined()
    const forHebrew = plans.filter((p) => p.cueCellId === hebrew.id)
    expect(forHebrew).toHaveLength(1)
    expect(texts.find((t) => t.id === forHebrew[0].textCellId)?.original).toContain("Messiah")
  })
})
