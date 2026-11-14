// Make speech (AQU-2577): the order the three steps run in.
//
// WHY: the recipe spends the user's ElevenLabs characters and writes takes. A
// line must not be spoken before it has text, must not be re-voiced when
// speaking failed, and must stop for review when asked — and one failed line
// must not cost the lines after it.
import { describe, expect, it } from "vitest"
import { runMakeSpeech, stepsForLine, type MakeSpeechActions, type MakeSpeechRecipe } from "./make-speech"

const recipe = (over: Partial<MakeSpeechRecipe> = {}): MakeSpeechRecipe => ({
  translate: true, reviewTranslation: false, readerVoiceId: "layla", characterVoiceId: "chip", ...over,
})

describe("stepsForLine", () => {
  it("picks the steps a line needs", () => {
    const cases: [Partial<MakeSpeechRecipe>, boolean, string[]][] = [
      [{}, false, ["translate", "speak", "revoice"]],
      [{}, true, ["speak", "revoice"]],
      [{ characterVoiceId: null }, true, ["speak"]],
      // Reader and character are the same voice: nothing to change into.
      [{ characterVoiceId: "layla" }, true, ["speak"]],
      [{ reviewTranslation: true }, false, ["translate"]],
      // Review only holds a line that was just drafted, not one already translated.
      [{ reviewTranslation: true }, true, ["speak", "revoice"]],
      [{ translate: false }, false, []],
    ]
    for (const [over, hasText, steps] of cases) {
      expect(stepsForLine(recipe(over), hasText), JSON.stringify([over, hasText])).toEqual(steps)
    }
  })
})

describe("runMakeSpeech", () => {
  it("runs each line's steps in order, and a failed line does not stop the next", async () => {
    const calls: string[] = []
    const text = new Set(["b", "c"])
    const actions: MakeSpeechActions = {
      hasText: (id) => text.has(id),
      translate: async (id) => { calls.push(`translate ${id}`); text.add(id); return true },
      speak: async (id, voice) => { calls.push(`speak ${id} ${voice}`); return id !== "b" },
      revoice: async (id, voice) => { calls.push(`revoice ${id} ${voice}`); return true },
    }
    const seen: string[] = []
    const result = await runMakeSpeech(["a", "b", "c"], recipe(), actions, (id, state) => {
      seen.push(`${id}:${state.kind}${"step" in state ? `:${state.step}` : ""}`)
    })
    expect(calls).toEqual([
      "translate a", "speak a layla", "revoice a chip",
      "speak b layla",
      "speak c layla", "revoice c chip",
    ])
    expect(Object.fromEntries(result)).toEqual({
      a: { kind: "done" }, b: { kind: "failed", step: "speak" }, c: { kind: "done" },
    })
    expect(seen.slice(0, 3)).toEqual(["a:waiting", "b:waiting", "c:waiting"])
    expect(seen).toContain("a:running:revoice")
  })

  it("stops a drafted line for review, and skips a line with no text when it may not translate", async () => {
    const spoken: string[] = []
    const actions: MakeSpeechActions = {
      hasText: () => false,
      translate: async () => true,
      speak: async (id) => { spoken.push(id); return true },
      revoice: async () => true,
    }
    const reviewed = await runMakeSpeech(["a"], recipe({ reviewTranslation: true }), actions, () => {})
    const skipped = await runMakeSpeech(["a"], recipe({ translate: false }), actions, () => {})
    expect([reviewed.get("a"), skipped.get("a"), spoken]).toEqual([{ kind: "review" }, { kind: "skipped" }, []])
  })
})
