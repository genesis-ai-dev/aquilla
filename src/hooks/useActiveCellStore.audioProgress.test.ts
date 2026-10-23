// AQU-2110 — the navigation rollup's audio figures, at the level the bug
// escaped: a chapter on an audio-only project read "100% translated / 0%
// validated" however many of its takes were signed off, because the rollup
// derived `validated` from the projected TEXT flag and consulted audio
// validation nowhere. These drive the real `audioProgressCellIds` derivation
// over the real attachment shape into the store, the way the workspace does.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { audioProgressCellIds } from "@/lib/progress/audio-progress-cells"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string, canonicalRef: string): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    metadata: null,
  }
}

/**
 * Two chapters of a Scripture file: GEN 1 with ten lines (c1…c10), GEN 2 with
 * five (d1…d5). `text` names the cells that carry target text; everything
 * else has an empty target row, which is what an audio-only project's cells
 * look like.
 */
function twoChapters(text: ReadonlySet<string> = new Set()): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 1; n <= 10; n++) {
    const id = `c${n}`
    rows.push(row(id, "source", `Source ${n}`, `GEN 1:${n}`))
    rows.push(row(id, "target", text.has(id) ? `Draft ${n}` : "", `GEN 1:${n}`))
  }
  for (let n = 1; n <= 5; n++) {
    const id = `d${n}`
    rows.push(row(id, "source", `Source ${n}`, `GEN 2:${n}`))
    rows.push(row(id, "target", text.has(id) ? `Draft ${n}` : "", `GEN 2:${n}`))
  }
  return rows
}

function take(seed: string, slot: string, validatorCount: number, suffix = "abc"): AudioAttachmentOut {
  const audioId = `audio-${seed}-1700000000000-${suffix}`
  return {
    audioId,
    url: `frontier-audio://${audioId}.webm`,
    slot,
    mimeType: "audio/webm",
    voiceId: null,
    referenceAudioId: null,
    durationMs: 1000,
    trimStartMs: null,
    trimEndMs: null,
    role: "dub",
    validatorCount,
    validators: [],
    recordedBy: "tester",
  }
}

function entry(takes: AudioAttachmentOut[]): CellAudioEntry {
  const selectedBySlot = Object.fromEntries(takes.map((t) => [t.slot, t.audioId]))
  return {
    attachments: Object.fromEntries(takes.map((t) => [t.audioId, t])),
    selectedBySlot,
    selectedAudioId: selectedBySlot.recording ?? null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
}

/** Chapter 1 fully recorded; `votes(cellId)` says how many validated each take. */
function chapterOneRecorded(votes: (cellId: string) => number): Map<string, CellAudioEntry> {
  const map = new Map<string, CellAudioEntry>()
  for (let n = 1; n <= 10; n++) {
    const id = `c${n}`
    map.set(id, entry([take(id, "recording", votes(id))]))
  }
  return map
}

function store(requiredValidations = 1): CellStore {
  const s = new CellStore()
  s.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations, auditStats: new Map() })
  return s
}

/** Feed the store exactly as the workspace does: own takes, then the audio pair. */
function feedAudio(s: CellStore, audio: Map<string, CellAudioEntry>, requirement: number) {
  const ids = audioProgressCellIds(audio, requirement)
  s.setOwnTakeCellIds(ids.recorded)
  s.setAudioProgressCellIds(ids)
  return ids
}

const figures = (s: CellStore) => s.getNavigationIndex().map((chapter) => ({
  key: chapter.key,
  total: chapter.total,
  translated: chapter.translated,
  validated: chapter.validated,
  textTranslated: chapter.textTranslated,
  audioRecorded: chapter.audioRecorded,
  audioValidated: chapter.audioValidated,
}))

