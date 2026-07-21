import type { FileType, SourceLocation, TranslatableString } from "@/lib/parsers/types"

export const NORMALIZED_IMPORT_VERSION = 1 as const

export type ImportUnitKind =
  | "verse"
  | "heading"
  | "paratext"
  | "paragraph"
  | "list"
  | "blockquote"
  | "cue"
  | "segment"
  | "media"
  | "other"

export type RoundTripFidelity =
  | "native"
  | "verified-recipe"
  | "content-only"
  | "preserved-only"

export type ImportAddress =
  | {
      scheme: "scripture"
      book: string
      chapter: number
      verse: string
    }
  | {
      scheme: "scripture-structure"
      book: string
      chapter: number | null
      marker: string
      occurrence: number
    }
  | {
      scheme: "document"
      memberPath: string
      blockPath: string
      segment: number
    }
  | {
      scheme: "translation-unit"
      format: "xliff" | "tmx"
      unitId: string
      segmentId?: string
    }
  | {
      scheme: "timeline"
      cue: number
      startMs?: number
      endMs?: number
    }
  | {
      scheme: "sequence"
      index: number
    }

export type ImportSourceLocator =
  | {
      kind: "usfm"
      ref: string
      marker: string
      occurrence?: number
    }
  | {
      kind: "package-block"
      memberPath: string
      blockPath: string
      segment: number
    }
  | {
      kind: "translation-unit"
      format: "xliff" | "tmx"
      unitId: string
      segmentId?: string
    }
  | {
      kind: "cue"
      index: number
      startMs?: number
      endMs?: number
    }
  | {
      kind: "sequence"
      index: number
    }

export interface NormalizedImportUnit {
  unitKey: string
  kind: ImportUnitKind
  displayLabel: string | null
  canonicalRef?: string
  address: ImportAddress
  sourceLocator: ImportSourceLocator
  physicalOrder: number
  sourceText: string
  sourceHtml?: string
  targetText?: string
  startMs?: number
  endMs?: number
  speaker?: string
  paragraphStart?: boolean
  metadata?: Record<string, unknown>
}

export interface ImportWarning {
  code:
    | "duplicate-unit-key"
    | "duplicate-canonical-ref"
    | "invalid-timing"
    | "missing-verse-reference"
    | "empty-source"
  message: string
  unitKey?: string
  physicalOrder?: number
}

export interface NormalizedImportFile {
  manifestVersion: typeof NORMALIZED_IMPORT_VERSION
  fileName: string
  fileType: FileType
  profileId: string
  profileVersion: string
  deterministic: boolean
  fidelity: RoundTripFidelity
  units: NormalizedImportUnit[]
  warnings: ImportWarning[]
}

/**
 * Compact file-level provenance stored with the file projection. Unit-level
 * addresses and locators stay on cells, so this summary remains small even for
 * large books or subtitle files.
 */
export interface NormalizedImportSummary {
  version: typeof NORMALIZED_IMPORT_VERSION
  profileId: string
  profileVersion: string
  deterministic: boolean
  fidelity: RoundTripFidelity
  unitCount: number
  warningCounts: Partial<Record<ImportWarning["code"], number>>
}

export interface AquillaImportMetadata {
  version: typeof NORMALIZED_IMPORT_VERSION
  profileId: string
  profileVersion: string
  unitKey: string
  kind: ImportUnitKind
  displayLabel: string | null
  address: ImportAddress
  sourceLocator: ImportSourceLocator
  physicalOrder: number
  fidelity: RoundTripFidelity
}

export interface NormalizeImportOptions {
  fileName: string
  fileType: FileType
  profileId?: string
  profileVersion?: string
  fidelity?: RoundTripFidelity
}

interface XliffMetadata {
  unitId?: unknown
  segId?: unknown
}

interface TmxMetadata {
  tuid?: unknown
}

const SCRIPTURE_VERSE_RE = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+[a-z]?(?:-\d+[a-z]?)?)$/i
const SCRIPTURE_STRUCTURE_RE = /^([1-3]?[A-Z]{2,3})(?:\s+(\d+))?:([a-z]+\d*):(\d+)$/i

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function occurrenceKey(base: string, occurrences: Map<string, number>): { key: string; occurrence: number } {
  const occurrence = (occurrences.get(base) ?? 0) + 1
  occurrences.set(base, occurrence)
  return {
    key: occurrence === 1 ? base : `${base}#${occurrence}`,
    occurrence,
  }
}

function unitKind(value: TranslatableString): ImportUnitKind {
  if (value.medium === "media") return "media"
  switch (value.type) {
    case "verse":
      return "verse"
    case "heading":
      return "heading"
    case "paratext":
      return "paratext"
    case "list":
      return "list"
    case "blockquote":
      return "blockquote"
    case "cue":
      return "cue"
    case "text":
      return value.paragraphStart ? "paragraph" : "segment"
  }
}

