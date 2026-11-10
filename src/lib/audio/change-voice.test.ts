import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"

const convertToLibraryVoice = vi.fn()
const emitCellAudioAttach = vi.fn()
const injectOptimisticAudioAttachment = vi.fn()
const convertElevenLabsSpeech = vi.fn()
vi.mock("./voice-clone", () => ({ convertToLibraryVoice: (...a: unknown[]) => convertToLibraryVoice(...a) }))
vi.mock("@/lib/sync/elevenlabs", () => ({ convertElevenLabsSpeech: (...a: unknown[]) => convertElevenLabsSpeech(...a) }))
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: (...a: unknown[]) => emitCellAudioAttach(...a) }))
vi.mock("./audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: (...a: unknown[]) => injectOptimisticAudioAttachment(...a),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 2400) }))
vi.mock("./upload", async (orig) => ({
  ...(await orig<typeof import("./upload")>()),
  fetchCellAudio: vi.fn(async () => new Uint8Array([1, 2, 3])),
}))

const {
  changeCellVoice,
  changeVoiceBlocker,
  changeVoiceForCell,
  changeVoiceLabel,
  changeVoiceSourceTake,
  generateSlotOverVoiceChange,
  isVoiceChangedAudioId,
  originalTakeId,
  recordingLinesOf,
  recordingSharedBy,
  voiceChangedWithReference,
  voiceConversionKey,
  voiceReferenceFingerprint,
} = await import("./change-voice")
const { getTtsStatus, ttsStatusKey } = await import("./tts")

const session = { jwt: "jwt", username: "dev", createdAt: "" } as FrontierSession
const stock: Voice = { id: "preset-narrator", name: "Stock" } as Voice
const hearth: Voice = { id: "v-hearth", name: "Hearth", libraryVoiceId: "narrator-hearth" } as Voice
/** A trained custom voice: its model id is `c-<hex>`. */
const anna: Voice = { id: "v-anna", name: "Anna", libraryVoiceId: "c-0a1b2c3d" } as Voice
/** What the worker stamps for `hearth` (`library:narrator-hearth`). */
const HEARTH_FP = "78d70b3a"

function att(over: Partial<CodexCellAttachment> = {}): CodexCellAttachment {
  return { url: "frontier-audio://x.webm", type: "audio", ...over }
}

function cell(over: Partial<CellData> = {}): CellData {
  return {
    id: "GEN 1:1",
    fileId: "f1",
    selectedAudioId: "audio-GEN_1_1-1-abc.webm",
    attachments: {
      "audio-GEN_1_1-1-abc.webm": att({ slot: "recording", label: "Take 1", url: "frontier-audio://audio-GEN_1_1-1-abc.webm" }),
    },
    ...over,
  } as CellData
}

beforeEach(() => {
  convertToLibraryVoice.mockReset()
  emitCellAudioAttach.mockReset().mockResolvedValue("evt-1")
  injectOptimisticAudioAttachment.mockReset()
})

describe("reference fingerprint", () => {
  // Same values asserted in sync-worker/src/__tests__/voice-convert.test.ts —
  // the worker stamps this into the id and the client reads it back.
  it("matches the worker's FNV-1a", () => {
    expect(voiceReferenceFingerprint("ref1.wav")).toBe("a8dcd319")
    expect(voiceReferenceFingerprint("library:narrator-hearth")).toBe(HEARTH_FP)
  })

  it("reads a worker-named conversion back to the library voice it was made with", () => {
    const workerId = `vc-${HEARTH_FP}-audio-GEN_1_1-1759460000000-1a2b3c4d.wav`
    expect(voiceChangedWithReference(workerId, "library:narrator-hearth")).toBe(true)
    expect(voiceChangedWithReference(workerId, "library:c-0a1b2c3d")).toBe(false)
  })

  it("still reads legacy `-q<steps>-` conversions as voice-changed takes", () => {
    const legacy = `vc-${HEARTH_FP}-q25-audio-GEN_1_1-1759460000000-1a2b3c4d.wav`
    expect(isVoiceChangedAudioId(legacy)).toBe(true)
    expect(voiceChangedWithReference(legacy, "library:narrator-hearth")).toBe(true)
    expect(isVoiceChangedAudioId("audio-GEN_1_1-1-abc.webm")).toBe(false)
  })
})

describe("changeVoiceSourceTake", () => {
  it("prefers the selected recording and reports its slot", () => {
    const take = changeVoiceSourceTake(cell({
      selectedGeneratedVoiceAudioId: "g.wav",
      attachments: {
        "audio-GEN_1_1-1-abc.webm": att({ slot: "recording" }),
        "g.wav": att({ slot: "generatedVoice", voiceId: "v" }),
      },
    }))
    expect(take).toMatchObject({ audioId: "audio-GEN_1_1-1-abc.webm", slot: "recording" })
  })

  it("never picks the imported programme clip; falls through to the generated voice", () => {
    const take = changeVoiceSourceTake(cell({
      medium: "media",
      selectedAudioId: "audio-FILE1-1-src.mp3",
      selectedGeneratedVoiceAudioId: "g.wav",
      attachments: {
        "audio-FILE1-1-src.mp3": att({ slot: "recording", role: "source" }),
        "g.wav": att({ slot: "generatedVoice" }),
      },
    } as Partial<CellData>))
    expect(take).toMatchObject({ audioId: "g.wav", slot: "generatedVoice" })
  })

  it("returns null when the cell has no take", () => {
    expect(changeVoiceSourceTake(cell({ selectedAudioId: undefined, attachments: {} }))).toBeNull()
  })
})

// AQU-2499 (review, Nov 9): Change voice on an added track's take, or on the
// take open in the Station, re-voiced the main track's take instead.
describe("changeVoiceSourceTake on a take the person picked", () => {
  const MAIN = "audio-GEN_1_1-1-abc.webm"
  const ADDED = "audio-GEN_1_1-2-added.webm"
  const TRACK = "0199aaaa-track"
  const withAdded = (over: Partial<CellData> = {}) => cell({
    selectedBySlot: { recording: MAIN, [TRACK]: ADDED },
    attachments: {
      [MAIN]: att({ slot: "recording", label: "Take 1", url: `frontier-audio://${MAIN}` }),
      [ADDED]: att({ slot: TRACK, label: "Take 1", url: `frontier-audio://${ADDED}` }),
    },
    ...over,
  })

  it("acts on the added track's take, in its own track", () => {
    expect(changeVoiceSourceTake(withAdded(), ADDED)).toMatchObject({ audioId: ADDED, slot: TRACK })
    // The line-wide pick is still the main track's.
    expect(changeVoiceSourceTake(withAdded())).toMatchObject({ audioId: MAIN, slot: "recording" })
  })

  it("finds an added track's take when the main track is empty", () => {
    const c = withAdded({
      selectedAudioId: undefined,
      selectedBySlot: { [TRACK]: ADDED },
      attachments: { [ADDED]: att({ slot: TRACK, url: `frontier-audio://${ADDED}` }) },
    })
    expect(changeVoiceSourceTake(c)).toBeNull()
    expect(changeVoiceSourceTake(c, ADDED)).toMatchObject({ audioId: ADDED, slot: TRACK })
  })

  it("acts on an older version open in the Station, not the one playing", () => {
    const OLD = "audio-GEN_1_1-0-old.webm"
    const c = withAdded()
    c.attachments![OLD] = att({ slot: "recording", label: "Take 0", url: `frontier-audio://${OLD}` })
    expect(changeVoiceSourceTake(c, OLD)).toMatchObject({ audioId: OLD, slot: "recording" })
  })

  it("reads a piece of a cut take as the whole take playing in its track", () => {
    const PIECE = "audio-GEN_1_1-3-piece.webm"
    const c = withAdded()
    c.attachments![PIECE] = att({ slot: TRACK, url: `frontier-audio://${ADDED}`, pieceOf: ADDED })
    expect(changeVoiceSourceTake(c, PIECE)).toMatchObject({ audioId: ADDED, slot: TRACK })
    // A cut take already in this voice reads as done from either piece.
    const vc = `vc-${HEARTH_FP}-audio-GEN_1_1-4-z.wav`
    const done = withAdded({ selectedBySlot: { recording: MAIN, [TRACK]: vc } })
    done.attachments![vc] = att({ slot: TRACK, voiceId: "v-hearth", url: `frontier-audio://${vc}` })
    done.attachments![PIECE] = att({ slot: TRACK, voiceId: "v-hearth", url: `frontier-audio://${vc}`, pieceOf: vc })
    expect(changeVoiceBlocker(done, hearth, PIECE)).toBe("up-to-date")
  })

  it("says the picked take is up to date, whatever the main track holds", () => {
    const vc = `vc-${HEARTH_FP}-audio-GEN_1_1-4-z.wav`
    const c = withAdded({ selectedBySlot: { recording: MAIN, [TRACK]: vc } })
    c.attachments![vc] = att({ slot: TRACK, voiceId: "v-hearth", url: `frontier-audio://${vc}` })
    expect(changeVoiceBlocker(c, hearth, vc)).toBe("up-to-date")
    expect(changeVoiceBlocker(c, hearth)).toBeNull()
  })

  it("has nothing to convert on a deleted take or the imported programme clip", () => {
    const c = withAdded()
    c.attachments![ADDED] = { ...c.attachments![ADDED], isDeleted: true }
    expect(changeVoiceSourceTake(c, ADDED)).toBeNull()
    const SRC = "audio-FILE1-1-src.mp3"
    const media = cell({
      medium: "media",
      selectedAudioId: SRC,
      attachments: { [SRC]: att({ slot: "recording", role: "source" }) },
    } as Partial<CellData>)
    expect(changeVoiceSourceTake(media, SRC)).toBeNull()
  })

  it("converts the added track's take and lands the new take on that track", async () => {
    convertToLibraryVoice.mockResolvedValue({
      audioId: `vc-${HEARTH_FP}-audio-GEN_1_1-9-q`, ext: "wav", url: `frontier-audio://vc-${HEARTH_FP}-audio-GEN_1_1-9-q.wav`, bytes: 3,
    })
    await changeVoiceForCell({ projectId: "p1", cell: withAdded(), voice: hearth, session, author: "dev", audioId: ADDED })
    expect(convertToLibraryVoice.mock.calls[0][0]).toMatchObject({ sourceAudioId: ADDED })
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({ slot: TRACK, referenceAudioId: ADDED }))
    expect(injectOptimisticAudioAttachment).toHaveBeenCalledWith("f1", "GEN 1:1", expect.objectContaining({ slot: TRACK }), "evt-1")
  })
})

