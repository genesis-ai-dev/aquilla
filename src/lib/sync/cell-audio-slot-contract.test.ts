// AQU-646 stage 3 — the slot contract, ACROSS the client/server boundary.
//
// AGENTS.md rule 12: a synthetic fixture on each side does not cover their
// composition. Three separate things have to agree about what a slot means —
// the read route that emits `selectedBySlot`, the merge that folds it onto a
// cell, and the resolver that turns it back into a chip — and each of them has
// its own tests using its own hand-built shapes. This is the one place a REAL
// route response is carried the whole way through.
//
// It is worth the file because the failure it catches is silent: every layer
// passes its own tests while the composition drops a take, which is exactly
// what happened before `selectedBySlot` existed. The route already returned the
// attachment with its slot intact; nothing downstream could name the selection.

import { describe, expect, it } from "vitest"
import { collapseCellAudioRows } from "../../../sync-worker/src/events/cell-audio-collapse"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { resolveTargetAudio } from "@/lib/audio/track-audio"
import { slotForTrack } from "@/lib/timeline/track-slots"
import type { CellAudioEntry } from "./cell-audio-read-types"
import type { CellData } from "@/hooks/useCells"

const FILE = "f1"
const CELL = "c1"
/** An added track — a real uuidv7, as `handleAddTrack` mints. */
const TRACK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"

/** A take on the DEFAULT track must stay cell-seeded, or the resolver's
 *  source-clip guard rejects it — which is itself part of the contract. */
const DEFAULT_TAKE = `audio-${CELL}-1700000000-def.webm`
const TRACK_TAKE = `audio-${CELL}-1700000001-trk.webm`
const TRACK_OLD = `audio-${CELL}-1700000002-old.webm`

interface Row {
  cell_id: string
  audio_id: string
  slot: string
  url: string
  mime_type: string | null
  voice_id: string | null
  reference_audio_id: string | null
  duration_ms: number | null
  label: string | null
  trim_start_ms: number | null
  trim_end_ms: number | null
  target_offset_ms: number | null
  timings_json: string | null
  selected: number
  created_ts: number
}

const row = (over: Partial<Row> & Pick<Row, "audio_id" | "slot" | "selected">): Row => ({
  cell_id: CELL,
  url: `frontier-audio://${over.audio_id}`,
  mime_type: "audio/webm",
  voice_id: null,
  reference_audio_id: null,
  duration_ms: 1000,
  label: null,
  trim_start_ms: null,
  trim_end_ms: null,
  target_offset_ms: null,
  timings_json: null,
  created_ts: 1,
  ...over,
})

/** THE SERVER'S OWN collapse — the real one the route calls, not a copy. */
function readThroughRoute(rows: Row[]): Record<string, CellAudioEntry> {
  return collapseCellAudioRows(rows) as unknown as Record<string, CellAudioEntry>
}

const bareCell = (): CellData =>
  ({
    id: CELL,
    fileId: FILE,
    original: "",
    translated: "",
    medium: "media",
    startTime: 0,
    endTime: 4,
  }) as CellData

/** Route → merge → the cell a lane would draw from. */
function cellFor(rows: Row[]): CellData {
  const byCellId = new Map(Object.entries(readThroughRoute(rows)))
  return mergeCellsWithAudio([bareCell()], byCellId)[0]
}

describe("a take on an added track survives the whole round trip", () => {
  it("collapse → merge → resolver, on the track's own slot", () => {
    const cell = cellFor([
      row({ audio_id: TRACK_OLD, slot: slotForTrack(TRACK), selected: 0 }),
      row({ audio_id: TRACK_TAKE, slot: slotForTrack(TRACK), selected: 1 }),
    ])
    expect(resolveTargetAudio(cell, slotForTrack(TRACK))).toEqual({
      audioId: TRACK_TAKE,
      url: `frontier-audio://${TRACK_TAKE}`,
      kind: "take",
    })
  })

  // The two tracks are independent all the way down: each names its own take,
  // and neither can see the other's. This is the whole point of the stage.
  it("keeps two tracks' takes on ONE line apart", () => {
    const cell = cellFor([
      row({ audio_id: DEFAULT_TAKE, slot: "recording", selected: 1 }),
      row({ audio_id: TRACK_TAKE, slot: slotForTrack(TRACK), selected: 1 }),
    ])
    expect(resolveTargetAudio(cell)?.audioId).toBe(DEFAULT_TAKE)
    expect(resolveTargetAudio(cell, slotForTrack(TRACK))?.audioId).toBe(TRACK_TAKE)
  })

  // ONE SLOT HOLDS BOTH KINDS on an added track, so the tone has to come off
  // the attachment. `voice_id` is what the server stores for it, and it has to
  // survive the route and the merge to reach the chip.
  it("carries voiceId through, so a generated take on a track draws as one", () => {
    const cell = cellFor([
      row({ audio_id: TRACK_TAKE, slot: slotForTrack(TRACK), selected: 1, voice_id: "v-1" }),
    ])
    expect(resolveTargetAudio(cell, slotForTrack(TRACK))?.kind).toBe("generated")
  })

  // THE REGRESSION THIS FILE EXISTS FOR. Every layer passed its own tests while
  // the composition lost the selection: the route returned the attachment with
  // its slot, and nothing downstream could say which one was active.
  it("does not leak a track's selection into either named pointer", () => {
    const cell = cellFor([
      row({ audio_id: TRACK_TAKE, slot: slotForTrack(TRACK), selected: 1 }),
    ])
    expect(cell.selectedAudioId).toBeUndefined()
    expect(cell.selectedGeneratedVoiceAudioId).toBeUndefined()
    // …and the default track therefore draws nothing on this line, which is
    // correct: the take belongs to the other one.
    expect(resolveTargetAudio(cell)).toBeNull()
  })

  it("leaves the default track's two pointers exactly as they always were", async () => {
    const GEN = `audio-${CELL}-1700000003-gen.wav`
    const cell = cellFor([
      row({ audio_id: DEFAULT_TAKE, slot: "recording", selected: 1 }),
      row({ audio_id: GEN, slot: "generatedVoice", selected: 1, voice_id: "v-9" }),
    ])
    expect(cell.selectedAudioId).toBe(DEFAULT_TAKE)
    expect(cell.selectedGeneratedVoiceAudioId).toBe(GEN)
    // Recorded outranks generated on the default track — unchanged.
    expect(resolveTargetAudio(cell)?.audioId).toBe(DEFAULT_TAKE)
  })
})