function canonicalRef(value: TranslatableString): string | undefined {
  return nonEmptyString(value.globalReferences?.[0]) ?? nonEmptyString(value.group)
}

function addressAndLocator(
  value: TranslatableString,
  kind: ImportUnitKind,
  ref: string | undefined,
  physicalOrder: number,
  locationSegment: number,
): { address: ImportAddress; sourceLocator: ImportSourceLocator; keyBase: string; displayLabel: string | null } {
  const verse = ref?.match(SCRIPTURE_VERSE_RE)
  if (verse) {
    const normalizedRef = `${verse[1].toUpperCase()} ${Number(verse[2])}:${verse[3]}`
    return {
      address: {
        scheme: "scripture",
        book: verse[1].toUpperCase(),
        chapter: Number(verse[2]),
        verse: verse[3],
      },
      sourceLocator: { kind: "usfm", ref: normalizedRef, marker: "v" },
      keyBase: `scripture:${normalizedRef}`,
      displayLabel: kind === "verse" ? verse[3] : null,
    }
  }

  const structure = ref?.match(SCRIPTURE_STRUCTURE_RE)
  if (structure && (kind === "heading" || kind === "paratext")) {
    const marker = structure[3].toLowerCase()
    const occurrence = Number(structure[4])
    return {
      address: {
        scheme: "scripture-structure",
        book: structure[1].toUpperCase(),
        chapter: structure[2] ? Number(structure[2]) : null,
        marker,
        occurrence,
      },
      sourceLocator: { kind: "usfm", ref: ref!, marker, occurrence },
      keyBase: `scripture-structure:${ref}`,
      displayLabel: null,
    }
  }

  const xliff = value.metadata?.xliff as XliffMetadata | undefined
  const xliffUnitId = nonEmptyString(xliff?.unitId)
  if (xliffUnitId) {
    const segmentId = nonEmptyString(xliff?.segId)
    return {
      address: {
        scheme: "translation-unit",
        format: "xliff",
        unitId: xliffUnitId,
        ...(segmentId ? { segmentId } : {}),
      },
      sourceLocator: {
        kind: "translation-unit",
        format: "xliff",
        unitId: xliffUnitId,
        ...(segmentId ? { segmentId } : {}),
      },
      keyBase: `xliff:${xliffUnitId}${segmentId ? `:${segmentId}` : ""}`,
      displayLabel: String(physicalOrder + 1),
    }
  }

  const tmx = value.metadata?.tmx as TmxMetadata | undefined
  const tmxUnitId = nonEmptyString(tmx?.tuid) ?? nonEmptyString(value.group) ?? nonEmptyString(value.context)
  if (tmx && tmxUnitId) {
    return {
      address: { scheme: "translation-unit", format: "tmx", unitId: tmxUnitId },
      sourceLocator: { kind: "translation-unit", format: "tmx", unitId: tmxUnitId },
      keyBase: `tmx:${tmxUnitId}`,
      displayLabel: String(physicalOrder + 1),
    }
  }

  if (value.sourceLocation) {
    return {
      address: {
        scheme: "document",
        memberPath: value.sourceLocation.file,
        blockPath: value.sourceLocation.blockPath,
        segment: locationSegment,
      },
      sourceLocator: {
        kind: "package-block",
        memberPath: value.sourceLocation.file,
        blockPath: value.sourceLocation.blockPath,
        segment: locationSegment,
      },
      keyBase: `document:${value.sourceLocation.file}:${value.sourceLocation.blockPath}:${locationSegment}`,
      displayLabel: kind === "heading" ? null : String(physicalOrder + 1),
    }
  }

  if (kind === "cue") {
    const startMs = value.start === undefined ? undefined : Math.round(value.start * 1000)
    const endMs = value.end === undefined ? undefined : Math.round(value.end * 1000)
    const cue = physicalOrder + 1
    return {
      address: { scheme: "timeline", cue, ...(startMs === undefined ? {} : { startMs }), ...(endMs === undefined ? {} : { endMs }) },
      sourceLocator: { kind: "cue", index: cue, ...(startMs === undefined ? {} : { startMs }), ...(endMs === undefined ? {} : { endMs }) },
      keyBase: `cue:${nonEmptyString(value.context) ?? `${startMs ?? "untimed"}:${endMs ?? "untimed"}`}`,
      displayLabel: String(cue),
    }
  }

  const index = physicalOrder + 1
  const stableHint = nonEmptyString(value.group) ?? nonEmptyString(value.context) ?? kind
  return {
    address: { scheme: "sequence", index },
    sourceLocator: { kind: "sequence", index },
    keyBase: `sequence:${stableHint}`,
    displayLabel: kind === "heading" || kind === "paratext" ? null : String(index),
  }
}

function fidelityFor(fileType: FileType): RoundTripFidelity {
  switch (fileType) {
    case "usfm":
    case "docx":
    case "pptx":
      return "native"
    case "xliff":
    case "tmx":
    case "csv":
    case "tsv":
    case "txt":
    case "md":
    case "vtt":
    case "srt":
      return "content-only"
    case "audio":
    case "video":
      return "preserved-only"
    case "ebible":
    case "helloao":
    case "obs":
    case "sdbh":
      return "content-only"
  }
}