describe("generateSlotOverVoiceChange", () => {
  it("lands a later synthesis in the converted take's slot so it becomes the one that sounds", () => {
    expect(generateSlotOverVoiceChange(cell({
      selectedAudioId: "vc-a8dcd319-q25-audio-GEN_1_1-1-abcd.wav",
      attachments: {
        "vc-a8dcd319-q25-audio-GEN_1_1-1-abcd.wav": att({ slot: "recording" }),
      },
    }))).toBe("recording")
  })

  it("leaves a real recording in place", () => {
    expect(generateSlotOverVoiceChange(cell({
      attachments: { "audio-GEN_1_1-1-abc.webm": att({ slot: "recording" }) },
    }))).toBeUndefined()
  })

  it("is unset when the line has no take", () => {
    expect(generateSlotOverVoiceChange(cell({ selectedAudioId: undefined, attachments: {} }))).toBeUndefined()
  })
})

describe("originalTakeId", () => {
  it("walks back through earlier conversions to the original take", () => {
    const attachments = {
      "rec.webm": att(),
      "vc-aaaaaaaa-audio-c-1-x.wav": att({ referenceAudioId: "rec.webm" }),
      "vc-bbbbbbbb-audio-c-2-y.wav": att({ referenceAudioId: "vc-aaaaaaaa-audio-c-1-x.wav" }),
    }
    expect(originalTakeId(attachments, "vc-bbbbbbbb-audio-c-2-y.wav")).toBe("rec.webm")
  })

  it("does not walk past a denoised or ordinary take", () => {
    const attachments = { "dn-audio-c-1-x.webm": att({ referenceAudioId: "rec.webm" }), "rec.webm": att() }
    expect(originalTakeId(attachments, "dn-audio-c-1-x.webm")).toBe("dn-audio-c-1-x.webm")
  })

  it("stops at the last take still present when the original was deleted", () => {
    const attachments = {
      "rec.webm": att({ isDeleted: true }),
      "vc-aaaaaaaa-audio-c-1-x.wav": att({ referenceAudioId: "rec.webm" }),
    }
    expect(originalTakeId(attachments, "vc-aaaaaaaa-audio-c-1-x.wav")).toBe("vc-aaaaaaaa-audio-c-1-x.wav")
  })
})

