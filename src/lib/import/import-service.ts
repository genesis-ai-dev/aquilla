import type { FileType, TranslatableString } from "@/lib/parsers/types"
import {
  normalizeTranslatableStrings,
  type DeclarativeImportRecipe,
  type NormalizedImportFile,
} from "./normalized-manifest"
import type { AiImportClassification } from "./ai-recipe"
import type { RoundTripFidelity } from "../../../shared/import-contract"

export interface ParsedImportResult {
  name: string
  strings: TranslatableString[]
  rawSource?: string
  rawSourceFormat?: string
  rawBytes?: ArrayBuffer
  bookCode?: string
  corpusMarker?: "OT" | "NT"
  originalName?: string
  importRecipe?: DeclarativeImportRecipe
  importClassification?: Omit<AiImportClassification, "recipe"> & { recipe: DeclarativeImportRecipe }
  roundTripFidelity?: RoundTripFidelity
  /** Exact multi-member container retained once and bound to every emitted file. */
  sharedSourceArtifact?: { name: string; bytes: ArrayBuffer; format: string }
}

export interface PreparedImportFile {
  fileType: FileType
  results: ParsedImportResult[]
}

export interface ImportServiceContext {
  skipKeys?: ReadonlySet<string>
}

export interface ImportServiceCommitResult<Reference> {
  ref: Reference
  speakerPairs: { cellId: string; speaker: string | undefined }[]
}

export interface ImportServiceResult<Reference> {
  refs: Reference[]
  speakerPairs: { cellId: string; speaker: string | undefined }[]
  manifests: NormalizedImportFile[]
}

export interface ImportServiceDependencies<Context extends ImportServiceContext, Reference> {
  detectFileType: (fileName: string) => FileType | null
  isMediaFileType: (fileType: FileType) => boolean
  parseFile: (file: File, fileType: FileType) => Promise<ParsedImportResult[]>
  emitMediaFile: (file: File, fileType: FileType, context: Context) => Promise<Reference>
  emitParsedFile: (
    result: ParsedImportResult,
    fileType: FileType,
    context: Context,
    manifest: NormalizedImportFile,
  ) => Promise<ImportServiceCommitResult<Reference>>
}

function profileId(fileType: FileType): string {
  switch (fileType) {
    case "usfm":
      return "builtin:usfm-lossless"
    case "docx":
    case "pptx":
      return `builtin:ooxml-${fileType}`
    case "vtt":
    case "srt":
      return `builtin:subtitle-${fileType}`
    case "xliff":
    case "tmx":
      return `builtin:translation-${fileType}`
    default:
      return `builtin:${fileType}`
  }
}

/**
 * The single browser-side gateway for file imports.
 *
 * Existing deterministic parsers remain adapters behind this service. Every
 * parsed file is normalized before the first event is emitted, so callers do
 * not get a format-specific escape hatch that can bypass unit identity,
 * source-locator, ordering, warning, or fidelity metadata.
 */
export class ImportService<Context extends ImportServiceContext, Reference> {
  private readonly dependencies: ImportServiceDependencies<Context, Reference>

  constructor(dependencies: ImportServiceDependencies<Context, Reference>) {
    this.dependencies = dependencies
  }

  async importFile(
    file: File,
    context: Context,
    prepared?: PreparedImportFile,
  ): Promise<ImportServiceResult<Reference>> {
    const fileType = prepared?.fileType ?? this.dependencies.detectFileType(file.name)
    if (!fileType) {
      throw new Error(`Unsupported file type: ${file.name}`)
    }

    if (this.dependencies.isMediaFileType(fileType)) {
      const ref = await this.dependencies.emitMediaFile(file, fileType, context)
      return { refs: [ref], speakerPairs: [], manifests: [] }
    }

    const fileNameKey = file.name.trim().toLowerCase()
    if (context.skipKeys?.has(fileNameKey)) {
      return { refs: [], speakerPairs: [], manifests: [] }
    }

    const results = prepared?.results ?? await this.dependencies.parseFile(file, fileType)
    if (results.length === 0) {
      throw new Error(`${file.name} did not contain any importable content.`)
    }
    const refs: Reference[] = []
    const speakerPairs: { cellId: string; speaker: string | undefined }[] = []
    const manifests: NormalizedImportFile[] = []

    for (const result of results) {
      const resultNameKey = result.name.trim().toLowerCase()
      const resultCodeKey = result.bookCode?.toUpperCase()
      if (
        context.skipKeys?.has(resultNameKey)
        || (resultCodeKey && context.skipKeys?.has(resultCodeKey))
      ) {
        continue
      }
      if (result.strings.length === 0) {
        throw new Error(`${result.name} did not contain any importable content.`)
      }

      const manifest = normalizeTranslatableStrings(result.strings, {
        fileName: result.name,
        fileType,
        profileId: result.importRecipe
          ? `agentic:${result.importRecipe.id}`
          : result.rawSourceFormat === "usx"
            ? "builtin:usx-to-usfm"
            : profileId(fileType),
        profileVersion: "1",
        ...(result.importRecipe ? {
          deterministic: false,
          fidelity: "content-only" as const,
          recipe: result.importRecipe,
        } : result.rawSourceFormat === "usx" ? {
          // The exact USX artifact is retained, but translated content is not
          // yet serialized back into USX. Do not claim native round-trip.
          fidelity: "content-only" as const,
        } : result.roundTripFidelity ? {
          fidelity: result.roundTripFidelity,
        } : {}),
      })
      const committed = await this.dependencies.emitParsedFile(
        result,
        fileType,
        context,
        manifest,
      )
      refs.push(committed.ref)
      speakerPairs.push(...committed.speakerPairs)
      manifests.push(manifest)
    }

    return { refs, speakerPairs, manifests }
  }
}
