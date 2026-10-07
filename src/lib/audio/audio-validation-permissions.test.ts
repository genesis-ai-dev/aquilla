// AQU-490: the project policy, applied client-side so the UI never offers a
// vote the server is about to refuse — and can say why instead.
//
// The server (sync-worker route.ts) is the authority; these rules mirror it.
// Where the two could drift, the test says which way the mistake must fall.
import { describe, it, expect } from "vitest"
import {
  audioEntryFromCell,
  audioValidationScope,
  audioValidationTakes,
  canValidateTake,
  lineValidationTakes,
} from "./audio-validation-permissions"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

const reason = (r: string) => `blocked:${r}`
const policy = (over: Partial<{ roleLevel: number | null; username: string }> = {}) =>
  ({ roleLevel: 400, username: "ana", ...over })

describe("audioValidationScope", () => {
  it("allows everyone when the project sets no policy", () => {
    expect(audioValidationScope({}, policy())).toEqual({ canValidate: true, reason: null })
  })

  it("applies the audio role floor", () => {
    const project = { validationRoleFloorAudio: "project_lead" as const }
    expect(audioValidationScope(project, policy({ roleLevel: 400 })).canValidate).toBe(false)
    expect(audioValidationScope(project, policy({ roleLevel: 500 })).canValidate).toBe(true)
  })

  // A local or git project has no role ladder at all, exactly as for text.
  // Reading a null level as "below every floor" would make audio validation
  // impossible offline rather than unrestricted.
  it("ignores the floor on a project with no roles", () => {
    const project = { validationRoleFloorAudio: "maintainer" as const }
    expect(audioValidationScope(project, policy({ roleLevel: null })).canValidate).toBe(true)
  })

  it("applies the audio allowlist", () => {
    const project = { validationNamedUsersAudio: ["bo"] }
    expect(audioValidationScope(project, policy()).reason).toBe("allowlist")
    expect(audioValidationScope(project, policy({ username: "bo" })).canValidate).toBe(true)
  })

  // An EMPTY list is not a list of nobody — it is the absence of a rule, the
  // same reading the server takes. Otherwise clearing the field would lock
  // the whole project out.
  it("treats an empty allowlist as no allowlist", () => {
    expect(audioValidationScope({ validationNamedUsersAudio: [] }, policy()).canValidate).toBe(true)
  })
})

describe("canValidateTake — self-validation", () => {
  const scope = { canValidate: true, reason: null } as const

  it("lets the recorder validate their own take by default", () => {
    expect(canValidateTake({ recordedBy: "ana" }, {}, scope, "ana").canValidate).toBe(true)
  })

  it("refuses the recorder when the project turns self-validation off", () => {
    const project = { allowSelfValidationAudio: false }
    expect(canValidateTake({ recordedBy: "ana" }, project, scope, "ana")).toEqual({
      canValidate: false, reason: "self",
    })
    expect(canValidateTake({ recordedBy: "bo" }, project, scope, "ana").canValidate).toBe(true)
  })

  // THE UNKNOWN RECORDER. Takes whose attach event is gone carry null, and so
  // do projects the rollout script has not reached. Unknown must never match
  // the viewer, or self-validation-off would lock everybody out of exactly the
  // oldest recordings — the ones least likely to be noticed.
  it("never reads an unknown recorder as the viewer", () => {
    const project = { allowSelfValidationAudio: false }
    expect(canValidateTake({ recordedBy: null }, project, scope, "ana").canValidate).toBe(true)
    expect(canValidateTake({ recordedBy: "" }, project, scope, "").canValidate).toBe(true)
  })

  it("keeps the project-wide refusal rather than replacing it", () => {
    const blocked = { canValidate: false, reason: "role" } as const
    expect(canValidateTake({ recordedBy: "bo" }, {}, blocked, "ana")).toEqual({
      canValidate: false, reason: "role",
    })
  })
})

