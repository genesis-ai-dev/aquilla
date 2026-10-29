import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"

const convertToLibraryVoice = vi.fn()
const emitCellAudioAttach = vi.fn()
const injectOptimisticAudioAttachment = vi.fn()
vi.mock("./voice-clone", () => ({ convertToLibraryVoice: (...a: unknown[]) => convertToLibraryVoice(...a) }))
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
      "audio-GEN_1_1-1-abc.webm": att({ slot: "recording", label: "Take 1" }),
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

  it("blocks a plain TTS voice even when it still carries a removed short-clip clone field", () => {
    // AQU-2291: stored voices may keep `referenceAudioId`; it no longer makes them convertible.
    const legacyClone = { ...stock, id: "v-old", referenceAudioId: "ref1.wav" } as Voice
    expect(changeVoiceBlocker(cell(), legacyClone)).toBe("not-trained")
    expect(voiceConversionKey(legacyClone)).toBeNull()
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
        "rec.webm": att({ slot: "recording", label: "Take 1" }),
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

  it("refuses a voice with no trained model before calling the worker", async () => {
    await expect(changeVoiceForCell({ projectId: "p1", cell: cell(), voice: stock, session, author: "dev" }))
      .rejects.toThrow("Stock has no trained voice model yet — Change voice works with character voices and trained voices.")
    expect(convertToLibraryVoice).not.toHaveBeenCalled()
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
