/**
 * i18n catalog CLI (AQU-832) — the two ends of the dogfood loop.
 *
 *   pnpm i18n:check
 *     Lint the context sidecar against the base catalog. Same check the
 *     `context.test.ts` suite runs, exposed as a standalone command so it can be
 *     wired into a pre-commit hook or a docs example without booting vitest.
 *
 *   pnpm i18n:export [outDir]              (default: i18n-export/)
 *     Write the three files a translator or the translation agent needs:
 *       en.catalog.json  — the source file to import into an Aquilla project
 *       en.context.json  — the context sidecar, in the AQU-832 interchange shape
 *       en.notes.json    — message key → flattened context note, which is what
 *                          lands on each imported cell / in the agent prompt
 *
 *   pnpm i18n:import <locale> <translated.json>
 *     Take the JSON exported back out of the project and regenerate
 *     `src/lib/i18n/messages/<locale>.ts`, reporting untranslated and unknown
 *     keys instead of silently shipping a half-empty catalog.
 *
 * See docs/I18N-CONTEXT-CATALOG.md.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCatalogSourceJson,
  buildContextSidecarJson,
  contextNote,
  parseTranslatedCatalog,
  renderCatalogModule,
} from "../src/lib/i18n/catalog-export"
import { MESSAGE_KEYS, catalogContextIssues } from "../src/lib/i18n/context"
import { DEFAULT_LOCALE, isSupportedLocale } from "../src/lib/i18n/locales"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_OUT_DIR = "i18n-export"
const MESSAGES_DIR = join(REPO_ROOT, "src/lib/i18n/messages")

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

  const notes: Record<string, string> = {}
  for (const key of MESSAGE_KEYS) notes[key] = contextNote(key)

  const files: Array<[string, string]> = [
    ["en.catalog.json", buildCatalogSourceJson()],
    ["en.context.json", buildContextSidecarJson()],
    ["en.notes.json", JSON.stringify(notes, null, 2) + "\n"],
  ]
  for (const [name, contents] of files) {
    writeFileSync(join(outDir, name), contents, "utf8")
    console.log(`i18n-catalog: wrote ${join(outDirArg ?? DEFAULT_OUT_DIR, name)}`)
  }
  console.log(
    `\nNext: import en.catalog.json into an Aquilla project as a JSON i18n source, ` +
      `attaching each cell's note from en.notes.json.`,
  )
}

function runImport(locale?: string, file?: string): void {
  if (!locale || !file) fail("usage: i18n:import <locale> <translated.json>")
  if (!isSupportedLocale(locale)) {
    fail(`unknown locale "${locale}" — add it to src/lib/i18n/locales.ts first`)
  }
  if (locale === DEFAULT_LOCALE) {
    fail(`"${DEFAULT_LOCALE}" is the base catalog and is authored, not generated`)
  }

  const json = readFileSync(resolve(process.cwd(), file), "utf8")
  const { catalog, unknownKeys, missingKeys } = parseTranslatedCatalog(json)

  const target = join(MESSAGES_DIR, `${locale}.ts`)
  writeFileSync(target, renderCatalogModule(locale, catalog), "utf8")

  const translated = MESSAGE_KEYS.length - missingKeys.length
  console.log(
    `i18n-catalog: wrote src/lib/i18n/messages/${locale}.ts — ` +
      `${translated}/${MESSAGE_KEYS.length} key(s) translated.`,
  )
  if (missingKeys.length > 0) {
    console.log(
      `\n  Untranslated (falls back to English, safe to ship):\n` +
        missingKeys.map((k) => `    • ${k}`).join("\n"),
    )
  }
  if (unknownKeys.length > 0) {
    console.warn(
      `\n  Ignored — no longer in the base catalog (renamed or removed since export):\n` +
        unknownKeys.map((k) => `    • ${k}`).join("\n"),
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
  case "import":
    runImport(rest[0], rest[1])
    break
  default:
    fail(`unknown command "${command ?? ""}" — expected check | export | import`)
}
