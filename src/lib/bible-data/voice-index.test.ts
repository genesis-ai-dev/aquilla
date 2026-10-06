// AQU-1687 — the Voices index: who speaks in each Bible cell.
//
// What these tests protect (aquilla-specs 05-user-stories/see-who-is-speaking.md):
//   • a cell shows its voices in reading order, speaker → addressee, exactly
//     as the pack records them (golden cells from the real JHN 4 data);
//   • a cell with only narration says "Narrator";
//   • a bridge cell gets the union of its verses, and a verse split across
//     cells marks each cell approximate rather than guessing the boundary;
//   • headings and other non-verse cells get no voices;
//   • the chip shortens to "first + N" only when a cell has several speeches,
//     and a self-projected "I tell you that …" is not a second speaker.

import { describe, expect, it } from "vitest"
import { DISCIPLES, JESUS, SAMARITAN_WOMAN, jhn4People, jhn4Voices } from "./__fixtures__/jhn4"
import {
  buildVoiceIndex,
  cellVerses,
  cellVoicesFor,
  firstVerseBook,
  sharedVerseRefs,
  speaksIn,
  voiceChipModel,
  voiceIndexFor,
  voiceSequence,
  type CellVoices,
} from "./voice-index"
import { resolveVoiceLabel } from "./voice-labels"

const index = buildVoiceIndex(jhn4Voices())
const people = jhn4People()
const NONE_SHARED: ReadonlySet<string> = new Set()

/** English names, as an English interface with no project terminology shows them. */
function nameOf(id: string | undefined): string {
  if (!id) return "(unknown)"
  const label = resolveVoiceLabel(id, people.entities[id], {
    mode: "interface",
    interfaceLanguage: { language: "eng", keys: [{ key: "eng", otherScript: false }] },
    projectNames: { concepts: [], sourceLanguage: null, multiLane: false },
  })
  return label?.label ?? "(unknown)"
}

function voicesOf(ref: string, shared: ReadonlySet<string> = NONE_SHARED): CellVoices {
  const cell = cellVoicesFor(index, { ref, type: "text" }, shared)
  if (!cell) throw new Error(`no voices for ${ref}`)
  return cell
}

/** The chip as a reader sees it, e.g. "Narrator · Jesus → Samaritan woman +1". */
function chipText(cell: CellVoices): string {
  const { voices, more } = voiceChipModel(index, cell)
  const parts = voices.map((voice) => {
    if (voice.kind === "narrator") return "Narrator"
    const { speaker, addressee } = voice.speech
    return addressee ? `${nameOf(speaker)} → ${nameOf(addressee)}` : nameOf(speaker)
  })
  return parts.join(" · ") + (more > 0 ? ` +${more}` : "")
}

describe("golden cells from JHN 4", () => {
  it("4:7 — the narrator, then Jesus asking the woman for a drink", () => {
    const cell = voicesOf("JHN 4:7")
    expect(chipText(cell)).toBe("Narrator · Jesus → Samaritan woman")

    const [narration, request] = cell.runs
    expect(narration.speech).toBeNull()
    expect(request.speech).toMatchObject({
      speaker: JESUS,
      addressee: SAMARITAN_WOMAN,
      level: 1,
      type: "Dialogue",
      delivery: "requesting",
      speakerConf: 0.97,
      speakerSources: ["fcbh", "macula"],
    })
    // "Δός μοι πεῖν" is the whole quotation: it opens and closes in this verse.
    expect(request).toMatchObject({ opens: true, closes: true })
  })

  it("4:8 — narration only (the disciples' errand is an aside)", () => {
    const cell = voicesOf("JHN 4:8")
    expect(chipText(cell)).toBe("Narrator")
    expect(cell.runs.every((run) => run.speech === null)).toBe(true)
  })

  it("4:9 — the woman's question opens and closes inside the cell, before the narrator's aside", () => {
    const cell = voicesOf("JHN 4:9")
    expect(chipText(cell)).toBe("Narrator · Samaritan woman → Jesus · Narrator")

    const [lead, question, aside] = cell.runs
    expect(lead.speech).toBeNull()
    expect(question.speech).toMatchObject({ speaker: SAMARITAN_WOMAN, addressee: JESUS, level: 1 })
    expect(question).toMatchObject({ opens: true, closes: true })
    expect(aside.speech).toBeNull()
  })

  it("4:10 — Jesus' reply (level 1) quotes his own request inside it (level 2)", () => {
    const cell = voicesOf("JHN 4:10")
    const speeches = cell.runs.flatMap((run) => (run.speech ? [run.speech] : []))
    const reply = speeches.find((speech) => speech.level === 1)
    const quoted = speeches.find((speech) => speech.level === 2)

    expect(reply).toMatchObject({ speaker: JESUS, addressee: SAMARITAN_WOMAN })
    expect(quoted).toMatchObject({ speaker: JESUS, parent: reply?.id })
    // The level-2 quotation ("Give me a drink") opens and closes inside the cell.
    const quotedRun = cell.runs.find((run) => run.speech === quoted)
    expect(quotedRun).toMatchObject({ opens: true, closes: true })
    // The reply resumes after it and closes at the end of the verse.
    expect(cell.runs.at(-1)).toMatchObject({ speech: reply, opens: false, closes: true })

    // Two speeches: the chip shows the first and counts the other.
    expect(chipText(cell)).toBe("Narrator · Jesus → Samaritan woman +1")
  })

  it("4:12 — a speech that continues from the previous cell shows without the narrator", () => {
    expect(chipText(voicesOf("JHN 4:12"))).toBe("Samaritan woman → Jesus")
  })
})

