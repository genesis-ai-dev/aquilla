import { v7 as uuidv7 } from "uuid"
import { FRONTIER_CHAT_URL } from "@/lib/completion/completion-service"
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

export interface PreparedUnknownText {
  text: string
  bytes: ArrayBuffer
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Import cancelled")
}

function decodeUnknownText(bytes: ArrayBuffer, fileName: string): string {
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
  const text = decodeUnknownText(bytes, file.name)
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

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1] : trimmed
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
    const reference = readField(record, config.referenceField, headers)
    const kind = cellType(readField(record, config.typeField, headers), reference, classification.category)
    const speaker = readField(record, config.speakerField, headers)
    const start = seconds(readField(record, config.startField, headers), config.timeUnit)
    const end = seconds(readField(record, config.endField, headers), config.timeUnit)
    const recordNumber = index + 1
    strings.push({
      id: uuidv7(),
      original: source,
      translated: target,
      context: reference ?? `${classification.recipe.name} ${recordNumber}`,
      group: reference ?? `${classification.recipe.id}:${recordNumber}`,
      ...(reference ? { globalReferences: [reference] } : {}),
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
      },
    })
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
  return null
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
  const prompt = `You are the classification step inside a file importer. Classify the content and propose ONE constrained record recipe. Do not translate or rewrite text. Prefer line or paragraph records for prose; delimited for tables; json-array for JSON record arrays. Identify headings/verse references through fields when present. The recipe is interpreted locally and cannot run code.\n\nFile: ${file.name}\nMIME: ${file.type || "unknown"}\nSource language hint: ${options.sourceLanguage || "unknown"}\nTarget language hint: ${options.targetLanguage || "unknown"}\n\nReturn JSON only with: category (scripture|translation|document|subtitles|study-material|other), confidence (0..1), explanation, recipe {name,inputFormat,config}. config: recordMode (line|paragraph|delimited|json-array); optionally delimiter (comma, tab, semicolon, or pipe literal), hasHeader, recordsPath, sourceField, targetField, referenceField, typeField, speakerField, startField, endField, timeUnit (milliseconds|seconds|timestamp). Fields are header names for object/header data or zero-based indexes.\n\nSample:\n${sample}`
  const response = await (options.fetchImpl ?? fetch)(FRONTIER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.identityToken}`,
    },
    body: JSON.stringify({
      model: "default",
      messages: [
        { role: "system", content: "Return only a safe declarative import recipe as JSON. Never return code or prose outside JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 1200,
      stream: false,
      projectId: options.projectId,
      response_format: { type: "json_object" },
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`AI format analysis failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const body = await response.json() as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error("AI format analysis returned no recipe")
  let decoded: unknown
  try {
    decoded = JSON.parse(stripCodeFence(content))
  } catch {
    throw new Error("AI format analysis returned malformed JSON; try analyzing the file again")
  }
  const proposed = validatedClassification(decoded)
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
