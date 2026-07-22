import { v7 as uuidv7 } from "uuid"
import { AUTH_BASE } from "@/lib/frontier/auth"
import type { CellType, FileType, TranslatableString } from "@/lib/parsers/types"
import type { DeclarativeImportRecipe } from "./normalized-manifest"

export type ImportContentCategory =
  | "scripture"
  | "translation"
  | "document"
  | "subtitles"
  | "study-material"
  | "other"

type RecordMode = "line" | "paragraph" | "delimited" | "json-array"
type FieldRef = string | number

export interface AiRecipeConfig extends Record<string, unknown> {
  recordMode: RecordMode
  delimiter?: "," | "\t" | ";" | "|"
  hasHeader?: boolean
  recordsPath?: string
  sourceField?: FieldRef
  targetField?: FieldRef
  referenceField?: FieldRef
  /** Optional Scripture address components for tables that split references
   * across columns (or omit a repeated book/chapter column). */
  bookField?: FieldRef
  chapterField?: FieldRef
  verseField?: FieldRef
  book?: string
  chapter?: number
  typeField?: FieldRef
  speakerField?: FieldRef
  startField?: FieldRef
  endField?: FieldRef
  timeUnit?: "milliseconds" | "seconds" | "timestamp"
}

export interface AiImportClassification {
  category: ImportContentCategory
  confidence: number
  explanation: string
  recipe: DeclarativeImportRecipe & { config: AiRecipeConfig }
}

export interface AiParsedImport {
  strings: TranslatableString[]
  classification: AiImportClassification
}

const SAMPLE_CHARS = 12_000
const MAX_RECORDS = 20_000
export const MAX_UNKNOWN_TEXT_BYTES = 10 * 1024 * 1024
const BINARY_SCAN_BYTES = 8192
export const IMPORT_CLASSIFY_URL = `${AUTH_BASE}/api/v1/import/classify`

export interface PreparedUnknownText {
  text: string
  bytes: ArrayBuffer
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Import cancelled")
}

export function decodeImportText(bytes: ArrayBuffer, fileName: string): string {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, BINARY_SCAN_BYTES))
  const utf16Le = head[0] === 0xff && head[1] === 0xfe
  const utf16Be = head[0] === 0xfe && head[1] === 0xff
  const hasPrefix = (...prefix: number[]) => prefix.every((byte, index) => head[index] === byte)
  const knownBinary = [
    [0x50, 0x4b, 0x03, 0x04], // ZIP / OOXML
    [0xd0, 0xcf, 0x11, 0xe0], // legacy OLE .doc
    [0x25, 0x50, 0x44, 0x46], // PDF
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0xff, 0xd8, 0xff], // JPEG
    [0x47, 0x49, 0x46, 0x38], // GIF
    [0x49, 0x44, 0x33], // tagged MP3
  ].some((signature) => hasPrefix(...signature))
  const controlBytes = head.reduce(
    (count, byte) => count + (byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte) ? 1 : 0),
    0,
  )
  if (
    !utf16Le
    && !utf16Be
    && (knownBinary || head.includes(0) || (head.length >= 32 && controlBytes / head.length > 0.02))
  ) {
    throw new Error(`${fileName} appears to be binary; use a supported package or document format`)
  }
  try {
    return new TextDecoder(utf16Le ? "utf-16le" : utf16Be ? "utf-16be" : "utf-8", {
      fatal: true,
    }).decode(bytes)
  } catch {
    throw new Error(`${fileName} is not valid UTF-8 or UTF-16 text; use a supported package or document format`)
  }
}

/** Read an unknown extension once, with a client-memory cap and binary guard. */
export async function readUnknownTextFile(
  file: File,
  signal?: AbortSignal,
): Promise<PreparedUnknownText> {
  abortIfNeeded(signal)
  if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
    throw new Error(
      `${file.name} is too large for AI-assisted text detection (maximum ${MAX_UNKNOWN_TEXT_BYTES / 1024 / 1024} MB)`,
    )
  }
  const bytes = await file.arrayBuffer()
  abortIfNeeded(signal)
  const text = decodeImportText(bytes, file.name)
  if (!text.trim()) throw new Error(`${file.name} is empty`)
  return { text, bytes }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

