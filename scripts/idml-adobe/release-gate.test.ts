import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { assertIdmlReleaseGate } from "./release-gate"
import type { AdobeGateReport } from "./report"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe("IDML build release gate", () => {
  it("defaults to experimental without Adobe infrastructure", async () => {
    await expect(assertIdmlReleaseGate({})).resolves.toEqual({ stage: "experimental" })
  })

  it("blocks beta before browser and migration evidence exists", async () => {
    await expect(assertIdmlReleaseGate({
      VITE_IDML_FIDELITY_STAGE: "beta",
    })).rejects.toThrow(/IDML_BROWSER_GATE_PASSED/i)
  })

  it("allows beta/native only with a digest-pinned zero-loss Adobe report", async () => {
    const report = passingReport()
    const { path, digest } = await writeReport(report)
    await expect(assertIdmlReleaseGate({
      VITE_IDML_FIDELITY_STAGE: "native",
      IDML_BROWSER_GATE_PASSED: "1",
      IDML_MIGRATION_GATE_PASSED: "1",
      IDML_ADOBE_GATE_REPORT: path,
      VITE_IDML_ADOBE_REPORT_SHA256: digest,
      IDML_SOURCE_COMMIT: report.sourceCommit,
    })).resolves.toMatchObject({ stage: "native", report })
  })

  it("blocks a digest-valid report that contains silent skips or anchor loss", async () => {
    const report = { ...passingReport(), status: "failed" as const, silentSkips: 1 }
    const { path, digest } = await writeReport(report)
    await expect(assertIdmlReleaseGate({
      VITE_IDML_FIDELITY_STAGE: "beta",
      IDML_BROWSER_GATE_PASSED: "1",
      IDML_MIGRATION_GATE_PASSED: "1",
      IDML_ADOBE_GATE_REPORT: path,
      VITE_IDML_ADOBE_REPORT_SHA256: digest,
      IDML_SOURCE_COMMIT: report.sourceCommit,
    })).rejects.toThrow(/zero-loss pass/i)
  })

  it("blocks otherwise valid evidence produced for a different source commit", async () => {
    const report = passingReport()
    const { path, digest } = await writeReport(report)
    await expect(assertIdmlReleaseGate({
      VITE_IDML_FIDELITY_STAGE: "beta",
      IDML_BROWSER_GATE_PASSED: "1",
      IDML_MIGRATION_GATE_PASSED: "1",
      IDML_ADOBE_GATE_REPORT: path,
      VITE_IDML_ADOBE_REPORT_SHA256: digest,
      IDML_SOURCE_COMMIT: "fedcba9876543210fedcba9876543210fedcba98",
    })).rejects.toThrow(/source commit does not match/i)
  })

  it("accepts desktop-manual evidence for beta but never for native fidelity", async () => {
    const report = { ...passingReport(), automatedAdobe: false }
    const { path, digest } = await writeReport(report)
    const environment = {
      IDML_BROWSER_GATE_PASSED: "1",
      IDML_MIGRATION_GATE_PASSED: "1",
      IDML_ADOBE_GATE_REPORT: path,
      VITE_IDML_ADOBE_REPORT_SHA256: digest,
      IDML_SOURCE_COMMIT: report.sourceCommit,
    }
    await expect(assertIdmlReleaseGate({
      ...environment,
      VITE_IDML_FIDELITY_STAGE: "beta",
    })).resolves.toMatchObject({ stage: "beta" })
    await expect(assertIdmlReleaseGate({
      ...environment,
      VITE_IDML_FIDELITY_STAGE: "native",
    })).rejects.toThrow(/automated InDesign Server report/i)
  })
})

function passingReport(): AdobeGateReport {
  return {
    schemaVersion: 1,
    engineVersion: 2,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    adobeVersion: "21.0",
    automatedAdobe: true,
    generatedAt: new Date().toISOString(),
    status: "passed",
    fixtureCount: 3,
    passedFixtureCount: 3,
    silentSkips: 0,
    anchorLossCases: 0,
    mappingFailures: 0,
    findings: [],
    durationMs: 1_000,
  }
}

async function writeReport(report: AdobeGateReport): Promise<{ path: string; digest: string }> {
  const directory = await mkdtemp(join(tmpdir(), "aquilla-idml-gate-"))
  temporaryDirectories.push(directory)
  const path = join(directory, "report.json")
  const bytes = Buffer.from(JSON.stringify(report))
  await writeFile(path, bytes)
  return {
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
  }
}