describe("changeVoiceBlocker", () => {
  it("needs a take, and a character or trained voice", () => {
    expect(changeVoiceBlocker(cell({ selectedAudioId: undefined, attachments: {} }), hearth)).toBe("no-take")
    expect(changeVoiceBlocker(cell(), stock)).toBe("not-trained")
    expect(changeVoiceBlocker(cell(), hearth)).toBeNull()
    expect(changeVoiceBlocker(cell(), anna)).toBeNull()
  })

  it("blocks an Inworld quick clone: it reads text but cannot re-voice a take", () => {
    // Instant clones synthesize from text (Inworld voices:clone); only character,
    // trained and ElevenLabs voices convert speech to speech.
    const quickClone = { ...stock, id: "v-clone", provider: "inworld", referenceAudioId: "ref1.wav" } as Voice
    expect(changeVoiceBlocker(cell(), quickClone)).toBe("not-trained")
    expect(voiceConversionKey(quickClone)).toBeNull()
    // …and so is a pre-AQU-2291 Gemini clone, whose clip is now ignored.
    const legacyClone = { ...stock, id: "v-old", provider: "gemini", referenceAudioId: "ref1.wav" } as Voice
    expect(changeVoiceBlocker(cell(), legacyClone)).toBe("not-trained")
  })

  it("is up to date only when the selected take is already in THIS voice", () => {
    const converted = `vc-${HEARTH_FP}-audio-GEN_1_1-2-z.wav`
    const c = cell({
      selectedAudioId: converted,
      attachments: { [converted]: att({ slot: "recording", voiceId: "v-hearth", referenceAudioId: "rec.webm" }) },
    })
    expect(changeVoiceBlocker(c, hearth)).toBe("up-to-date")
    expect(changeVoiceBlocker(c, anna)).toBeNull()
    // A legacy `-q` id in the same voice is just as done.
    const legacy = `vc-${HEARTH_FP}-q40-audio-GEN_1_1-3-z.wav`
    expect(changeVoiceBlocker(cell({
      selectedAudioId: legacy,
      attachments: { [legacy]: att({ slot: "recording", voiceId: "v-hearth" }) },
    }), hearth)).toBe("up-to-date")
  })
})

