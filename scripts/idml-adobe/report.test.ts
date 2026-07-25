import { describe, expect, it } from "vitest"
import {
  buildAdobeGateReport,
  structuralDifferences,
  type AdobeDocumentMetrics,
  type AdobeGateManifest,
  type AdobeRawReport,
} from "./report"

describe("Adobe IDML structural gate", () => {
  it("passes a complete open/preflight/save/reopen/PDF cycle and reports reflow separately", () => {
    const before = metrics()
    const translated = metrics({ oversetStoryIds: [42] })
    const report = buildAdobeGateReport(
      manifest(),
      rawReport(before, translated, translated),
    )

    expect(report).toMatchObject({
      status: "passed",
      automatedAdobe: true,
      fixtureCount: 1,
      passedFixtureCount: 1,
      silentSkips: 0,
      anchorLossCases: 0,
      mappingFailures: 0,
    })
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "REFLOW_OR_OVERSET", severity: "warning" }),
    ])
  })

  it("fails on source/candidate structure loss and candidate/save-reopen drift", () => {
    const before = metrics()
    const candidate = metrics({ footnoteCount: 0 })
    const reopened = metrics({ tableCount: 0, tables: [] })
    const report = buildAdobeGateReport(
      manifest(),
      rawReport(before, candidate, reopened),
    )

    expect(report.status).toBe("failed")
    expect(report.anchorLossCases).toBe(1)
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ANCHOR_LOSS", severity: "error" }),
      expect.objectContaining({ code: "STRUCTURE_CHANGED", severity: "error" }),
    ]))
  })

  it("fails beta/native evidence when browser, migration, mapping, or silent-skip gates are not clean", () => {
    const dirtyManifest = manifest()
    dirtyManifest.gates.browser = "failed"
    dirtyManifest.gates.migration = "not-run"
    dirtyManifest.fixtures[0]!.exportReport = {
      translated: 1,
      missing: 1,
      rejected: 1,
      unsupported: 2,
    }
    const report = buildAdobeGateReport(
      dirtyManifest,
      rawReport(metrics(), metrics(), metrics()),
    )

    expect(report.status).toBe("failed")
    expect(report.mappingFailures).toBe(2)
    expect(report.silentSkips).toBe(2)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "BROWSER_GATE_FAILED",
      "MIGRATION_GATE_FAILED",
      "SILENT_SKIP",
    ]))
  })

  it("fails incomplete or dirty Adobe observations even when the process returned", () => {
    const raw = rawReport(metrics(), metrics(), metrics())
    raw.fixtures[0]!.candidate.preflightIssueCount = 1
    raw.fixtures[0]!.reopened.metrics = undefined
    raw.fixtures.push(raw.fixtures[0]!)
    const report = buildAdobeGateReport(manifest(), raw)

    expect(report.status).toBe("failed")
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ADOBE_PREFLIGHT_FAILED" }),
      expect.objectContaining({ code: "ADOBE_REOPEN_FAILED" }),
      expect.objectContaining({ code: "STRUCTURE_CHANGED", detail: expect.stringMatching(/duplicate/i) }),
    ]))
  })

  it("compares collection metrics independent of enumeration order", () => {
    const before = metrics()
    const after = metrics({
      pageItems: [...before.pageItems].reverse(),
      layers: [...before.layers].reverse(),
    })
    expect(structuralDifferences(before, after)).toEqual([])
  })
})

function manifest(): AdobeGateManifest {
  return {
    schemaVersion: 1,
    engineVersion: 2,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    preflightProfile: "Aquilla IDML Production",
    gates: { browser: "passed", migration: "passed" },
    fixtures: [{
      id: "mixed-runs",
      source: "source.idml",
      candidate: "candidate.idml",
      allowReflow: true,
      exportReport: { translated: 1, missing: 0, rejected: 0, unsupported: 0 },
    }],
  }
}

function rawReport(
  source: AdobeDocumentMetrics,
  candidate: AdobeDocumentMetrics,
  reopened: AdobeDocumentMetrics,
): AdobeRawReport {
    const observation = (value: AdobeDocumentMetrics) => ({
      opened: true,
      preflightCompleted: true,
      preflightIssueCount: 0,
      preflightResults: [],
      metrics: value,
  })
  return {
    schemaVersion: 1,
    executionMode: "indesign-server",
    adobeVersion: "21.0",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    fixtures: [{
      id: "mixed-runs",
      source: observation(source),
      candidate: observation(candidate),
      reopened: observation(reopened),
      pdf: { created: true, byteLength: 100 },
      savedIdml: { created: true, byteLength: 200 },
      errors: [],
    }],
  }
}

function metrics(overrides: Partial<AdobeDocumentMetrics> = {}): AdobeDocumentMetrics {
  return {
    pageCount: 2,
    spreadCount: 1,
    masterSpreadCount: 1,
    layerCount: 2,
    storyCount: 1,
    footnoteCount: 1,
    noteCount: 1,
    tableCount: 1,
    hyperlinkCount: 1,
    pageItems: [{
      id: 10,
      type: "TextFrame",
      geometricBounds: ["0", "0", "100", "100"],
      visibleBounds: ["0", "0", "100", "100"],
      objectStyle: "Body frame",
      layerId: 20,
      parentPageId: 30,
    }],
    tables: [{
      storyId: 42,
      index: 0,
      rowCount: 2,
      columnCount: 3,
      tableStyle: "Body table",
    }],
    paragraphAssignments: [{ storyId: 42, index: 0, style: "Body" }],
    characterAssignments: [{ storyId: 42, index: 0, style: "Bold" }],
    links: [{ id: 50, status: "NORMAL", type: "JPEG" }],
    layers: [{ id: 20, name: "Text" }, { id: 21, name: "Assets" }],
    masterSpreads: [{ id: 60, name: "A-Master", pageCount: 2 }],
    oversetStoryIds: [],
    ...overrides,
  }
}
