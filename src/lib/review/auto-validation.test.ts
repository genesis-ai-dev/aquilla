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
