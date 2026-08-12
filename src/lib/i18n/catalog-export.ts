/**
 * Catalog ⇄ Aquilla-project interchange (AQU-832).
 *
 * Closes the dogfood loop: Aquilla's own UI catalog is translated *in Aquilla*,
 * with the AQU-832 context metadata riding along as per-cell context so human
 * translators and the translation agent both see what each string does.
 *
 *   1. `buildCatalogSourceJson()` emits the en catalog as a JSON source file.
 *   2. That file imports through `parsers/json-i18n.ts`, one cell per message
 *      key; `contextNote()` supplies each cell's context blob.
 *   3. Translation happens in the app (or via the agent) with all the usual
 *      QA / health / completion tooling.
 *   4. `exportJson(original, cells, { keyed: true })` re-serializes the same
 *      document with translations substituted, `parseTranslatedCatalog()` turns
 *      that back into a `Catalog`, and `renderCatalogModule()` writes
 *      `messages/<locale>.ts` — which `messages/index.ts` already ships to the
 *      `LanguageSwitcher`.
 *
 * The JSON path mapping is the load-bearing detail: `json-i18n` addresses leaves
 * by JSON path, and message keys contain dots, so `common.save` lives at
 * `messages["common.save"]`. `catalogJsonPath()` / `messageKeyForPath()` are the
 * only places that encoding is spelled out — keyed export depends on them
 * agreeing with the parser exactly.
 *
 * `scripts/i18n-catalog.ts` is the CLI over this module.
 */

import { en, type Catalog, type MessageKey } from "./messages/en"
import {
  CATALOG_CONTEXT,
  CONTEXT_SCHEMA_VERSION,
  MESSAGE_KEYS,
  englishSourceFor,
  pluralMessageFor,
  resolveKeyContext,
} from "./context"
import { DEFAULT_LOCALE, LOCALES } from "./locales"
import {
  PLURAL_CATEGORIES,
  plural,
  pluralCategoriesFor,
  type PluralCategory,
} from "./plurals"
import { screenshotPath, screenshotSurface } from "./screenshots"

/** Root object key wrapping the messages in the exported source document. */
export const CATALOG_SOURCE_ROOT = "messages"

/**
 * Separator between a message key and a plural category in the exported
 * document, e.g. `search.resultCount#one`.
 *
 * Count-governed keys cannot export as one leaf: a translator working in Aquilla
 * translates cells, and Arabic needs six cells where English wrote two forms. So
 * a plural key exports one leaf per category *the target locale needs*, seeded
 * with the nearest English form. `#` cannot appear in a message key, so a leaf
 * name is unambiguous in both directions.
 */
export const PLURAL_LEAF_SEPARATOR = "#"

/** Leaf name for one plural category of a key. */
export function pluralLeafKey(key: string, category: PluralCategory): string {
  return `${key}${PLURAL_LEAF_SEPARATOR}${category}`
}

/**
 * Split a leaf name back into its message key and (for a plural leaf) the
 * category it carries. Unknown categories are treated as part of the key, so a
 * genuinely odd leaf is reported as an unknown key rather than silently
 * half-parsed.
 */
export function parseLeafKey(leaf: string): { key: string; category?: PluralCategory } {
  const at = leaf.lastIndexOf(PLURAL_LEAF_SEPARATOR)
  if (at === -1) return { key: leaf }
  const category = leaf.slice(at + 1)
  const known = PLURAL_CATEGORIES.find((c) => c === category)
  if (!known) return { key: leaf }
  return { key: leaf.slice(0, at), category: known }
}

/**
 * Every leaf the exported document holds for `locale`, in base-catalog order:
 * one per plain key, and one per plural category the locale needs.
 */
export function catalogLeafKeys(locale: string = DEFAULT_LOCALE): string[] {
  const categories = pluralCategoriesFor(locale)
  return MESSAGE_KEYS.flatMap((key) => {
    const forms = pluralMessageFor(key)
    if (!forms) return [key]
    return categories.map((category) => pluralLeafKey(key, category))
  })
}

/**
 * JSON path of a message key inside the exported source document, in exactly
 * the form `parsers/json-i18n.ts` produces when it walks that document. Message
 * keys are not bare identifiers (they contain dots), so they are always bracket-
 * quoted rather than dot-joined.
 */
export function catalogJsonPath(key: string): string {
  return `${CATALOG_SOURCE_ROOT}[${JSON.stringify(key)}]`
}

const CATALOG_PATH_PATTERN = new RegExp(`^${CATALOG_SOURCE_ROOT}\\[(".*")\\]$`)

