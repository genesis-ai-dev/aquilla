export type IdmlFidelityStage = "experimental" | "internal" | "beta" | "native"

export interface IdmlReleaseEnvironment {
  readonly [key: string]: string | boolean | undefined
  VITE_IDML_FIDELITY_STAGE?: string
  VITE_IDML_INTERNAL_ORGS?: string
  VITE_IDML_BETA_ORGS?: string
}

export interface IdmlFormatCopy {
  stage: IdmlFidelityStage
  label: string
  description: string
  nativeFidelity: boolean
}

export function idmlFormatCopy(
  environment: IdmlReleaseEnvironment,
): IdmlFormatCopy {
  const stage = parseIdmlStage(environment.VITE_IDML_FIDELITY_STAGE)
  if (stage === "native") {
    return {
      stage,
      label: "InDesign (.idml)",
      description: "Adobe-validated native IDML round-trip. Protected translations are written only into their original text slots; layout reflow and overset remain possible when translated text length or font coverage changes.",
      nativeFidelity: true,
    }
  }
  if (stage === "beta") {
    return {
      stage,
      label: "InDesign IDML (beta)",
      description: "Protected IDML round-trip beta. Export is blocked if any locator or anchor cannot be proven, and Adobe validation evidence is required for every release.",
      nativeFidelity: false,
    }
  }
  if (stage === "internal") {
    return {
      stage,
      label: "InDesign IDML (internal preview)",
      description: "Internal protected-content preview. Native formatting fidelity is not claimed.",
      nativeFidelity: false,
    }
  }
  return {
    stage,
    label: "InDesign IDML (experimental)",
    description: "Protected translations are written only into their original text slots while the rest of the IDML package stays unchanged. Export is blocked if any locator or protected anchor cannot be proven. Adobe-native fidelity is not claimed until the automated InDesign gate passes.",
    nativeFidelity: false,
  }
}

export function idmlOrgEligible(
  orgId: string | undefined,
  environment: IdmlReleaseEnvironment,
): boolean {
  const stage = parseIdmlStage(environment.VITE_IDML_FIDELITY_STAGE)
  if (stage === "experimental" || stage === "native") return true
  if (!orgId) return false
  const allowlist = stage === "internal"
    ? environment.VITE_IDML_INTERNAL_ORGS
    : environment.VITE_IDML_BETA_ORGS
  return new Set(
    (allowlist ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ).has(orgId)
}

export function parseIdmlStage(value: string | undefined): IdmlFidelityStage {
  const stage = value || "experimental"
  if (
    stage !== "experimental"
    && stage !== "internal"
    && stage !== "beta"
    && stage !== "native"
  ) {
    return "experimental"
  }
  return stage
}

export const CURRENT_IDML_FORMAT_COPY = idmlFormatCopy(import.meta.env)