// AQU-2499 (review, Nov 9): Change voice converts the whole stored recording
// a take plays. When other lines play that recording too (a chapter uploaded
// as one file and put on each verse, a Station version saved over several
// lines), it converted all of it once per line, each one paid, and every line
// then played the whole thing. It is refused there; the pieces of a cut take
// on one line are one line's recording and still convert.
describe("a recording shared by several lines", () => {
  const OBJECT = "audio-GEN_1_1-1-range.mp3"
  const URL = `frontier-audio://${OBJECT}`
  /** Bulk upload's range shape: the first line's take is the object, every
   *  other line's take its own id over the same url. */
  const verse = (n: number) => {
    const id = n === 1 ? OBJECT : `audio-GEN_1_${n}-1-range.mp3`
    return cell({ id: `GEN 1:${n}`, selectedAudioId: id, attachments: { [id]: att({ slot: "recording", url: URL }) } })
  }
  const chapter = [verse(1), verse(2), verse(3)]
  const lines = recordingLinesOf(chapter.map((c) => [c.id, c] as const))

  it("counts every line that holds the recording, this one included", () => {
    expect(chapter.map((c) => recordingSharedBy(c, undefined, lines))).toEqual([3, 3, 3])
    expect(chapter.map((c) => changeVoiceBlocker(c, hearth, undefined, lines))).toEqual(["shared", "shared", "shared"])
  })

  it("refuses a Station version saved over several lines, from any of them", () => {
    const first = "audio-GEN_1_1-5-st.wav"
    const station = `frontier-audio://${first}`
    const one = cell({ attachments: { [first]: att({ slot: "recording", url: station, trimEndMs: 4000 }) } })
    const two = cell({ id: "GEN 1:2", attachments: { "audio-GEN_1_2-5-st.wav": att({ slot: "recording", url: station, trimStartMs: 4000 }) } })
    const held = recordingLinesOf([one, two].map((c) => [c.id, c] as const))
    expect(changeVoiceBlocker(two, hearth, "audio-GEN_1_2-5-st.wav", held)).toBe("shared")
    expect(recordingSharedBy(two, "audio-GEN_1_2-5-st.wav", held)).toBe(2)
  })

  it("judges a re-voiced take by the recording it would be converted from", () => {
    const vc = `vc-${HEARTH_FP}-audio-GEN_1_2-9-q.wav`
    const v2 = verse(2)
    v2.selectedAudioId = vc
    v2.attachments![vc] = att({ slot: "recording", voiceId: "v-hearth", referenceAudioId: "audio-GEN_1_2-1-range.mp3", url: `frontier-audio://${vc}` })
    expect(changeVoiceBlocker(v2, anna, undefined, lines)).toBe("shared")
  })

  it("lets the pieces of a cut take on one line through: they are that line's own recording", () => {
    const whole = "audio-GEN_1_1-1-abc.webm"
    const piece = "audio-GEN_1_1-2-def.webm"
    const cut = cell({
      attachments: {
        [whole]: att({ slot: "recording", url: `frontier-audio://${whole}`, trimEndMs: 2000 }),
        [piece]: att({ slot: "recording", url: `frontier-audio://${whole}`, trimStartMs: 2000, pieceOf: whole }),
      },
    })
    const other = cell({ id: "GEN 1:2", selectedAudioId: "audio-GEN_1_2-1-x.webm", attachments: { "audio-GEN_1_2-1-x.webm": att({ slot: "recording", url: "frontier-audio://audio-GEN_1_2-1-x.webm" }) } })
    const held = recordingLinesOf([cut, other].map((c) => [c.id, c] as const))
    expect(recordingSharedBy(cut, piece, held)).toBe(1)
    expect(changeVoiceBlocker(cut, hearth, piece, held)).toBeNull()
    expect(changeVoiceBlocker(cut, hearth, undefined, held)).toBeNull()
  })

  it("does not count a deleted take, or a line no longer holding it", () => {
    const v2 = verse(2)
    v2.attachments![v2.selectedAudioId!] = { ...v2.attachments![v2.selectedAudioId!], isDeleted: true }
    const held = recordingLinesOf([verse(1), v2].map((c) => [c.id, c] as const))
    expect(recordingSharedBy(verse(1), undefined, held)).toBe(1)
    expect(changeVoiceBlocker(verse(1), hearth, undefined, held)).toBeNull()
  })
})

