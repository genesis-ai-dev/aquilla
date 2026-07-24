import {
  computeIdmlAnchorSequenceHash,
  parseLegacySegmentIndexHtml,
  renderIdmlUnitHtml,
  sha256Hex,
  validateIdmlTranslation,
} from "./html.js"
import type {
  IdmlDiagnostic,
  IdmlFormatMetadataV2,
  IdmlLocator,
  IdmlProtectedToken,
  IdmlScope,
  IdmlTextSlot,
  IdmlTranslationUnit,
  LegacyIdmlUpgradeResult,
} from "./types.js"

type UnknownRecord = Record<string, unknown>

const IDML_SCOPES = new Set<IdmlScope>([
  "story-paragraph",
  "table-cell",
  "footnote",
  "endnote",
  "note",
  "text-path",
  "anchored-story",
  "master-story",
  "custom-variable",
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function recordAt(value: unknown, ...path: readonly string[]): UnknownRecord | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

function valueAt(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function diagnostic(code: IdmlDiagnostic["code"], message: string): IdmlDiagnostic {
  return { code, severity: "error", message }
}

function rejected(code: IdmlDiagnostic["code"], message: string): LegacyIdmlUpgradeResult {
  return { ok: false, diagnostics: [diagnostic(code, message)] }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function uniqueDefined(values: readonly (string | undefined)[]): string | undefined | null {
  const defined = values.filter((value): value is string => value !== undefined)
  if (defined.length === 0) return undefined
  return defined.every((value) => value === defined[0]) ? defined[0] : null
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined
}

function booleanArray(value: unknown): readonly boolean[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "boolean")
    ? value
    : undefined
}

function numberArray(value: unknown): readonly number[] | undefined {
  return Array.isArray(value)
    && value.every((item) => Number.isSafeInteger(item) && item >= 0)
    ? value as number[]
    : undefined
}

function validSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined
}

function validMemberPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[^\\\u0000-\u001f]+$/.test(value)) return undefined
  if (
    value.startsWith("/")
    || value.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    return undefined
  }
  return value
}

function formatCandidate(input: UnknownRecord): UnknownRecord | undefined {
  const direct = recordAt(input, "metadata")
  if (direct && direct.version !== undefined && direct.slotCount !== undefined) return direct
  return recordAt(input, "metadata", "idml")
    ?? recordAt(input, "idml")
    ?? (
      input.version !== undefined && input.slotCount !== undefined
        ? input
        : undefined
    )
}

function locatorCandidate(input: UnknownRecord): UnknownRecord | undefined {
  const locator = recordAt(input, "locator") ?? recordAt(input, "sourceLocator")
  return locator?.kind === "idml" ? locator : undefined
}

function sourceHtmlCandidate(input: UnknownRecord): string | undefined {
  return nonEmptyString(input.sourceHtml)
    ?? nonEmptyString(input.valueHtml)
    ?? (
      typeof input.value === "string" && input.value.includes("data-segment-index")
        ? input.value
        : undefined
    )
    ?? nonEmptyString(valueAt(input, "source", "sourceHtml"))
    ?? nonEmptyString(valueAt(input, "source", "valueHtml"))
    ?? (
      typeof valueAt(input, "source", "value") === "string"
        ? valueAt(input, "source", "value") as string
        : undefined
    )
}

function targetHtmlCandidate(input: UnknownRecord): string | undefined {
  return nonEmptyString(input.targetHtml)
    ?? nonEmptyString(valueAt(input, "target", "targetHtml"))
    ?? nonEmptyString(valueAt(input, "target", "valueHtml"))
    ?? (
      typeof valueAt(input, "target", "value") === "string"
        ? valueAt(input, "target", "value") as string
        : undefined
    )
}

