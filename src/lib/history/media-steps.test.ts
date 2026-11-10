// Decision 11 (P13.5): linking a film, pairing heard lines and assigning
// characters can be undone — and someone else's change since is left alone.
import { describe, it, expect, vi } from "vitest"
import {
  CastStepBuilder,
  filmNow,
  mediaStepHandlers,
  timingNow,
  timingStepHandlers,
  voiceEntryChanges,
  voiceSettingsPatch,
  type CastValue,
  type FileTiming,
  type MediaStepContext,
  type TimingStepContext,
} from "./media-steps"
import type { StepHandler } from "./history"
import { stepLane } from "./step-lane"

function ctxFor(state: {
  film?: Record<string, string | null>
  links?: Set<string>
  cast?: Record<string, CastValue>
  voices?: Record<string, unknown>
}) {
  const ctx: MediaStepContext = {
    readFilm: (fileId) => (state.film && fileId in state.film ? state.film[fileId] : undefined),
    writeFilm: vi.fn(async (fileId, url) => {
      state.film = { ...state.film, [fileId]: url }
      return true
    }),
    readCueLink: (t, c) => (state.links ? state.links.has(`${t}|${c}`) : null),
    writeCueLinks: vi.fn(async (changes) => {
      for (const { textCellId, cueCellId, linked } of changes) {
        if (linked) state.links?.add(`${textCellId}|${cueCellId}`)
        else state.links?.delete(`${textCellId}|${cueCellId}`)
      }
      return true
    }),
    readCast: (fileId, cellId) => state.cast?.[`${fileId}/${cellId}`] ?? null,
    writeCast: vi.fn(async (changes) => {
      for (const { fileId, cellId, value } of changes) state.cast![`${fileId}/${cellId}`] = { ...state.cast![`${fileId}/${cellId}`], ...value }
    }),
    readVoiceSettings: () => state.voices ?? null,
    writeVoiceSettings: vi.fn(async (patch) => {
      state.voices = { ...state.voices, ...patch }
    }),
  }
  return { ctx, handlers: mediaStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
}

describe("film.link", () => {
  it("puts film A back after linking B, and redoes it; skipped once someone linked another", async () => {
    const state = { film: { ep2: "https://b" } as Record<string, string | null> }
    const { ctx, handlers } = ctxFor(state)
    const data = { fileId: "ep2", before: "https://a", after: "https://b" }
    expect(await handlers["film.link"].undo(data)).toEqual({ kind: "done" })
    expect(state.film.ep2).toBe("https://a")
    expect(await handlers["film.link"].redo(data)).toEqual({ kind: "done" })
    expect(state.film.ep2).toBe("https://b")
    state.film.ep2 = "https://c"
    expect(await handlers["film.link"].undo(data)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.writeFilm).toHaveBeenCalledTimes(2)
  })

  it("clearing a film is undone by linking it again", async () => {
    const state = { film: { ep2: null } as Record<string, string | null> }
    const { handlers } = ctxFor(state)
    expect(await handlers["film.link"].undo({ fileId: "ep2", before: "https://a", after: null })).toEqual({ kind: "done" })
    expect(state.film.ep2).toBe("https://a")
  })
})

// Review, Oct 29: the film just written here stands in for the project read
// until that read answers. Any new answer ends it, not only one spelled
// exactly as written (the server may tidy the address), or a collaborator's
// later film would be hidden behind it and an Undo would write over theirs.
describe("filmNow", () => {
  it("is the film written here until the read moves, then the read", () => {
    const pending = { url: "https://films.example/ep2 ", readBefore: "https://films.example/ep1" }
    expect(filmNow("https://films.example/ep1", pending)).toEqual({ film: "https://films.example/ep2 ", settled: false })
    expect(filmNow("https://films.example/ep2", pending)).toEqual({ film: "https://films.example/ep2", settled: true })
    expect(filmNow("https://films.example/ep9", pending)).toEqual({ film: "https://films.example/ep9", settled: true })
    expect(filmNow("https://films.example/ep1", undefined)).toEqual({ film: "https://films.example/ep1", settled: true })
  })
})

describe("cue.link", () => {
  it("an unlink is undone by linking the pair again, so the line counts through it once more", async () => {
    const state = { links: new Set<string>() }
    const { handlers } = ctxFor(state)
    const data = { textCellId: "sub12", cueCellId: "heard15", linked: false }
    expect(await handlers["cue.link"].undo(data)).toEqual({ kind: "done" })
    expect(state.links.has("sub12|heard15")).toBe(true)
    expect(await handlers["cue.link"].redo(data)).toEqual({ kind: "done" })
    expect(state.links.has("sub12|heard15")).toBe(false)
  })

  it("is skipped when someone paired them again since, and gone when the pairings can't be read", async () => {
    const state = { links: new Set(["sub12|heard15"]) }
    expect(await ctxFor(state).handlers["cue.link"].undo({ textCellId: "sub12", cueCellId: "heard15", linked: false })).toEqual({
      kind: "skipped",
      reason: "changed",
    })
    expect(await ctxFor({}).handlers["cue.link"].undo({ textCellId: "a", cueCellId: "b", linked: true })).toEqual({
      kind: "skipped",
      reason: "gone",
    })
  })
})

// Review, Oct 29: "Re-pair cues" can change hundreds of pairings. Undoing it
// is one write, not one per pairing, and the pairings come back as they were:
// the matcher's own stay the matcher's, and nothing it removed turns into a
// pinned hand pairing or a hand rejection.
describe("cue.links (re-pairing the cues)", () => {
  const repair = {
    links: [
      { textCellId: "sub1", cueCellId: "heard1", linked: true, origin: "auto" as const, confidence: 0.9 },
      { textCellId: "sub2", cueCellId: "heard2", linked: false, origin: "manual" as const, confidence: null },
    ],
  }

  it("is undone and redone in one write each, keeping each pairing's origin", async () => {
    const state = { links: new Set(["sub1|heard1"]) }
    const { ctx, handlers } = ctxFor(state)
    expect(await handlers["cue.links"].undo(repair)).toEqual({ kind: "done" })
    expect(ctx.writeCueLinks).toHaveBeenCalledTimes(1)
    expect(ctx.writeCueLinks).toHaveBeenLastCalledWith([
      { textCellId: "sub1", cueCellId: "heard1", linked: false, origin: "auto", confidence: null },
      { textCellId: "sub2", cueCellId: "heard2", linked: true, origin: "manual", confidence: null },
    ])
    expect([...state.links]).toEqual(["sub2|heard2"])
    expect(await handlers["cue.links"].redo(repair)).toEqual({ kind: "done" })
    expect(ctx.writeCueLinks).toHaveBeenCalledTimes(2)
    expect(ctx.writeCueLinks).toHaveBeenLastCalledWith([
      { textCellId: "sub1", cueCellId: "heard1", linked: true, origin: "auto", confidence: 0.9 },
      { textCellId: "sub2", cueCellId: "heard2", linked: false, origin: "auto", confidence: null },
    ])
  })

  it("leaves a pairing someone changed since, and still takes back the rest", async () => {
    const state = { links: new Set(["sub1|heard1", "sub2|heard2"]) }
    const { ctx, handlers } = ctxFor(state)
    expect(await handlers["cue.links"].undo(repair)).toEqual({ kind: "done", partial: { skipped: 1 } })
    expect(ctx.writeCueLinks).toHaveBeenLastCalledWith([
      { textCellId: "sub1", cueCellId: "heard1", linked: false, origin: "auto", confidence: null },
    ])
  })
})

describe("cast.assign", () => {
  it("puts the old character back on both sides of a decision, and the decision record too", async () => {
    const state = {
      cast: {
        "ep2/sub3": { castName: "Mary", cameraState: "on" },
        "cues/heard3": { castName: "Mary", cameraState: "on" },
      } as Record<string, CastValue>,
      voices: { characterResolutions: { "sub3 heard3": { name: { chose: "subtitle", rejected: "Martha" } } } } as Record<string, unknown>,
    }
    const step = new CastStepBuilder()
    step.cell("ep2", { id: "sub3", metadata: { cast_name: "Mary" }, cameraState: "on" }, { castName: "Mary", cameraState: "on" })
    step.cell("cues", { id: "heard3", metadata: { cast_name: "Martha" }, cameraState: "on" }, { castName: "Mary", cameraState: "on" })
    step.settings({ characterResolutions: {} }, { characterResolutions: state.voices.characterResolutions as Record<string, unknown> })
    const data = step.data()!
    // The subtitle already said Mary: only the heard line changed.
    expect(data.cells.map((c) => c.cellId)).toEqual(["heard3"])
    const { handlers } = ctxFor(state)
    expect(await handlers["cast.assign"].undo(data)).toEqual({ kind: "done" })
    expect(state.cast["cues/heard3"].castName).toBe("Martha")
    expect(state.voices.characterResolutions).toEqual({})
    expect(await handlers["cast.assign"].redo(data)).toEqual({ kind: "done" })
    expect(state.cast["cues/heard3"].castName).toBe("Mary")
  })

  it("leaves a line someone has changed since, and says the step was partly undone", async () => {
    const state = {
      cast: {
        "ep2/a": { castName: null },
        "ep2/b": { castName: "Peter" }, // renamed by someone else since
      } as Record<string, CastValue>,
    }
    const data = {
      cells: [
        { fileId: "ep2", cellId: "a", before: { castName: "John" }, after: { castName: null } },
        { fileId: "ep2", cellId: "b", before: { castName: "John" }, after: { castName: null } },
      ],
    }
    const { handlers } = ctxFor(state)
    expect(await handlers["cast.assign"].undo(data)).toEqual({ kind: "done", partial: { skipped: 1 } })
    expect(state.cast["ep2/a"].castName).toBe("John")
    expect(state.cast["ep2/b"].castName).toBe("Peter")
  })
})

describe("voice settings entries", () => {
  it("remembers only the entries a save changed, and puts back only those still as it left them", () => {
    const before = { castAssignments: { a: "v1", b: "v2" }, laneCastAssignments: { sw: { a: "v9" } } }
    const patch = { castAssignments: { b: "v2" }, laneCastAssignments: { sw: {} } }
    const changes = voiceEntryChanges(before, patch)
    expect(changes).toEqual([
      { path: ["castAssignments", "a"], before: "v1" },
      { path: ["laneCastAssignments", "sw", "a"], before: "v9" },
    ])
    // Someone gave line a a new voice since; the per-language entry is still gone.
    const now = { castAssignments: { a: "v5", b: "v2" }, laneCastAssignments: { sw: {} } }
    const { patch: undo, applied } = voiceSettingsPatch(now, changes, "undo")
    expect(applied).toBe(1)
    expect(undo).toEqual({ laneCastAssignments: { sw: { a: "v9" } } })
  })
})

// AQU-2492 (review, Nov 9; Sam's call the same day): switching a file's timing
// is an Undo step. Undo puts the file back on the timing it had, Redo switches
// it again; the switch's own role rule applies, and a switch someone else made
// in between is left alone.
describe("file.timing", () => {
  function timingCtx(state: { timing: Record<string, FileTiming>; may?: boolean; filmTimed?: boolean }) {
    const ctx: TimingStepContext = {
      readTiming: (fileId) => state.timing[fileId],
      mayChangeTiming: () => state.may ?? true,
      offersTiming: (_fileId, mode) => !(mode === "audioFirst" && state.filmTimed),
      writeTiming: vi.fn(async (fileId, mode) => {
        state.timing[fileId] = mode
        return true
      }),
    }
    return { ctx, handlers: timingStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
  }
  const step = { fileId: "f1", before: "dubbing" as const, after: "audioFirst" as const }

  it("undo puts the file back on the timing it had, and redo switches it again", async () => {
    const state = { timing: { f1: "audioFirst" as FileTiming } }
    const { ctx, handlers } = timingCtx(state)
    expect(await handlers["file.timing"].undo(step)).toEqual({ kind: "done" })
    expect(state.timing.f1).toBe("dubbing")
    expect(await handlers["file.timing"].redo(step)).toEqual({ kind: "done" })
    expect(state.timing.f1).toBe("audioFirst")
    expect(ctx.writeTiming).toHaveBeenCalledTimes(2)
  })

  it("is skipped as changed when someone else switched the file's timing in between", async () => {
    const state = { timing: { f1: "dubbing" as FileTiming } }
    const { ctx, handlers } = timingCtx(state)
    expect(await handlers["file.timing"].undo(step)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.writeTiming).not.toHaveBeenCalled()
  })

  it("is skipped as not allowed when the person may no longer switch timing", async () => {
    const state = { timing: { f1: "audioFirst" as FileTiming }, may: false }
    const { ctx, handlers } = timingCtx(state)
    expect(await handlers["file.timing"].undo(step)).toEqual({ kind: "skipped", reason: "notAllowed" })
    expect(ctx.writeTiming).not.toHaveBeenCalled()
  })

  it("redo is skipped as changed when the file can no longer follow its recordings (a film was linked since)", async () => {
    const state = { timing: { f1: "dubbing" as FileTiming }, filmTimed: true }
    const { ctx, handlers } = timingCtx(state)
    expect(await handlers["file.timing"].redo(step)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.writeTiming).not.toHaveBeenCalled()
  })

  it("is skipped as gone when the file can't be read", async () => {
    const { handlers } = timingCtx({ timing: {} })
    expect(await handlers["file.timing"].undo(step)).toEqual({ kind: "skipped", reason: "gone" })
  })

  it("belongs to every language", () => {
    expect(stepLane("file.timing", step, "fr")).toBeUndefined()
  })
})

describe("timingNow", () => {
  it("reads the switch written here until the project read answers, then the read", () => {
    const pending = { mode: "audioFirst" as const, readBefore: "dubbing" as const }
    expect(timingNow("dubbing", pending)).toEqual({ mode: "audioFirst", settled: false })
    expect(timingNow("audioFirst", pending)).toEqual({ mode: "audioFirst", settled: true })
    expect(timingNow("dubbing", undefined)).toEqual({ mode: "dubbing", settled: true })
  })
})
