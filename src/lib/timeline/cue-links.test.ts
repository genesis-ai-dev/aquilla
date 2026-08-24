// The auto-linker. (AQU-646 stage 4)
//
// The synthetic cases below pin the rules. The last block runs the linker over
// The Chosen's REAL episode-101 pair and asserts the numbers this design was
// chosen from — it skips itself when the sample files aren't on the machine,
// so it is a genuine check locally and harmless anywhere else.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assert, describe, it, expect } from "vitest"

import { planCueLinks, autoLinkable, cueSimilarity, dominantScript, type LinkableCue } from "./cue-links"
import { planTimebaseCorrection } from "@/lib/import/timebase"
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

  it("reads the two apostrophes as one character", () => {
    // The audio VTT types contractions curly, the subtitle file straight. Every
    // contraction in the 37 curly cues was scoring as a miss: these two pairs
    // are verbatim from episode 101 and scored 0.50 and 0.75 before the fold.
    expect(cueSimilarity("That’s right.", "That's right.")).toBe(1)
    expect(cueSimilarity("You taught God’s law.", "You taught God's law.")).toBe(1)
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

// ── Claiming ─────────────────────────────────────────────────────────────
//
// Subtitle rows tile the timeline back to back, so a cue whose window runs a
// fraction past its own row touches the next one — in a two-hander, the other
// actor's line. Five cues in episode 101 acquired a second speaker that way and
// the character spreadsheet is what exposed them (Sam, 2026-08-17: "they are
// all mistakes").
//
// Every case below is a miniature of a REAL one, with the timings the matcher
// actually sees (i.e. after the timebase correction) and the wording verbatim,
// named for where it happens in the episode. Four of the five could be caught
// by a confidence floor; the students at 10:53 cannot, which is the whole
// reason claiming exists.
describe("planCueLinks — an extra link must explain unclaimed words", () => {
  const kept = (plans: ReturnType<typeof planCueLinks>) =>
    plans.filter((p) => p.basis !== "redundant")
  const rowsFor = (plans: ReturnType<typeof planCueLinks>, cueId: string) =>
    kept(plans)
      .filter((p) => p.cueCellId === cueId)
      .map((p) => p.textCellId)
      .sort()

  it("drops the neighbour a cue's own row already explained (8:09)", () => {
    // DRIVER's row is the line, word for word. MATTHEW's next row overlaps by
    // 334ms and scores 0.50 on the shared "It's".
    const plans = planCueLinks({
      textCells: [
        cue("driver", 489.1, 490.9, "It's me that don't want to be seen with you, remember?"),
        cue("matthew", 490.9, 492.2, 'It\'s "publicanus."'),
      ],
      audioCues: [cue("c", 489.3, 491.3, "It's me that don't want to be seen with you, remember?")],
    })
    expect(rowsFor(plans, "c")).toEqual(["driver"])
    expect(plans.find((p) => p.textCellId === "matthew")?.basis).toBe("redundant")
  })

  it("drops the second of two IDENTICAL rows, which no score can separate (10:53)", () => {
    // Two students each say "Rabbi." Both rows match the heard line perfectly —
    // both score 1.00 — so only "there is nothing left to explain" can tell
    // them apart, and overlap decides which one keeps it (900ms vs 105ms).
    const plans = planCueLinks({
      textCells: [cue("student-1", 653.3, 654.2, "Rabbi."), cue("student-2", 654.2, 655.0, "Rabbi.")],
      audioCues: [cue("c", 653.279, 654.28, "Rabbi.")],
    })
    expect(rowsFor(plans, "c")).toEqual(["student-1"])
  })

  it("drops a row whose shared words were all already spoken for (26:01)", () => {
    // Eden's row DOES share words with the heard line — "hello, love" is in
    // both, which is why it scored 0.67 — but Simon's row supplied every one of
    // them. Sharing words is not the test; supplying unexplained ones is.
    const plans = planCueLinks({
      textCells: [
        cue("simon", 1563.4, 1564.2, "Hello, love."),
        cue("eden", 1564.2, 1565.9, 'Don\'t you "hello, love" me.'),
      ],
      audioCues: [cue("c", 1561.2, 1564.4, "Oh... hello, love.")],
    })
    expect(rowsFor(plans, "c")).toEqual(["simon"])
  })

  it("drops a near-miss neighbour on a 72ms sliver (32:50)", () => {
    // "Pharisee" against "Pharisees" — different tokens, so Mary's row scores
    // 0.50 on the article alone.
    const plans = planCueLinks({
      textCells: [
        cue("sol", 1970.7, 1971.3, "A Pharisee?"),
        cue("mary", 1971.3, 1972.9, "He's a leader of the Pharisees"),
      ],
      audioCues: [cue("c", 1970.8, 1971.4, "A Pharisee?")],
    })
    expect(rowsFor(plans, "c")).toEqual(["sol"])
  })

  it("prefers the better explanation over the earlier one (45:58)", () => {
    // THE CASE THAT RULES OUT DOCUMENT ORDER. Simon's junk row STARTS EARLIER
    // than Andrew's real one and shares the tail "it didn't", so first-come
    // claiming would let it take those words and keep both links. Ordering by
    // score puts Andrew's exact match first, and Simon's row is then left with
    // nothing to add.
    const plans = planCueLinks({
      textCells: [
        cue("simon", 2755.0, 2758.3, "snatch a net during cleanup, but it didn't work."),
        cue("andrew", 2758.4, 2759.9, "Of course, it didn't."),
      ],
      audioCues: [cue("c", 2758.0, 2758.9, "Of course, it didn't.")],
    })
    expect(rowsFor(plans, "c")).toEqual(["andrew"])
  })

  it("keeps every row of a genuine staircase (43:35)", () => {
    // One heard line, two rows, each supplying its own stretch: "Simon, I came
    // with about 60 percent" + "of what I owe". Both earn their link, and the
    // second row goes on to serve the NEXT cue with the words it has left.
    const plans = planCueLinks({
      textCells: [
        cue("head", 2615.621, 2617.034, "Simon, I came with about 60 percent"),
        cue("tail", 2617.117, 2619.119, "of what I owe. I can't even pay..."),
      ],
      audioCues: [
        cue("c1", 2615.55, 2617.89, "Simon, I came with about 60 percent of what I owe."),
        cue("c2", 2617.9, 2619.5, "I can't even pay-- We're ruined."),
      ],
    })
    expect(rowsFor(plans, "c1")).toEqual(["head", "tail"])
    expect(rowsFor(plans, "c2")).toEqual(["tail"])
  })

  it("lets one row answer for two heard lines that repeat it (39:54)", () => {
    // THE ASYMMETRY. Two audio cues both transcribe "Yes, Rabbi." — overlapping
    // utterances, a crowd answering — against ONE condensed subtitle row.
    // Spending the row on the first cue would leave the second with no line to
    // read, so a row is never used up; only a cue is.
    const plans = planCueLinks({
      textCells: [cue("row", 2393.56, 2394.436, "Yes, Rabbi.")],
      audioCues: [cue("c1", 2393.853, 2394.478, "Yes, Rabbi."), cue("c2", 2394.228, 2394.937, "Yes, Rabbi.")],
    })
    expect(kept(plans).map((p) => p.cueCellId).sort()).toEqual(["c1", "c2"])
  })

  it("honours both rows when the transcript repeats the word (merged echo)", () => {
    // The mirror of 10:53: one cue transcribed with the utterance twice. Its
    // ledger holds `rabbi x 2`, so the second row still has something to
    // explain. Counting word TYPES rather than instances would break this.
    const plans = planCueLinks({
      textCells: [cue("student-1", 653.3, 654.2, "Rabbi."), cue("student-2", 654.2, 655.0, "Rabbi.")],
      audioCues: [cue("c", 653.279, 655.0, "Rabbi. Rabbi.")],
    })
    expect(rowsFor(plans, "c")).toEqual(["student-1", "student-2"])
  })

  it("will not buy a second link with words already spoken for (26:01)", () => {
    // Eden's row DOES share words with the heard line — "hello, love" is in
    // both, which is why it scored 0.67 — but Simon's row supplied every one
    // of them. Sharing words is not the test; supplying unexplained ones is.
    //
    // A row that ALSO happened to carry the leftover "Oh" would survive this,
    // because it would then explain more of the cue than Simon's two words do
    // and be awarded first. That is the same shape as the one echo in episode
    // 306 this pass does not catch (5:16), and every ordering that catches it
    // costs more junk elsewhere — measured, not assumed. See `claimWords`.
    const plans = planCueLinks({
      textCells: [
        cue("simon", 1563.4, 1564.2, "Hello, love."),
        cue("eden", 1564.2, 1565.9, 'Don\'t you "hello, love" me.'),
      ],
      audioCues: [cue("c", 1561.2, 1564.4, "Oh... hello, love.")],
    })
    expect(rowsFor(plans, "c")).toEqual(["simon"])
  })

  it("still pairs a line that is NOTHING BUT an interjection", () => {
    // The guard must not swallow a genuine one. A row whose whole content is
    // "Yes, yes." holds nothing back, so it is the head of a staircase, not a
    // neighbour scavenging a scrap — episode 101's 6:00 line.
    const plans = planCueLinks({
      textCells: [
        cue("head", 360.485, 362.404, "Yes, yes."),
        cue("tail", 362.487, 366.45, "So do your enemies."),
      ],
      audioCues: [cue("c", 360.7, 363.6, "Yes, yes. So do your enemies...")],
    })
    expect(rowsFor(plans, "c")).toEqual(["head", "tail"])
  })

  it("drops a row that ECHOES another character's line (306 43:36)", () => {
    // Simon repeats Nadab's question back at him. Nadab's row overlaps the
    // tail of Simon's cue and shares "soon / expect / a / response" with it —
    // no sliver, no low score. What condemns it is that every word it offers
    // is already accounted for by the row that explains more of the line.
    //
    // ORDERING IS WHAT MAKES THIS WORK. Nadab's shorter row scores 0.86
    // against Simon's 0.70, so awarding by score hands the words to the echo
    // and leaves the real line redundant.
    const chatter = Array.from({ length: 30 }, (_, i) =>
      cue(`pad-${i}`, 100 + i * 4, 103 + i * 4, `You know how we can expect to want a response ${i}.`),
    )
    const plans = planCueLinks({
      textCells: [
        ...chatter,
        cue("nadab", 2610.0, 2613.5, "How soon can we expect a response?"),
        cue("simon", 2616.5, 2619.0, "You want to know how soon to expect a response."),
        cue("simon-2", 2619.0, 2622.0, 'Let me tell you something about that word "soon."'),
      ],
      audioCues: [
        ...chatter,
        cue("c-nadab", 2610.0, 2613.5, "I'm sorry. How soon can we expect a response?"),
        cue(
          "c",
          2616.6,
          2622.0,
          'You wanna know how soon you can expect a response? Let me tell you something about that word "soon".',
        ),
      ],
    })
    expect(rowsFor(plans, "c")).toEqual(["simon", "simon-2"])
  })

  it("leaves cross-script pairings alone — they have no words to claim", () => {
    // Their similarity is structurally zero, so every one of them would
    // contribute the empty set and be thrown away. The timing rule stands.
    const plans = planCueLinks({
      textCells: [
        cue("sub-1", 984, 987, '"Messiah will destroy the Romans"'),
        cue("sub-2", 984, 987, '"Messiah will destroy the Romans"'),
      ],
      audioCues: [cue("cue-1", 984.2, 986.8, "המשיח יהרוס את הרומאים")],
    })
    expect(plans.filter((p) => p.basis === "cross-script")).toHaveLength(2)
    expect(plans.some((p) => p.basis === "redundant")).toBe(false)
  })

  it("gives the same answer however the input is ordered", () => {
    // Claiming is order-dependent by nature, so the ordering has to be a total
    // one derived from the data — never from where a cell sat in the array.
    const texts = [
      cue("simon", 2755.0, 2758.3, "snatch a net during cleanup, but it didn't work."),
      cue("andrew", 2758.4, 2759.9, "Of course, it didn't."),
    ]
    const cues = [cue("c", 2758.0, 2758.9, "Of course, it didn't.")]
    const forward = planCueLinks({ textCells: texts, audioCues: cues })
    const backward = planCueLinks({ textCells: [...texts].reverse(), audioCues: cues })
    const survivors = (p: typeof forward) =>
      p.filter((x) => x.basis !== "redundant").map((x) => x.textCellId).sort()
    expect(survivors(backward)).toEqual(survivors(forward))
  })

  it("does not confuse the two sides when a cue and a row share an id", () => {
    // The app mints UUIDv7 per file so this cannot happen there — but the
    // fixtures in this very file number both sides from zero, and a single
    // id-keyed lookup silently scored every cue against the wrong words.
    const plans = planCueLinks({
      textCells: [cue("c0", 10, 12, "I see him.")],
      audioCues: [cue("c0", 10.1, 11.9, "I see him.")],
    })
    expect(plans.filter((p) => p.basis === "words")).toHaveLength(1)
  })

  it("excludes a redundant pairing from the auto-linkable set", () => {
    const plans = planCueLinks({
      textCells: [cue("student-1", 653.3, 654.2, "Rabbi."), cue("student-2", 654.2, 655.0, "Rabbi.")],
      audioCues: [cue("c", 653.279, 654.28, "Rabbi.")],
    })
    expect(plans).toHaveLength(2)
    expect(autoLinkable(plans).map((p) => p.textCellId)).toEqual(["student-1"])
  })
})

// ── The real episode ─────────────────────────────────────────────────────
const DL = path.join(os.homedir(), "Code", "aquilla-app", "the-chosen-media", "101")
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
  const allPlans = planCueLinks({ textCells: texts, audioCues: cues })
  const plans = allPlans.filter((p) => p.basis !== "redundant")
  const linkedCues = new Set(plans.map((p) => p.cueCellId))
  const linkedTexts = new Set(plans.map((p) => p.textCellId))
  const byId = (side: LinkableCue[]) => new Map(side.map((c) => [c.id, c]))
  const cueById = byId(cues)

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

  // Claiming, measured on the whole episode rather than on miniatures.
  it("drops exactly the five two-speaker pairings and nothing else", () => {
    // These are the five Sam identified from the character spreadsheet, which
    // is the only thing that could have found them: each is a real speaker
    // change that the timing alone made look like one line performed by two
    // people. The list is exact on purpose — a sixth entry means the rule has
    // started eating real links, which is the failure that matters.
    const dropped = allPlans
      .filter((p) => p.basis === "redundant")
      .map((p) => Math.round(cueById.get(p.cueCellId)!.startTime!))
      .sort((a, b) => a - b)
    expect(dropped).toEqual([489, 653, 1561, 1971, 2758])
  })

  it("corrects a file whose own timing grid cannot be read — episode 306", () => {
    // THE REGRESSION THAT COST A WHOLE EPISODE. 306's subtitles are cut fine
    // enough (1019 rows against this episode's 650) that their frame grid
    // scores below the fingerprint's floor, so no correction was planned and
    // nothing was said. It imported drifting: 61% of its heard lines found a
    // subtitle, against 98% everywhere else. Pairing lines by their WORDING
    // measures the drift without needing either grid to be readable.
    const ep306 = path.join(os.homedir(), "Code", "aquilla-app", "the-chosen-media", "306")
    const subs = parseVtt(path.join(ep306, "TheChosen_306_en_SingleSpeaker.vtt"))
    const rawCues = parseVtt(path.join(ep306, "306_audio_timestamps.vtt"))
    const times = (cs: LinkableCue[]) => cs.flatMap((c) => [c.startTime!, c.endTime!])

    const verdict = planTimebaseCorrection({
      cueTimes: times(rawCues),
      referenceTimes: times(subs),
      lastCueSec: Math.max(...rawCues.map((c) => c.endTime!)),
      cueLines: rawCues.map((c) => ({ startTime: c.startTime, original: c.original })),
      referenceLines: subs.map((c) => ({ startTime: c.startTime, original: c.original })),
    })
    assert(verdict.kind === "correct")
    expect(verdict.cue.label).toBe("24")
    expect(verdict.reference.label).toBe("23.976")
    expect(verdict.measured!.anchors).toBeGreaterThan(100)

    const corrected = rawCues.map((c) => ({
      ...c,
      startTime: applyTimebaseScale(c.startTime!, verdict.scale),
      endTime: applyTimebaseScale(c.endTime!, verdict.scale),
    }))
    const linked = (cs: LinkableCue[]) =>
      new Set(
        planCueLinks({ textCells: subs, audioCues: cs })
          .filter((p) => p.basis === "words")
          .map((p) => p.cueCellId),
      ).size / cs.length
    // 61% -> 96%. The uncorrected number is asserted too, because a change
    // that quietly stopped applying the correction would otherwise look fine.
    expect(linked(rawCues)).toBeLessThan(0.7)
    expect(linked(corrected)).toBeGreaterThan(0.95)
  })

  it("costs no cue and no subtitle its last pairing", () => {
    // The one thing claiming must never do. An earlier cut spent the SUBTITLE
    // row as well as the cue, and the two overlapping "Yes, Rabbi." cues at
    // 39:54 — a crowd answering together over one condensed row — lost the
    // second of them outright.
    const survivors = (get: (p: (typeof allPlans)[number]) => string) => ({
      before: new Set(allPlans.map(get)),
      after: new Set(plans.map(get)),
    })
    for (const side of [(p: (typeof allPlans)[number]) => p.cueCellId, (p: (typeof allPlans)[number]) => p.textCellId]) {
      const { before, after } = survivors(side)
      expect([...before].filter((id) => !after.has(id))).toEqual([])
    }
  })

  it("reads the curly apostrophe, which used to cost real matches", () => {
    // 37 of the 548 cues type contractions with U+2019 and every one of their
    // contractions was scoring as a miss. "That's right." against itself scored
    // 0.50. Nothing that a claiming rule counting WORDS could be trusted on
    // top of.
    const curly = cues.filter((c) => (c.original ?? "").includes("’"))
    expect(curly.length).toBeGreaterThan(30)
    const perfect = curly.filter((c) =>
      plans.some((p) => p.cueCellId === c.id && p.confidence === 1),
    )
    expect(perfect.length).toBeGreaterThan(curly.length / 2)
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
