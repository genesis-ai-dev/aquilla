import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertManifest,
  buildAdobeGateReport,
  sha256File,
  type AdobeGateManifest,
  type AdobeRawReport,
} from "./idml-adobe/report"
import {
  prepareAdobeCorpus,
  resolveCleanGitCommit,
} from "./idml-adobe/prepare-corpus"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..")
const VALIDATOR = resolve(SCRIPT_DIR, "idml-adobe/validate.idjs")
const DEFAULT_CORPUS_MANIFEST = resolve(
  REPOSITORY_ROOT,
  "packages/idml-roundtrip/fixtures/manifest.json",
)

interface PreparedGate {
  manifest: AdobeGateManifest
  manifestPath: string
  rawReportPath: string
  finalReportPath: string
  desktopWrapperPath: string
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const options = parseOptions(rest)
  if (!command) {
    usage()
    process.exitCode = 2
    return
  }
  if (command === "prepare-corpus") {
    if (!options.outputDir) {
      usage()
      process.exitCode = 2
      return
    }
    const sourceCommit = await resolveCleanGitCommit(REPOSITORY_ROOT)
    const preparedCorpus = await prepareAdobeCorpus({
      corpusManifestPath: options.corpusManifest ?? DEFAULT_CORPUS_MANIFEST,
      outputDirectory: options.outputDir,
      sourceCommit,
      ...(options.preflightProfile
        ? { preflightProfile: options.preflightProfile }
        : {}),
      ...(options.browserGate ? { browserGate: options.browserGate } : {}),
      ...(options.migrationGate ? { migrationGate: options.migrationGate } : {}),
    })
    console.log(`Prepared ${preparedCorpus.manifest.fixtures.length} Adobe corpus candidate(s).`)
    console.log(`Manifest: ${preparedCorpus.manifestPath}`)
    console.log(`Source commit: ${preparedCorpus.manifest.sourceCommit}`)
    console.log(
      `Producer gates: browser=${preparedCorpus.manifest.gates.browser}, `
      + `migration=${preparedCorpus.manifest.gates.migration}`,
    )
    return
  }
  if (!options.manifest || !options.outputDir) {
    usage()
    process.exitCode = 2
    return
  }
  const executionMode = command === "run-server" ? "indesign-server" : "desktop-manual"
  const prepared = await prepare(options.manifest, options.outputDir, executionMode)

  if (command === "prepare-desktop") {
    console.log(`Prepared Adobe validation manifest: ${prepared.manifestPath}`)
    console.log(`Run this file from InDesign 18.5+ → Window → Utilities → Scripts:`)
    console.log(prepared.desktopWrapperPath)
    console.log(`Then finalize with:`)
    console.log(`pnpm idml:adobe finalize --manifest ${options.manifest} --output-dir ${options.outputDir}`)
    return
  }

  if (command === "run-server") {
    if (!options.sampleClient) {
      throw new Error("run-server requires --sample-client <path>.")
    }
    await runSampleClient(
      options.sampleClient,
      options.host ?? "localhost:12345",
      prepared,
    )
    await finalize(prepared)
    return
  }

  if (command === "finalize") {
    await finalize(prepared)
    return
  }

  usage()
  process.exitCode = 2
}

async function prepare(
  manifestPath: string,
  outputDirectory: string,
  executionMode: "indesign-server" | "desktop-manual",
): Promise<PreparedGate> {
  const absoluteManifest = resolve(manifestPath)
  const manifestDirectory = dirname(absoluteManifest)
  const outputDir = resolve(outputDirectory)
  await mkdir(outputDir, { recursive: true })
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8")) as AdobeGateManifest
  assertManifest(manifest)
  for (const fixture of manifest.fixtures) {
    await assertFixtureDigest(
      absoluteFrom(manifestDirectory, fixture.source),
      fixture.sourceSha256,
      fixture.id,
      "source",
    )
    await assertFixtureDigest(
      absoluteFrom(manifestDirectory, fixture.candidate),
      fixture.candidateSha256,
      fixture.id,
      "candidate",
    )
  }

  const materialized = {
    ...manifest,
    executionMode,
    fixtures: manifest.fixtures.map((fixture) => ({
      ...fixture,
      source: absoluteFrom(manifestDirectory, fixture.source),
      candidate: absoluteFrom(manifestDirectory, fixture.candidate),
      resavedIdml: join(outputDir, `${safeId(fixture.id)}.adobe-resaved.idml`),
      pdf: join(outputDir, `${safeId(fixture.id)}.pdf`),
    })),
  }
  const materializedPath = join(outputDir, "adobe-materialized-manifest.json")
  const rawReportPath = join(outputDir, "adobe-raw-report.json")
  const finalReportPath = join(outputDir, "adobe-gate-report.json")
  await writeFile(materializedPath, JSON.stringify(materialized, null, 2) + "\n")

  const desktopWrapperPath = join(outputDir, "run-adobe-validation.idjs")
  await writeFile(desktopWrapperPath, desktopWrapper(
    VALIDATOR,
    materializedPath,
    rawReportPath,
  ))
  return {
    manifest,
    manifestPath: materializedPath,
    rawReportPath,
    finalReportPath,
    desktopWrapperPath,
  }
}

