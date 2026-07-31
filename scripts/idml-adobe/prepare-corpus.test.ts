import { spawnSync } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import {
  parseIdml,
  validateExport,
} from "@aquilla/idml-roundtrip"
import { afterEach, describe, expect, it } from "vitest"

import {
  classifyUnsupportedDiagnostics,
  deterministicTargetHtml,
  prepareAdobeCorpus,
} from "./prepare-corpus"
import { assertManifest } from "./report"

const CORPUS_MANIFEST = resolve(
  import.meta.dirname,
  "../../packages/idml-roundtrip/fixtures/manifest.json",
)
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567"
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("Adobe corpus preparation", () => {
  it("strict-exports every committed valid fixture and defaults external gates to not-run", async () => {
    const outputDirectory = temporaryDirectory("default-gates")
    const prepared = await prepareAdobeCorpus({
      corpusManifestPath: CORPUS_MANIFEST,
      outputDirectory,
      sourceCommit: SOURCE_COMMIT,
    })

    expect(prepared.manifest.sourceCommit).toBe(SOURCE_COMMIT)
    expect(prepared.manifest.gates).toEqual({
      browser: "not-run",
      migration: "not-run",
    })
    expect(prepared.manifest.fixtures.map((fixture) => fixture.id)).toEqual([
      "feature-rich",
      "biblica-profile",
    ])
    expect(() => assertManifest(prepared.manifest)).not.toThrow()

    for (const fixture of prepared.manifest.fixtures) {
      const sourcePath = resolve(dirname(prepared.manifestPath), fixture.source)
      const candidatePath = resolve(dirname(prepared.manifestPath), fixture.candidate)
      const sourceBytes = new Uint8Array(await readFile(sourcePath))
      const candidateBytes = new Uint8Array(await readFile(candidatePath))
      const parsedSource = await parseIdml(sourceBytes, "generic")
      const parsedCandidate = await parseIdml(candidateBytes, "generic")

      expect(fixture.exportReport).toMatchObject({
        translated: parsedSource.units.length,
        missing: 0,
        rejected: 0,
        unsupportedLiteral: 0,
      })
      expect(fixture.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(fixture.candidateSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(await validateExport(candidateBytes, parsedSource.manifest)).toEqual([])
      expect(parsedCandidate.units).toHaveLength(parsedSource.units.length)
      for (const unit of parsedCandidate.units) {
        expect(unit.sourceText).toContain(
          `[AQUILLA-ADOBE:${fixture.id}:${String(unit.order).padStart(4, "0")}]`,
        )
      }
    }
    expect(prepared.manifest.fixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "feature-rich",
        exportReport: expect.objectContaining({
          unsupportedLiteral: 0,
          // Two of these five are the embedded processing instructions the
          // engine started preserving in AQU-551. Preserving them raises this
          // count; what the Adobe gate cares about is that none of them
          // degraded into an unsupportedLiteral text skip.
          preservedUnsupported: 5,
        }),
      }),
      expect.objectContaining({
        id: "biblica-profile",
        exportReport: expect.objectContaining({
          unsupportedLiteral: 0,
          preservedUnsupported: 0,
        }),
      }),
    ]))
  })

  it("produces byte-identical candidates and manifest on a repeated run", async () => {
    const outputDirectory = temporaryDirectory("deterministic")
    const options = {
      corpusManifestPath: CORPUS_MANIFEST,
      outputDirectory,
      sourceCommit: SOURCE_COMMIT,
      browserGate: "passed",
    }
    const first = await prepareAdobeCorpus(options)
    const firstManifest = await readFile(first.manifestPath)
    const firstCandidates = await candidateBytes(first)

    const second = await prepareAdobeCorpus(options)
    expect(await readFile(second.manifestPath)).toEqual(firstManifest)
    expect(await candidateBytes(second)).toEqual(firstCandidates)
    expect(second.manifest.gates).toEqual({
      browser: "passed",
      migration: "not-run",
    })
  })

  it("sets producer gates only from explicit valid values", async () => {
    const outputDirectory = temporaryDirectory("explicit-gates")
    const prepared = await prepareAdobeCorpus({
      corpusManifestPath: CORPUS_MANIFEST,
      outputDirectory,
      sourceCommit: SOURCE_COMMIT,
      browserGate: "failed",
      migrationGate: "passed",
    })
    expect(prepared.manifest.gates).toEqual({
      browser: "failed",
      migration: "passed",
    })

    await expect(prepareAdobeCorpus({
      corpusManifestPath: CORPUS_MANIFEST,
      outputDirectory,
      sourceCommit: SOURCE_COMMIT,
      browserGate: "not-run",
    })).rejects.toThrow(/browser-gate must be passed or failed/i)
  })

  it("preserves protected anchors when constructing deterministic target HTML", async () => {
    const corpus = JSON.parse(await readFile(CORPUS_MANIFEST, "utf8")) as {
      valid: Array<{ path: string }>
    }
    const bytes = new Uint8Array(
      await readFile(resolve(dirname(CORPUS_MANIFEST), corpus.valid[0]!.path)),
    )
    const parsed = await parseIdml(bytes, "generic")
    const unit = parsed.units[0]!
    const target = deterministicTargetHtml(
      unit.sourceHtml,
      unit.metadata,
      "feature-rich",
      unit.order,
    )

    expect(target).not.toBe(unit.sourceHtml)
    expect(
      target.match(/data-idml-(?:slot|token)=/g),
    ).toEqual(unit.sourceHtml.match(/data-idml-(?:slot|token)=/g))
  })

  it("keeps unclassified unsupported diagnostics fail-closed", () => {
    expect(classifyUnsupportedDiagnostics([
      {
        code: "UNSUPPORTED_CONSTRUCT",
        severity: "warning",
        message: "future unsupported construct",
      },
      {
        code: "UNSUPPORTED_CONSTRUCT",
        severity: "warning",
        message: "proven computed construct",
        details: { unsupportedDisposition: "preserved-nonliteral" },
      },
    ])).toEqual({
      unsupportedLiteral: 1,
      preservedUnsupported: 1,
    })
  })

  it("prints command help without requiring a value for --help", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..")
    const result = spawnSync(
      "pnpm",
      ["idml:adobe", "prepare-corpus", "--help"],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("pnpm idml:adobe prepare-corpus")
    expect(result.stderr).not.toContain("requires a value")
  })
})

function temporaryDirectory(label: string): string {
  const path = resolve(
    tmpdir(),
    `aquilla-idml-adobe-${label}-${process.pid}-${temporaryDirectories.length}`,
  )
  temporaryDirectories.push(path)
  return path
}

async function candidateBytes(
  prepared: Awaited<ReturnType<typeof prepareAdobeCorpus>>,
): Promise<Uint8Array[]> {
  return await Promise.all(prepared.manifest.fixtures.map(async (fixture) => (
    new Uint8Array(
      await readFile(resolve(dirname(prepared.manifestPath), fixture.candidate)),
    )
  )))
}
