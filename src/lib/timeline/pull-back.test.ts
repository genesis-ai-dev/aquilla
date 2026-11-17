// AQU-2432 (Sam, Nov 6): following the recordings, a take dragged EARLIER,
// over the end of the take before it, so one speaker comes in before the other
// has finished. These pin how the programme READS such a place:
//   - rule 3: the later lines move up — the pause rule run backwards. A take
//     pulled 0.5 s back starts its line 0.5 s earlier; the line before it is
//     0.5 s shorter (its take plays on under this one); every later line moves
//     up 0.5 s;
//   - rule 4: up to the start of the take before it on its track, never past;
//   - rule 6: the pieces of a cut take and the voice tracks too;
//   - and every take with no place of its own following the recordings reads
//     exactly as it did.

import { describe, expect, it } from "vitest"
import { buildProgramme, leadSecForMove, naturalStartSec, pieceLeadSecForMove, pullFloorSec, withoutHiddenTakes } from "./programme"
import { buildTimelineLayout } from "./layout"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"
const MUSIC = "0b9b2d44-1f5e-7f11-9d0e-3c6a2b8d4e10"

type Take = { durationMs?: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs?: number; recordingsOffsetMs?: number }

const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
const trackId = (id: string, slot = TRACK) => `audio-${id}-1700000500-${slot === TRACK ? "track" : "music"}.wav`