async function finalize(prepared: PreparedGate): Promise<void> {
  const raw = JSON.parse(await readFile(prepared.rawReportPath, "utf8")) as AdobeRawReport & {
    fatal?: { message?: string }
  }
  if (raw.fatal) throw new Error(`Adobe validator failed: ${raw.fatal.message ?? "unknown error"}`)
  const report = buildAdobeGateReport(prepared.manifest, raw)
  await writeFile(prepared.finalReportPath, JSON.stringify(report, null, 2) + "\n")
  const digest = await sha256File(prepared.finalReportPath)
  console.log(`Adobe gate: ${report.status}`)
  console.log(`Fixtures: ${report.passedFixtureCount}/${report.fixtureCount}`)
  console.log(`Report: ${prepared.finalReportPath}`)
  console.log(`SHA-256: ${digest}`)
  if (report.status !== "passed") process.exitCode = 1
}

async function runSampleClient(
  sampleClient: string,
  host: string,
  prepared: PreparedGate,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolve(sampleClient), [
      "-host",
      host,
      VALIDATOR,
      `manifest=${prepared.manifestPath}`,
      `output=${prepared.rawReportPath}`,
    ], {
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`InDesign Server sampleclient exited ${String(code ?? signal)}.`))
    })
  })
}

function desktopWrapper(
  validatorPath: string,
  manifestPath: string,
  outputPath: string,
): string {
  return [
    "const { app, ScriptLanguage } = require(\"indesign\")",
    `const result = app.doScript(${JSON.stringify(validatorPath)}, ScriptLanguage.UXPSCRIPT, [`,
    `  ${JSON.stringify(`manifest=${manifestPath}`)},`,
    `  ${JSON.stringify(`output=${outputPath}`)},`,
    "])",
    "console.log(result)",
    "",
  ].join("\n")
}

function parseOptions(args: string[]): Record<string, string | undefined> & {
  manifest?: string
  outputDir?: string
  sampleClient?: string
  host?: string
  corpusManifest?: string
  preflightProfile?: string
  browserGate?: string
  migrationGate?: string
} {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument ${String(key)}.`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`)
    options[toCamelCase(key.slice(2))] = value
    index += 1
  }
  return options
}

function absoluteFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path)
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-")
}

async function assertFixtureDigest(
  path: string,
  expected: string | undefined,
  fixtureId: string,
  kind: "source" | "candidate",
): Promise<void> {
  if (!expected) return
  const actual = await sha256File(path)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Adobe fixture ${fixtureId} ${kind} SHA-256 does not match its manifest.`,
    )
  }
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function usage(): void {
  console.error([
    "Usage:",
    "  pnpm idml:adobe prepare-corpus --output-dir <dir> [--corpus-manifest <manifest.json>] [--preflight-profile <name>] [--browser-gate passed|failed] [--migration-gate passed|failed]",
    "  pnpm idml:adobe prepare-desktop --manifest <manifest.json> --output-dir <dir>",
    "  pnpm idml:adobe run-server --manifest <manifest.json> --output-dir <dir> --sample-client <path> [--host localhost:12345]",
    "  pnpm idml:adobe finalize --manifest <manifest.json> --output-dir <dir>",
  ].join("\n"))
}

main().catch((error) => {
  console.error(`[idml-adobe] ${(error as Error).message}`)
  process.exitCode = 1
})
