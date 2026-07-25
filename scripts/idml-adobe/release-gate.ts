import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { AdobeGateReport } from "./report"

export type IdmlFidelityStage = "experimental" | "internal" | "beta" | "native"

export interface ReleaseGateEnvironment {
  VITE_IDML_FIDELITY_STAGE?: string
  IDML_ADOBE_GATE_REPORT?: string
  VITE_IDML_ADOBE_REPORT_SHA256?: string
  IDML_SOURCE_COMMIT?: string
  GITHUB_SHA?: string
  CF_PAGES_COMMIT_SHA?: string
  IDML_BROWSER_GATE_PASSED?: string
  IDML_MIGRATION_GATE_PASSED?: string
}

export async function assertIdmlReleaseGate(
  environment: ReleaseGateEnvironment,
): Promise<{ stage: IdmlFidelityStage; report?: AdobeGateReport }> {
  const stage = parseStage(environment.VITE_IDML_FIDELITY_STAGE)
  if (stage === "experimental" || stage === "internal") return { stage }

  if (environment.IDML_BROWSER_GATE_PASSED !== "1") {
    throw new Error(`IDML ${stage} builds require IDML_BROWSER_GATE_PASSED=1.`)
  }
  if (environment.IDML_MIGRATION_GATE_PASSED !== "1") {
    throw new Error(`IDML ${stage} builds require IDML_MIGRATION_GATE_PASSED=1.`)
  }
  const reportPath = environment.IDML_ADOBE_GATE_REPORT
  if (!reportPath) {
    throw new Error(`IDML ${stage} builds require IDML_ADOBE_GATE_REPORT.`)
  }
  const bytes = await readFile(reportPath)
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (
    !environment.VITE_IDML_ADOBE_REPORT_SHA256
    || digest !== environment.VITE_IDML_ADOBE_REPORT_SHA256.toLowerCase()
  ) {
    throw new Error("IDML Adobe gate report digest is missing or does not match.")
  }
  const report = JSON.parse(bytes.toString("utf8")) as AdobeGateReport
  const expectedCommit = (
    environment.IDML_SOURCE_COMMIT
    || environment.GITHUB_SHA
    || environment.CF_PAGES_COMMIT_SHA
  )?.toLowerCase()
  if (!expectedCommit || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error(`IDML ${stage} builds require a full IDML_SOURCE_COMMIT (or provider commit SHA).`)
  }
  if (
    typeof report.sourceCommit !== "string"
    || report.sourceCommit.toLowerCase() !== expectedCommit
  ) {
    throw new Error("IDML Adobe gate report source commit does not match this build.")
  }
  if (
    report.schemaVersion !== 1
    || report.engineVersion !== 2
    || report.status !== "passed"
    || report.fixtureCount <= 0
    || report.fixtureCount !== report.passedFixtureCount
    || report.silentSkips !== 0
    || report.unsupportedLiteral !== 0
    || !Number.isSafeInteger(report.preservedUnsupported)
    || report.preservedUnsupported < 0
    || report.anchorLossCases !== 0
    || report.mappingFailures !== 0
    || !Array.isArray(report.findings)
    || report.findings.some((finding) => finding.severity === "error")
  ) {
    throw new Error("IDML Adobe gate report is not a complete zero-loss pass.")
  }
  if (stage === "native" && report.automatedAdobe !== true) {
    throw new Error("IDML native builds require an automated InDesign Server report; desktop-manual evidence cannot enable native fidelity.")
  }
  return { stage, report }
}

export function parseStage(value: string | undefined): IdmlFidelityStage {
  const stage = value || "experimental"
  if (
    stage !== "experimental"
    && stage !== "internal"
    && stage !== "beta"
    && stage !== "native"
  ) {
    throw new Error(`Unsupported VITE_IDML_FIDELITY_STAGE ${stage}.`)
  }
  return stage
}
