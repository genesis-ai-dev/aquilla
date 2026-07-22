import { v7 as uuidv7 } from "uuid"
import { AUTH_BASE } from "@/lib/frontier/auth"
import type { CellType, TranslatableString } from "@/lib/parsers/types"
import type { DeclarativeImportRecipe } from "./normalized-manifest"
import type { ImportContentCategory } from "./ai-recipe"
import { MAX_SANDBOX_PROGRAM_CHARS } from "../../../shared/import-contract"

export const IMPORT_SANDBOX_PARSE_URL = `${AUTH_BASE}/api/v1/import/parse`
export const MAX_SANDBOX_IMPORT_UNITS = 20_000

export interface SandboxImportClassification {
  category: ImportContentCategory
  confidence: number
  explanation: string
  recipe: DeclarativeImportRecipe
}

export interface SandboxParsedImport {
  strings: TranslatableString[]
  classification: SandboxImportClassification
}

const CELL_TYPES = new Set<CellType>([
  "text", "heading", "list", "blockquote", "cue", "verse", "paratext",
])
const CATEGORIES = new Set<ImportContentCategory>([
  "scripture", "translation", "document", "subtitles", "study-material", "other",
])
const SCRIPTURE_VERSE_RE = /^[1-3]?[A-Z]{2,3}\s+\d+:\d+[a-z]?(?:-\d+[a-z]?)?$/i
const SCRIPTURE_STRUCTURE_RE = /^[1-3]?[A-Z]{2,3}(?:\s+\d+)?:[a-z]+\d*:\d+$/i

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalString(value: unknown, max = 100_000): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined
}

function checkedOptionalString(
  value: unknown,
  max: number,
  field: string,
  position: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`Sandbox parser returned invalid ${field} at position ${position}`)
  }
  return value
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function validateRecipe(value: unknown): Promise<DeclarativeImportRecipe> {
  const recipe = object(value)
  const program = object(recipe?.program)
  if (
    recipe?.version !== 1
    || typeof recipe.id !== "string"
    || !recipe.id
    || typeof recipe.name !== "string"
    || !recipe.name
    || typeof recipe.inputFormat !== "string"
    || recipe.strategy !== "sandbox-program"
    || recipe.proposedBy !== "ai"
    || !object(recipe.config)
    || program?.language !== "python"
    || typeof program.source !== "string"
    || !program.source
    || program.source.length > MAX_SANDBOX_PROGRAM_CHARS
    || typeof program.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(program.sha256)
    || recipe.id !== `sandbox-${program.sha256.slice(0, 32)}`
    || object(recipe.config)?.programSha256 !== program.sha256
  ) {
    throw new Error("Sandbox parser returned invalid recipe provenance")
  }
  if (await sha256Hex(program.source as string) !== program.sha256) {
    throw new Error("Sandbox parser returned invalid recipe provenance")
  }
  return recipe as unknown as DeclarativeImportRecipe
}

