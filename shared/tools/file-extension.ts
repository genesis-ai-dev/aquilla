/**
 * Smart Extensions apiRev 7: what an extension may record about a project file.
 *
 * Stored in `files.meta.extension` (JSON, no schema change), written at
 * creation (`file.create` payload `extension`, through /import) and replaced
 * by `file.extension.set`. Shared by the SPA host, the sync-worker projection
 * and the files read route so all three agree on the shape and the limits.
 *
 *   kind  "normal"    an ordinary translatable file (the default)
 *         "reference" read-only reference material (original-language text,
 *                     link tables): shown, but not translation work
 *         "data"      an extension's own data (one cell per record, value =
 *                     JSON). Hidden from file lists, totals and search through
 *                     the `files.role` EXTENSION_DATA_ROLE, like the other
 *                     hidden companion files (db/shared/counted-files.ts)
 *   tags  free-form labels; files.list filters on them
 *   group a group key: an editor extension opened on any member gets the
 *         whole group as aquilla.context.group
 *   owner the tool that created the file
 *   meta  the extension's own small JSON (upstream repo/ref/sha, …)
 */

/** `files.role` of an extension data file (hidden; see counted-files.ts). */
export const EXTENSION_DATA_ROLE = "extension-data"

export type FileExtensionKind = "normal" | "reference" | "data"

/** AQU-1937: which import contribution wrote the file, with the options it
 *  ran with and the upstream version it read — what "Refresh from source"
 *  re-runs. Recorded by the PLATFORM, never chosen by the extension. */
export interface FileImportProvenance {
  tool: string
  importer: string
  options: Record<string, unknown>
  upstream?: Record<string, unknown>
  at: number
}

export interface FileExtensionMeta {
  kind: FileExtensionKind
  tags: string[]
  group?: string
  owner?: string
  meta?: Record<string, unknown>
  import?: FileImportProvenance
}

export const MAX_FILE_TAGS = 20
export const MAX_TAG_CHARS = 80
export const MAX_FILE_EXTENSION_META_BYTES = 16 * 1024

/** True when the string holds an ASCII control character (U+0000-U+001F). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A tag or group key: printable, no whitespace runs at the ends. */
function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (!v || v.length > MAX_TAG_CHARS || hasControlChar(v)) return null
  return v
}

export type ParsedFileExtension = { ok: true; value: FileExtensionMeta } | { ok: false; error: string }

/** Validate untrusted input (an extension's call, an event payload). */
export function parseFileExtension(input: unknown): ParsedFileExtension {
  if (!isRecord(input)) return { ok: false, error: "extension must be an object" }
  const kind = input.kind === undefined ? "normal" : input.kind
  if (kind !== "normal" && kind !== "reference" && kind !== "data") {
    return { ok: false, error: 'kind must be "normal", "reference" or "data"' }
  }
  const rawTags = input.tags === undefined ? [] : input.tags
  if (!Array.isArray(rawTags)) return { ok: false, error: "tags must be a list of strings" }
  const tags: string[] = []
  for (const t of rawTags) {
    const v = cleanLabel(t)
    if (!v) return { ok: false, error: `each tag must be a string of 1-${MAX_TAG_CHARS} characters` }
    if (!tags.includes(v)) tags.push(v)
  }
  if (tags.length > MAX_FILE_TAGS) return { ok: false, error: `at most ${MAX_FILE_TAGS} tags` }
  const out: FileExtensionMeta = { kind, tags }
  if (input.group !== undefined && input.group !== null) {
    const g = cleanLabel(input.group)
    if (!g) return { ok: false, error: `group must be a string of 1-${MAX_TAG_CHARS} characters` }
    out.group = g
  }
  if (input.owner !== undefined && input.owner !== null) {
    if (typeof input.owner !== "string" || input.owner.length === 0 || input.owner.length > 200) {
      return { ok: false, error: "owner must be a tool id" }
    }
    out.owner = input.owner
  }
  if (input.meta !== undefined && input.meta !== null) {
    if (!isRecord(input.meta)) return { ok: false, error: "meta must be an object" }
    out.meta = input.meta
  }
  if (input.import !== undefined && input.import !== null) {
    const imp = input.import
    if (!isRecord(imp) || typeof imp.tool !== "string" || typeof imp.importer !== "string" || !isRecord(imp.options) || typeof imp.at !== "number") {
      return { ok: false, error: "import must be { tool, importer, options, upstream?, at }" }
    }
    out.import = {
      tool: imp.tool,
      importer: imp.importer,
      options: imp.options,
      ...(isRecord(imp.upstream) ? { upstream: imp.upstream } : {}),
      at: imp.at,
    }
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_FILE_EXTENSION_META_BYTES) {
    return { ok: false, error: `extension metadata exceeds ${MAX_FILE_EXTENSION_META_BYTES / 1024} KB` }
  }
  return { ok: true, value: out }
}

/** Read `files.meta.extension` leniently (a malformed blob reads as absent). */
export function readFileExtension(meta: unknown): FileExtensionMeta | null {
  if (!isRecord(meta) || meta.extension === undefined) return null
  const parsed = parseFileExtension(meta.extension)
  return parsed.ok ? parsed.value : null
}