describe("AQU-2110 — the navigation rollup counts audio validation", () => {
  it("reads a fully recorded and validated chapter as 100% audio validated while its text figures stay at 0", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)

    const [one, two] = figures(s)
    // The figure that used to sit at 0% however many takes were validated.
    expect(one).toMatchObject({ total: 10, audioRecorded: 10, audioValidated: 10 })
    // Text validation is a different question and still has no answer here;
    // `translated` keeps counting the take (AQU-646) while text alone is 0,
    // which is what tells the picker this file is audio-only.
    expect(one).toMatchObject({ validated: 0, textTranslated: 0, translated: 10 })
    expect(two).toMatchObject({ total: 5, audioRecorded: 0, audioValidated: 0, translated: 0, validated: 0 })
  })

  it("reads a partly validated chapter as its own line count, never rounded up", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded((id) => (["c1", "c2", "c3"].includes(id) ? 1 : 0)), 1)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 3, total: 10 })
  })

  it("moves the chapter's figure when a take is validated or un-validated, without rebuilding the file", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    const snapshot = s.getFileProgressSnapshot()
    const before = s.getNavigationIndex()
    const version = s.getAllVersion()
    expect(before[0].audioValidated).toBe(10)

    // One vote withdrawn — a fresh read of the same file.
    feedAudio(s, chapterOneRecorded((id) => (id === "c7" ? 0 : 1)), 1)
    expect(s.getNavigationIndex()).not.toBe(before)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 9 })
    // Whole-file subscribers were woken; the file-progress snapshot (text
    // counts) was neither rebuilt nor touched.
    expect(s.getAllVersion()).toBeGreaterThan(version)
    expect(s.getFileProgressSnapshot()).toBe(snapshot)

    // ...and the vote back.
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    expect(figures(s)[0]).toMatchObject({ audioValidated: 10 })
  })

  it("holds a chapter below validated when the requirement is 2 and each take has one vote", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 2)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 0 })

    feedAudio(s, chapterOneRecorded(() => 2), 2)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 10 })
  })

  it("counts a line with chosen takes on two tracks only once BOTH meet the requirement", () => {
    const s = store()
    s.replaceRows(twoChapters())
    const audio = chapterOneRecorded(() => 1)
    audio.set("c1", entry([take("c1", "recording", 1, "aaa"), take("c1", "track-2", 0, "bbb")]))
    feedAudio(s, audio, 1)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 9 })

    audio.set("c1", entry([take("c1", "recording", 1, "aaa"), take("c1", "track-2", 1, "bbb")]))
    feedAudio(s, new Map(audio), 1)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 10 })
  })

  it("leaves a text-only file's figures exactly as they were, with no audio counted", () => {
    const text = new Set(["c1", "c2", "c3", "c4", "d1"])
    const s = store()
    s.replaceRows(twoChapters(text))
    feedAudio(s, new Map(), 1)
    const [one, two] = figures(s)
    expect(one).toMatchObject({ total: 10, translated: 4, textTranslated: 4, validated: 0, audioRecorded: 0, audioValidated: 0 })
    expect(two).toMatchObject({ total: 5, translated: 1, textTranslated: 1, audioRecorded: 0, audioValidated: 0 })

    // Byte-identical to a store that was never told about audio at all.
    const untouched = store()
    untouched.replaceRows(twoChapters(text))
    expect(s.getNavigationIndex()).toEqual(untouched.getNavigationIndex())
  })

  it("reports both pairs on a file that has target text and takes", () => {
    const text = new Set(["c1", "c2", "c3", "c4", "c5", "c6"])
    const s = store()
    s.replaceRows(twoChapters(text))
    // Lines 4…10 recorded and validated: three of them also carry text.
    const audio = new Map<string, CellAudioEntry>()
    for (let n = 4; n <= 10; n++) audio.set(`c${n}`, entry([take(`c${n}`, "recording", 1)]))
    feedAudio(s, audio, 1)
    expect(figures(s)[0]).toMatchObject({
      total: 10,
      textTranslated: 6,
      // Text OR a take of the line's own, as before this change.
      translated: 10,
      validated: 0,
      audioRecorded: 7,
      audioValidated: 7,
    })
  })

  it("keeps text-alone moving on an optimistic edit to a recorded line, where `translated` holds still", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    s.getNavigationIndex()
    expect(figures(s)[0]).toMatchObject({ translated: 10, textTranslated: 0 })

    // The first word typed on an audio-only file: the incremental path patches
    // the index in place rather than rebuilding it.
    s.applyOptimisticTargetEdit("c3", { value: "A first word" })
    expect(figures(s)[0]).toMatchObject({ translated: 10, textTranslated: 1, audioRecorded: 10, audioValidated: 10 })

    // And it agrees with a store built cold from the same rows and audio.
    const cold = store()
    cold.replaceRows(twoChapters(new Set(["c3"])))
    feedAudio(cold, chapterOneRecorded(() => 1), 1)
    expect(figures(s)).toEqual(figures(cold))

    // Clearing the word takes text-alone back to 0 and leaves the take's credit.
    s.applyOptimisticTargetEdit("c3", { value: "" })
    expect(figures(s)[0]).toMatchObject({ translated: 10, textTranslated: 0 })
  })

  it("a refetch that changed nothing is a no-op for subscribers", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    const index = s.getNavigationIndex()
    const version = s.getAllVersion()
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    expect(s.getNavigationIndex()).toBe(index)
    expect(s.getAllVersion()).toBe(version)
  })

  it("subtracts structural cells from the audio figures as it does from the text ones", () => {
    const s = store()
    const rows = twoChapters()
    // Line c1 becomes a voiced chapter heading.
    for (const r of rows) if (r.cellId === "c1") r.type = "heading"
    s.replaceRows(rows)
    s.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map(), countStructural: false })
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    expect(figures(s)[0]).toMatchObject({ total: 9, audioRecorded: 9, audioValidated: 9 })
  })
})

describe("AQU-2132 — the audio sets belong to the file that was read", () => {
  it("drops the previous file's recorded and audio-validated lines on a file switch", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)
    expect(figures(s)[0]).toMatchObject({ audioRecorded: 10, audioValidated: 10 })

    // Open a DIFFERENT file whose cells happen to carry the same ids — the
    // coincidence that makes the leak visible rather than merely latent. Its
    // own attachment read has not landed yet, so nothing in it is recorded.
    s.reset("p", "file-b")
    s.replaceRows(twoChapters())
    expect(figures(s)[0]).toMatchObject({ translated: 0, audioRecorded: 0, audioValidated: 0 })
  })

  it("keeps them across a full re-read of the SAME file, so a refetch cannot blank the figures", () => {
    const s = store()
    s.replaceRows(twoChapters())
    feedAudio(s, chapterOneRecorded(() => 1), 1)

    // `reset()` also runs on every full re-read of the open file, where the
    // hand-off has nothing new to re-assert: clearing there would leave the
    // footer, the chapter picker and the sidebar chapter grid on text figures.
    s.reset("p", "f")
    s.replaceRows(twoChapters())
    expect(figures(s)[0]).toMatchObject({ translated: 10, audioRecorded: 10, audioValidated: 10 })
  })
})
