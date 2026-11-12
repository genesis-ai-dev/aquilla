// AQU-1692 — a maintainer's voice corrections, applied to the voice index.
//
// What these tests protect (aquilla-specs 04-features/bible-knowledge-layer.md,
// "Errors in the data"):
//   • a corrected speaker is who the chip names AND who "Show every line by …"
//     finds: the two must never disagree;
//   • the pack's own reading is kept, so the popover can say what was changed;
//   • a correction from another book changes nothing here;
//   • after a pack rebuild moves a speech's boundary, its correction is listed
//     as orphaned instead of silently disappearing;
//   • equal corrections keep the same index object (rows stay memoized), and a
//     changed one gives a new index (no stale chip).

import { describe, expect, it } from "vitest"
import type { BibleVoiceOverrides } from "../../../db/shared/bible-voice-overrides"
import { DISCIPLES, JESUS, SAMARITAN_WOMAN, jhn4Voices } from "./__fixtures__/jhn4"
import { buildVoiceIndex, cellVoicesFor, speaksIn, voiceChipModel, voiceIndexFor } from "./voice-index"
import { PROJECT_SOURCE } from "./voice-overrides"

/** JHN 4:9, "How is it that you, a Jew, ask a drink of me …": the Samaritan woman to Jesus. */
const WOMAN_4_9 = "sp:n43004009008-n43004009018"
const NONE_SHARED: ReadonlySet<string> = new Set()

function correction(fields: { speaker?: string; addressee?: string }) {
  return { ...fields, note: "Our reading.", by: "mara", at: "2026-10-06T12:00:00Z" }
}

describe("a corrected speaker", () => {
  const overrides: BibleVoiceOverrides = { [WOMAN_4_9]: correction({ speaker: DISCIPLES }) }
  const index = buildVoiceIndex(jhn4Voices(), overrides)
  const cell = cellVoicesFor(index, { ref: "JHN 4:9" }, NONE_SHARED)!

  it("is the speaker the chip shows and the one 'Show every line by …' finds", () => {
    const chip = voiceChipModel(index, cell)
    const speech = chip.voices.find((voice) => voice.kind === "speech")
    expect(speech?.kind === "speech" && speech.speech.speaker).toBe(DISCIPLES)
    expect(speaksIn(cell, DISCIPLES)).toBe(true)
    expect(speaksIn(cell, SAMARITAN_WOMAN)).toBe(false)
  })

  it("is sure, cites the project, and keeps the pack's reading beside it", () => {
    const speech = index.speeches.get(WOMAN_4_9)!
    expect(speech.speakerConf).toBe(1)
    expect(speech.speakerSources).toEqual([PROJECT_SOURCE])
    // The addressee was not corrected, so it keeps the pack's evidence.
    expect(speech.addressee).toBe(JESUS)
    expect(speech.addresseeSources).not.toEqual([PROJECT_SOURCE])
    expect(index.overrides.get(WOMAN_4_9)?.original).toEqual({ speaker: SAMARITAN_WOMAN, addressee: JESUS })
  })

  it("leaves the pack's layer as it was", () => {
    const layer = jhn4Voices()
    buildVoiceIndex(layer, overrides)
    expect(layer.speeches.find((speech) => speech.id === WOMAN_4_9)?.speaker).toBe(SAMARITAN_WOMAN)
  })
})

describe("which corrections apply", () => {
  it("ignores another book's correction, and does not call it orphaned", () => {
    const index = buildVoiceIndex(jhn4Voices(), {
      "sp:o080010160001-o080010170052": correction({ speaker: "person:Ruth" }),
    })
    expect(index.overrides.size).toBe(0)
    expect(index.orphanedOverrides).toEqual([])
  })

  it("lists this book's correction whose speech a rebuilt pack no longer has", () => {
    // The speech's last word moved, so its id did too.
    const moved = "sp:n43004009008-n43004009020"
    const index = buildVoiceIndex(jhn4Voices(), { [moved]: correction({ speaker: DISCIPLES }) })
    expect(index.orphanedOverrides).toEqual([moved])
    expect(speaksIn(cellVoicesFor(index, { ref: "JHN 4:9" }, NONE_SHARED)!, SAMARITAN_WOMAN)).toBe(true)
  })
})

describe("memo per (pack version, book, corrections)", () => {
  it("keeps the index for equal corrections in a new object, and rebuilds for a changed one", () => {
    const layer = jhn4Voices()
    const first = voiceIndexFor("1.0.0", layer, { [WOMAN_4_9]: correction({ speaker: DISCIPLES }) })
    // A settings refetch parses a new, equal object.
    expect(voiceIndexFor("1.0.0", layer, { [WOMAN_4_9]: correction({ speaker: DISCIPLES }) })).toBe(first)
    const changed = voiceIndexFor("1.0.0", layer, { [WOMAN_4_9]: correction({ speaker: JESUS }) })
    expect(changed).not.toBe(first)
    expect(changed.speeches.get(WOMAN_4_9)?.speaker).toBe(JESUS)
    // Removing the last correction is a change too.
    expect(voiceIndexFor("1.0.0", layer, {}).speeches.get(WOMAN_4_9)?.speaker).toBe(SAMARITAN_WOMAN)
  })
})
