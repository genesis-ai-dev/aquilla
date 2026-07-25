import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"

import {
  exportIdml,
  parseIdml,
  validateExport,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
  type IdmlTranslation,
} from "@aquilla/idml-roundtrip"

import {
  assertManifest,
  type AdobeGateManifest,
} from "./report"

const DEFAULT_PREFLIGHT_PROFILE = "Aquilla IDML Production"
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

interface ValidCorpusFixture {
  readonly path: string
  readonly sha256: string
}

interface CorpusManifest {
  readonly version: number
  readonly generated: boolean
  readonly valid: readonly ValidCorpusFixture[]
}

export interface PrepareAdobeCorpusOptions {
  readonly corpusManifestPath: string
  readonly outputDirectory: string
  readonly sourceCommit: string
  readonly preflightProfile?: string
  readonly browserGate?: string
  readonly migrationGate?: string
}

export interface PreparedAdobeCorpus {
  readonly manifest: AdobeGateManifest
  readonly manifestPath: string
}

/**
 * Builds deterministic, strict-exported Adobe candidates from every valid
 * fixture listed by the committed conformance manifest. This does not run
 * InDesign or claim that any external producer/consumer gate has passed.
 */
export async function prepareAdobeCorpus(
  options: PrepareAdobeCorpusOptions,
): Promise<PreparedAdobeCorpus> {
  const sourceCommit = normalizeSourceCommit(options.sourceCommit)
  const browserGate = explicitGate(options.browserGate, "browser")
  const migrationGate = explicitGate(options.migrationGate, "migration")
  const preflightProfile = options.preflightProfile?.trim() || DEFAULT_PREFLIGHT_PROFILE
  const corpusManifestPath = resolve(options.corpusManifestPath)
  const corpusDirectory = dirname(corpusManifestPath)
  const outputDirectory = resolve(options.outputDirectory)
  const candidateDirectory = resolve(outputDirectory, "candidates")
  const corpus = parseCorpusManifest(
    JSON.parse(await readFile(corpusManifestPath, "utf8")) as unknown,
  )

  const fixtureIds = new Set<string>()
  const fixtureInputs = corpus.valid.map((fixture) => {
    const sourcePath = resolveCorpusPath(corpusDirectory, fixture.path)
    const id = fixtureId(fixture.path)
    if (fixtureIds.has(id)) {
      throw new Error(`Valid corpus fixtures produce duplicate Adobe ID ${id}.`)
    }
    fixtureIds.add(id)
    return { fixture, sourcePath, id }
  })

  await mkdir(candidateDirectory, { recursive: true })
  const fixtures: AdobeGateManifest["fixtures"][number][] = []
  for (const input of fixtureInputs) {
    const sourceBytes = new Uint8Array(await readFile(input.sourcePath))
    const sourceSha256 = sha256(sourceBytes)
    if (sourceSha256 !== input.fixture.sha256.toLowerCase()) {
      throw new Error(
        `Committed corpus checksum mismatch for ${input.fixture.path}: `
        + `expected ${input.fixture.sha256}, received ${sourceSha256}.`,
      )
    }

    const parsed = await parseIdml(sourceBytes, "generic")
    if (parsed.units.length === 0) {
      throw new Error(`Valid corpus fixture ${input.fixture.path} produced no translation units.`)
    }
    const translations = parsed.units.map((unit): IdmlTranslation => {
      const targetHtml = deterministicTargetHtml(
        unit.sourceHtml,
        unit.metadata,
        input.id,
        unit.order,
      )
      const validation = validateIdmlTranslation(
        unit.sourceHtml,
        targetHtml,
        unit.metadata,
      )
      if (!validation.valid) {
        const codes = validation.diagnostics.map((diagnostic) => diagnostic.code).join(", ")
        throw new Error(
          `Generated Adobe translation for ${input.id}/${unit.id} failed anchor validation: ${codes}.`,
        )
      }
      return {
        unitId: unit.id,
        locator: unit.locator,
        metadata: unit.metadata,
        sourceHtml: unit.sourceHtml,
        targetHtml,
      }
    })

    const exported = await exportIdml(sourceBytes, translations, { strict: true })
    if (
      exported.report.translated !== parsed.units.length
      || exported.report.missing !== 0
      || exported.report.rejected !== 0
    ) {
      throw new Error(
        `Strict export for ${input.fixture.path} did not translate every unit `
        + `(${exported.report.translated}/${parsed.units.length}; `
        + `${exported.report.missing} missing; ${exported.report.rejected} rejected).`,
      )
    }
    const exportDiagnostics = await validateExport(exported.bytes, parsed.manifest)
    if (exportDiagnostics.length > 0) {
      throw new Error(
        `Export validation failed for ${input.fixture.path}: `
        + exportDiagnostics.map((diagnostic) => diagnostic.code).join(", "),
      )
    }

    const candidatePath = resolve(candidateDirectory, `${input.id}.candidate.idml`)
    await writeFileAtomic(candidatePath, exported.bytes)
    fixtures.push({
      id: input.id,
      source: relativeManifestPath(outputDirectory, input.sourcePath),
      candidate: relativeManifestPath(outputDirectory, candidatePath),
      sourceSha256,
      candidateSha256: sha256(exported.bytes),
      allowReflow: true,
      exportReport: {
        translated: exported.report.translated,
        missing: exported.report.missing,
        rejected: exported.report.rejected,
        unsupported: exported.report.unsupported,
      },
    })
  }

  const manifest: AdobeGateManifest = {
    schemaVersion: 1,
    engineVersion: 2,
    sourceCommit,
    preflightProfile,
    gates: {
      browser: browserGate,
      migration: migrationGate,
    },
    fixtures,
  }
  assertManifest(manifest)
  const manifestPath = resolve(outputDirectory, "adobe-manifest.json")
  await writeFileAtomic(
    manifestPath,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  )
  return { manifest, manifestPath }
}

