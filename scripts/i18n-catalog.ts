/**
 * i18n catalog CLI (AQU-832) — the two ends of the dogfood loop.
 *
 *   pnpm i18n:check
 *     Lint the context sidecar against the base catalog. Same check the
 *     `context.test.ts` suite runs, exposed as a standalone command so it can be
 *     wired into a pre-commit hook or a docs example without booting vitest.
 *
 *   pnpm i18n:export [outDir]              (default: i18n-export/)
 *     Write the files a translator or the translation agent needs:
 *       en.context.json      — the context sidecar, in the AQU-832 interchange shape
 *       <locale>.catalog.json — the source file to import into an Aquilla project
 *       <locale>.notes.json   — leaf key → flattened context note, which is what
 *                               lands on each imported cell / in the agent prompt
 *
 *     One catalog per target locale, not one shared `en.catalog.json`, because
 *     count-governed keys export one cell per plural category and the category
 *     set is a property of the *target* language: Arabic needs six cells where
 *     Thai needs one. `en.*` is still emitted, as the base/reference pair.
 *
 *   pnpm i18n:import <locale> <translated.json> [--replace]
 *     Take the JSON exported back out of the project and regenerate
 *     `src/lib/i18n/messages/<locale>.ts`, reporting untranslated, stale, and
 *     unknown keys instead of silently shipping a half-empty catalog.
 *
 *     Default is a MERGE: the existing catalog is loaded and the incoming
 *     translations are overlaid on top, so a file that only carries newly
 *     added keys does not wipe out everything translated before it. Pass
 *     `--replace` for the old full-replacement behaviour (only ever wanted for
 *     a genuine from-scratch retranslation).
 *
 *     A source-hash sidecar (`src/lib/i18n/source-hashes.json`) records which
 *     English source each translated key was last translated against, so a
 *     later change to that English string flags the carried-over translation
 *     as stale instead of shipping it — and being reported as translated —
 *     undetectably out of date.
 *
 * See docs/I18N-CONTEXT-CATALOG.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCatalogSourceJson,
  buildContextSidecarJson,
  catalogLeafKeys,
  contextNote,
  importCatalog,
  parseLeafKey,
  renderCatalogModule,
  type SourceHashes,
} from "../src/lib/i18n/catalog-export"
import { MESSAGE_KEYS, catalogContextIssues } from "../src/lib/i18n/context"
import { DEFAULT_LOCALE, LOCALES, isSupportedLocale } from "../src/lib/i18n/locales"
import { CATALOGS } from "../src/lib/i18n/messages"
import type { MessageKey } from "../src/lib/i18n/messages/en"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_OUT_DIR = "i18n-export"
const MESSAGES_DIR = join(REPO_ROOT, "src/lib/i18n/messages")
const SOURCE_HASHES_PATH = join(REPO_ROOT, "src/lib/i18n/source-hashes.json")

function fail(message: string): never {
  console.error(`i18n-catalog: ${message}`)
  process.exit(1)
}

function runCheck(): void {
  const issues = catalogContextIssues()
  if (issues.length > 0) {
    console.error(
      `i18n-catalog: ${issues.length} context issue(s) — every message key needs a ` +
        `namespace \`_context\` or its own description (docs/I18N-CONTEXT-CATALOG.md):\n`,
    )
    for (const issue of issues) console.error(`  • ${issue}`)
    process.exit(1)
  }
  console.log(
    `i18n-catalog: context complete — ${MESSAGE_KEYS.length} message key(s) covered.`,
  )
}

function runExport(outDirArg?: string): void {
  const outDir = resolve(REPO_ROOT, outDirArg ?? DEFAULT_OUT_DIR)
  mkdirSync(outDir, { recursive: true })

  const files: Array<[string, string]> = [
    ["en.context.json", buildContextSidecarJson()],
  ]
  for (const { code } of LOCALES) {
    const notes: Record<string, string> = {}
    for (const leaf of catalogLeafKeys(code)) {
      const { key, category } = parseLeafKey(leaf)
      notes[leaf] = contextNote(key as MessageKey, code, category)
    }
    files.push([`${code}.catalog.json`, buildCatalogSourceJson(code)])
    files.push([`${code}.notes.json`, JSON.stringify(notes, null, 2) + "\n"])
  }
  for (const [name, contents] of files) {
    writeFileSync(join(outDir, name), contents, "utf8")
    console.log(`i18n-catalog: wrote ${join(outDirArg ?? DEFAULT_OUT_DIR, name)}`)
  }
  console.log(
    `\nNext: import <locale>.catalog.json into an Aquilla project as a JSON i18n ` +
      `source, attaching each cell's note from <locale>.notes.json.`,
  )
}

/** All locales' source-hash sidecars, keyed by locale code. Missing file reads as empty. */
function loadSourceHashes(): Record<string, SourceHashes> {
  if (!existsSync(SOURCE_HASHES_PATH)) return {}
  return JSON.parse(readFileSync(SOURCE_HASHES_PATH, "utf8")) as Record<string, SourceHashes>
}