async function deterministicRecipeId(
  category: ImportContentCategory,
  config: AiRecipeConfig,
): Promise<string> {
  // A recipe identifies parser semantics, not one artifact. Keeping content
  // out of the digest means a text edit does not re-key every record on
  // re-import; unit identity remains file-scoped through the imported file.
  const material = stableJson({ category, config })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `ai-${hex.slice(0, 32)}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fieldRef(value: unknown): FieldRef | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0)
    ? value
    : undefined
}

function normalizedDelimiter(value: unknown): AiRecipeConfig["delimiter"] | undefined {
  if (value === "," || value === "comma") return ","
  if (value === "\t" || value === "tab") return "\t"
  if (value === ";" || value === "semicolon") return ";"
  if (value === "|" || value === "pipe") return "|"
  return undefined
}

function validatedClassification(value: unknown): Omit<AiImportClassification, "recipe"> & {
  recipe: Omit<DeclarativeImportRecipe, "id" | "version" | "strategy" | "proposedBy"> & { config: AiRecipeConfig }
} {
  if (!isObject(value) || !isObject(value.recipe) || !isObject(value.recipe.config)) {
    throw new Error("AI returned an invalid import recipe")
  }
  const category = value.category
  const categories: ImportContentCategory[] = [
    "scripture", "translation", "document", "subtitles", "study-material", "other",
  ]
  if (typeof category !== "string" || !categories.includes(category as ImportContentCategory)) {
    throw new Error("AI did not identify a supported content category")
  }
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0
  const explanation = typeof value.explanation === "string" ? value.explanation.trim() : "AI-assisted structure"
  const recordMode = value.recipe.config.recordMode
  if (!(["line", "paragraph", "delimited", "json-array"] as unknown[]).includes(recordMode)) {
    throw new Error("AI proposed an unsupported record mode")
  }
  const rawDelimiter = value.recipe.config.delimiter
  const delimiter = normalizedDelimiter(rawDelimiter)
  if (rawDelimiter !== undefined && delimiter === undefined) {
    throw new Error("AI proposed an unsupported delimiter")
  }
  const config: AiRecipeConfig = {
    recordMode: recordMode as RecordMode,
    ...(delimiter !== undefined ? { delimiter } : {}),
    ...(typeof value.recipe.config.hasHeader === "boolean" ? { hasHeader: value.recipe.config.hasHeader } : {}),
    ...(typeof value.recipe.config.recordsPath === "string" ? { recordsPath: value.recipe.config.recordsPath } : {}),
    ...(fieldRef(value.recipe.config.sourceField) !== undefined ? { sourceField: fieldRef(value.recipe.config.sourceField) } : {}),
    ...(fieldRef(value.recipe.config.targetField) !== undefined ? { targetField: fieldRef(value.recipe.config.targetField) } : {}),
    ...(fieldRef(value.recipe.config.referenceField) !== undefined ? { referenceField: fieldRef(value.recipe.config.referenceField) } : {}),
    ...(fieldRef(value.recipe.config.bookField) !== undefined ? { bookField: fieldRef(value.recipe.config.bookField) } : {}),
    ...(fieldRef(value.recipe.config.chapterField) !== undefined ? { chapterField: fieldRef(value.recipe.config.chapterField) } : {}),
    ...(fieldRef(value.recipe.config.verseField) !== undefined ? { verseField: fieldRef(value.recipe.config.verseField) } : {}),
    ...(typeof value.recipe.config.book === "string" && /^[1-3]?[A-Za-z]{2,3}$/.test(value.recipe.config.book.trim())
      ? { book: value.recipe.config.book.trim().toUpperCase() }
      : {}),
    ...(typeof value.recipe.config.chapter === "number"
      && Number.isInteger(value.recipe.config.chapter)
      && value.recipe.config.chapter > 0
      ? { chapter: value.recipe.config.chapter }
      : {}),
    ...(fieldRef(value.recipe.config.typeField) !== undefined ? { typeField: fieldRef(value.recipe.config.typeField) } : {}),
    ...(fieldRef(value.recipe.config.speakerField) !== undefined ? { speakerField: fieldRef(value.recipe.config.speakerField) } : {}),
    ...(fieldRef(value.recipe.config.startField) !== undefined ? { startField: fieldRef(value.recipe.config.startField) } : {}),
    ...(fieldRef(value.recipe.config.endField) !== undefined ? { endField: fieldRef(value.recipe.config.endField) } : {}),
    ...(["milliseconds", "seconds", "timestamp"].includes(String(value.recipe.config.timeUnit))
      ? { timeUnit: value.recipe.config.timeUnit as AiRecipeConfig["timeUnit"] }
      : {}),
  }
  if ((recordMode === "delimited" || recordMode === "json-array") && config.sourceField === undefined) {
    throw new Error("AI recipe does not identify the source-text field")
  }
  return {
    category: category as ImportContentCategory,
    confidence,
    explanation,
    recipe: {
      name: typeof value.recipe.name === "string" && value.recipe.name.trim()
        ? value.recipe.name.trim()
        : "AI-assisted records",
      inputFormat: typeof value.recipe.inputFormat === "string" && value.recipe.inputFormat.trim()
        ? value.recipe.inputFormat.trim()
        : "unknown-text",
      config,
    },
  }
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"'
        index++
      } else {
        quoted = !quoted
      }
    } else if (!quoted && char === delimiter) {
      row.push(field)
      field = ""
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index++
      row.push(field)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

type RecordValue = string[] | Record<string, unknown> | string

function nestedJsonArray(value: unknown, path: string | undefined): unknown[] {
  let cursor = value
  for (const part of (path ?? "").split(".").filter(Boolean)) {
    if (!isObject(cursor)) return []
    cursor = cursor[part]
  }
  return Array.isArray(cursor) ? cursor : []
}

function recordsFor(text: string, config: AiRecipeConfig): { records: RecordValue[]; headers?: string[] } {
  switch (config.recordMode) {
    case "line":
      return { records: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }
    case "paragraph":
      return { records: text.split(/(?:\r?\n){2,}/).map((part) => part.trim()).filter(Boolean) }
    case "delimited": {
      const rows = parseDelimited(text, config.delimiter ?? "\t")
      const headers = config.hasHeader ? rows.shift()?.map((cell) => cell.trim()) : undefined
      return { records: rows, ...(headers ? { headers } : {}) }
    }
    case "json-array":
      return { records: nestedJsonArray(JSON.parse(text), config.recordsPath) as RecordValue[] }
  }
}

function readField(
  record: RecordValue,
  ref: FieldRef | undefined,
  headers?: string[],
  wholeRecordFallback = false,
): string | undefined {
  if (ref === undefined) return wholeRecordFallback && typeof record === "string" ? record : undefined
  if (Array.isArray(record)) {
    const index = typeof ref === "number" ? ref : headers?.indexOf(ref) ?? -1
    const value = index >= 0 ? record[index] : undefined
    return typeof value === "string" ? value.trim() : value == null ? undefined : String(value)
  }
  if (isObject(record)) {
    const value = record[String(ref)]
    return typeof value === "string" ? value.trim() : value == null ? undefined : String(value)
  }
  return typeof record === "string" ? record : undefined
}

function cellType(value: string | undefined, reference: string | undefined, category: ImportContentCategory): CellType {
  const normalized = value?.trim().toLowerCase()
  if (normalized && /^(heading|header|title|section|chapter)$/.test(normalized)) return "heading"
  if (normalized === "verse" || /^[1-3]?[A-Z]{2,3}\s+\d+:\d/i.test(reference ?? "")) return "verse"
  if (normalized === "cue" || category === "subtitles") return "cue"
  if (normalized === "list") return "list"
  if (normalized === "blockquote" || normalized === "quote") return "blockquote"
  if (normalized === "paratext") return "paratext"
  return "text"
}

const SCRIPTURE_REFERENCE_RE = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+[a-z]?(?:-\d+[a-z]?)?)$/i

function canonicalScriptureReference(value: string | undefined): string | undefined {
  const match = value?.trim().match(SCRIPTURE_REFERENCE_RE)
  return match ? `${match[1].toUpperCase()} ${Number(match[2])}:${match[3]}` : undefined
}

function composedReference(
  record: RecordValue,
  headers: string[] | undefined,
  config: AiRecipeConfig,
): { context?: string; canonical?: string; scriptureScope?: string } {
  const direct = readField(record, config.referenceField, headers)?.trim()
  const directCanonical = canonicalScriptureReference(direct)
  if (directCanonical) {
    return {
      context: direct,
      canonical: directCanonical,
      scriptureScope: directCanonical.slice(0, directCanonical.indexOf(":")),
    }
  }

  const directScope = direct?.match(/^([1-3]?[A-Z]{2,3})\s+(\d+)$/i)
  if (directScope) {
    const scriptureScope = `${directScope[1].toUpperCase()} ${Number(directScope[2])}`
    return { context: direct, scriptureScope }
  }

  const book = (readField(record, config.bookField, headers) ?? config.book)?.trim().toUpperCase()
  const chapterRaw = readField(record, config.chapterField, headers) ?? (
    config.chapter === undefined ? undefined : String(config.chapter)
  )
  const verse = readField(record, config.verseField, headers)?.trim()
  const chapter = chapterRaw?.trim()
  const scriptureScope = book && chapter && /^\d+$/.test(chapter) && Number(chapter) > 0
    ? `${book} ${Number(chapter)}`
    : undefined
  const composed = book && chapter && verse ? `${book} ${chapter}:${verse}` : undefined
  const canonical = canonicalScriptureReference(composed)
  return {
    ...(direct ? { context: direct } : composed ? { context: composed } : scriptureScope ? { context: scriptureScope } : {}),
    ...(canonical ? { canonical } : {}),
    ...(scriptureScope ? { scriptureScope } : {}),
  }
}

function seconds(value: string | undefined, unit: AiRecipeConfig["timeUnit"]): number | undefined {
  if (!value) return undefined
  if (unit === "timestamp") {
    const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/)
    if (!match) return undefined
    return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] ?? "0").padEnd(3, "0")) / 1000
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return unit === "milliseconds" ? numeric / 1000 : numeric
}

export function applyDeclarativeRecipe(
  text: string,
  classification: AiImportClassification,
): TranslatableString[] {
  const { records, headers } = recordsFor(text, classification.recipe.config)
  if (records.length > MAX_RECORDS) throw new Error(`AI recipe produced more than ${MAX_RECORDS.toLocaleString()} records`)
  const strings: TranslatableString[] = []
  records.forEach((record, index) => {
    const config = classification.recipe.config
    const source = readField(record, config.sourceField, headers, true)?.trim()
    if (!source) return
    const target = readField(record, config.targetField, headers) ?? ""
    const reference = composedReference(record, headers, config)
    const kind = cellType(readField(record, config.typeField, headers), reference.canonical ?? reference.context, classification.category)
    const speaker = readField(record, config.speakerField, headers)
    const start = seconds(readField(record, config.startField, headers), config.timeUnit)
    const end = seconds(readField(record, config.endField, headers), config.timeUnit)
    const recordNumber = index + 1
    const structuralReference = reference.scriptureScope && (kind === "heading" || kind === "paratext")
      ? `${reference.scriptureScope}:${kind === "heading" ? "h" : "p"}:${recordNumber}`
      : undefined
    const identityReference = structuralReference ?? reference.canonical
    strings.push({
      id: uuidv7(),
      original: source,
      translated: target,
      context: reference.context ?? `${classification.recipe.name} ${recordNumber}`,
      group: identityReference ?? reference.context ?? `${classification.recipe.id}:${recordNumber}`,
      ...(identityReference
        ? {
            globalReferences: [identityReference],
            ...(reference.scriptureScope ? { section: reference.scriptureScope } : {}),
          }
        : {}),
      type: kind,
      ...(speaker ? { speaker } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(kind === "text" ? { paragraphStart: true } : {}),
      metadata: {
        aquillaRecipe: {
          recipeId: classification.recipe.id,
          record: recordNumber,
          ...(config.sourceField !== undefined ? { field: String(config.sourceField) } : {}),
        },
        ...(reference.context && !reference.canonical ? { importReferenceLabel: reference.context } : {}),
      },
    })
  })
  // A structural row often omits its own reference and simply precedes the
  // first verse it introduces. Scope it to the nearest Scripture chapter
  // (prefer the following row at chapter boundaries) using a structural
  // identity, never the verse identity itself.
  strings.forEach((string, index) => {
    if ((string.type !== "heading" && string.type !== "paratext") || string.section) return
    const nextScope = strings.slice(index + 1).find((candidate) => candidate.section)?.section
    const previousScope = strings.slice(0, index).reverse().find((candidate) => candidate.section)?.section
    const scriptureScope = nextScope ?? previousScope
    if (!scriptureScope || !/^[1-3]?[A-Z]{2,3}\s+\d+$/i.test(scriptureScope)) return
    const record = (string.metadata?.aquillaRecipe as { record?: unknown } | undefined)?.record
    const occurrence = typeof record === "number" && Number.isInteger(record) ? record : index + 1
    const structuralReference = `${scriptureScope}:${string.type === "heading" ? "h" : "p"}:${occurrence}`
    string.section = scriptureScope
    string.group = structuralReference
    string.globalReferences = [structuralReference]
  })
  if (strings.length === 0) throw new Error("The proposed import recipe did not produce any source cells")
  return strings
}

export function sniffKnownTextFile(text: string): FileType | null {
  const head = text.slice(0, 4096)
  const trimmed = text.trimStart()
  if (/(^|\n)\s*\\id\b/.test(head)) return "usfm"
  if (/<xliff[\s>]/i.test(head)) return "xliff"
  if (/<tmx[\s>]/i.test(head)) return "tmx"
  if (/<usx[\s>]/i.test(head)) return "usfm"
  if (/^WEBVTT(?:\s|$)/i.test(trimmed)) return "vtt"
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+/m.test(text)) return "srt"
  if (/^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}\s*$/m.test(text)) return "sbv"
  if (/^\s*(?:<!doctype\s+html|<html[\s>]|<body[\s>])/i.test(trimmed)) return "html"
  if (/^\s*(?:\{|\[)/.test(trimmed)) {
    try {
      JSON.parse(text)
      return "json"
    } catch {
      // Not valid JSON; allow the reviewed AI fallback to classify it.
    }
  }
  if (/^(?:#.*\n)*msgid\s+"/m.test(text) && /^msgstr(?:\[\d+\])?\s+"/m.test(text)) return "po"
  return null
}

const STRUCTURAL_HEADER_NAMES = new Set([
  "ref", "reference", "canonical_ref", "book", "chapter", "verse", "type", "kind",
  "speaker", "character", "cast", "start", "start_time", "end", "end_time",
])

function hasStructuralHeader(row: string[]): boolean {
  return row.some((value) => STRUCTURAL_HEADER_NAMES.has(value.trim().toLowerCase()))
}

function consistentDelimitedRecords(text: string, delimiter: "\t" | ";" | "|"): boolean {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 25)
  if (rows.length < 3) return false
  const widths = rows.map((row) => parseDelimited(row, delimiter)[0]?.length ?? 0)
  return widths[0] >= 2 && widths.filter((width) => width === widths[0]).length / widths.length >= 0.8
}

/**
 * Known extensions still need structural review when the extension describes a
 * container rather than a record profile. This is deliberately conservative:
 * ordinary prose/i18n resources stay deterministic and free of model calls.
 */
export function shouldUseAiForKnownText(fileType: FileType, text: string): boolean {
  if (fileType === "md" && /^\s*\|.+\|\s*\r?\n\s*\|?\s*:?-{3,}/m.test(text)) return true
  if (fileType === "txt") {
    return consistentDelimitedRecords(text, "\t")
      || consistentDelimitedRecords(text, "|")
      || consistentDelimitedRecords(text, ";")
  }
  if (fileType === "csv" || fileType === "tsv") {
    const rows = parseDelimited(text, fileType === "tsv" ? "\t" : ",")
    return rows.length > 1 && hasStructuralHeader(rows[0] ?? [])
  }
  if (fileType === "json") {
    try {
      const value = JSON.parse(text)
      const records = Array.isArray(value)
        ? value
        : isObject(value)
          ? Object.values(value).find((candidate) => Array.isArray(candidate))
          : undefined
      return Array.isArray(records)
        && records.some((record) => isObject(record) && Object.values(record).filter((entry) => typeof entry === "string").length >= 2)
    } catch {
      return false
    }
  }
  return false
}

export async function classifyAndParseUnknownText(
  file: File,
  options: {
    identityToken: string
    projectId: string
    sourceLanguage?: string
    targetLanguage?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
  prepared?: PreparedUnknownText,
): Promise<AiParsedImport> {
  abortIfNeeded(options.signal)
  const { text } = prepared ?? await readUnknownTextFile(file, options.signal)
  if (text.includes("\0")) throw new Error(`${file.name} appears to be binary; use a supported package or document format`)
  const sample = text.slice(0, SAMPLE_CHARS)
  const response = await (options.fetchImpl ?? fetch)(IMPORT_CLASSIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.identityToken}`,
    },
    body: JSON.stringify({
      projectId: options.projectId,
      fileName: file.name,
      mime: file.type,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      sample,
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`AI format analysis failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  let body: { classification?: unknown }
  try {
    body = await response.json() as { classification?: unknown }
  } catch {
    throw new Error("AI format analysis returned malformed JSON; try analyzing the file again")
  }
  if (!body.classification) throw new Error("AI format analysis returned no recipe")
  const proposed = validatedClassification(body.classification)
  const recipe: AiImportClassification["recipe"] = {
    version: 1,
    id: await deterministicRecipeId(proposed.category, proposed.recipe.config),
    name: proposed.recipe.name,
    inputFormat: proposed.recipe.inputFormat,
    strategy: "records",
    config: proposed.recipe.config,
    proposedBy: "ai",
  }
  const classification: AiImportClassification = { ...proposed, recipe }
  return { strings: applyDeclarativeRecipe(text, classification), classification }
}