/** A timed line with its source clip, a take, and optionally takes on other tracks. */
function line(id: string, startTime: number, endTime: number, take?: Take, others: Record<string, Take> = {}): CellData {
  return {
    id, fileId: "f1", original: id, translated: "", medium: "media", startTime, endTime,
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    ...(Object.keys(others).length > 0 ? { selectedBySlot: Object.fromEntries(Object.keys(others).map((s) => [s, trackId(id, s)])) } : {}),
    attachments: {
      ...(take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {}),
      ...Object.fromEntries(Object.entries(others).map(([s, t]) => [trackId(id, s), { type: "audio", url: `frontier-audio://${s}`, slot: s, ...t }])),
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
  } as unknown as CellData
}

/** Mia's line 4 (a 3 s take) and Lee's line 5 (2 s), then line 6 (1 s); Lee's
 *  take placed `leeMs` from where his line would start. */
const scene = (lee: Take) => [
  line("l4", 0, 3, { durationMs: 3_000 }),
  line("l5", 3, 5, { durationMs: 2_000, ...lee }),
  line("l6", 5, 6, { durationMs: 1_000 }),
]

describe("a take pulled back over the take before it (AQU-2432)", () => {
  it("pulled 0.6 s back: its line starts 0.6 s earlier, the line before it is 0.6 s shorter, the later lines move up 0.6 s", () => {
    const [mia, lee, next] = buildProgramme(scene({ recordingsOffsetMs: -600 })).slots
    expect(lee.startSec).toBeCloseTo(2.4, 5)
    expect(lee.pulledBackSec).toBeCloseTo(0.6, 5)
    expect(lee.targetLeadSec).toBeUndefined() // its take starts its line
    expect(lee.slotLenSec).toBeCloseTo(2, 5)
    expect(mia.slotLenSec).toBeCloseTo(2.4, 5)
    // Mia's original is cut where her line now ends; her take is not.
    expect(mia.sourceLenSec).toBeCloseTo(2.4, 5)
    expect(mia.sourceWindow).toEqual({ start: 0, end: expect.closeTo(2.4, 5) })
    expect(mia.targetLenSec).toBeCloseTo(3, 5)
    expect(next.startSec).toBeCloseTo(4.4, 5)
    expect(naturalStartSec(lee)).toBeCloseTo(3, 5)
  })

  it("no further back than the start of the take before it, whatever is stored", () => {
    const [mia, lee, next] = buildProgramme(scene({ recordingsOffsetMs: -9_000 })).slots
    expect(lee.startSec).toBeCloseTo(0, 5)
    expect(mia.slotLenSec).toBeCloseTo(0, 5)
    // Mia's whole take sounds under Lee's line; line 6 follows Lee's.
    expect(next.startSec).toBeCloseTo(2, 5)
    // …and to the start of Mia's take when it starts into her line.
    const paused = [line("l4", 0, 3, { durationMs: 3_000, recordingsOffsetMs: 400 }), line("l5", 3, 5, { durationMs: 2_000, recordingsOffsetMs: -9_000 })]
    expect(buildProgramme(paused).slots[1].startSec).toBeCloseTo(0.4, 5)
  })

  it("the first line has nothing before it: it never starts before the file does", () => {
    const [first] = buildProgramme([line("l1", 0, 3, { durationMs: 2_000, recordingsOffsetMs: -500 })]).slots
    expect(first.startSec).toBe(0)
    expect(first.pulledBackSec).toBeUndefined()
  })

  it("a nudge under the wobble is the line's own start", () => {
    const [, lee] = buildProgramme(scene({ recordingsOffsetMs: -30 })).slots
    expect(lee.startSec).toBeCloseTo(3, 5)
    expect(lee.pulledBackSec).toBeUndefined()
  })

  it("OLD DATA: a take placed before its line only following the source starts on its line following the recordings, as before", () => {
    const [, lee] = buildProgramme(scene({ targetOffsetMs: -1_000 })).slots
    expect(lee.startSec).toBeCloseTo(3, 5)
    expect(lee.pulledBackSec).toBeUndefined()
  })

  it("three at once: a short take pulled back inside a long one ends before it; the next line starts where the short one's line ends, and the file reaches the long one's end", () => {
    const cells = [
      line("l4", 0, 3, { durationMs: 4_000 }),
      line("l5", 3, 5, { durationMs: 500, recordingsOffsetMs: -2_000 }),
      line("l6", 5, 6, { durationMs: 1_000, recordingsOffsetMs: -1_000 }),
    ]
    const prog = buildProgramme(cells)
    const [mia, lee, ana] = prog.slots
    expect(lee.startSec).toBeCloseTo(2, 5)
    expect(mia.slotLenSec).toBeCloseTo(2, 5)
    // Lee's line would end at 2.5 s; Ana is pulled back 1 s from there, but no
    // further than Lee's take's start: 2 s.
    expect(ana.startSec).toBeCloseTo(2, 5)
    expect(lee.slotLenSec).toBeCloseTo(0, 5)
    // Mia's 4 s take plays on to 4 s, past Ana's line (2–3 s).
    expect(prog.totalSec).toBeCloseTo(4, 5)
  })

  it("the timeline draws each take at its own place: Mia's whole, Lee's from 0.6 s before her end", () => {
    const cells = scene({ recordingsOffsetMs: -600 })
    const layout = buildTimelineLayout("audioFirst", cells, cells)
    const geomOf = (c: CellData) => layout.targetGeom(c, c.attachments?.[takeId(c.id)] as never, takeId(c.id))!
    expect([geomOf(cells[0]).start, geomOf(cells[0]).end]).toEqual([0, expect.closeTo(3, 5)])
    expect([geomOf(cells[1]).start, geomOf(cells[1]).end]).toEqual([expect.closeTo(2.4, 5), expect.closeTo(4.4, 5)])
    // Mia's take is trimmed as the whole of it, though her line now ends at 2.4 s.
    expect(layout.chipSection(cells[0], cells[0].attachments?.[takeId("l4")] as never, takeId("l4"))!.end).toBeCloseTo(3, 5)
    // The text row: Lee's line starts where his take does.
    expect(layout.spanFor(cells[1], "subtitle")!.start).toBeCloseTo(2.4, 5)
  })

  it("the move bounds: Lee's take back to the start of Mia's; none ahead", () => {
    const cells = scene({ recordingsOffsetMs: -600 })
    const layout = buildTimelineLayout("audioFirst", cells, cells)
    expect(layout.moveBounds(cells[1], cells[1].attachments?.[takeId("l5")] as never, takeId("l5"))).toEqual({ floorSec: 0, ceilSec: null })
    expect(buildTimelineLayout("dubbing", cells, cells).moveBounds(cells[1], undefined, takeId("l5"))).toBeNull()
    expect(pullFloorSec(null, null)).toBe(0)
  })

  it("a drop is measured from where the line would start, below it for a take pulled back", () => {
    const [, lee] = buildProgramme(scene({ recordingsOffsetMs: -600 })).slots
    expect(leadSecForMove(lee, 2.4)).toBeCloseTo(-0.6, 5)
    expect(leadSecForMove(lee, 3.5)).toBeCloseTo(0.5, 5)
    expect(leadSecForMove(lee, 2.98)).toBe(0)
  })

  it("a hidden line's take is out of what plays, and out of how far the file reaches", () => {
    const cells = [line("l4", 0, 3, { durationMs: 6_000 }), line("l5", 3, 5, { durationMs: 1_000, recordingsOffsetMs: -5_000 })]
    const prog = buildProgramme(cells)
    expect(prog.totalSec).toBeCloseTo(6, 5)
    expect(withoutHiddenTakes(prog, new Set(["l4"])).totalSec).toBeCloseTo(2, 5)
  })
})

describe("pieces of a cut take (AQU-2432, rule 6)", () => {
  const TAKE = takeId("a")
  const PIECE = "audio-a-1700000900-piece.wav"
  const PIECE3 = "audio-a-1700000950-piece.wav"
  /** A take cut in three: 0–1.5, 2.5–3.7, 3.7–4.0 of its recording. */
  const cut = (second: Take, third: Take = {}) =>
    ({
      ...line("a", 0, 6),
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimEndMs: 1500, recordingsOffsetMs: 0 },
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700, ...second },
        [PIECE3]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 3700, ...third },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    }) as unknown as CellData

  it("a piece pulled 1 s back sounds over the end of the piece in front, both in the take", () => {
    const [slot] = buildProgramme([cut({ recordingsOffsetMs: -1_000 }, { recordingsOffsetMs: 0 })]).slots
    expect(slot.targetPieces!.map((p) => p.atSec)).toEqual([0, expect.closeTo(0.5, 5), expect.closeTo(2.7, 5)])
    expect(slot.targetPieces![1].overlapBeforeSec).toBeCloseTo(1, 5)
    expect(slot.targetPieces![1].gapBeforeSec).toBeUndefined()
    // The third, never moved, sits where the take played straight through puts it.
    expect(slot.targetPieces![2].gapBeforeSec).toBeCloseTo(1, 5)
    expect(slot.targetLenSec).toBeCloseTo(3, 5)
  })

  it("never before the start of the piece in front", () => {
    const [slot] = buildProgramme([cut({ recordingsOffsetMs: -9_000 })]).slots
    expect(slot.targetPieces![1].atSec).toBe(0)
    expect(slot.targetPieces![1].overlapBeforeSec).toBeCloseTo(1.5, 5)
  })

  it("a piece read from its place following the source keeps the old rule: never over the piece in front", () => {
    const [slot] = buildProgramme([cut({ targetOffsetMs: -1_000 })]).slots
    expect(slot.targetPieces![1].atSec).toBeCloseTo(1.5, 5)
    expect(slot.targetPieces![1].overlapBeforeSec).toBeUndefined()
  })

  it("a take ends where its last-ending piece does: a piece inside the one in front ends before it", () => {
    // The second pulled back to the first's start: inside it, ending at 1.2 s
    // where the first ends at 1.5 s. The third at its own place after both.
    const [slot] = buildProgramme([cut({ recordingsOffsetMs: -2_700 }, { recordingsOffsetMs: 0 })]).slots
    const [, second, third] = slot.targetPieces!
    expect(second.atSec).toBe(0)
    expect(third.atSec).toBeCloseTo(2.7, 5)
    expect(slot.targetLenSec).toBeCloseTo(3, 5)
  })

  it("the drop of a piece over the one in front stores its place there", () => {
    const [slot] = buildProgramme([cut({ recordingsOffsetMs: 0 })]).slots
    // Dropped at 0.5 s: 1 s over the end of the first piece; measured back
    // without the 1.5 s before it.
    expect(pieceLeadSecForMove(slot, 1, 0.5)).toBeCloseTo(-1, 5)
    // At the first piece's start, no further.
    expect(pieceLeadSecForMove(slot, 1, -1)).toBeCloseTo(-1.5, 5)
  })
})

