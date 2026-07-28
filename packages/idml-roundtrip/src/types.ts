export const IDML_SCHEMA_VERSION = 2 as const

export type IdmlScope =
  | "story-paragraph"
  | "table-cell"
  | "footnote"
  | "endnote"
  | "note"
  | "text-path"
  | "anchored-story"
  | "master-story"
  | "custom-variable"

export type IdmlDiagnosticSeverity = "info" | "warning" | "error"

export type IdmlDiagnosticCode =
  | "INVALID_ZIP"
  | "ZIP64_UNSUPPORTED"
  | "ARCHIVE_TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "EXPANSION_TOO_LARGE"
  | "COMPRESSION_RATIO_EXCEEDED"
  | "UNSAFE_MEMBER_PATH"
  | "DUPLICATE_MEMBER"
  | "ENCRYPTED_MEMBER"
  | "UNSUPPORTED_COMPRESSION"
  | "INVALID_MIMETYPE"
  | "INVALID_UCF_ORDER"
  | "MISSING_DESIGNMAP"
  | "MALFORMED_XML"
  | "UNSAFE_XML_DECLARATION"
  | "MISSING_STORY"
  | "UNSUPPORTED_CONSTRUCT"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "ANCHOR_MISSING"
  | "ANCHOR_DUPLICATED"
  | "ANCHOR_REORDERED"
  | "ANCHOR_INVALID"
  | "LOCATOR_MISSING"
  | "LOCATOR_DUPLICATED"
  | "LOCATOR_STALE"
  | "SOURCE_HASH_MISMATCH"
  | "MEMBER_CHANGED"
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED"
  | "EXPORT_REJECTED"

export interface IdmlDiagnostic {
  readonly code: IdmlDiagnosticCode
  readonly severity: IdmlDiagnosticSeverity
  readonly message: string
  readonly memberPath?: string
  readonly unitId?: string
  readonly details?: Readonly<Record<string, string | number | boolean | null>>
}

export interface IdmlLimits {
  readonly maxInputBytes: number
  readonly maxEntries: number
  readonly maxEntryUncompressedBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxCompressionRatio: number
}

export interface IdmlArchiveMember {
  readonly path: string
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly compressionMethod: 0 | 8
  readonly crc32: number
  readonly localHeaderOffset: number
  readonly isDirectory: boolean
}

export interface IdmlPackageInspection {
  readonly format: "idml"
  readonly mimetype: "application/vnd.adobe.indesign-idml-package"
  readonly byteLength: number
  readonly members: readonly IdmlArchiveMember[]
  readonly diagnostics: readonly IdmlDiagnostic[]
}

export interface IdmlLocator {
  readonly kind: "idml"
  readonly memberPath: string
  readonly storyId?: string
  readonly elementPath: string
  readonly elementId?: string
  readonly scope: IdmlScope
  readonly part: number
  readonly slotIndexes: readonly number[]
  readonly sourceBlockHash: string
}

export interface IdmlFormatMetadataV2 {
  readonly version: 2
  readonly slotCount: number
  readonly editableSlotIndexes: readonly number[]
  readonly protectedTokenCount: number
  readonly anchorSequenceHash: string
}

export interface IdmlTextSlot {
  readonly index: number
  readonly text: string
  readonly characterStyleId: string
  readonly editable: boolean
}

export type IdmlProtectedTokenKind =
  | "br"
  | "tab"
  | "inline-object"
  | "variable"
  | "cross-reference"
  | "unknown"

export interface IdmlProtectedToken {
  readonly index: number
  readonly kind: IdmlProtectedTokenKind
  readonly xmlName: string
  readonly position: number
}

export interface IdmlTranslationUnit {
  readonly id: string
  readonly order: number
  readonly sourceText: string
  readonly sourceHtml: string
  readonly locator: IdmlLocator
  readonly metadata: IdmlFormatMetadataV2
  readonly slots: readonly IdmlTextSlot[]
  readonly protectedTokens: readonly IdmlProtectedToken[]
  readonly diagnostics: readonly IdmlDiagnostic[]
  /**
   * `AppliedParagraphStyle` of the originating ParagraphStyleRange. Semantic
   * adapters (e.g. Biblica study-note selection) classify paragraphs by style,
   * which no other unit field carries. Absent for custom-variable units.
   *
   * Parse-time context only: it is deliberately outside `metadata`, so the
   * persisted v2 cell shape and the anchor hash are unaffected.
   */
  readonly paragraphStyleId?: string
}