/**
 * Inverse of {@link catalogJsonPath}: recover the message key from a cell's
 * `context` path. Returns `undefined` for a path that isn't a catalog message
 * (so a caller can skip cells that came from some other file).
 */
export function messageKeyForPath(path: string): string | undefined {
  const match = CATALOG_PATH_PATTERN.exec(path)
  if (!match) return undefined
  try {
    const decoded: unknown = JSON.parse(match[1])
    return typeof decoded === "string" ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * The exported source document for `locale`: every leaf with the English text a
 * translator starts from.
 *
 * The locale matters only for plural keys — it decides how many category leaves
 * that key contributes. An Arabic translator gets six leaves for `{count}
 * result`, seeded with English's nearest form; a Thai translator gets one.
 */
export function buildCatalogSourceDocument(
  locale: string = DEFAULT_LOCALE,
): Record<string, Record<string, string>> {
  const messages: Record<string, string> = {}
  for (const leaf of catalogLeafKeys(locale)) {
    const { key, category } = parseLeafKey(leaf)
    const forms = pluralMessageFor(key as MessageKey)
    messages[leaf] =
      forms && category
        ? (forms.forms[category] ?? forms.forms.other ?? "")
        : englishSourceFor(key as MessageKey)
  }
  return { [CATALOG_SOURCE_ROOT]: messages }
}

/** Serialized source file, ready to import into an Aquilla project. */
export function buildCatalogSourceJson(locale: string = DEFAULT_LOCALE): string {
  return JSON.stringify(buildCatalogSourceDocument(locale), null, 2) + "\n"
}

/**
 * A translator-facing note for one message key, flattening the resolved context
 * into plain prose. This is what lands on the imported cell's context and what
 * the translation agent receives in its prompt — so it must stand alone, with
 * no reference to code.
 */
export function contextNote(
  key: MessageKey,
  locale: string = DEFAULT_LOCALE,
  category?: PluralCategory,
): string {
  const ctx = resolveKeyContext(key)
  const lines = [`Surface: ${ctx.surface}`, `String: ${ctx.description}`]

  if (ctx.plural) {
    // A translator cannot infer their own plural categories from English, and
    // getting this wrong is not a quality problem — it is an ungrammatical
    // sentence no reviewer can repair without re-keying the catalog. So the note
    // states the governing number and the exact category set to fill.
    const categories = pluralCategoriesFor(locale)
    lines.push(
      `Plural: this message changes with the number in {${ctx.plural.countVar}}. ` +
        `Your language uses ${categories.length} form(s): ${categories.join(", ")}. ` +
        `Translate the form named in this cell's key after "` +
        `${PLURAL_LEAF_SEPARATOR}" — each form is its own cell.`,
    )
    if (category) {
      lines.push(
        `This cell: the "${category}" form — used for the counts your language puts ` +
          `in that category. Fill it in even if it reads the same as another form.`,
      )
    }
    const english = Object.entries(ctx.plural.forms)
      .map(([cat, form]) => `${cat} = "${form}"`)
      .join("; ")
    lines.push(`English forms: ${english}`)
  }

  if (ctx.screenshot) {
    const surface = screenshotSurface(ctx.screenshot)
    const title = surface ? `${surface.title} — ` : ""
    lines.push(`Screenshot: ${title}${screenshotPath(ctx.screenshot)}`)
    if (surface) lines.push(`In this screenshot: ${surface.notes}`)
  }

  for (const [name, meaning] of Object.entries(ctx.placeholders)) {
    lines.push(`Placeholder {${name}}: ${meaning}`)
  }

  if (ctx.maxLength !== undefined) {
    lines.push(
      `Length: aim for ${ctx.maxLength} characters or fewer — the layout is constrained here.`,
    )
  }

  return lines.join("\n")
}

/**
 * The plural section of the sidecar: for every count-governed key, the
 * placeholder that governs it, the English forms, and the category set each
 * shipping locale must fill. Without the per-locale sets a translator has no way
 * to know that Arabic needs six forms and Thai one.
 */
export function buildPluralSidecar(): Record<
  string,
  {
    countVar: string
    english: Partial<Record<PluralCategory, string>>
    categoriesByLocale: Record<string, PluralCategory[]>
  }
> {
  const categoriesByLocale: Record<string, PluralCategory[]> = {}
  for (const locale of LOCALES) {
    categoriesByLocale[locale.code] = pluralCategoriesFor(locale.code)
  }
  const out: Record<
    string,
    {
      countVar: string
      english: Partial<Record<PluralCategory, string>>
      categoriesByLocale: Record<string, PluralCategory[]>
    }
  > = {}
  for (const key of MESSAGE_KEYS) {
    const forms = pluralMessageFor(key)
    if (!forms) continue
    out[key] = { countVar: forms.countVar, english: forms.forms, categoriesByLocale }
  }
  return out
}

/** The generated JSON sidecar, in the documented interchange shape. */
export function buildContextSidecar(): unknown {
  return {
    version: CONTEXT_SCHEMA_VERSION,
    generatedFrom: "src/lib/i18n/context.ts",
    namespaces: CATALOG_CONTEXT,
    plurals: buildPluralSidecar(),
  }
}

export function buildContextSidecarJson(): string {
  return JSON.stringify(buildContextSidecar(), null, 2) + "\n"
}

export interface ParsedCatalog {
  /** Keys that exist in the base catalog, with their translated values. */
  catalog: Catalog
  /** Paths/keys present in the file that the base catalog doesn't define. */
  unknownKeys: string[]
  /** Base keys the file left untranslated (absent, empty, or still English). */
  missingKeys: MessageKey[]
}

function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key)
}

