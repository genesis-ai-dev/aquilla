/**
 * i18n catalog CLI (AQU-832) — the two ends of the dogfood loop.
 *
 *   pnpm i18n:check
 *     Lint the context sidecar against the base catalog. Same check the
 *     `context.test.ts` suite runs, exposed as a standalone command so it can be
 *     wired into a pre-commit hook or a docs example without booting vitest.
 *     It also fails an English message that uses a retired word from the
 *     interface's word list (AQU-2261, src/lib/i18n/retired-terms.ts), naming
 *     the word to write instead.
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
 *     The import also prunes the translation baseline (AQU-2740) for that
 *     locale: every key it filled stops being an allowed gap.
 *
 *   pnpm i18n:import-todo [dir]            (default: i18n-todo/)
 *     Import every `<locale>.todo.json` packet in `dir` — the second half of
 *     `pnpm i18n:todo --new`. Same merge as `import`, once per locale.
 *
 *   pnpm i18n:baseline [--rebuild | --allow <key>… [--locale <code>…]]
 *     Maintain `src/lib/i18n/translation-baseline.json`, the keys each locale is
 *     still allowed to show in English (AQU-2740, src/lib/i18n/coverage.ts).
 *     With no flag it only prunes entries that are no longer gaps. `--allow`
 *     adds keys that should read the same in every language (a product name,
 *     a format). `--rebuild` allows every current gap — the one way to grow the
 *     baseline wholesale, so it belongs in a commit of its own that says why.
 *
 * `check` fails on a gap the baseline does not allow, and on a baseline entry
 * that is no longer a gap, so the baseline only shrinks.
 *
 * See docs/I18N-CONTEXT-CATALOG.md.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
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
import {
  allLocaleGaps,
  allowInBaseline,
  baselineCounts,
  baselineFromGaps,
  coverageViolations,
  localeGaps,
  pruneBaseline,
  renderBaseline,
  unprunedEntries,
  type TranslationBaseline,
} from "../src/lib/i18n/coverage"
import { DEFAULT_LOCALE, LOCALES, isSupportedLocale } from "../src/lib/i18n/locales"
import { CATALOGS, unknownCatalogKeys } from "../src/lib/i18n/messages/all"
import { retiredTermIssues } from "../src/lib/i18n/retired-terms"
import type { MessageKey } from "../src/lib/i18n/messages/en"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_OUT_DIR = "i18n-export"
const MESSAGES_DIR = join(REPO_ROOT, "src/lib/i18n/messages")
const SOURCE_HASHES_PATH = join(REPO_ROOT, "src/lib/i18n/source-hashes.json")
const BASELINE_PATH = join(REPO_ROOT, "src/lib/i18n/translation-baseline.json")
const DEFAULT_TODO_DIR = "i18n-todo"
/** How many violations `check` lists before summarizing the rest. */
const LIST_LIMIT = 40

function fail(message: string): never {
  console.error(`i18n-catalog: ${message}`)
  process.exit(1)
}

function runCheck(): void {
  const issues = [...catalogContextIssues(), ...unknownCatalogKeys()]
  // AQU-2261: the interface's word list. An English message may not use a
  // retired word; each failure names the word to write instead.
  const retired = retiredTermIssues()
  if (issues.length > 0) {
    console.error(
      `i18n-catalog: ${issues.length} context issue(s) — every message key needs a ` +
        `namespace \`_context\` or its own description (docs/I18N-CONTEXT-CATALOG.md):\n`,
    )
    for (const issue of issues) console.error(`  • ${issue}`)
  }
  if (retired.length > 0) {
    console.error(
      `${issues.length > 0 ? "\n" : ""}i18n-catalog: ${retired.length} retired word(s) in English ` +
        `messages — see src/lib/i18n/retired-terms.ts and docs/UI-GLOSSARY.md:\n`,
    )
    for (const issue of retired) console.error(`  • ${issue}`)
  }
  const coverage = coverageIssues()
  if (coverage.length > 0) {
    if (issues.length > 0 || retired.length > 0) console.error("")
    for (const line of coverage) console.error(line)
  }
  if (issues.length > 0 || retired.length > 0 || coverage.length > 0) process.exit(1)
  console.log(
    `i18n-catalog: context complete — ${MESSAGE_KEYS.length} message key(s) covered, ` +
      `no retired words, every locale translated outside the baseline.`,
  )
}

/**
 * AQU-2740: the translation ratchet. Returns the lines to print, empty when the
 * catalogs and the baseline agree.
 */