/**
 * Resolve the exact commit under test and reject tracked changes. Otherwise
 * the generated evidence could claim a commit that did not produce it.
 */
export async function resolveCleanGitCommit(repositoryRoot: string): Promise<string> {
  const root = resolve(repositoryRoot)
  const [sourceCommit, trackedStatus] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
  ])
  if (trackedStatus.trim()) {
    throw new Error(
      "Corpus preparation requires a clean tracked worktree so its output is bound to HEAD.",
    )
  }
  return normalizeSourceCommit(sourceCommit.trim())
}

export function deterministicTargetHtml(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
  fixtureIdValue: string,
  unitOrder: number,
): string {
  const slotIndex = metadata.editableSlotIndexes[0]
  if (slotIndex === undefined) {
    throw new Error(`Adobe fixture ${fixtureIdValue} unit ${unitOrder} has no editable text slot.`)
  }
  const anchor = `<span data-idml-slot="${slotIndex}"`
  const anchorStart = sourceHtml.indexOf(anchor)
  const contentStart = sourceHtml.indexOf(">", anchorStart) + 1
  if (anchorStart < 0 || contentStart === 0) {
    throw new Error(
      `Adobe fixture ${fixtureIdValue} unit ${unitOrder} lost editable slot ${slotIndex}.`,
    )
  }
  const marker = `[AQUILLA-ADOBE:${fixtureIdValue}:${String(unitOrder).padStart(4, "0")}] `
  return `${sourceHtml.slice(0, contentStart)}${marker}${sourceHtml.slice(contentStart)}`
}

function parseCorpusManifest(value: unknown): CorpusManifest {
  const manifest = value as Partial<CorpusManifest> | null
  if (
    !manifest
    || manifest.version !== 1
    || manifest.generated !== true
    || !Array.isArray(manifest.valid)
    || manifest.valid.length === 0
  ) {
    throw new Error("IDML corpus manifest is missing its generated valid-fixture list.")
  }
  for (const fixture of manifest.valid) {
    if (
      !fixture
      || typeof fixture.path !== "string"
      || fixture.path.length === 0
      || typeof fixture.sha256 !== "string"
      || !SHA256.test(fixture.sha256)
    ) {
      throw new Error("IDML corpus manifest contains an invalid valid-fixture entry.")
    }
  }
  return manifest as CorpusManifest
}

function resolveCorpusPath(corpusDirectory: string, fixturePath: string): string {
  if (isAbsolute(fixturePath)) {
    throw new Error(`Corpus fixture path must be relative: ${fixturePath}.`)
  }
  const absolute = resolve(corpusDirectory, fixturePath)
  const fromCorpus = relative(corpusDirectory, absolute)
  if (fromCorpus === ".." || fromCorpus.startsWith(`..${sep}`) || isAbsolute(fromCorpus)) {
    throw new Error(`Corpus fixture path escapes the corpus directory: ${fixturePath}.`)
  }
  return absolute
}

function fixtureId(path: string): string {
  const name = basename(path, extname(path))
  const id = name.replace(/[^A-Za-z0-9._-]+/g, "-")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Corpus fixture path cannot produce a safe Adobe ID: ${path}.`)
  }
  return id
}

function explicitGate(
  value: string | undefined,
  name: "browser" | "migration",
): "passed" | "failed" | "not-run" {
  if (value === undefined) return "not-run"
  if (value === "passed" || value === "failed") return value
  throw new Error(`--${name}-gate must be passed or failed when explicitly supplied.`)
}

function normalizeSourceCommit(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!FULL_GIT_SHA.test(normalized)) {
    throw new Error("Adobe corpus preparation requires the current full 40-character git SHA.")
  }
  return normalized
}

function relativeManifestPath(manifestDirectory: string, path: string): string {
  const value = relative(manifestDirectory, path).split(sep).join("/")
  return value.startsWith(".") ? value : `./${value}`
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, bytes)
  await rename(temporaryPath, path)
}

async function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", repositoryRoot, ...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`))
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}