function futureVersion(input: UnknownRecord): number | undefined {
  const candidates = [
    valueAt(input, "metadata", "idml", "version"),
    valueAt(input, "idml", "version"),
    input.slotCount !== undefined ? input.version : undefined,
  ]
  const directMetadata = recordAt(input, "metadata")
  if (directMetadata?.slotCount !== undefined) candidates.push(directMetadata.version)
  for (const version of candidates) {
    if (typeof version === "number" && Number.isInteger(version) && version > 2) return version
    if (typeof version === "string" && /^[0-9]+$/.test(version)) {
      const parsed = Number(version)
      if (Number.isSafeInteger(parsed) && parsed > 2) return parsed
    }
  }
  return undefined
}

function parseMetadataV2(candidate: UnknownRecord): IdmlFormatMetadataV2 | undefined {
  const editableSlotIndexes = numberArray(candidate.editableSlotIndexes)
  const slotCount = nonNegativeInteger(candidate.slotCount)
  const protectedTokenCount = nonNegativeInteger(candidate.protectedTokenCount)
  const anchorSequenceHash = validSha256(candidate.anchorSequenceHash)
  if (
    candidate.version !== 2
    || slotCount === undefined
    || !editableSlotIndexes
    || protectedTokenCount === undefined
    || !anchorSequenceHash
  ) {
    return undefined
  }
  return {
    version: 2,
    slotCount,
    editableSlotIndexes,
    protectedTokenCount,
    anchorSequenceHash,
  }
}

function parseLocator(candidate: UnknownRecord): IdmlLocator | undefined {
  const memberPath = validMemberPath(candidate.memberPath)
  const elementPath = nonEmptyString(candidate.elementPath)
  const scope = candidate.scope
  const part = nonNegativeInteger(candidate.part)
  const slotIndexes = numberArray(candidate.slotIndexes)
  const sourceBlockHash = validSha256(candidate.sourceBlockHash)
  if (
    candidate.kind !== "idml"
    || !memberPath
    || !elementPath
    || typeof scope !== "string"
    || !IDML_SCOPES.has(scope as IdmlScope)
    || part === undefined
    || !slotIndexes
    || !sourceBlockHash
  ) {
    return undefined
  }
  return {
    kind: "idml",
    memberPath,
    ...(nonEmptyString(candidate.storyId) ? { storyId: candidate.storyId as string } : {}),
    elementPath,
    ...(nonEmptyString(candidate.elementId) ? { elementId: candidate.elementId as string } : {}),
    scope: scope as IdmlScope,
    part,
    slotIndexes,
    sourceBlockHash,
  }
}

function upgradeV2Passthrough(input: UnknownRecord): LegacyIdmlUpgradeResult | undefined {
  const rawMetadata = formatCandidate(input)
  const rawLocator = locatorCandidate(input)
  if (!rawMetadata && !rawLocator) return undefined
  if (!rawMetadata || !rawLocator) {
    return rejected("LOCATOR_MISSING", "IDML v2 passthrough requires both metadata and locator")
  }
  const metadata = parseMetadataV2(rawMetadata)
  if (!metadata) return rejected("ANCHOR_INVALID", "IDML v2 metadata is malformed")
  const locator = parseLocator(rawLocator)
  if (!locator) return rejected("LOCATOR_MISSING", "IDML v2 locator is malformed")
  if (
    locator.slotIndexes.length !== metadata.slotCount
    || new Set(locator.slotIndexes).size !== locator.slotIndexes.length
  ) {
    return rejected("LOCATOR_MISSING", "IDML v2 locator slot indexes do not match its metadata")
  }
  const sourceHtml = sourceHtmlCandidate(input)
  if (!sourceHtml) return rejected("ANCHOR_MISSING", "IDML v2 source HTML is missing")
  const targetHtml = targetHtmlCandidate(input)
  const validation = validateIdmlTranslation(sourceHtml, targetHtml ?? sourceHtml, metadata)
  if (!validation.valid) return { ok: false, diagnostics: validation.diagnostics }
  return {
    ok: true,
    locator,
    metadata,
    sourceHtml,
    ...(targetHtml !== undefined ? { targetHtml } : {}),
  }
}