describe("on the other tracks (AQU-2432, rule 6)", () => {
  it("a voice take pulled back pulls its line back; the main take stays where it was, a pause into its line", () => {
    const cells = [
      line("l1", 0, 3, { durationMs: 2_000 }, { [TRACK]: { durationMs: 1_000 } }),
      line("l2", 3, 6, { durationMs: 2_000 }, { [TRACK]: { durationMs: 1_000, recordingsOffsetMs: -1_500 } }),
    ]
    const [s1, s2] = buildProgramme(cells, { layerSlots: [TRACK] }).slots
    expect(s2.startSec).toBeCloseTo(0.5, 5)
    expect(s1.slotLenSec).toBeCloseTo(0.5, 5)
    expect(s2.layers![0].atSec).toBe(0)
    expect(s2.targetLeadSec).toBeCloseTo(1.5, 5)
    expect(s2.slotLenSec).toBeCloseTo(3.5, 5)
  })

  it("…no further than the start of the voice take before it", () => {
    const cells = [
      line("l1", 0, 3, { durationMs: 2_000 }, { [TRACK]: { durationMs: 1_000, recordingsOffsetMs: 700 } }),
      line("l2", 3, 6, { durationMs: 2_000 }, { [TRACK]: { durationMs: 1_000, recordingsOffsetMs: -9_000 } }),
    ]
    expect(buildProgramme(cells, { layerSlots: [TRACK] }).slots[1].startSec).toBeCloseTo(0.7, 5)
  })

  it("a take on a track made a layer stays where it was put when its line is pulled back", () => {
    const opts = { layerSlots: [MUSIC], layerTrackSlots: [MUSIC] }
    const still = [line("l1", 0, 3, { durationMs: 2_000 }), line("l2", 3, 6, { durationMs: 2_000 }, { [MUSIC]: { durationMs: 1_000, recordingsOffsetMs: 300 } })]
    const pulled = [still[0], line("l2", 3, 6, { durationMs: 2_000, recordingsOffsetMs: -1_000 }, { [MUSIC]: { durationMs: 1_000, recordingsOffsetMs: 300 } })]
    const at = (cells: CellData[]) => {
      const s = buildProgramme(cells, opts).slots[1]
      return s.startSec + s.layers![0].atSec
    }
    expect(at(still)).toBeCloseTo(2.3, 5)
    expect(at(pulled)).toBeCloseTo(2.3, 5)
  })
})
