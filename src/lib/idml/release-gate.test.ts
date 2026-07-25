import { describe, expect, it } from "vitest"
import { idmlFormatCopy, idmlOrgEligible } from "./release-gate"

describe("IDML product rollout gate", () => {
  it("defaults to experimental/content-only and never claims native fidelity", () => {
    expect(idmlFormatCopy({})).toMatchObject({
      stage: "experimental",
      nativeFidelity: false,
      label: expect.stringMatching(/experimental/i),
    })
  })

  it("limits internal and beta stages to explicit organization allowlists", () => {
    expect(idmlOrgEligible("org-a", {
      VITE_IDML_FIDELITY_STAGE: "internal",
      VITE_IDML_INTERNAL_ORGS: "org-a,org-b",
    })).toBe(true)
    expect(idmlOrgEligible("org-c", {
      VITE_IDML_FIDELITY_STAGE: "beta",
      VITE_IDML_BETA_ORGS: "org-a,org-b",
    })).toBe(false)
  })

  it("uses native copy only for the native stage", () => {
    expect(idmlFormatCopy({ VITE_IDML_FIDELITY_STAGE: "native" })).toMatchObject({
      stage: "native",
      nativeFidelity: true,
      label: "InDesign (.idml)",
    })
  })
})