/**
 * Parse a translated export back into a `Catalog`.
 *
 * Unknown keys are reported rather than thrown on, so a catalog that drifted
 * (a key renamed in `en` after the file was handed to a translator) still yields
 * every usable string instead of failing wholesale. Values identical to the
 * English source count as missing, not translated — that's the honest read of a
 * round-trip where the translator skipped a cell and `exportJson` fell back to
 * `cell.original`.
 */
export function parseTranslatedCatalog(json: string): ParsedCatalog {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON in translated catalog: ${detail}`, { cause: err })
  }

  const root = (parsed as Record<string, unknown> | null)?.[CATALOG_SOURCE_ROOT]
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(
      `Translated catalog is missing its "${CATALOG_SOURCE_ROOT}" object — ` +
        `it must round-trip the document shape produced by buildCatalogSourceJson()`,
    )
  }

  const catalog: Catalog = {}
  const unknownKeys: string[] = []
  const pluralForms = new Map<MessageKey, Partial<Record<PluralCategory, string>>>()

  for (const [leaf, value] of Object.entries(root as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    const { key, category } = parseLeafKey(leaf)
    if (!isMessageKey(key)) {
      unknownKeys.push(leaf)
      continue
    }
    const forms = pluralMessageFor(key)
    if (forms && category) {
      // Seeded with the nearest English form, so "still English" means the
      // translator skipped this category — exactly as for a plain key.
      const seed = forms.forms[category] ?? forms.forms.other ?? ""
      if (value.length > 0 && value !== seed) {
        const collected = pluralForms.get(key) ?? {}
        collected[category] = value
        pluralForms.set(key, collected)
      }
      continue
    }
    if (forms || category) {
      // A plural key exported as a bare leaf, or a category suffix on a key that
      // is not count-governed: the shapes drifted, so report rather than guess.
      unknownKeys.push(leaf)
      continue
    }
    if (value.length > 0 && value !== en[key]) catalog[key] = value
  }

  for (const [key, forms] of pluralForms) {
    const base = pluralMessageFor(key)
    if (base) catalog[key] = plural(forms, base.countVar)
  }

  const missingKeys = MESSAGE_KEYS.filter((key) => catalog[key] === undefined)
  return { catalog, unknownKeys, missingKeys }
}

/**
 * Render a `messages/<locale>.ts` module for a translated catalog — the shipping
 * artifact of the loop. Keys follow the base-catalog order so regenerating a
 * locale produces a minimal diff, and untranslated keys are simply omitted
 * (`translate()` falls back to English per key, never to a raw key).
 */
export function renderCatalogModule(locale: string, catalog: Catalog): string {
  const entries = MESSAGE_KEYS.filter((key) => catalog[key] !== undefined).map(
    // `JSON.stringify` covers both shapes: a plain string, and the
    // `{ forms, countVar }` object a count-governed key carries.
    (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(catalog[key])},`,
  )
  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : ""
  return `/**
 * ${locale} catalog — GENERATED by \`scripts/i18n-catalog.ts import\` (AQU-832).
 *
 * Produced by translating the en catalog in an Aquilla project and exporting it
 * back. Do not hand-edit: re-run the import to regenerate. Keys absent here fall
 * back to English per key, so a partial catalog is safe to ship.
 */

import type { Catalog } from "./en"

export const ${locale.replace(/-/g, "_")}: Catalog = {${body}}
`
}