/**
 * The character range of one owner slot that a slice owns.
 *
 * `slot` is the slot's position in the owner unit (slot positions and
 * `IdmlTextSlot.index` always coincide within a unit). Offsets are indexes into
 * that slot's source text, so a slice may own part of a slot — which is what
 * lets a caller cut a paragraph at sentence boundaries rather than only between
 * slots.
 */
export interface IdmlSliceRange {
  readonly slot: number
  readonly start: number
  readonly end: number
}

/**
 * One editor-sized piece of a unit: a self-consistent unit a translator can
 * edit, plus the owner ranges needed to merge its translation back.
 */
export interface IdmlUnitSlice {
  readonly unit: IdmlTranslationUnit
  readonly ranges: readonly IdmlSliceRange[]
}

/** A slice's translated slot text, ready to be merged back into its owner. */
export interface IdmlSliceTranslation {
  readonly ranges: readonly IdmlSliceRange[]
  /**
   * Target text per slice slot, in slice-slot order. `undefined` keeps the
   * owner's source text for that range, so an untranslated slice never blanks
   * out text a publisher shipped.
   */
  readonly slotTexts: readonly (string | undefined)[]
}

export interface IdmlManifestMember {
  readonly path: string
  readonly sha256: string
  readonly byteLength: number
  readonly isDirectory: boolean
  /**
   * Canonical XML structure with literal translatable text removed. Injected
   * Content/Br/Content line-break chains are folded so legitimate translation
   * reflow does not look like structural corruption.
   */
  readonly structuralSha256?: string
}

export interface IdmlSourceManifest {
  readonly version: 2
  readonly sourceSha256: string
  readonly profile: string
  readonly members: readonly IdmlManifestMember[]
  readonly unitLocators: readonly IdmlLocator[]
  readonly diagnostics: readonly IdmlDiagnostic[]
}

export interface IdmlParseResult {
  readonly units: readonly IdmlTranslationUnit[]
  readonly manifest: IdmlSourceManifest
  readonly diagnostics: readonly IdmlDiagnostic[]
}

export type IdmlSemanticProfile =
  | "generic"
  | "biblica"
  | {
      readonly id: string
      readonly includeUnit?: (unit: IdmlTranslationUnit) => boolean
    }

export interface IdmlTranslation {
  readonly unitId: string
  readonly locator: IdmlLocator
  readonly metadata: IdmlFormatMetadataV2
  readonly sourceHtml: string
  readonly targetHtml: string
}

export interface IdmlTranslationValidation {
  readonly valid: boolean
  readonly diagnostics: readonly IdmlDiagnostic[]
  readonly slots: readonly string[]
}

export interface IdmlExportReport {
  readonly translated: number
  readonly unchanged: number
  readonly missing: number
  readonly rejected: number
  readonly unsupported: number
  readonly changedMemberPaths: readonly string[]
  readonly originalByteLength: number
  readonly exportedByteLength: number
  readonly sizeDelta: number
  readonly warnings: readonly IdmlDiagnostic[]
}

export interface IdmlExportResult {
  readonly bytes: Uint8Array
  readonly report: IdmlExportReport
}

export interface IdmlExportOptions {
  readonly strict: true
  readonly limits?: Partial<IdmlLimits>
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: IdmlProgress) => void
}

export interface IdmlParseOptions {
  readonly limits?: Partial<IdmlLimits>
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: IdmlProgress) => void
}

export interface IdmlProgress {
  readonly phase: "inspect" | "unpack" | "parse" | "validate" | "export" | "package"
  readonly completed: number
  readonly total: number
  readonly memberPath?: string
}

export type LegacyIdmlUpgradeResult =
  | {
      readonly ok: true
      readonly locator: IdmlLocator
      readonly metadata: IdmlFormatMetadataV2
      readonly sourceHtml: string
      readonly targetHtml?: string
    }
  | {
      readonly ok: false
      readonly diagnostics: readonly IdmlDiagnostic[]
    }
