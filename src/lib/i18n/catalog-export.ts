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
  resolveKeyContext,
} from "./context"
import { screenshotPath, screenshotSurface } from "./screenshots"

/** Root object key wrapping the messages in the exported source document. */
export const CATALOG_SOURCE_ROOT = "messages"

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

/** The exported source document: every message key with its English value. */
export function buildCatalogSourceDocument(): Record<string, Record<string, string>> {
  const messages: Record<string, string> = {}
  for (const key of MESSAGE_KEYS) messages[key] = en[key]
  return { [CATALOG_SOURCE_ROOT]: messages }
}

/** Serialized source file, ready to import into an Aquilla project. */
export function buildCatalogSourceJson(): string {
  return JSON.stringify(buildCatalogSourceDocument(), null, 2) + "\n"
}

/**
 * A translator-facing note for one message key, flattening the resolved context
 * into plain prose. This is what lands on the imported cell's context and what
 * the translation agent receives in its prompt — so it must stand alone, with
 * no reference to code.
 */
export function contextNote(key: MessageKey): string {
  const ctx = resolveKeyContext(key)
  const lines = [`Surface: ${ctx.surface}`, `String: ${ctx.description}`]

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

/** The generated JSON sidecar, in the documented interchange shape. */
export function buildContextSidecar(): unknown {
  return {
    version: CONTEXT_SCHEMA_VERSION,
    generatedFrom: "src/lib/i18n/context.ts",
    namespaces: CATALOG_CONTEXT,
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
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    if (!isMessageKey(key)) {
      unknownKeys.push(key)
      continue
    }
    if (value.length > 0 && value !== en[key]) catalog[key] = value
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