function coverageIssues(): string[] {
  const gaps = allLocaleGaps(CATALOGS, loadSourceHashes())
  const baseline = loadBaseline()
  const lines: string[] = []

  const violations = coverageViolations(gaps, baseline)
  if (violations.length > 0) {
    const keys = new Set(violations.map((v) => v.key))
    lines.push(
      `i18n-catalog: ${keys.size} English message(s) are not translated in every locale ` +
        `(${violations.length} locale gap(s)). New or reworded English ships with its ` +
        `translations (docs/I18N-CONTEXT-CATALOG.md → "Translating a branch's new strings"):\n`,
    )
    const byKey = new Map<string, string[]>()
    for (const v of violations) {
      byKey.set(v.key, [...(byKey.get(v.key) ?? []), v.kind === "stale" ? `${v.locale} (stale)` : v.locale])
    }
    for (const [key, locales] of [...byKey].slice(0, LIST_LIMIT)) {
      lines.push(`  • ${key}: ${locales.join(", ")}`)
    }
    if (byKey.size > LIST_LIMIT) lines.push(`  … and ${byKey.size - LIST_LIMIT} more key(s)`)
    lines.push(
      `\n  Fix: pnpm i18n:todo --new, translate the values in i18n-todo/<locale>.todo.json, ` +
        `then pnpm i18n:import-todo.` +
        `\n  A string that must read the same in every language: pnpm i18n:baseline --allow <key>.`,
    )
  }

  const unpruned = unprunedEntries(gaps, baseline)
  if (unpruned.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(
      `i18n-catalog: ${unpruned.length} translation-baseline entr(ies) are no longer gaps ` +
        `(translated since, or the key is gone). Run pnpm i18n:baseline to prune them:`,
    )
    for (const { key, locale } of unpruned.slice(0, LIST_LIMIT)) lines.push(`  • ${key}: ${locale}`)
    if (unpruned.length > LIST_LIMIT) lines.push(`  … and ${unpruned.length - LIST_LIMIT} more`)
  }
  return lines
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

/** The committed translation baseline. A missing file allows no gaps at all. */
function loadBaseline(): TranslationBaseline {
  if (!existsSync(BASELINE_PATH)) return {}
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as TranslationBaseline
}

function saveBaseline(baseline: TranslationBaseline): void {
  writeFileSync(BASELINE_PATH, renderBaseline(baseline), "utf8")
}

function runImport(
  locale?: string,
  file?: string,
  opts: { replace?: boolean; quiet?: boolean } = {},
): void {
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

  // AQU-2740: what this import filled is no longer an allowed gap for this
  // locale. Pruning here keeps the baseline current with no extra step, and
  // keeps an import commit to the generated files the release plan expects.
  const before = loadBaseline()
  const pruned = pruneBaseline(
    before,
    new Map([[locale, localeGaps(outcome.catalog, outcome.hashes)]]),
    locale,
  )
  const prunedCount = (baselineCounts(before)[locale] ?? 0) - (baselineCounts(pruned)[locale] ?? 0)
  if (prunedCount > 0) saveBaseline(pruned)

  const translated = MESSAGE_KEYS.length - outcome.untranslatedKeys.length
  console.log(
    `i18n-catalog: wrote src/lib/i18n/messages/${locale}.ts ` +
      `(${opts.replace ? "replace" : "merge"}) — ` +
      `${translated}/${MESSAGE_KEYS.length} key(s) translated` +
      (prunedCount > 0 ? `, ${prunedCount} pruned from the translation baseline.` : "."),
  )
  if (outcome.untranslatedKeys.length > 0 && !opts.quiet) {
    console.log(
      `\n  Untranslated (never translated for this locale, falls back to English, ` +
        `safe to ship):\n` +
        outcome.untranslatedKeys.map((k) => `    • ${k}`).join("\n"),
    )
  }
  if (outcome.staleKeys.length > 0 && opts.quiet) {
    console.warn(`  ${outcome.staleKeys.length} carried-over translation(s) are stale; pnpm i18n:todo lists them.`)
  } else if (outcome.staleKeys.length > 0) {
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

/**
 * Import every `<locale>.todo.json` in `dirArg`. A packet still holding only its
 * English seed imports as a no-op (`parseTranslatedCatalog` skips a leaf equal
 * to its English), so an untouched locale is harmless; the check afterwards is
 * what says whether anything is left.
 */
function runImportTodo(dirArg?: string): void {
  const dir = resolve(process.cwd(), dirArg ?? DEFAULT_TODO_DIR)
  if (!existsSync(dir)) fail(`no packet directory at ${dir} — run pnpm i18n:todo --new first`)
  const packets = readdirSync(dir)
    .filter((name) => name.endsWith(".todo.json"))
    .map((name) => name.slice(0, -".todo.json".length))
    .filter((locale) => isSupportedLocale(locale) && locale !== DEFAULT_LOCALE)
    .sort()
  if (packets.length === 0) fail(`no <locale>.todo.json packets in ${dir}`)
  for (const locale of packets) runImport(locale, join(dir, `${locale}.todo.json`), { quiet: true })
}

function runBaseline(args: string[]): void {
  const gaps = allLocaleGaps(CATALOGS, loadSourceHashes())
  const before = loadBaseline()
  let after: TranslationBaseline
  if (args.includes("--rebuild")) {
    after = baselineFromGaps(gaps)
  } else if (args.includes("--allow")) {
    const keys: string[] = []
    const locales: string[] = []
    let into = keys
    for (const arg of args) {
      if (arg === "--allow") into = keys
      else if (arg === "--locale") into = locales
      else into.push(arg)
    }
    const known = new Set<string>(MESSAGE_KEYS)
    const unknown = keys.filter((key) => !known.has(key))
    if (keys.length === 0) fail("usage: i18n:baseline --allow <key>… [--locale <code>…]")
    if (unknown.length > 0) fail(`not an English message key: ${unknown.join(", ")}`)
    after = allowInBaseline(pruneBaseline(before, gaps), gaps, keys, locales.length > 0 ? locales : undefined)
  } else {
    after = pruneBaseline(before, gaps)
  }
  saveBaseline(after)

  const was = baselineCounts(before)
  const now = baselineCounts(after)
  const locales = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()
  console.log("i18n-catalog: wrote src/lib/i18n/translation-baseline.json — allowed English fallbacks per locale:")
  for (const locale of locales) {
    const delta = (now[locale] ?? 0) - (was[locale] ?? 0)
    console.log(`  ${locale.padEnd(8)} ${String(now[locale] ?? 0).padStart(6)}${delta === 0 ? "" : `  (${delta > 0 ? "+" : ""}${delta})`}`)
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
  case "import-todo":
    runImportTodo(rest[0])
    break
  case "baseline":
    runBaseline(rest)
    break
  default:
    fail(`unknown command "${command ?? ""}" — expected check | export | import | import-todo | baseline`)
}