describe("audioValidationTakes", () => {
  const entry = (attachments: Record<string, unknown>, selected: Record<string, string>) =>
    ({
      attachments,
      selectedBySlot: selected,
      selectedAudioId: selected.recording ?? null,
      selectedGeneratedVoiceAudioId: selected.generatedVoice ?? null,
      audioTimings: {},
    }) as unknown as CellAudioEntry

  it("returns nothing for a cell with no audio at all", () => {
    expect(audioValidationTakes(undefined, {}, policy(), reason)).toEqual([])
  })

  // The source clip is filtered by selectedDubTakes, not here — one definition
  // of "which takes count", shared with the server's SQL.
  it("leaves out the imported source clip", () => {
    const e = entry(
      {
        src: { audioId: "src", slot: "recording", role: "source", validatorCount: 0, validators: [] },
        dub: { audioId: "dub", slot: "track-2", validatorCount: 1, validators: ["bo"] },
      },
      { recording: "src", "track-2": "dub" },
    )
    expect(audioValidationTakes(e, {}, policy(), reason).map((t) => t.audioId)).toEqual(["dub"])
  })

  it("carries the vote count, the validators and the refusal reason", () => {
    const e = entry(
      { a: { audioId: "a", slot: "recording", validatorCount: 2, validators: ["bo", "cy"], recordedBy: "ana" } },
      { recording: "a" },
    )
    const [take] = audioValidationTakes(e, { allowSelfValidationAudio: false }, policy(), reason)
    expect(take).toMatchObject({
      audioId: "a", validatorCount: 2, validators: ["bo", "cy"],
      canValidate: false, blockedReason: "blocked:self",
    })
  })

  it("marks a generated voice, which never auto-validates", () => {
    const e = entry(
      { g: { audioId: "g", slot: "generatedVoice", voiceId: "v1", validatorCount: 0, validators: [] } },
      { generatedVoice: "g" },
    )
    expect(audioValidationTakes(e, {}, policy(), reason)[0].isGenerated).toBe(true)
  })

  // A worker predating AQU-490 sends none of the fields. The control must read
  // that as "nobody has validated anything", never as a crash.
  it("reads a pre-AQU-490 response as unvalidated", () => {
    const e = entry({ a: { audioId: "a", slot: "recording" } }, { recording: "a" })
    expect(audioValidationTakes(e, {}, policy(), reason)[0]).toMatchObject({
      validatorCount: 0, validators: [], isGenerated: false, canValidate: true,
    })
  })
})

describe("audioEntryFromCell", () => {
  it("puts the audio id back, since the editor keeps it as the map key", () => {
    const entry = audioEntryFromCell({
      attachments: { "take-1": { slot: "recording", validatorCount: 2, validators: ["bo"] } },
      selectedBySlot: { recording: "take-1" },
      selectedAudioId: "take-1",
    })!
    expect(entry.attachments["take-1"].audioId).toBe("take-1")
    expect(audioValidationTakes(entry, {}, policy(), reason)[0]).toMatchObject({
      audioId: "take-1", validatorCount: 2, validators: ["bo"],
    })
  })

  it("carries role through, so a source clip still does not count", () => {
    const entry = audioEntryFromCell({
      attachments: { src: { slot: "recording", role: "source" } },
      selectedBySlot: { recording: "src" },
      selectedAudioId: "src",
    })!
    expect(audioValidationTakes(entry, {}, policy(), reason)).toEqual([])
  })

  it("returns nothing for a cell that has no attachments at all", () => {
    expect(audioEntryFromCell({})).toBeUndefined()
    expect(audioEntryFromCell(undefined)).toBeUndefined()
  })

  // A hand-built cell stub (the recording modal makes one) has no slot on its
  // attachment. Defaulting to the main track keeps it visible rather than
  // parking it under a slot nothing selects.
  it("defaults a slotless attachment to the main track", () => {
    const entry = audioEntryFromCell({
      attachments: { a: {} },
      selectedBySlot: { recording: "a" },
    })!
    expect(entry.attachments.a.slot).toBe("recording")
  })
})