describe("changeVoiceLabel", () => {
  it("names the source and the voice, or leaves it for the strip to backfill", () => {
    expect(changeVoiceLabel("Take 2", "Narrator")).toBe("Take 2 → Narrator")
    expect(changeVoiceLabel(null, "Narrator")).toBeUndefined()
  })
})

describe("changeVoiceForCell", () => {
  it("converts the ORIGINAL take and attaches the result in the source take's slot", async () => {
    convertToLibraryVoice.mockResolvedValue({
      audioId: "vc-a8dcd319-audio-GEN_1_1-9-q", ext: "wav", url: "frontier-audio://vc-a8dcd319-audio-GEN_1_1-9-q.wav", bytes: 3,
    })
    const prior = "vc-ffffffff-audio-GEN_1_1-5-p.wav"
    const c = cell({
      selectedAudioId: prior,
      attachments: {
        "rec.webm": att({ slot: "recording", label: "Take 1", url: "frontier-audio://rec.webm" }),
        [prior]: att({ slot: "recording", voiceId: "v-old", referenceAudioId: "rec.webm" }),
      },
    })

    const res = await changeVoiceForCell({ projectId: "p1", cell: c, voice: hearth, session, author: "dev" })

    expect(convertToLibraryVoice).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", fileId: "f1", cellId: "GEN 1:1", libraryVoiceId: "narrator-hearth", sourceAudioId: "rec.webm",
    }))
    const sent = convertToLibraryVoice.mock.calls[0][0]
    expect(sent).not.toHaveProperty("source")
    // AQU-2291: the new contract has no clone clip and no quality knob.
    expect(sent).not.toHaveProperty("referenceAudioId")
    expect(sent).not.toHaveProperty("diffusionSteps")
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({
      cellId: "GEN 1:1",
      audioId: "vc-a8dcd319-audio-GEN_1_1-9-q.wav",
      slot: "recording",
      voiceId: "v-hearth",
      referenceAudioId: "rec.webm",
      label: "Take 1 → Hearth",
      durationMs: 2400,
    }))
    expect(injectOptimisticAudioAttachment).toHaveBeenCalledWith(
      "f1", "GEN 1:1", expect.objectContaining({ slot: "recording", voiceId: "v-hearth" }), "evt-1",
    )
    expect(res.audioId).toBe("vc-a8dcd319-audio-GEN_1_1-9-q.wav")
  })

  // AQU-2499 (review, Nov 9): the worker reads storage by the name it is
  // sent, and a take that shares another take's recording has no object of
  // its own — it answered "source audio not found".
  it("sends the stored recording a piece of a cut take plays, not the piece's own id", async () => {
    convertToLibraryVoice.mockResolvedValue({
      audioId: `vc-${HEARTH_FP}-audio-GEN_1_1-9-q`, ext: "wav", url: `frontier-audio://vc-${HEARTH_FP}-audio-GEN_1_1-9-q.wav`, bytes: 3,
    })
    const first = "audio-GEN_1_1-1-abc.webm"
    const piece = "audio-GEN_1_1-2-def.webm"
    const c = cell({
      selectedAudioId: piece,
      attachments: {
        // The first piece was deleted; the second still plays its recording.
        [first]: att({ slot: "recording", label: "Take 1 · 1", url: `frontier-audio://${first}`, isDeleted: true }),
        [piece]: att({ slot: "recording", label: "Take 1 · 2", url: `frontier-audio://${first}`, pieceOf: first }),
      },
    })

    await changeVoiceForCell({ projectId: "p1", cell: c, voice: hearth, session, author: "dev" })

    expect(convertToLibraryVoice.mock.calls[0][0]).toMatchObject({ sourceAudioId: first })
    // The new take still names the take it was made from.
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({ referenceAudioId: piece, label: "Take 1 · 2 → Hearth" }))
  })

  it("sends the first line's recording for a later line of a range uploaded as one file", async () => {
    const rachel = { id: "v-rachel", name: "Rachel", provider: "elevenlabs", elevenLabs: { voiceId: "el123" } } as Voice
    convertElevenLabsSpeech.mockResolvedValue({ audioId: "vc-x-audio-GEN_1_2-9-r", ext: "mp3", url: "frontier-audio://vc-x-audio-GEN_1_2-9-r.mp3", bytes: 3 })
    const shared = "audio-GEN_1_1-1-range.mp3"
    const own = "audio-GEN_1_2-1-range.mp3"
    const c = cell({
      id: "GEN 1:2",
      selectedAudioId: own,
      attachments: { [own]: att({ slot: "recording", url: `frontier-audio://${shared}` }) },
    })

    await changeVoiceForCell({ projectId: "p1", cell: c, voice: rachel, session, author: "dev" })

    expect(convertElevenLabsSpeech.mock.calls[0][0]).toMatchObject({ cellId: "GEN 1:2", sourceAudioId: shared })
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({ referenceAudioId: own }))
  })

  it("refuses a voice with no trained model before calling the worker", async () => {
    await expect(changeVoiceForCell({ projectId: "p1", cell: cell(), voice: stock, session, author: "dev" }))
      .rejects.toThrow("Stock can read text but can't re-voice recordings — Change voice works with character, trained and ElevenLabs voices.")
    expect(convertToLibraryVoice).not.toHaveBeenCalled()
  })
})