function legacyStructure(input: UnknownRecord): UnknownRecord | undefined {
  return recordAt(input, "metadata", "data", "idmlStructure")
    ?? recordAt(input, "data", "idmlStructure")
    ?? recordAt(input, "idmlStructure")
    ?? recordAt(input, "source", "metadata", "data", "idmlStructure")
}

function legacyRelationships(input: UnknownRecord): UnknownRecord | undefined {
  return recordAt(input, "metadata", "data", "relationships")
    ?? recordAt(input, "data", "relationships")
    ?? recordAt(input, "relationships")
    ?? recordAt(input, "source", "metadata", "data", "relationships")
}

function exactSourceBlockBytes(input: UnknownRecord, structure: UnknownRecord): Uint8Array | undefined {
  const candidates = [
    structure.sourceBlockBytes,
    input.sourceBlockBytes,
    valueAt(input, "source", "sourceBlockBytes"),
  ]
  for (const candidate of candidates) {
    if (candidate instanceof Uint8Array) return candidate
    if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate)
    if (ArrayBuffer.isView(candidate)) {
      return new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength)
    }
  }
  const xml = nonEmptyString(structure.sourceBlockXml)
    ?? nonEmptyString(input.sourceBlockXml)
    ?? nonEmptyString(valueAt(input, "source", "sourceBlockXml"))
  return xml !== undefined ? new TextEncoder().encode(xml) : undefined
}

function resolveSourceBlockHash(
  input: UnknownRecord,
  structure: UnknownRecord,
): string | LegacyIdmlUpgradeResult {
  const provided = uniqueDefined([
    validSha256(structure.sourceBlockHash),
    validSha256(input.sourceBlockHash),
    validSha256(valueAt(input, "sourceLocator", "sourceBlockHash")),
  ])
  if (provided === null) {
    return rejected("SOURCE_HASH_MISMATCH", "Legacy IDML source block hashes disagree")
  }
  const bytes = exactSourceBlockBytes(input, structure)
  const computed = bytes ? sha256Hex(bytes) : undefined
  if (provided && computed && provided !== computed) {
    return rejected("SOURCE_HASH_MISMATCH", "Legacy IDML source block hash does not match the exact XML block")
  }
  if (provided) return provided
  if (computed) return computed
  return rejected(
    "SOURCE_HASH_MISMATCH",
    "Legacy IDML upgrade needs the exact original paragraph XML block or its SHA-256",
  )
}

function resolveLegacyMemberPath(
  input: UnknownRecord,
  structure: UnknownRecord,
  storyId: string | undefined,
): string | undefined {
  const explicit = uniqueDefined([
    validMemberPath(structure.memberPath),
    validMemberPath(input.memberPath),
    validMemberPath(valueAt(input, "sourceLocator", "memberPath")),
  ])
  if (explicit === null) return undefined
  if (explicit) return explicit
  return storyId && /^[A-Za-z0-9_.:-]+$/.test(storyId)
    ? `Stories/Story_${storyId}.xml`
    : undefined
}

