import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { shouldAutoValidateHumanEdit } from "./auto-validation"

const decision = (overrides: Partial<Parameters<typeof shouldAutoValidateHumanEdit>[0]> = {}) =>
  shouldAutoValidateHumanEdit({
    value: "Human translation",
    canValidate: true,
    allowSelfValidation: true,
    roleLevel: ROLE.CONTRIBUTOR,
    ...overrides,
  })

describe("shouldAutoValidateHumanEdit", () => {
  it("preserves auto-validation when self-validation is allowed or unspecified", () => {
    expect(decision()).toBe(true)
    expect(decision({ allowSelfValidation: undefined })).toBe(true)
  })

  it("does not auto-validate when the project forbids self-validation", () => {
    expect(decision({ allowSelfValidation: false })).toBe(false)
  })

  it("does not auto-validate empty content or a user without validation capability", () => {
    expect(decision({ value: "   " })).toBe(false)
    expect(decision({ canValidate: false })).toBe(false)
    expect(decision({ roleLevel: ROLE.VIEWER })).toBe(false)
  })
})

// AQU-490: the audio twin. Same shape of negative cases as the text rule, plus
// the one that is specific to audio — the two self-validation switches are
// separate, and the audio decision must never read the text one.
import { shouldAutoValidateFreshRecording } from "./auto-validation"

const recording = (overrides: Partial<Parameters<typeof shouldAutoValidateFreshRecording>[0]> = {}) =>
  shouldAutoValidateFreshRecording({
    scopeCanValidate: true,
    allowSelfValidationAudio: true,
    roleLevel: ROLE.CONTRIBUTOR,
    ...overrides,
  })

describe("shouldAutoValidateFreshRecording", () => {
  it("validates a fresh recording when self-validation is allowed or unspecified", () => {
    expect(recording()).toBe(true)
    expect(recording({ allowSelfValidationAudio: undefined })).toBe(true)
  })

  it("does not when the project forbids validating your own recordings", () => {
    expect(recording({ allowSelfValidationAudio: false })).toBe(false)
  })

  it("does not for someone outside the audio role floor or allowlist", () => {
    expect(recording({ scopeCanValidate: false })).toBe(false)
    // A contributor may record but a commenter may not validate — the
    // reviewer floor is the server's, and canPerform fails open on unknown
    // kinds, so the kind has to be one it knows.
    expect(recording({ roleLevel: ROLE.COMMENTER })).toBe(false)
  })

  it("does not for a local project with no roles at all… unless scope says yes", () => {
    // roleLevel null = local/git project: canPerform allows, scope decides.
    expect(recording({ roleLevel: null })).toBe(true)
  })
})