function saveSourceHashes(all: Record<string, SourceHashes>): void {
  writeFileSync(SOURCE_HASHES_PATH, JSON.stringify(all, null, 2) + "\n", "utf8")
}

function runImport(locale?: string, file?: string, opts: { replace?: boolean } = {}): void {
  if (!locale || !file) fail("usage: i18n:import <locale> <translated.json> [--replace]")
  if (!isSupportedLocale(locale)) {
    fail(`unknown locale "${locale}" — add it to src/lib/i18n/locales.ts first`)
  }
  if (locale === DEFAULT_LOCALE) {
    fail(`"${DEFAULT_LOCALE}" is the base catalog and is authored, not generated`)
  }

  const json = readFileSync(resolve(process.cwd(), file), "utf8")
  const allHashes = loadSourceHashes()
  const outcome = importCatalog(
    json,
    CATALOGS[locale] ?? {},
    allHashes[locale] ?? {},
    opts,
  )

  const target = join(MESSAGES_DIR, `${locale}.ts`)
  writeFileSync(target, renderCatalogModule(locale, outcome.catalog), "utf8")
  allHashes[locale] = outcome.hashes
  saveSourceHashes(allHashes)

  const translated = MESSAGE_KEYS.length - outcome.untranslatedKeys.length
  console.log(
    `i18n-catalog: wrote src/lib/i18n/messages/${locale}.ts ` +
      `(${opts.replace ? "replace" : "merge"}) — ` +
      `${translated}/${MESSAGE_KEYS.length} key(s) translated.`,
  )
  if (outcome.untranslatedKeys.length > 0) {
    console.log(
      `\n  Untranslated (never translated for this locale, falls back to English, ` +
        `safe to ship):\n` +
        outcome.untranslatedKeys.map((k) => `    • ${k}`).join("\n"),
    )
  }
  if (outcome.staleKeys.length > 0) {
    console.warn(
      `\n  Stale — English source changed since these were translated (still shipping ` +
        `the existing translation; re-translate to refresh):\n` +
        outcome.staleKeys.map((k) => `    • ${k}`).join("\n"),
    )
  }
  if (outcome.unknownKeys.length > 0) {
    console.warn(
      `\n  Ignored — no longer in the base catalog (renamed or removed since export):\n` +
        outcome.unknownKeys.map((k) => `    • ${k}`).join("\n"),
    )
  }
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case "check":
    runCheck()
    break
  case "export":
    runExport(rest[0])
    break
  case "import": {
    const flags = rest.filter((a) => a.startsWith("--"))
    const positional = rest.filter((a) => !a.startsWith("--"))
    runImport(positional[0], positional[1], { replace: flags.includes("--replace") })
    break
  }
  default:
    fail(`unknown command "${command ?? ""}" — expected check | export | import`)
}