describe("self-projected speech", () => {
  it("shows as the speech around it, not as a second voice (4:35, 'I tell you …')", () => {
    const cell = voicesOf("JHN 4:35")
    // The pack has a self-projected speech in this verse...
    expect(cell.runs.some((run) => run.speech?.selfProjected)).toBe(true)
    // ...but the reader sees Jesus speaking, quoting the disciples' saying.
    const sequence = voiceSequence(index, cell)
    expect(sequence.map((voice) => (voice.kind === "speech" ? nameOf(voice.speech.speaker) : "Narrator"))).toEqual([
      "Jesus",
      "disciples",
      "Jesus",
    ])
    expect(chipText(cell)).toBe("Jesus → disciples +1")
  })
})

describe("mapping cells to verses", () => {
  it("gives a bridge cell the union of its verses, in reading order", () => {
    const bridge = voicesOf("JHN 4:7-8")
    expect(bridge.refs).toEqual(["JHN 4:7", "JHN 4:8"])
    expect(bridge.runs).toEqual([...voicesOf("JHN 4:7").runs, ...voicesOf("JHN 4:8").runs])
    expect(chipText(bridge)).toBe("Narrator · Jesus → Samaritan woman · Narrator")
    expect(bridge.approximate).toBe(false)
  })

  it("marks every cell of a split verse approximate, each with the whole verse's voices", () => {
    const cells = [
      { ref: "JHN 4:8", type: "text" },
      { ref: "JHN 4:9", type: "text" },
      { ref: "JHN 4:9", type: "text" },
      { ref: "JHN 4:10", type: "text" },
    ]
    const shared = sharedVerseRefs(cells)
    expect([...shared]).toEqual(["JHN 4:9"])

    const part = voicesOf("JHN 4:9", shared)
    expect(part.approximate).toBe(true)
    expect(chipText(part)).toBe("Narrator · Samaritan woman → Jesus · Narrator")
    expect(voicesOf("JHN 4:10", shared).approximate).toBe(false)
  })

  it("marks a lettered part of a verse approximate even with no sibling cell", () => {
    expect(voicesOf("JHN 4:9a").approximate).toBe(true)
    expect(cellVerses({ ref: "JHN 4:9a-10b" })).toEqual({ book: "JHN", refs: ["JHN 4:9", "JHN 4:10"], partial: true })
  })

  it("gives headings, titles and other non-verse cells nothing", () => {
    expect(cellVoicesFor(index, { ref: "JHN 4:7", type: "heading" }, NONE_SHARED)).toBeNull()
    expect(cellVoicesFor(index, { ref: "JHN 4:7", type: "paratext" }, NONE_SHARED)).toBeNull()
    expect(cellVoicesFor(index, { ref: "JHN 4:s:1", type: "text" }, NONE_SHARED)).toBeNull()
    expect(cellVoicesFor(index, { ref: "JHN 4", type: "text" }, NONE_SHARED)).toBeNull()
    expect(cellVoicesFor(index, { ref: "", type: "text" }, NONE_SHARED)).toBeNull()
  })

  it("gives nothing for another book or a verse the pack lacks", () => {
    expect(cellVoicesFor(index, { ref: "MRK 4:7", type: "text" }, NONE_SHARED)).toBeNull()
    expect(cellVoicesFor(index, { ref: "JHN 4:99", type: "text" }, NONE_SHARED)).toBeNull()
  })

  it("finds the file's book from its first verse cell", () => {
    expect(firstVerseBook([{ ref: "JHN:mt:1", type: "paratext" }, { ref: "JHN 4:1", type: "text" }])).toBe("JHN")
    expect(firstVerseBook([{ ref: "intro", type: "text" }])).toBeNull()
  })
})

describe("who speaks in a cell", () => {
  it("counts quoted speech as speaking, for 'Show every line by …'", () => {
    expect(speaksIn(voicesOf("JHN 4:10"), JESUS)).toBe(true)
    expect(speaksIn(voicesOf("JHN 4:10"), SAMARITAN_WOMAN)).toBe(false)
    expect(speaksIn(voicesOf("JHN 4:9"), SAMARITAN_WOMAN)).toBe(true)
    expect(speaksIn(voicesOf("JHN 4:35"), DISCIPLES)).toBe(true)
    expect(speaksIn(voicesOf("JHN 4:8"), JESUS)).toBe(false)
  })
})

describe("memo per (pack version, book)", () => {
  it("builds once per version and book, and never answers a new file with an old index", () => {
    const layer = jhn4Voices()
    const first = voiceIndexFor("1.0.0", layer)
    expect(voiceIndexFor("1.0.0", layer)).toBe(first)
    expect(voiceIndexFor("1.0.1", layer)).not.toBe(first)
    // Same version and book, different file object (a refetch): rebuilt.
    expect(voiceIndexFor("1.0.0", jhn4Voices())).not.toBe(first)
  })
})