// Sam, 2026-09-30: in a dubbing file a subtitle line's takes live on the heard
// lines performing it, and the line's audio check read only the row — "No
// audio to validate" everywhere, and a vote on the heard line never showed.
describe("lineValidationTakes — a line and the heard lines performing it", () => {
  const cue = (id: string, audioId: string | null, over: { validators?: string[]; original?: string } = {}) => ({
    id,
    fileId: "cues",
    original: over.original ?? id,
    attachments: audioId
      ? { [audioId]: { slot: "recording", validators: over.validators ?? [], validatorCount: over.validators?.length ?? 0 } }
      : undefined,
    selectedAudioId: audioId,
  })
  const row = { id: "line-1", fileId: "subs" }
  const name = (c: { id: string; original?: string }) => `“${c.original ?? c.id}”`
  const track = (_: unknown, slot: string) => (slot === "recording" ? "Target audio" : slot === "t2" ? "Track" : "?")

  it("is the row's own takes, owned by the row, when nothing performs it", () => {
    const own = {
      ...row,
      attachments: { t1: { slot: "recording" } },
      selectedAudioId: "t1",
    }
    const { takes, ownerOf } = lineValidationTakes(own, undefined, {}, policy(), reason, name, track)
    expect(takes.map((t) => t.audioId)).toEqual(["t1"])
    expect(ownerOf.get("t1")).toEqual({ fileId: "subs", cellId: "line-1" })
  })

  it("takes the heard line's selected take, named by its words, voted on its cue", () => {
    const heard = cue("cue-a", "ta", { validators: ["bo"], original: "Bring back some bread," })
    const { takes, ownerOf } = lineValidationTakes(row, [{ cell: heard, hasTake: true }], {}, policy(), reason, name, track)
    expect(takes).toEqual([
      expect.objectContaining({ audioId: "ta", label: "“Bring back some bread,”", validators: ["bo"], canValidate: true }),
    ])
    expect(ownerOf.get("ta")).toEqual({ fileId: "cues", cellId: "cue-a" })
  })

  it("lists every part of a split line, and a part not yet recorded takes no vote", () => {
    const { takes, ownerOf } = lineValidationTakes(
      row,
      [{ cell: cue("cue-a", "ta"), hasTake: true }, { cell: cue("cue-b", null), hasTake: false }],
      {},
      policy(),
      reason,
      name,
      track,
    )
    expect(takes.map((t) => t.audioId)).toEqual(["ta", "unrecorded:cue-b"])
    expect(takes[1]).toMatchObject({
      unrecorded: true, canValidate: false, blockedReason: "blocked:unrecorded", label: "“cue-b”",
    })
    expect(ownerOf.get("unrecorded:cue-b")).toEqual({ fileId: "cues", cellId: "cue-b" })
  })

  it("applies the project's policy to a heard line's take as to the row's own", () => {
    const heard = { ...cue("cue-a", "ta"), attachments: { ta: { slot: "recording", recordedBy: "ana" } } }
    const { takes } = lineValidationTakes(
      row, [{ cell: heard, hasTake: true }], { allowSelfValidationAudio: false }, policy(), reason, name, track,
    )
    expect(takes[0]).toMatchObject({ canValidate: false, blockedReason: "blocked:self" })
  })
})

// Sam, 2026-09-30: every track numbers its own takes, so two tracks' takes
// both read "Take 1" in the hover list.
describe("lineValidationTakes — takes on more than one track", () => {
  const name = (c: { id: string; original?: string }) => `“${c.original ?? c.id}”`
  const track = (_: unknown, slot: string) => (slot === "recording" ? "Target audio" : "Track")
  const twoTracks = (id: string, fileId: string, original?: string) => ({
    id, fileId, original,
    attachments: {
      a: { slot: "recording", label: "Take 1" },
      b: { slot: "t2", label: "Take 1" },
    },
    selectedBySlot: { recording: "a", t2: "b" },
    selectedAudioId: "a",
  })

  it("names a line's own takes by track and take", () => {
    const { takes } = lineValidationTakes(twoTracks("line-1", "subs"), undefined, {}, policy(), reason, name, track)
    expect(new Set(takes.map((t) => t.label))).toEqual(new Set(["Target audio · Take 1", "Track · Take 1"]))
  })

  it("names a heard line's takes by its words, track and take", () => {
    const heard = twoTracks("cue-a", "cues", "Bring back some bread,")
    const { takes } = lineValidationTakes({ id: "line-1", fileId: "subs" }, [{ cell: heard, hasTake: true }], {}, policy(), reason, name, track)
    expect(new Set(takes.map((t) => t.label))).toEqual(new Set([
      "“Bring back some bread,” · Target audio · Take 1",
      "“Bring back some bread,” · Track · Take 1",
    ]))
  })

  it("keeps a single take's plain name", () => {
    const one = { id: "line-1", fileId: "subs", attachments: { a: { slot: "recording", label: "Take 3" } }, selectedAudioId: "a" }
    const { takes } = lineValidationTakes(one, undefined, {}, policy(), reason, name, track)
    expect(takes[0].label).toBe("Take 3")
  })
})