describe("ElevenLabs voices (AQU-2299)", () => {
  const rachel: Voice = {
    id: "v-rachel", name: "Rachel", provider: "elevenlabs",
    elevenLabs: { voiceId: "el123", settings: { stability: 0.3, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true } },
  } as Voice

  it("converts through ElevenLabs speech-to-speech and attaches the mp3 in the take's slot", async () => {
    // The id the worker mints for `elevenlabs:el123` (sync-worker elevenlabs.ts).
    const fp = voiceReferenceFingerprint("elevenlabs:el123")
    convertElevenLabsSpeech.mockResolvedValue({
      audioId: `vc-${fp}-audio-GEN_1_1-9-r`, ext: "mp3", url: `frontier-audio://vc-${fp}-audio-GEN_1_1-9-r.mp3`, bytes: 3,
    })
    expect(voiceConversionKey(rachel)).toBe("elevenlabs:el123")
    expect(changeVoiceBlocker(cell(), rachel)).toBeNull()

    await changeVoiceForCell({ projectId: "p1", cell: cell(), voice: rachel, session, author: "dev" })

    expect(convertToLibraryVoice).not.toHaveBeenCalled()
    expect(convertElevenLabsSpeech).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", fileId: "f1", cellId: "GEN 1:1", voiceId: "el123",
      sourceAudioId: "audio-GEN_1_1-1-abc.webm", modelId: "eleven_multilingual_sts_v2",
      voiceSettings: expect.objectContaining({ stability: 0.3 }),
    }), expect.any(Function))
    const attached = emitCellAudioAttach.mock.calls[0][0] as { audioId: string; mimeType: string; slot: string }
    expect(attached).toMatchObject({ audioId: `vc-${fp}-audio-GEN_1_1-9-r.mp3`, mimeType: "audio/mpeg", slot: "recording" })

    // That take now reads as up to date for the same voice.
    const after = cell({
      selectedAudioId: attached.audioId,
      attachments: { [attached.audioId]: att({ slot: "recording", voiceId: "v-rachel" }) },
    })
    expect(changeVoiceBlocker(after, rachel)).toBe("up-to-date")
  })
})

