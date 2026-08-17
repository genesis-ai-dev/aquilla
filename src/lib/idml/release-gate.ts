import type { MessageKey } from "@/lib/i18n/messages/en"

export type IdmlFidelityStage = "experimental" | "internal" | "beta" | "native"

export interface IdmlReleaseEnvironment {
  readonly [key: string]: string | boolean | undefined
  VITE_IDML_FIDELITY_STAGE?: string
  VITE_IDML_INTERNAL_ORGS?: string
  VITE_IDML_BETA_ORGS?: string
}

// AQU-832: label/description are catalog keys, not English strings —
// `CURRENT_IDML_FORMAT_COPY` below is a module-level constant evaluated
// before any I18nProvider exists, so it cannot call t() itself. The caller
// (ExportDialog) resolves these keys at render time.
export interface IdmlFormatCopy {
  stage: IdmlFidelityStage
  label: MessageKey
  description: MessageKey
  nativeFidelity: boolean
}

export function idmlFormatCopy(
  environment: IdmlReleaseEnvironment,
): IdmlFormatCopy {
  const stage = parseIdmlStage(environment.VITE_IDML_FIDELITY_STAGE)
  if (stage === "native") {
    return {
      stage,
      label: "importExport.idml.labelNative",
      description: "importExport.idml.descriptionNative",
      nativeFidelity: true,
    }
  }
  if (stage === "beta") {
    return {
      stage,
      label: "importExport.idml.labelBeta",
      description: "importExport.idml.descriptionBeta",
      nativeFidelity: false,
    }
  }
  if (stage === "internal") {
    return {
      stage,
      label: "importExport.idml.labelInternal",
      description: "importExport.idml.descriptionInternal",
      nativeFidelity: false,
    }
  }
  return {
    stage,
    label: "importExport.idml.labelExperimental",
    description: "importExport.idml.descriptionExperimental",
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
