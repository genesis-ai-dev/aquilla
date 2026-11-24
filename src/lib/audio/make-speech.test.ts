// Make speech (AQU-2577): the order the steps run in.
//
// WHY: the recipe spends the user's speech credits and writes takes. A line
// must not be spoken before it has text, must not be cloned when speaking
// failed, a failure must say why, and one failed line must not cost the lines
// after it.
import { describe, expect, it } from "vitest"
import {
  loadMakeSpeechRecipe,
  runMakeSpeech,
  saveMakeSpeechRecipe,
  stepsForLine,
  translateMissing,
  type MakeSpeechActions,
  type MakeSpeechRecipe,
} from "./make-speech"

const recipe = (over: Partial<MakeSpeechRecipe> = {}): MakeSpeechRecipe => ({
  readerVoiceId: "layla", clone: true, characterVoiceId: "chip", ...over,
})

describe("stepsForLine", () => {
  it("picks the speech steps a line needs", () => {
    const cases: [Partial<MakeSpeechRecipe>, boolean, string[]][] = [
      [{}, true, ["speak", "revoice"]],
      [{ clone: false }, true, ["speak"]],
      [{ characterVoiceId: null }, true, ["speak"]],
      // Reader and character are the same voice: nothing to clone into.
      [{ characterVoiceId: "layla" }, true, ["speak"]],
      // No text: nothing to say. Translating is translateMissing's job.
      [{}, false, []],
    ]
    for (const [over, hasText, steps] of cases) {
      expect(stepsForLine(recipe(over), hasText), JSON.stringify([over, hasText])).toEqual(steps)
    }
  })
})

describe("translateMissing", () => {
  it("drafts only the lines with no text, and leaves them for review", async () => {
    const text = new Set(["b"])
    const translated: string[] = []
    const actions: MakeSpeechActions = {
      hasText: (id) => text.has(id),
      translate: async (id) => { translated.push(id); text.add(id); return id !== "c" },
      speak: async () => true,
      revoice: async () => true,
      failureReason: (id, step) => `${step} ${id} failed: no model`,
    }
    const states = new Map<string, unknown>()
    const drafted = await translateMissing(["a", "b", "c"], actions, (id, s) => states.set(id, s))
    expect(translated).toEqual(["a", "c"])
    expect(drafted).toEqual(["a"])
    expect(Object.fromEntries(states)).toEqual({
      a: { kind: "review" },
      c: { kind: "failed", step: "translate", reason: "translate c failed: no model" },
    })
  })
})

describe("runMakeSpeech", () => {
  it("runs each line's steps in order, and a failed line does not stop the next", async () => {
    const calls: string[] = []
    const actions: MakeSpeechActions = {
      hasText: (id) => id !== "d",
      translate: async () => true,
      speak: async (id, voice) => { calls.push(`speak ${id} ${voice}`); return id !== "b" },
      revoice: async (id, voice) => {
        calls.push(`revoice ${id} ${voice}`)
        if (id === "c") throw new Error("Seed-VC timed out")
        return true
      },
      failureReason: () => "Inworld rejected the voice",
    }
    const seen: string[] = []
    const result = await runMakeSpeech(["a", "b", "c", "d"], recipe(), actions, (id, state) => {
      seen.push(`${id}:${state.kind}${"step" in state ? `:${state.step}` : ""}`)
    })
    expect(calls).toEqual([
      "speak a layla", "revoice a chip",
      "speak b layla",
      "speak c layla", "revoice c chip",
    ])
    expect(Object.fromEntries(result)).toEqual({
      a: { kind: "done" },
      b: { kind: "failed", step: "speak", reason: "Inworld rejected the voice" },
      c: { kind: "failed", step: "revoice", reason: "Seed-VC timed out" },
      d: { kind: "skipped" },
    })
    expect(seen.slice(0, 4)).toEqual(["a:waiting", "b:waiting", "c:waiting", "d:waiting"])
    expect(seen).toContain("a:running:revoice")
  })
})

describe("the remembered recipe", () => {
  it("keeps the voices and the clone toggle, never the delivery", () => {
    saveMakeSpeechRecipe("p1", { ...recipe({ clone: false }), delivery: { settings: { speed: 1.2 }, tags: [] } })
    expect(loadMakeSpeechRecipe("p1")).toEqual(recipe({ clone: false }))
  })

  it("reads a recipe saved before the clone toggle as cloning when it named a character", () => {
    localStorage.clear()
    saveMakeSpeechRecipe("p2", recipe())
    const key = Object.keys(localStorage).find((k) => k.endsWith("p2"))
    expect(key).toBeDefined()
    localStorage.setItem(key ?? "", JSON.stringify({ translate: true, readerVoiceId: "layla", characterVoiceId: "chip" }))
    expect(loadMakeSpeechRecipe("p2")).toEqual(recipe())
  })
})