export function normalizeTranslatableStrings(
  strings: TranslatableString[],
  options: NormalizeImportOptions,
): NormalizedImportFile {
  const occurrences = new Map<string, number>()
  const locationOccurrences = new Map<string, number>()
  const canonicalOccurrences = new Map<string, number>()
  const warnings: ImportWarning[] = []

  const units = strings.map((value, physicalOrder): NormalizedImportUnit => {
    const kind = unitKind(value)
    const ref = canonicalRef(value)
    const locationBase = value.sourceLocation
      ? `${value.sourceLocation.file}:${value.sourceLocation.blockPath}`
      : ""
    const locationSegment = locationBase
      ? (locationOccurrences.get(locationBase) ?? 0) + 1
      : 1
    if (locationBase) locationOccurrences.set(locationBase, locationSegment)

    const described = addressAndLocator(value, kind, ref, physicalOrder, locationSegment)
    const { key: unitKey } = occurrenceKey(described.keyBase, occurrences)

    if (value.original.trim() === "") {
      warnings.push({
        code: "empty-source",
        message: "The unit has no source text.",
        unitKey,
        physicalOrder,
      })
    }
    if (kind === "verse" && described.address.scheme !== "scripture") {
      warnings.push({
        code: "missing-verse-reference",
        message: "A verse unit has no parseable canonical Scripture reference.",
        unitKey,
        physicalOrder,
      })
    }
    if (described.address.scheme === "scripture") {
      const seen = canonicalOccurrences.get(described.keyBase) ?? 0
      canonicalOccurrences.set(described.keyBase, seen + 1)
      if (seen > 0) {
        warnings.push({
          code: "duplicate-canonical-ref",
          message: `Canonical reference ${ref} occurs more than once.`,
          unitKey,
          physicalOrder,
        })
      }
    }
    if (
      kind === "cue"
      && value.start !== undefined
      && value.end !== undefined
      && value.end <= value.start
    ) {
      warnings.push({
        code: "invalid-timing",
        message: "Cue end time must be after its start time.",
        unitKey,
        physicalOrder,
      })
    }

    const startMs = value.start === undefined ? undefined : Math.round(value.start * 1000)
    const endMs = value.end === undefined ? undefined : Math.round(value.end * 1000)
    return {
      unitKey,
      kind,
      displayLabel: described.displayLabel,
      ...(ref ? { canonicalRef: ref } : {}),
      address: described.address,
      sourceLocator: described.sourceLocator,
      physicalOrder,
      sourceText: value.original,
      ...(value.originalHtml ? { sourceHtml: value.originalHtml } : {}),
      ...(value.translated ? { targetText: value.translated } : {}),
      ...(startMs === undefined ? {} : { startMs }),
      ...(endMs === undefined ? {} : { endMs }),
      ...(value.speaker ? { speaker: value.speaker } : {}),
      ...(value.paragraphStart ? { paragraphStart: true } : {}),
      ...(value.metadata ? { metadata: value.metadata } : {}),
    }
  })

  return {
    manifestVersion: NORMALIZED_IMPORT_VERSION,
    fileName: options.fileName,
    fileType: options.fileType,
    profileId: options.profileId ?? `builtin:${options.fileType}`,
    profileVersion: options.profileVersion ?? "1",
    deterministic: true,
    fidelity: options.fidelity ?? fidelityFor(options.fileType),
    units,
    warnings,
  }
}

export function aquillaImportMetadata(
  file: Pick<NormalizedImportFile, "profileId" | "profileVersion" | "fidelity">,
  unit: NormalizedImportUnit,
): AquillaImportMetadata {
  return {
    version: NORMALIZED_IMPORT_VERSION,
    profileId: file.profileId,
    profileVersion: file.profileVersion,
    unitKey: unit.unitKey,
    kind: unit.kind,
    displayLabel: unit.displayLabel,
    address: unit.address,
    sourceLocator: unit.sourceLocator,
    physicalOrder: unit.physicalOrder,
    fidelity: file.fidelity,
  }
}

export function summarizeNormalizedImport(
  file: NormalizedImportFile,
): NormalizedImportSummary {
  const warningCounts: NormalizedImportSummary["warningCounts"] = {}
  for (const warning of file.warnings) {
    warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + 1
  }
  return {
    version: file.manifestVersion,
    profileId: file.profileId,
    profileVersion: file.profileVersion,
    deterministic: file.deterministic,
    fidelity: file.fidelity,
    unitCount: file.units.length,
    warningCounts,
  }
}

export function sourceLocationFromLocator(locator: ImportSourceLocator): SourceLocation | undefined {
  return locator.kind === "package-block"
    ? { file: locator.memberPath, blockPath: locator.blockPath }
    : undefined
}