function validateUnits(value: unknown, recipeId: string): TranslatableString[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Sandbox parser did not produce any importable cells")
  }
  if (value.length > MAX_SANDBOX_IMPORT_UNITS) {
    throw new Error(`Sandbox parser produced more than ${MAX_SANDBOX_IMPORT_UNITS.toLocaleString()} cells`)
  }

  return value.map((candidate, index) => {
    const unit = object(candidate)
    const position = index + 1
    const original = optionalString(unit?.sourceText)
    if (!unit || original === undefined || !original.trim()) {
      throw new Error(`Sandbox parser returned an invalid source cell at position ${position}`)
    }
    const rawType = unit.type
    if (rawType !== undefined && (typeof rawType !== "string" || !CELL_TYPES.has(rawType as CellType))) {
      throw new Error(`Sandbox parser returned an invalid cell type at position ${position}`)
    }
    const type: CellType = (rawType as CellType | undefined) ?? "text"
    if (
      unit.globalReferences !== undefined
      && (!Array.isArray(unit.globalReferences)
        || unit.globalReferences.length > 32
        || unit.globalReferences.some((ref) => typeof ref !== "string" || ref.length > 255))
    ) {
      throw new Error(`Sandbox parser returned invalid references at position ${position}`)
    }
    const refs = (unit.globalReferences ?? []) as string[]
    const record = position
    const structural = type === "heading" || type === "paratext"
    // A model may attach the following verse as contextual chapter evidence.
    // Keep that evidence, but never expose it as the heading's canonical ref:
    // ref-based target matching would otherwise pair verse text to the heading.
    let identityRefs = structural
      ? refs.filter((ref) => SCRIPTURE_STRUCTURE_RE.test(ref))
      : refs
    const structuralContextRefs = structural
      ? refs.filter((ref) => !SCRIPTURE_STRUCTURE_RE.test(ref))
      : []
    const contextualVerseRef = structural
      ? refs.find((ref) => SCRIPTURE_VERSE_RE.test(ref))
      : undefined
    const rawGroup = checkedOptionalString(unit.group, 1000, "group", position)
    const inferredSection = contextualVerseRef?.split(":", 1)[0]
      ?? (rawGroup && SCRIPTURE_VERSE_RE.test(rawGroup) ? rawGroup.split(":", 1)[0] : undefined)
    const section = checkedOptionalString(unit.section, 1000, "section", position) ?? inferredSection
    if (structural && identityRefs.length === 0 && section && /^[1-3]?[A-Z]{2,3}\s+\d+$/i.test(section)) {
      identityRefs = [`${section}:${type === "heading" ? "h" : "p"}:${record}`]
    }
    const group = structural && rawGroup && SCRIPTURE_VERSE_RE.test(rawGroup)
      ? identityRefs[0] ?? section
      : rawGroup ?? identityRefs[0] ?? section
    const metadata = unit.metadata === undefined ? {} : object(unit.metadata)
    if (!metadata) throw new Error(`Sandbox parser returned invalid metadata at position ${position}`)
    if (unit.paragraphStart !== undefined && typeof unit.paragraphStart !== "boolean") {
      throw new Error(`Sandbox parser returned invalid paragraphStart at position ${position}`)
    }
    const targetText = checkedOptionalString(unit.targetText, 100_000, "target text", position)
    const speaker = checkedOptionalString(unit.speaker, 500, "speaker", position)
    const context = checkedOptionalString(unit.context, 1000, "context", position)
      ?? refs[0]
      ?? section
      ?? `Imported record ${record}`
    const start = finiteNumber(unit.start)
    const end = finiteNumber(unit.end)
    if (
      (unit.start !== undefined && start === undefined)
      || (unit.end !== undefined && end === undefined)
      || (start === undefined) !== (end === undefined)
      || (start !== undefined && (start < 0 || end! <= start))
    ) {
      throw new Error(`Sandbox parser returned invalid timing at position ${position}`)
    }
    return {
      id: uuidv7(),
      original,
      translated: targetText ?? "",
      context,
      group: group ?? `${recipeId}:${record}`,
      ...(section ? { section } : {}),
      ...(identityRefs.length ? { globalReferences: identityRefs } : {}),
      type,
      ...(speaker ? { speaker } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(unit.paragraphStart === true ? { paragraphStart: true } : {}),
      metadata: {
        ...metadata,
        ...(structuralContextRefs.length > 0
          ? { aquillaStructuralContext: { globalReferences: refs, ...(rawGroup ? { group: rawGroup } : {}) } }
          : {}),
        aquillaRecipe: { recipeId, record },
      },
    }
  })
}

export async function parseUnknownFileInSandbox(
  file: File,
  options: {
    identityToken: string
    projectId: string
    sourceLanguage?: string
    targetLanguage?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<SandboxParsedImport> {
  const response = await (options.fetchImpl ?? fetch)(
    `${IMPORT_SANDBOX_PARSE_URL}/${encodeURIComponent(options.projectId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.identityToken}`,
        "Content-Type": file.type || "application/octet-stream",
        "X-Artifact-Name": encodeURIComponent(file.name),
        ...(options.sourceLanguage ? { "X-Source-Language": encodeURIComponent(options.sourceLanguage) } : {}),
        ...(options.targetLanguage ? { "X-Target-Language": encodeURIComponent(options.targetLanguage) } : {}),
      },
      body: file,
      signal: options.signal,
    },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string; error?: { message?: string } } | null
    const detail = payload?.message ?? payload?.error?.message
    throw new Error(detail || `Sandbox format analysis failed (${response.status})`)
  }
  const payload = object(await response.json())
  const classification = object(payload?.classification)
  const category = classification?.category
  const recipe = await validateRecipe(classification?.recipe)
  if (typeof category !== "string" || !CATEGORIES.has(category as ImportContentCategory)) {
    throw new Error("Sandbox parser returned an invalid content category")
  }
  const confidence = finiteNumber(classification?.confidence)
  const explanation = optionalString(classification?.explanation, 1000)
  if (confidence === undefined || confidence < 0 || confidence > 1 || !explanation?.trim()) {
    throw new Error("Sandbox parser returned invalid classification details")
  }
  return {
    strings: validateUnits(payload?.units, recipe.id),
    classification: {
      category: category as ImportContentCategory,
      confidence,
      explanation,
      recipe,
    },
  }
}
