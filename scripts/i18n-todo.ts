/**
 * i18n translation work-packet generator.
 *
 * `pnpm i18n:export` writes the FULL interchange document for every locale —
 * 3.5k+ leaves each, seeded with English. That is the right artifact to hand a
 * translator starting from scratch, and the wrong one to hand a translator (or
 * a translation agent) topping up a catalogue that is already ~93% filled: the
 * 230 keys that actually need work are invisible inside 3,500 that do not.
 *
 * This emits the complement — one packet per locale containing ONLY the leaves
 * that are untranslated or stale, each with the English source and the
 * translator note `contextNote()` already assembles from the context sidecar.
 *
 *   npx tsx scripts/i18n-todo.ts [outDir] [--locale <code>]   (default: i18n-todo/)
 *
 * Two classes land in a packet, and the distinction matters:
 *   - **untranslated** — the locale has no value for this key. It currently
 *     falls back to English, which is honest but not localized.
 *   - **stale** — the locale HAS a value, but the English source has changed
 *     since it was made, so the shipped translation now describes something
 *     else. `source-hashes.json` is what makes this detectable at all; without
 *     it a drifted translation ships silently and reads as complete.
 *
 * The packet is written in the same `{ "messages": { leaf: value } }` shape
 * `scripts/i18n-catalog.ts import` consumes, so a filled-in packet imports
 * directly with no reshaping:
 *
 *   npx tsx scripts/i18n-catalog.ts import <locale> i18n-todo/<locale>.todo.json
 *
 * (a merge, not a replace — the ~93% already translated is left untouched).
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CATALOG_SOURCE_ROOT,
  catalogLeafKeys,
  contextNote,
  parseLeafKey,
  sourceHash,
  type SourceHashes,
} from "../src/lib/i18n/catalog-export"
import { DEFAULT_LOCALE, LOCALES } from "../src/lib/i18n/locales"
import { CATALOGS } from "../src/lib/i18n/messages"
import { en, type MessageKey } from "../src/lib/i18n/messages/en"
import { isPluralMessage } from "../src/lib/i18n/plurals"
import sourceHashes from "../src/lib/i18n/source-hashes.json" with { type: "json" }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_OUT_DIR = "i18n-todo"

/** The English string a leaf renders: the plain value, or one plural form. */
function englishFor(leaf: string): string {
  const { key, category } = parseLeafKey(leaf)
  const base = en[key as MessageKey]
  if (base === undefined) return ""
  if (!isPluralMessage(base)) return base
  if (!category) return base.forms.other ?? ""
  // A locale may need a category English does not distinguish (Arabic has six
  // where English has two); `other` is the documented stand-in to translate FROM.
  return base.forms[category] ?? base.forms.other ?? ""
}

interface Packet {
  locale: string
  untranslated: string[]
  stale: string[]
  messages: Record<string, string>
  notes: Record<string, string>
}

function packetFor(locale: string): Packet {
  const catalog = CATALOGS[locale] ?? {}
  const hashes = (sourceHashes as Record<string, SourceHashes>)[locale] ?? {}
  const untranslated: string[] = []
  const stale: string[] = []
  const messages: Record<string, string> = {}
  const notes: Record<string, string> = {}

  for (const leaf of catalogLeafKeys(locale)) {
    const { key, category } = parseLeafKey(leaf)
    // `parseLeafKey` returns a plain `string` (it also parses leaves that are no
    // longer in the catalog); narrow once here so the catalog and hash sidecar —
    // both keyed by `MessageKey` — can be indexed without repeating the cast.
    const messageKey = key as MessageKey
    const value = catalog[messageKey]
    const hasValue =
      value !== undefined &&
      (!isPluralMessage(value) || (category ? value.forms[category] !== undefined : true))

    if (!hasValue) {
      untranslated.push(leaf)
    } else if (
      hashes[messageKey] !== undefined &&
      hashes[messageKey] !== sourceHash(messageKey)
    ) {
      // Translated once, but against a different English source since changed.
      stale.push(leaf)
    } else {
      continue
    }
    // Seeded with English: `parseTranslatedCatalog` treats a leaf still equal to
    // its English source as skipped, so an unfilled packet is a safe no-op.
    messages[leaf] = englishFor(leaf)
    notes[leaf] = contextNote(messageKey, locale, category)
  }

  return { locale, untranslated, stale, messages, notes }
}

const args = process.argv.slice(2)
const localeFlag = args.indexOf("--locale")
const only = localeFlag === -1 ? null : args[localeFlag + 1]
const outDirArg = args.find((a) => !a.startsWith("--") && a !== only)
const outDir = resolve(REPO_ROOT, outDirArg ?? DEFAULT_OUT_DIR)
mkdirSync(outDir, { recursive: true })

let grandTotal = 0
for (const { code } of LOCALES) {
  if (code === DEFAULT_LOCALE) continue
  if (only && code !== only) continue
  const packet = packetFor(code)
  const total = packet.untranslated.length + packet.stale.length
  grandTotal += total

  writeFileSync(
    join(outDir, `${code}.todo.json`),
    JSON.stringify({ [CATALOG_SOURCE_ROOT]: packet.messages }, null, 2) + "\n",
    "utf8",
  )
  writeFileSync(
    join(outDir, `${code}.todo.notes.json`),
    JSON.stringify(packet.notes, null, 2) + "\n",
    "utf8",
  )
  console.log(
    `i18n-todo: ${code} — ${total} leaf/leaves to translate ` +
      `(${packet.untranslated.length} untranslated, ${packet.stale.length} stale)`,
  )
}
console.log(`\ni18n-todo: ${grandTotal} leaf/leaves total across locales → ${outDir}`)
console.log(
  `Fill the values in <locale>.todo.json, then:\n` +
    `  npx tsx scripts/i18n-catalog.ts import <locale> ${outDirArg ?? DEFAULT_OUT_DIR}/<locale>.todo.json`,
)