function makeUnit(
  locator: IdmlLocator,
  metadata: IdmlFormatMetadataV2,
  slots: readonly IdmlTextSlot[],
  protectedTokens: readonly IdmlProtectedToken[],
): IdmlTranslationUnit {
  return {
    id: `legacy:${locator.memberPath}:${locator.elementPath}:${locator.part}`,
    order: 0,
    sourceText: slots.map((slot) => slot.text).join(""),
    sourceHtml: "",
    locator,
    metadata,
    slots,
    protectedTokens,
    diagnostics: [],
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function legacyScope(value: unknown): IdmlScope | undefined {
  return typeof value === "string" && IDML_SCOPES.has(value as IdmlScope)
    ? value as IdmlScope
    : undefined
}

export function upgradeLegacyIdmlMetadata(input: unknown): LegacyIdmlUpgradeResult {
  if (!isRecord(input)) return rejected("LOCATOR_MISSING", "IDML upgrade input must be an object")

  const unsupportedVersion = futureVersion(input)
  if (unsupportedVersion !== undefined) {
    return rejected(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported future IDML metadata version ${unsupportedVersion}`,
    )
  }

  const passthrough = upgradeV2Passthrough(input)
  if (passthrough) return passthrough

  const structure = legacyStructure(input)
  if (!structure) {
    return rejected("LOCATOR_MISSING", "Legacy Codex data.idmlStructure metadata is missing")
  }
  const contentSegments = stringArray(structure.contentSegments)
  const contentSegmentCount = nonNegativeInteger(structure.contentSegmentCount)
  if (
    !contentSegments
    || contentSegmentCount === undefined
    || contentSegmentCount !== contentSegments.length
  ) {
    return rejected(
      "ANCHOR_INVALID",
      "Legacy IDML contentSegments and contentSegmentCount must be present and agree exactly",
    )
  }

  const sourceLegacyHtml = sourceHtmlCandidate(input)
  if (!sourceLegacyHtml) {
    return rejected("ANCHOR_MISSING", "Legacy IDML segment-index source HTML is missing")
  }
  const parsedSource = parseLegacySegmentIndexHtml(sourceLegacyHtml)
  if (
    !parsedSource
    || parsedSource.segmentCount !== contentSegmentCount
    || parsedSource.slots.length !== contentSegmentCount
    || parsedSource.slots.some((slot, index) => slot.index !== index)
  ) {
    return rejected(
      "ANCHOR_INVALID",
      "Legacy IDML source HTML must contain each segment index exactly once in document order",
    )
  }
  if (parsedSource.slots.some((slot, index) => slot.text !== contentSegments[index])) {
    return rejected(
      "ANCHOR_INVALID",
      "Legacy IDML source HTML does not exactly match idmlStructure.contentSegments",
    )
  }
  const paragraphStyle = nonEmptyString(valueAt(
    structure,
    "paragraphStyleRange",
    "appliedParagraphStyle",
  ))
  if (!paragraphStyle || parsedSource.paragraphStyle !== paragraphStyle) {
    return rejected(
      "ANCHOR_INVALID",
      "Legacy IDML paragraph style metadata does not match its segment-index HTML",
    )
  }

  const storedBreakBefore = booleanArray(structure.contentSegmentBreakBefore)
  if (
    !storedBreakBefore
    || storedBreakBefore.length !== contentSegmentCount
    || storedBreakBefore.some((value, index) => value !== parsedSource.breakBefore[index])
  ) {
    return rejected(
      "ANCHOR_INVALID",
      "Legacy IDML line-break metadata must be present and match its segment-index HTML",
    )
  }

  const relationships = legacyRelationships(input)
  const storyId = uniqueDefined([
    nonEmptyString(structure.storyId),
    nonEmptyString(valueAt(input, "metadata", "storyId")),
    nonEmptyString(relationships?.parentStory),
    parsedSource.storyId,
  ])
  if (storyId === null) return rejected("LOCATOR_DUPLICATED", "Legacy IDML story identifiers disagree")

  const paragraphId = uniqueDefined([
    nonEmptyString(structure.paragraphId),
    nonEmptyString(valueAt(input, "metadata", "paragraphId")),
  ])
  if (paragraphId === null) {
    return rejected("LOCATOR_DUPLICATED", "Legacy IDML paragraph identifiers disagree")
  }
  const paragraphOrder = nonNegativeInteger(relationships?.paragraphOrder)
  if (!paragraphId && paragraphOrder === undefined) {
    return rejected(
      "LOCATOR_MISSING",
      "Legacy IDML needs a paragraph ID or an explicit stable paragraph order",
    )
  }
  if (paragraphId && !/^[A-Za-z0-9_.:-]+$/.test(paragraphId)) {
    return rejected("LOCATOR_MISSING", "Legacy IDML paragraph ID cannot form a stable locator")
  }

  const memberPath = resolveLegacyMemberPath(input, structure, storyId ?? undefined)
  if (!memberPath) {
    return rejected(
      "LOCATOR_MISSING",
      "Legacy IDML needs a valid member path or a stable Story ID",
    )
  }
  const sourceBlockHash = resolveSourceBlockHash(input, structure)
  if (typeof sourceBlockHash !== "string") return sourceBlockHash

  const scope = legacyScope(structure.scope) ?? "story-paragraph"
  const part = nonNegativeInteger(structure.part) ?? 0
  const slotIndexes = parsedSource.slots.map((slot) => slot.index)
  const elementPath = paragraphId
    ? `/Story/ParagraphStyleRange[@Self="${paragraphId}"]`
    : `/Story/ParagraphStyleRange[${(paragraphOrder ?? 0) + 1}]`
  const locator: IdmlLocator = {
    kind: "idml",
    memberPath,
    ...(storyId ? { storyId } : {}),
    elementPath,
    ...(paragraphId ? { elementId: paragraphId } : {}),
    scope,
    part,
    slotIndexes,
    sourceBlockHash,
  }

  const slots: readonly IdmlTextSlot[] = parsedSource.slots.map((slot) => ({
    index: slot.index,
    text: slot.text,
    characterStyleId: slot.characterStyleId,
    editable: true,
  }))
  const breaks = storedBreakBefore
  const protectedTokens: readonly IdmlProtectedToken[] = breaks.flatMap((hasBreak, position) => (
    hasBreak
      ? [{
          index: 0,
          kind: "br" as const,
          xmlName: "Br",
          position,
        }]
      : []
  )).map((token, index) => ({ ...token, index }))
  const metadata: IdmlFormatMetadataV2 = {
    version: 2,
    slotCount: slots.length,
    editableSlotIndexes: slotIndexes,
    protectedTokenCount: protectedTokens.length,
    anchorSequenceHash: computeIdmlAnchorSequenceHash(slots, protectedTokens),
  }
  const sourceHtml = renderIdmlUnitHtml(makeUnit(locator, metadata, slots, protectedTokens))

  const targetLegacyHtml = targetHtmlCandidate(input)
  let targetHtml: string | undefined
  if (targetLegacyHtml !== undefined) {
    const parsedTarget = parseLegacySegmentIndexHtml(targetLegacyHtml)
    if (
      !parsedTarget
      || parsedTarget.segmentCount !== contentSegmentCount
      || parsedTarget.slots.length !== slots.length
      || !sameNumbers(parsedTarget.slots.map((slot) => slot.index), slotIndexes)
      || parsedTarget.slots.some((
        slot,
        index,
      ) => slot.characterStyleId !== slots[index]?.characterStyleId)
      || parsedTarget.breakBefore.some((value, index) => value !== breaks[index])
      || parsedTarget.paragraphStyle !== parsedSource.paragraphStyle
      || parsedTarget.storyId !== parsedSource.storyId
    ) {
      return rejected(
        "ANCHOR_INVALID",
        "Legacy IDML target HTML changed segment identity, order, style, or structural breaks",
      )
    }
    const targetSlots: readonly IdmlTextSlot[] = parsedTarget.slots.map((slot) => ({
      index: slot.index,
      text: slot.text,
      characterStyleId: slot.characterStyleId,
      editable: true,
    }))
    targetHtml = renderIdmlUnitHtml(makeUnit(locator, metadata, targetSlots, protectedTokens))
    const validation = validateIdmlTranslation(sourceHtml, targetHtml, metadata)
    if (!validation.valid) return { ok: false, diagnostics: validation.diagnostics }
  }

  return {
    ok: true,
    locator,
    metadata,
    sourceHtml,
    ...(targetHtml !== undefined ? { targetHtml } : {}),
  }
}
