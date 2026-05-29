// Regression guard for a silent-failure class that bit us once: the core
// "generate + persist cell audio" function (generateAndAttachCellVoice) was
// accidentally emptied by an unrelated refactor. Because an `import { X }` from
// an emptied module resolves to `undefined` without a tsc error (and esbuild
// strips types), every static gate — tsc, vite build, the unit suite — stayed
// green while audio generation silently did nothing (the call threw into a
// try/catch that returned false). Only actually invoking it surfaced the loss.
//
// These tests just assert the persistence functions still EXIST as callables.
// They are intentionally dependency-light so they can't themselves rot.
import { describe, expect, it } from "vitest"
import { generateAndAttachCellVoice } from "./generate-voice"
import { generateCellVoice } from "./voice-generate-helpers"

describe("cell-audio generation wiring", () => {
  it("generateAndAttachCellVoice is a live function (not an emptied module)", () => {
    expect(typeof generateAndAttachCellVoice).toBe("function")
  })

  it("generateCellVoice is a live function", () => {
    expect(typeof generateCellVoice).toBe("function")
  })
})