describe("changeCellVoice", () => {
  it("leaves the failure on the cell's tts badge", async () => {
    convertToLibraryVoice.mockRejectedValue(new Error("Voice conversion failed (502): boom"))
    const ok = await changeCellVoice({ projectId: "p1", cell: cell(), voice: hearth, session, author: "dev" })
    expect(ok).toBe(false)
    expect(getTtsStatus(ttsStatusKey("GEN 1:1"))).toEqual({ kind: "error", message: "Voice conversion failed (502): boom" })
  })
})

describe("library voices", () => {
  it("pin conversions to a namespaced model key", () => {
    expect(voiceConversionKey(hearth)).toBe("library:narrator-hearth")
    expect(voiceConversionKey(anna)).toBe("library:c-0a1b2c3d")
    expect(voiceConversionKey(stock)).toBeNull()
  })

  it("converts a trained custom voice through its c-<hex> model", async () => {
    convertToLibraryVoice.mockResolvedValue({
      audioId: "vc-1f0600da-audio-GEN_1_1-9-q", ext: "wav", url: "frontier-audio://vc-1f0600da-audio-GEN_1_1-9-q.wav", bytes: 3,
    })
    await changeVoiceForCell({ projectId: "p1", cell: cell(), voice: anna, session, author: "dev" })
    expect(convertToLibraryVoice.mock.calls[0][0]).toMatchObject({ libraryVoiceId: "c-0a1b2c3d", sourceAudioId: "audio-GEN_1_1-1-abc.webm" })
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({
      voiceId: "v-anna", label: "Take 1 → Anna",
    }))
  })
})
