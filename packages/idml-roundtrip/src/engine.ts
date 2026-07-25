import JSZip from "jszip"
import type { JSZipObject } from "jszip"
import { inspectIdml } from "./archive.js"
import { sha256, sha256Text } from "./crypto.js"
import { IdmlError, throwIfAborted } from "./errors.js"
import {
  computeIdmlAnchorSequenceHash,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
} from "./html.js"
import type {
  IdmlArchiveMember,
  IdmlDiagnostic,
  IdmlExportOptions,
  IdmlExportResult,
  IdmlFormatMetadataV2,
  IdmlLocator,
  IdmlPackageInspection,
  IdmlParseOptions,
  IdmlParseResult,
  IdmlProgress,
  IdmlProtectedToken,
  IdmlProtectedTokenKind,
  IdmlScope,
  IdmlSemanticProfile,
  IdmlSourceManifest,
  IdmlTextSlot,
  IdmlTranslation,
  IdmlTranslationUnit,
} from "./types.js"
import {
  decodeXmlBytes,
  elementDescendants,
  elementPath,
  escapeXmlText,
  getAttribute,
  nearestAncestor,
  parseXml,
  resolveElementPath,
} from "./xml.js"
import type { XmlDocument, XmlElement } from "./xml.js"

const IDML_MIMETYPE = "application/vnd.adobe.indesign-idml-package"
const DEFAULT_CHARACTER_STYLE = "CharacterStyle/$ID/[No character style]"
const STORY_MEMBER_PATTERN = /^Stories\/[^/]+\.xml$/i
const LAYOUT_MEMBER_PATTERN = /^(?:MasterSpreads|Spreads)\/[^/]+\.xml$/i
const XML_MEMBER_PATTERN = /\.xml$/i
const TRANSPARENT_LITERAL_CONTAINERS: ReadonlySet<string> = new Set([
  "CharacterStyleRange",
  "HyperlinkTextSource",
  "HyperlinkTextDestination",
  "XMLElement",
  "HiddenText",
  "Condition",
])
const SUPPORTED_PARAGRAPH_ANCESTORS: ReadonlySet<string> = new Set([
  "ParagraphStyleRange",
  ...TRANSPARENT_LITERAL_CONTAINERS,
  "Table",
  "Cell",
  "Footnote",
  "Endnote",
  "EndnoteRange",
  "Note",
  "NoteRange",
])
const IDML_SCOPES: ReadonlySet<IdmlScope> = new Set([
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
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50

interface LoadedMember {
  readonly inspection: IdmlArchiveMember
  readonly bytes: Uint8Array
  readonly hash: string
  readonly zipEntry: JSZipObject
  readonly xml?: XmlDocument
}

interface LoadedPackage {
  readonly inputBytes: Uint8Array
  readonly inspection: IdmlPackageInspection
  readonly members: ReadonlyMap<string, LoadedMember>
}

interface ParsedInternal {
  readonly result: IdmlParseResult
  readonly loaded: LoadedPackage
}

interface SlotElement {
  readonly element: XmlElement
  readonly slot: IdmlTextSlot
  readonly contentPart: number
  readonly contentPartCount: number
}

interface UnitExtraction {
  readonly unit: IdmlTranslationUnit
  readonly slotElements: readonly SlotElement[]
}

interface ParagraphExtraction {
  readonly extraction?: UnitExtraction
  readonly diagnostics: readonly IdmlDiagnostic[]
}

interface Replacement {
  readonly start: number
  readonly end: number
  readonly value: string
}

interface StoryContext {
  readonly scopeByStoryId: ReadonlyMap<string, IdmlScope>
}

export async function parseIdml(
  bytes: Uint8Array | ArrayBuffer,
  profile: IdmlSemanticProfile = "generic",
  options?: IdmlParseOptions,
): Promise<IdmlParseResult> {
  return (await parseIdmlInternal(bytes, profile, options)).result
}

export async function exportIdml(
  bytes: Uint8Array | ArrayBuffer,
  translations: readonly IdmlTranslation[],
  options: IdmlExportOptions,
): Promise<IdmlExportResult> {
  if (!options || options.strict !== true) {
    throw new IdmlError("EXPORT_REJECTED", "IDML export must run in strict mode")
  }
  if (!Array.isArray(translations)) {
    throw new IdmlError("EXPORT_REJECTED", "IDML translations must be an array")
  }
  throwIfAborted(options.signal)
  const parsed = await parseIdmlInternal(bytes, "generic", {
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  })
  const originalBytes = parsed.loaded.inputBytes
  const unsupported = parsed.result.diagnostics.filter(
    (diagnostic) => diagnostic.code === "UNSUPPORTED_CONSTRUCT",
  ).length

  if (translations.length === 0) {
    return {
      bytes: originalBytes,
      report: {
        translated: 0,
        unchanged: parsed.result.units.length,
        missing: 0,
        rejected: 0,
        unsupported,
        changedMemberPaths: [],
        originalByteLength: originalBytes.byteLength,
        exportedByteLength: originalBytes.byteLength,
        sizeDelta: 0,
        warnings: parsed.result.diagnostics.filter((diagnostic) => diagnostic.severity !== "error"),
      },
    }
  }

  emitProgress(options.onProgress, {
    phase: "validate",
    completed: 0,
    total: translations.length,
  })
  const unitsByLocation = new Map(
    parsed.result.units.map((unit) => [locatorLocationKey(unit.locator), unit] as const),
  )
  const unitsByElementId = new Map<string, IdmlTranslationUnit[]>()
  for (const unit of parsed.result.units) {
    if (!unit.locator.elementId) continue
    const key = locatorElementIdKey(unit.locator.memberPath, unit.locator.elementId)
    const matches = unitsByElementId.get(key) ?? []
    matches.push(unit)
    unitsByElementId.set(key, matches)
  }
  const seenTranslationLocators = new Set<string>()
  const seenUnitSlots = new Set<string>()
  const seenUnitParts = new Set<string>()
  const diagnostics: IdmlDiagnostic[] = []
  const accepted: Array<{
    readonly translation: IdmlTranslation
    readonly unit: IdmlTranslationUnit
    readonly slotPositions: readonly number[]
    readonly targetSlots: readonly string[]
  }> = []

  for (let index = 0; index < translations.length; index += 1) {
    throwIfAborted(options.signal)
    const translation = translations[index] as unknown
    if (!isRuntimeTranslation(translation)) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_STALE",
          "IDML translation payload or locator is malformed",
        ),
      )
      continue
    }
    const exactKey = locatorIdentityKey(translation.locator)
    const locationKey = locatorLocationKey(translation.locator)
    if (seenTranslationLocators.has(exactKey)) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_DUPLICATED",
          "Multiple translations resolve to the same IDML paragraph",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    seenTranslationLocators.add(exactKey)

    let unit = unitsByLocation.get(locationKey)
    let reconciledByElementId = false
    if (!unit && translation.locator.elementId) {
      const idMatches =
        unitsByElementId.get(
          locatorElementIdKey(
            translation.locator.memberPath,
            translation.locator.elementId,
          ),
        ) ?? []
      if (idMatches.length === 1) {
        unit = idMatches[0]
        reconciledByElementId = true
      } else if (idMatches.length > 1) {
        diagnostics.push(
          diagnostic(
            "LOCATOR_DUPLICATED",
            "IDML element ID is not unique within its member",
            translation.locator.memberPath,
            translation.unitId,
          ),
        )
        continue
      }
    }
    if (!unit) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_MISSING",
          "IDML translation locator does not resolve to a translation unit",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    const projected = projectUnitForLocator(unit, translation.locator)
    if (!projected) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_STALE",
          "IDML locator slot indexes no longer match the source structure",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    if (!sameLocatorBase(translation.locator, unit.locator, reconciledByElementId)) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_STALE",
          "IDML locator no longer matches the source structure",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    const resolvedLocationKey = locatorLocationKey(unit.locator)
    const partKey = `${resolvedLocationKey}\u0000${translation.locator.part}`
    if (seenUnitParts.has(partKey)) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_DUPLICATED",
          `Multiple translations use IDML part ${translation.locator.part}`,
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    const overlappingSlot = translation.locator.slotIndexes.find((slotIndex) => (
      seenUnitSlots.has(unitSlotKey(resolvedLocationKey, slotIndex))
    ))
    if (overlappingSlot !== undefined) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_DUPLICATED",
          `Multiple translations resolve to IDML slot ${overlappingSlot}`,
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    seenUnitParts.add(partKey)
    for (const slotIndex of translation.locator.slotIndexes) {
      seenUnitSlots.add(unitSlotKey(resolvedLocationKey, slotIndex))
    }
    if (translation.locator.sourceBlockHash !== unit.locator.sourceBlockHash) {
      diagnostics.push(
        diagnostic(
          "SOURCE_HASH_MISMATCH",
          "IDML paragraph source hash has changed",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    if (
      translation.sourceHtml !== projected.unit.sourceHtml ||
      !sameMetadata(translation.metadata, projected.unit.metadata)
    ) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_STALE",
          "IDML source HTML or format metadata no longer matches the source package",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    const validation = validateIdmlTranslation(
      translation.sourceHtml,
      translation.targetHtml,
      translation.metadata,
    )
    if (!validation.valid) {
      diagnostics.push(
        ...validation.diagnostics.map((entry) => ({
          ...entry,
          memberPath: entry.memberPath ?? translation.locator.memberPath,
          unitId: entry.unitId ?? translation.unitId,
        })),
      )
      continue
    }
    if (validation.slots.length !== projected.unit.slots.length) {
      diagnostics.push(
        diagnostic(
          "ANCHOR_INVALID",
          `Translation returned ${validation.slots.length} slots; expected ${projected.unit.slots.length}`,
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    if (
      unit.locator.scope === "custom-variable" &&
      validation.slots.some((slot) => /\r|\n/.test(slot))
    ) {
      diagnostics.push(
        diagnostic(
          "ANCHOR_INVALID",
          "Custom text variables cannot contain editor line breaks",
          translation.locator.memberPath,
          translation.unitId,
        ),
      )
      continue
    }
    accepted.push({
      translation,
      unit,
      slotPositions: projected.slotPositions,
      targetSlots: validation.slots,
    })
    emitProgress(options.onProgress, {
      phase: "validate",
      completed: index + 1,
      total: translations.length,
      memberPath: translation.locator.memberPath,
    })
    if ((index & 31) === 31) await yieldToEventLoop()
  }

  if (diagnostics.length > 0) {
    throw new IdmlError(
      "EXPORT_REJECTED",
      `IDML export rejected ${diagnostics.length} invalid translation mapping(s)`,
      deepFreeze(diagnostics),
    )
  }

  const updatesByUnit = new Map<string, {
    readonly unit: IdmlTranslationUnit
    readonly targetSlots: string[]
  }>()
  for (const item of accepted) {
    const unitKey = locatorLocationKey(item.unit.locator)
    const update = updatesByUnit.get(unitKey) ?? {
      unit: item.unit,
      targetSlots: item.unit.slots.map((slot) => slot.text),
    }
    for (let localIndex = 0; localIndex < item.slotPositions.length; localIndex += 1) {
      const position = item.slotPositions[localIndex]!
      update.targetSlots[position] = item.targetSlots[localIndex] ?? ""
    }
    updatesByUnit.set(unitKey, update)
  }
  const replacementsByMember = new Map<string, Replacement[]>()
  let translatedCount = 0
  const updates = [...updatesByUnit.values()]
  emitProgress(options.onProgress, {
    phase: "export",
    completed: 0,
    total: updates.length,
  })
  for (let acceptedIndex = 0; acceptedIndex < updates.length; acceptedIndex += 1) {
    throwIfAborted(options.signal)
    const update = updates[acceptedIndex]!
    const member = parsed.loaded.members.get(update.unit.locator.memberPath)
    if (!member?.xml) {
      throw new IdmlError(
        "LOCATOR_MISSING",
        `IDML member ${update.unit.locator.memberPath} is unavailable during export`,
      )
    }
    const target = resolveAndVerifyElement(member.xml, update.unit.locator, update.unit.id)
    const slotElements = extractSlotElements(
      target,
      update.unit.locator.scope,
      member.xml.source,
    )
    if (
      slotElements.length !== update.unit.slots.length ||
      !sameNumbers(
        update.unit.locator.slotIndexes,
        slotElements.map((slot) => slot.slot.index),
      )
    ) {
      throw new IdmlError(
        "LOCATOR_STALE",
        `IDML slot structure changed for ${update.unit.id}`,
      )
    }

    let unitChanged = false
    const contentGroups = new Map<XmlElement, SlotElement[]>()
    for (const slotElement of slotElements) {
      const group = contentGroups.get(slotElement.element) ?? []
      group.push(slotElement)
      contentGroups.set(slotElement.element, group)
    }
    for (const [contentElement, bindings] of contentGroups) {
      const translatedParts = bindings.map(
        (binding) => update.targetSlots[binding.slot.index] ?? "",
      )
      if (
        bindings.every(
          (binding, index) => translatedParts[index] === binding.slot.text,
        )
      ) {
        continue
      }
      unitChanged = true
      const replacement = replacementForSlot(
        member.xml.source,
        contentElement,
        translatedParts.join("\t"),
        member.inspection.path,
      )
      const memberReplacements = replacementsByMember.get(member.inspection.path) ?? []
      memberReplacements.push(replacement)
      replacementsByMember.set(member.inspection.path, memberReplacements)
    }
    if (unitChanged) translatedCount += 1
    emitProgress(options.onProgress, {
      phase: "export",
      completed: acceptedIndex + 1,
      total: updates.length,
      memberPath: update.unit.locator.memberPath,
    })
    if ((acceptedIndex & 31) === 31) await yieldToEventLoop()
  }

  if (replacementsByMember.size === 0) {
    return {
      bytes: originalBytes,
      report: {
        translated: 0,
        unchanged: parsed.result.units.length,
        missing: 0,
        rejected: 0,
        unsupported,
        changedMemberPaths: [],
        originalByteLength: originalBytes.byteLength,
        exportedByteLength: originalBytes.byteLength,
        sizeDelta: 0,
        warnings: parsed.result.diagnostics.filter((diagnostic) => diagnostic.severity !== "error"),
      },
    }
  }

  const changedMemberBytes = new Map<string, Uint8Array>()
  for (const [memberPath, replacements] of replacementsByMember) {
    const member = parsed.loaded.members.get(memberPath)
    if (!member?.xml) {
      throw new IdmlError("LOCATOR_MISSING", `IDML member ${memberPath} is unavailable`)
    }
    const updated = applyReplacements(member.xml.source, replacements, memberPath)
    parseXml(updated, memberPath)
    changedMemberBytes.set(memberPath, new TextEncoder().encode(updated))
  }

  throwIfAborted(options.signal)
  emitProgress(options.onProgress, {
    phase: "package",
    completed: 0,
    total: parsed.loaded.members.size,
  })
  const exportedBytes = await packageIdml(parsed.loaded, changedMemberBytes, options)
  const changedMemberPaths = [...changedMemberBytes.keys()].sort(codeUnitCompare)
  return {
    bytes: exportedBytes,
    report: {
      translated: translatedCount,
      unchanged: parsed.result.units.length - translatedCount,
      missing: 0,
      rejected: 0,
      unsupported,
      changedMemberPaths,
      originalByteLength: originalBytes.byteLength,
      exportedByteLength: exportedBytes.byteLength,
      sizeDelta: exportedBytes.byteLength - originalBytes.byteLength,
      warnings: parsed.result.diagnostics.filter((diagnostic) => diagnostic.severity !== "error"),
    },
  }
}

/**
 * Validates package membership and non-literal XML structure. Literal Content
 * values are intentionally omitted from structural fingerprints, so this API
 * cannot distinguish an intended translation from tampered literal text
 * without the original translation inputs.
 */
export async function validateExport(
  bytes: Uint8Array | ArrayBuffer,
  manifest: IdmlSourceManifest,
  options?: IdmlParseOptions,
): Promise<readonly IdmlDiagnostic[]> {
  throwIfAborted(options?.signal)
  if ((manifest as { readonly version: number }).version !== 2) {
    return deepFreeze([
      diagnostic(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Unsupported IDML manifest version ${(manifest as { readonly version: number }).version}`,
      ),
    ])
  }
  let loaded: LoadedPackage
  try {
    loaded = await loadPackage(bytes, options)
  } catch (error) {
    if (error instanceof IdmlError && isReadableValidationDifference(error.code)) {
      return deepFreeze([...error.diagnostics])
    }
    throw error
  }

  const diagnostics: IdmlDiagnostic[] = []
  const validationTotal = manifest.members.length + manifest.unitLocators.length
  emitProgress(options?.onProgress, {
    phase: "validate",
    completed: 0,
    total: validationTotal,
  })
  const expected = new Map(manifest.members.map((member) => [member.path, member]))
  const actual = new Map(
    [...loaded.members.values()].map((member) => [member.inspection.path, member] as const),
  )
  for (const member of manifest.members) {
    if (!actual.has(member.path)) {
      diagnostics.push(diagnostic("MEMBER_REMOVED", "Expected IDML member is missing", member.path))
    }
  }
  for (const member of actual.values()) {
    if (!expected.has(member.inspection.path)) {
      diagnostics.push(
        diagnostic("MEMBER_ADDED", "Unexpected IDML member was added", member.inspection.path),
      )
    }
  }

  const translatableMembers = new Set(manifest.unitLocators.map((locator) => locator.memberPath))
  const changedMembers = new Set<string>()
  const reportChangedMember = (path: string, message: string): void => {
    if (changedMembers.has(path)) return
    changedMembers.add(path)
    diagnostics.push(diagnostic("MEMBER_CHANGED", message, path))
  }
  for (let memberIndex = 0; memberIndex < manifest.members.length; memberIndex += 1) {
    throwIfAborted(options?.signal)
    const expectedMember = manifest.members[memberIndex]!
    const actualMember = actual.get(expectedMember.path)
    if (!actualMember) {
      emitProgress(options?.onProgress, {
        phase: "validate",
        completed: memberIndex + 1,
        total: validationTotal,
        memberPath: expectedMember.path,
      })
      continue
    }
    if (actualMember.inspection.isDirectory !== expectedMember.isDirectory) {
      reportChangedMember(
        expectedMember.path,
        "An IDML member changed between a file and an explicit directory",
      )
      emitProgress(options?.onProgress, {
        phase: "validate",
        completed: memberIndex + 1,
        total: validationTotal,
        memberPath: expectedMember.path,
      })
      continue
    }
    if (
      !translatableMembers.has(expectedMember.path) &&
      actualMember.hash !== expectedMember.sha256
    ) {
      reportChangedMember(
        expectedMember.path,
        "A non-translatable IDML member changed during export",
      )
    }
    if (expectedMember.structuralSha256) {
      if (!actualMember.xml) {
        reportChangedMember(expectedMember.path, "An expected XML member is no longer XML")
      } else if (
        (await structuralXmlSha256(actualMember.xml)) !== expectedMember.structuralSha256
      ) {
        reportChangedMember(
          expectedMember.path,
          "IDML XML structure changed outside literal translatable text",
        )
      }
    }
    emitProgress(options?.onProgress, {
      phase: "validate",
      completed: memberIndex + 1,
      total: validationTotal,
      memberPath: expectedMember.path,
    })
    if ((memberIndex & 7) === 7) await yieldToEventLoop()
  }

  for (let locatorIndex = 0; locatorIndex < manifest.unitLocators.length; locatorIndex += 1) {
    throwIfAborted(options?.signal)
    const locator = manifest.unitLocators[locatorIndex]!
    const member = actual.get(locator.memberPath)
    if (!member?.xml) {
      if (member) {
        diagnostics.push(
          diagnostic("LOCATOR_MISSING", "Locator member is not XML", locator.memberPath),
        )
      }
    } else if (!resolveLocatorForValidation(member.xml, locator)) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_MISSING",
          "Exported IDML no longer contains an expected locator",
          locator.memberPath,
        ),
      )
    }
    emitProgress(options?.onProgress, {
      phase: "validate",
      completed: manifest.members.length + locatorIndex + 1,
      total: validationTotal,
      memberPath: locator.memberPath,
    })
    if ((locatorIndex & 31) === 31) await yieldToEventLoop()
  }
  return deepFreeze(diagnostics)
}

function isReadableValidationDifference(code: IdmlDiagnostic["code"]): boolean {
  return (
    code === "INVALID_MIMETYPE" ||
    code === "INVALID_UCF_ORDER" ||
    code === "MISSING_DESIGNMAP" ||
    code === "MALFORMED_XML" ||
    code === "UNSAFE_XML_DECLARATION" ||
    code === "UNSAFE_MEMBER_PATH" ||
    code === "DUPLICATE_MEMBER" ||
    code === "ENCRYPTED_MEMBER" ||
    code === "UNSUPPORTED_COMPRESSION"
  )
}

function resolveLocatorForValidation(
  document: XmlDocument,
  locator: IdmlLocator,
): XmlElement | null {
  const byPath = resolveElementPath(document, locator.elementPath)
  if (byPath && (!locator.elementId || getAttribute(byPath, "Self") === locator.elementId)) {
    return byPath
  }
  if (!locator.elementId) return null
  const byId = elementDescendants(
    document.root,
    (element) => getAttribute(element, "Self") === locator.elementId,
  )
  return byId.length === 1 ? byId[0]! : null
}

async function parseIdmlInternal(
  bytes: Uint8Array | ArrayBuffer,
  profile: IdmlSemanticProfile,
  options?: IdmlParseOptions,
): Promise<ParsedInternal> {
  throwIfAborted(options?.signal)
  const loaded = await loadPackage(bytes, options)
  const designmap = loaded.members.get("designmap.xml")?.xml
  if (!designmap) {
    throw new IdmlError("MISSING_DESIGNMAP", "IDML package has no readable designmap.xml")
  }
  const diagnostics: IdmlDiagnostic[] = [...loaded.inspection.diagnostics]
  const storyMembers = discoverStoryMembers(designmap, loaded, diagnostics)
  const missingStoryDiagnostics = diagnostics.filter(
    (entry) => entry.code === "MISSING_STORY" && entry.severity === "error",
  )
  if (missingStoryDiagnostics.length > 0) {
    throw new IdmlError(
      "MISSING_STORY",
      "IDML designmap.xml references one or more missing Story members",
      missingStoryDiagnostics,
    )
  }
  if (storyMembers.length === 0) {
    throw new IdmlError("MISSING_STORY", "IDML package does not contain any Story XML members")
  }
  const storyContext = buildStoryContext(loaded)
  const extractions: UnitExtraction[] = []
  let order = 0

  const paragraphTasks: Array<{
    readonly memberPath: string
    readonly document: XmlDocument
    readonly paragraph: XmlElement
  }> = []
  for (const memberPath of storyMembers) {
    const member = loaded.members.get(memberPath)
    if (!member?.xml) {
      throw new IdmlError("MISSING_STORY", `Story member ${memberPath} is missing or is not XML`)
    }
    for (const paragraph of elementDescendants(
      member.xml.root,
      (element) => element.localName === "ParagraphStyleRange",
    )) {
      const opaqueAncestor = opaqueParagraphAncestor(paragraph)
      if (opaqueAncestor) {
        diagnostics.push(
          diagnostic(
            "UNSUPPORTED_CONSTRUCT",
            `Unknown IDML container <${opaqueAncestor.name}> was preserved as opaque content`,
            memberPath,
            undefined,
            {
              elementPath: elementPath(opaqueAncestor),
              unsupportedDisposition: "unsupported-literal",
              constructKind: "unknown-container",
              xmlName: opaqueAncestor.name,
            },
          ),
        )
        continue
      }
      paragraphTasks.push({ memberPath, document: member.xml, paragraph })
    }
  }
  emitProgress(options?.onProgress, {
    phase: "parse",
    completed: 0,
    total: paragraphTasks.length,
  })
  for (let paragraphIndex = 0; paragraphIndex < paragraphTasks.length; paragraphIndex += 1) {
    throwIfAborted(options?.signal)
    const task = paragraphTasks[paragraphIndex]!
    const result = await extractParagraphUnit(
      task.document,
      task.memberPath,
      task.paragraph,
      order,
      storyContext,
    )
    diagnostics.push(...result.diagnostics)
    if (result.extraction) {
      extractions.push(result.extraction)
      order += 1
    }
    emitProgress(options?.onProgress, {
      phase: "parse",
      completed: paragraphIndex + 1,
      total: paragraphTasks.length,
      memberPath: task.memberPath,
    })
    if ((paragraphIndex & 31) === 31) await yieldToEventLoop()
  }

  let customMemberIndex = 0
  for (const member of loaded.members.values()) {
    throwIfAborted(options?.signal)
    customMemberIndex += 1
    if (!member.xml) continue
    const variables = elementDescendants(
      member.xml.root,
      isTextVariableDefinition,
    )
    for (const variable of variables) {
      if (!isCustomTextVariableDefinition(variable)) {
        diagnostics.push(
          diagnostic(
            "UNSUPPORTED_CONSTRUCT",
            `Computed text variable ${getAttribute(variable, "Self") ?? "(unnamed)"} was preserved`,
            member.inspection.path,
            undefined,
            {
              unsupportedDisposition: "preserved-nonliteral",
              constructKind: "computed-text-variable",
            },
          ),
        )
        continue
      }
      const extraction = await extractCustomVariableUnit(
        member.xml,
        member.inspection.path,
        variable,
        order,
      )
      if (!extraction) continue
      extractions.push(extraction)
      diagnostics.push(...extraction.unit.diagnostics)
      order += 1
    }
    if ((customMemberIndex & 7) === 0) await yieldToEventLoop()
  }

  const units = unitsForSemanticProfile(profile, extractions)
  const profileId = typeof profile === "string" ? profile : profile.id
  const manifestMembers = []
  let manifestMemberIndex = 0
  for (const member of loaded.members.values()) {
    throwIfAborted(options?.signal)
    manifestMembers.push({
      path: member.inspection.path,
      sha256: member.hash,
      byteLength: member.bytes.byteLength,
      isDirectory: member.inspection.isDirectory,
      ...(member.xml
        ? { structuralSha256: await structuralXmlSha256(member.xml) }
        : {}),
    })
    if ((manifestMemberIndex & 7) === 7) await yieldToEventLoop()
    manifestMemberIndex += 1
  }
  manifestMembers.sort((left, right) => codeUnitCompare(left.path, right.path))
  const manifest: IdmlSourceManifest = {
    version: 2,
    sourceSha256: await sha256(loaded.inputBytes),
    profile: profileId,
    members: manifestMembers,
    unitLocators: units.map((unit) => unit.locator),
    diagnostics,
  }
  const result = deepFreeze({
    units,
    manifest,
    diagnostics,
  })
  return { result, loaded }
}

function unitsForSemanticProfile(
  profile: IdmlSemanticProfile,
  extractions: readonly UnitExtraction[],
): IdmlTranslationUnit[] {
  const allLiteralUnits = extractions.map((entry) => entry.unit)
  if (profile === "biblica") {
    // v2 deliberately includes the same complete set of literal IDML locations
    // as generic. The legacy Biblica notes-only view omitted valid stories,
    // tables, footnotes, variables, and other text, so any presentation filter
    // belongs in an adapter after the lossless shared-engine parse.
    return allLiteralUnits
  }
  if (typeof profile === "object" && profile.includeUnit) {
    return allLiteralUnits.filter((unit) => profile.includeUnit?.(unit) === true)
  }
  return allLiteralUnits
}

async function loadPackage(
  bytes: Uint8Array | ArrayBuffer,
  options?: IdmlParseOptions,
): Promise<LoadedPackage> {
  const inputBytes = toUint8Array(bytes)
  emitProgress(options?.onProgress, { phase: "inspect", completed: 0, total: 1 })
  const inspection = await inspectIdml(inputBytes, options?.limits)
  throwIfAborted(options?.signal)
  emitProgress(options?.onProgress, { phase: "inspect", completed: 1, total: 1 })

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(inputBytes, { checkCRC32: true, createFolders: false })
  } catch (error) {
    throw new IdmlError(
      "INVALID_ZIP",
      `Unable to read IDML archive: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const packageMembers = inspection.members
  const members = new Map<string, LoadedMember>()
  emitProgress(options?.onProgress, {
    phase: "unpack",
    completed: 0,
    total: packageMembers.length,
  })
  for (let memberIndex = 0; memberIndex < packageMembers.length; memberIndex += 1) {
    throwIfAborted(options?.signal)
    const memberInspection = packageMembers[memberIndex]!
    const entry = zip.files[memberInspection.path]
    if (!entry) {
      throw new IdmlError(
        "INVALID_ZIP",
        `Central-directory member ${memberInspection.path} could not be loaded`,
      )
    }
    const memberBytes = memberInspection.isDirectory
      ? new Uint8Array()
      : await entry.async("uint8array")
    let xml: XmlDocument | undefined
    if (XML_MEMBER_PATTERN.test(memberInspection.path)) {
      const source = decodeXmlBytes(memberBytes, memberInspection.path)
      xml = parseXml(source, memberInspection.path)
    }
    members.set(memberInspection.path, {
      inspection: memberInspection,
      bytes: memberBytes,
      hash: await sha256(memberBytes),
      zipEntry: entry,
      ...(xml ? { xml } : {}),
    })
    emitProgress(options?.onProgress, {
      phase: "unpack",
      completed: memberIndex + 1,
      total: packageMembers.length,
      memberPath: memberInspection.path,
    })
    if ((memberIndex & 7) === 7) await yieldToEventLoop()
  }
  return { inputBytes, inspection, members }
}

function discoverStoryMembers(
  designmap: XmlDocument,
  loaded: LoadedPackage,
  diagnostics: IdmlDiagnostic[],
): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const orderedLayoutMembers: string[] = []
  const seenLayoutMembers = new Set<string>()
  for (const element of elementDescendants(
    designmap.root,
    (candidate) =>
      candidate.localName === "Story" ||
      candidate.localName === "Spread" ||
      candidate.localName === "MasterSpread",
  )) {
    const rawSource = getAttribute(element, "src")
    if (!rawSource) continue
    const source = rawSource.replace(/^\.\//, "")
    if (LAYOUT_MEMBER_PATTERN.test(source)) {
      if (loaded.members.has(source) && !seenLayoutMembers.has(source)) {
        seenLayoutMembers.add(source)
        orderedLayoutMembers.push(source)
      }
      continue
    }
    if (!STORY_MEMBER_PATTERN.test(source)) continue
    addStoryMember(source, loaded, diagnostics, ordered, seen)
  }

  const storyPathsById = new Map<string, string[]>()
  for (const [memberPath, member] of loaded.members) {
    if (!STORY_MEMBER_PATTERN.test(memberPath) || !member.xml) continue
    const storyIds = new Set(
      elementDescendants(
        member.xml.root,
        (element) => element.localName === "Story" && Boolean(getAttribute(element, "Self")),
      ).map((element) => getAttribute(element, "Self")!),
    )
    for (const storyId of storyIds) {
      const paths = storyPathsById.get(storyId) ?? []
      paths.push(memberPath)
      storyPathsById.set(storyId, paths)
    }
  }

  const remainingLayoutMembers = [...loaded.members.keys()]
    .filter((memberPath) =>
      LAYOUT_MEMBER_PATTERN.test(memberPath) && !seenLayoutMembers.has(memberPath),
    )
    .sort(codeUnitCompare)
  for (const layoutPath of [...orderedLayoutMembers, ...remainingLayoutMembers]) {
    const layout = loaded.members.get(layoutPath)?.xml
    if (!layout) continue
    for (const element of elementDescendants(
      layout.root,
      (candidate) => Boolean(getAttribute(candidate, "ParentStory")),
    )) {
      const storyId = getAttribute(element, "ParentStory")!
      const paths = storyPathsById.get(storyId)
      if (paths?.length !== 1) continue
      addStoryMember(paths[0]!, loaded, diagnostics, ordered, seen)
    }
  }

  const remaining = [...loaded.members.keys()]
    .filter((memberPath) => STORY_MEMBER_PATTERN.test(memberPath) && !seen.has(memberPath))
    .sort(codeUnitCompare)
  ordered.push(...remaining)
  return ordered
}

function addStoryMember(
  source: string,
  loaded: LoadedPackage,
  diagnostics: IdmlDiagnostic[],
  ordered: string[],
  seen: Set<string>,
): void {
  if (!loaded.members.has(source)) {
    diagnostics.push(
      diagnostic("MISSING_STORY", `designmap.xml references missing story ${source}`, source),
    )
    return
  }
  if (seen.has(source)) return
  seen.add(source)
  ordered.push(source)
}

function buildStoryContext(loaded: LoadedPackage): StoryContext {
  const scopeByStoryId = new Map<string, IdmlScope>()
  const rank = new Map<IdmlScope, number>([
    ["story-paragraph", 0],
    ["anchored-story", 1],
    ["text-path", 2],
    ["master-story", 3],
  ])
  for (const member of loaded.members.values()) {
    if (!member.xml) continue
    for (const element of elementDescendants(member.xml.root)) {
      const storyId = getAttribute(element, "ParentStory")
      if (!storyId) continue
      let scope: IdmlScope = "story-paragraph"
      if (/^MasterSpreads\//i.test(member.inspection.path)) {
        scope = "master-story"
      } else if (
        element.localName === "TextPath" ||
        nearestAncestor(element, (ancestor) => ancestor.localName === "TextPath")
      ) {
        scope = "text-path"
      } else if (
        nearestAncestor(
          element,
          (ancestor) =>
            ancestor.localName === "ParagraphStyleRange" ||
            ancestor.localName === "CharacterStyleRange",
        )
      ) {
        scope = "anchored-story"
      }
      const current = scopeByStoryId.get(storyId)
      if (!current || (rank.get(scope) ?? 0) > (rank.get(current) ?? 0)) {
        scopeByStoryId.set(storyId, scope)
      }
    }
  }
  return { scopeByStoryId }
}

async function extractParagraphUnit(
  document: XmlDocument,
  memberPath: string,
  paragraph: XmlElement,
  order: number,
  storyContext: StoryContext,
): Promise<ParagraphExtraction> {
  const scope = paragraphScope(paragraph, storyContext)
  const slotElements = extractSlotElements(paragraph, scope, document.source)
  const { tokens, diagnostics } = extractProtectedTokens(paragraph, memberPath, document.source)
  if (slotElements.length === 0) {
    if (tokens.length === 0) return { diagnostics }
    return {
      diagnostics: [
        ...diagnostics,
        {
          code: "UNSUPPORTED_CONSTRUCT",
          severity: "warning",
          message:
            "Paragraph contains only protected IDML tokens and was preserved without a translation unit",
          memberPath,
          details: {
            elementPath: elementPath(paragraph),
            protectedTokenCount: tokens.length,
            unsupportedDisposition: "preserved-nonliteral",
            constructKind: "protected-only-paragraph",
          },
        },
      ],
    }
  }
  const story = nearestAncestor(paragraph, (ancestor) => ancestor.localName === "Story")
  const storyId = story ? getAttribute(story, "Self") : undefined
  const locator = await createLocator(
    document,
    paragraph,
    memberPath,
    scope,
    slotElements.map((entry) => entry.slot.index),
    storyId,
  )
  const unit = await createUnit(
    locator,
    order,
    slotElements.map((entry) => entry.slot),
    tokens,
    diagnostics,
  )
  return { extraction: { unit, slotElements }, diagnostics }
}

async function extractCustomVariableUnit(
  document: XmlDocument,
  memberPath: string,
  variable: XmlElement,
  order: number,
): Promise<UnitExtraction | null> {
  const contents = elementDescendants(
    variable,
    (element) =>
      element.localName === "Contents" &&
      nearestAncestor(element, (ancestor) => ancestor.localName === "TextVariable") === variable,
  )
  if (contents.length === 0) return null
  const slotElements: SlotElement[] = []
  for (const element of contents) {
    appendContentSlots(
      slotElements,
      element,
      DEFAULT_CHARACTER_STYLE,
      document.source,
    )
  }
  const protectedTokens = tabTokensForContentSlots(slotElements)
  const locator = await createLocator(
    document,
    variable,
    memberPath,
    "custom-variable",
    slotElements.map((entry) => entry.slot.index),
  )
  const unit = await createUnit(
    locator,
    order,
    slotElements.map((entry) => entry.slot),
    protectedTokens,
    [],
  )
  return { unit, slotElements }
}

function extractSlotElements(
  paragraphOrVariable: XmlElement,
  scope: IdmlScope,
  source: string,
): SlotElement[] {
  if (scope === "custom-variable") {
    const slots: SlotElement[] = []
    for (const element of elementDescendants(
      paragraphOrVariable,
      (element) =>
        element.localName === "Contents" &&
        nearestAncestor(element, (ancestor) => ancestor.localName === "TextVariable") ===
          paragraphOrVariable,
    )) {
      appendContentSlots(slots, element, DEFAULT_CHARACTER_STYLE, source)
    }
    return slots
  }

  const slots: SlotElement[] = []
  const visit = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.kind !== "element") continue
      if (child.localName === "ParagraphStyleRange") continue
      if (child.localName === "Content") {
        const characterRange = nearestAncestor(
          child,
          (ancestor) => ancestor.localName === "CharacterStyleRange",
        )
        appendContentSlots(
          slots,
          child,
          (characterRange &&
            (getAttribute(characterRange, "AppliedCharacterStyle") ??
              getAttribute(characterRange, "Self"))) ||
            DEFAULT_CHARACTER_STYLE,
          source,
        )
        continue
      }
      if (TRANSPARENT_LITERAL_CONTAINERS.has(child.localName)) visit(child)
    }
  }
  visit(paragraphOrVariable)
  return slots
}

function extractProtectedTokens(
  paragraph: XmlElement,
  memberPath: string,
  source: string,
): { tokens: IdmlProtectedToken[]; diagnostics: IdmlDiagnostic[] } {
  const tokens: IdmlProtectedToken[] = []
  const diagnostics: IdmlDiagnostic[] = []
  let slotBoundary = 0

  const visit = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.kind !== "element") continue
      if (child.localName === "ParagraphStyleRange") continue
      if (child.localName === "Content") {
        const text = contentText(child)
        if (text.includes("\t") && !contentHasOpaqueMarkup(source, child)) {
          const parts = text.split("\t")
          for (let partIndex = 1; partIndex < parts.length; partIndex += 1) {
            tokens.push({
              index: tokens.length,
              kind: "tab",
              xmlName: child.name,
              position: slotBoundary + partIndex,
            })
          }
          slotBoundary += parts.length
        } else {
          slotBoundary += 1
        }
        if (contentHasOpaqueMarkup(source, child)) {
          tokens.push({
            index: tokens.length,
            kind: "unknown",
            xmlName: child.name,
            position: Math.max(0, slotBoundary - 1),
          })
          diagnostics.push(
            diagnostic(
              "UNSUPPORTED_CONSTRUCT",
              "Markup inside an IDML Content slot was locked and preserved",
              memberPath,
              undefined,
              {
                unsupportedDisposition: "unsupported-literal",
                constructKind: "opaque-content-markup",
              },
            ),
          )
        }
        continue
      }
      if (child.localName === "Properties") continue
      const kind = protectedTokenKind(child)
      if (kind) {
        tokens.push({
          index: tokens.length,
          kind,
          xmlName: child.name,
          position: slotBoundary,
        })
        if (kind === "unknown") {
          diagnostics.push(
            diagnostic(
              "UNSUPPORTED_CONSTRUCT",
              `Unknown inline IDML element <${child.name}> was preserved as a protected token`,
              memberPath,
              undefined,
              {
                unsupportedDisposition: child.selfClosing
                  ? "preserved-nonliteral"
                  : "unsupported-literal",
                constructKind: "unknown-inline-element",
                xmlName: child.name,
              },
            ),
          )
        }
      }
      if (!isOpaqueToken(kind)) visit(child)
    }
  }
  visit(paragraph)
  return { tokens, diagnostics }
}

function appendContentSlots(
  slots: SlotElement[],
  element: XmlElement,
  characterStyleId: string,
  source: string,
): void {
  const text = contentText(element)
  const opaque = contentHasOpaqueMarkup(source, element)
  const parts = opaque ? [text] : text.split("\t")
  for (let contentPart = 0; contentPart < parts.length; contentPart += 1) {
    slots.push({
      element,
      contentPart,
      contentPartCount: parts.length,
      slot: {
        index: slots.length,
        text: parts[contentPart] ?? "",
        characterStyleId,
        editable: !opaque,
      },
    })
  }
}

function tabTokensForContentSlots(
  slots: readonly SlotElement[],
): IdmlProtectedToken[] {
  const tokens: IdmlProtectedToken[] = []
  for (const binding of slots) {
    if (binding.contentPart === 0) continue
    tokens.push({
      index: tokens.length,
      kind: "tab",
      xmlName: binding.element.name,
      position: binding.slot.index,
    })
  }
  return tokens
}

function contentText(element: XmlElement): string {
  let text = ""
  for (const child of element.children) {
    if (child.kind !== "element") text += child.value
  }
  return text
}

function contentHasOpaqueMarkup(source: string, element: XmlElement): boolean {
  if (element.selfClosing) return false
  const interior = source.slice(element.openEnd, element.closeStart)
  return interior.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").includes("<")
}

async function structuralXmlSha256(document: XmlDocument): Promise<string> {
  return sha256Text(JSON.stringify(structuralXmlElement(document.root)))
}

function structuralXmlElement(element: XmlElement): unknown {
  const attributes = [...element.attributes]
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort((left, right) => codeUnitCompare(left[0], right[0]))
  if (isLiteralTextElement(element)) {
    return ["literal", element.name, attributes]
  }

  const significantChildren = element.children.filter(
    (child) => child.kind === "element" || child.value.trim().length > 0,
  )
  const children: unknown[] = []
  for (let index = 0; index < significantChildren.length; index += 1) {
    const child = significantChildren[index]!
    if (child.kind !== "element") {
      children.push(["text", child.kind, child.value])
      continue
    }
    children.push(structuralXmlElement(child))
    if (child.localName !== "Content") continue

    // A translated slot containing editor line breaks is exported as an
    // alternating Content/Br/Content chain. Fold only attribute-free injected
    // pairs; original adjacent Content siblings remain independently visible.
    while (index + 2 < significantChildren.length) {
      const lineBreak = significantChildren[index + 1]
      const continuation = significantChildren[index + 2]
      if (
        lineBreak?.kind !== "element" ||
        lineBreak.localName !== "Br" ||
        lineBreak.attributes.length !== 0 ||
        continuation?.kind !== "element" ||
        continuation.localName !== "Content" ||
        continuation.attributes.length !== 0
      ) {
        break
      }
      index += 2
    }
  }
  return ["element", element.name, attributes, element.selfClosing, children]
}

function isLiteralTextElement(element: XmlElement): boolean {
  if (element.localName === "Content") return true
  if (element.localName !== "Contents") return false
  const variable = nearestAncestor(
    element,
    (ancestor) => ancestor.localName === "TextVariable",
  )
  return variable ? isCustomTextVariableDefinition(variable) : false
}

function isTextVariableDefinition(element: XmlElement): boolean {
  return (
    element.localName === "TextVariable" &&
    Boolean(getAttribute(element, "Self")) &&
    Boolean(getAttribute(element, "VariableType")) &&
    !getAttribute(element, "src")
  )
}

function isCustomTextVariableDefinition(element: XmlElement): boolean {
  return (
    isTextVariableDefinition(element) &&
    /CustomTextType/i.test(getAttribute(element, "VariableType") ?? "")
  )
}

function protectedTokenKind(element: XmlElement): IdmlProtectedTokenKind | null {
  switch (element.localName) {
    case "Br":
      return "br"
    case "Tab":
    case "TabStop":
      return "tab"
    case "TextVariableInstance":
      return "variable"
    case "CrossReferenceSource":
    case "CrossReferenceTextSource":
      return "cross-reference"
    case "TextFrame":
    case "Rectangle":
    case "Oval":
    case "Polygon":
    case "GraphicLine":
    case "Group":
    case "Image":
    case "PDF":
    case "EPS":
    case "ImportedPage":
      return "inline-object"
    case "CharacterStyleRange":
    case "HyperlinkTextSource":
    case "HyperlinkTextDestination":
    case "XMLElement":
    case "HiddenText":
    case "Condition":
    case "Properties":
    case "Table":
    case "Cell":
    case "Footnote":
    case "Endnote":
    case "EndnoteRange":
    case "Note":
    case "NoteRange":
      return null
    default:
      return "unknown"
  }
}

function isOpaqueToken(kind: IdmlProtectedTokenKind | null): boolean {
  return (
    kind === "variable" ||
    kind === "cross-reference" ||
    kind === "inline-object" ||
    kind === "unknown"
  )
}

function opaqueParagraphAncestor(paragraph: XmlElement): XmlElement | null {
  let ancestor = paragraph.parent
  while (ancestor) {
    if (ancestor.localName === "Story") return null
    if (!SUPPORTED_PARAGRAPH_ANCESTORS.has(ancestor.localName)) return ancestor
    ancestor = ancestor.parent
  }
  return null
}

function paragraphScope(paragraph: XmlElement, storyContext: StoryContext): IdmlScope {
  if (nearestAncestor(paragraph, (ancestor) => ancestor.localName === "Footnote")) {
    return "footnote"
  }
  if (
    nearestAncestor(
      paragraph,
      (ancestor) => ancestor.localName === "Endnote" || ancestor.localName === "EndnoteRange",
    )
  ) {
    return "endnote"
  }
  if (
    nearestAncestor(
      paragraph,
      (ancestor) => ancestor.localName === "Note" || ancestor.localName === "NoteRange",
    )
  ) {
    return "note"
  }
  if (
    nearestAncestor(
      paragraph,
      (ancestor) => ancestor.localName === "Cell" || ancestor.localName === "Table",
    )
  ) {
    return "table-cell"
  }
  const story = nearestAncestor(paragraph, (ancestor) => ancestor.localName === "Story")
  const storyId = story ? getAttribute(story, "Self") : undefined
  return (storyId && storyContext.scopeByStoryId.get(storyId)) || "story-paragraph"
}

async function createLocator(
  document: XmlDocument,
  element: XmlElement,
  memberPath: string,
  scope: IdmlScope,
  slotIndexes: readonly number[],
  storyId?: string,
): Promise<IdmlLocator> {
  const block = document.source.slice(element.start, element.end)
  return {
    kind: "idml",
    memberPath,
    ...(storyId ? { storyId } : {}),
    elementPath: elementPath(element),
    ...(getAttribute(element, "Self") ? { elementId: getAttribute(element, "Self") } : {}),
    scope,
    part: 0,
    slotIndexes: [...slotIndexes],
    sourceBlockHash: await sha256Text(block),
  }
}

async function createUnit(
  locator: IdmlLocator,
  order: number,
  slots: readonly IdmlTextSlot[],
  protectedTokens: readonly IdmlProtectedToken[],
  diagnostics: readonly IdmlDiagnostic[],
): Promise<IdmlTranslationUnit> {
  const metadata: IdmlFormatMetadataV2 = {
    version: 2,
    slotCount: slots.length,
    editableSlotIndexes: slots.filter((slot) => slot.editable).map((slot) => slot.index),
    protectedTokenCount: protectedTokens.length,
    anchorSequenceHash: computeIdmlAnchorSequenceHash(slots, protectedTokens),
  }
  const id = `${locator.memberPath}#${locator.elementPath}:part-${locator.part}`
  const draft: IdmlTranslationUnit = {
    id,
    order,
    sourceText: sourceTextFromSlots(slots, protectedTokens),
    sourceHtml: "",
    locator,
    metadata,
    slots: [...slots],
    protectedTokens: [...protectedTokens],
    diagnostics: [...diagnostics],
  }
  return { ...draft, sourceHtml: renderIdmlUnitHtml(draft) }
}

function sourceTextFromSlots(
  slots: readonly IdmlTextSlot[],
  protectedTokens: readonly IdmlProtectedToken[],
): string {
  const tabsByBoundary = new Map<number, number>()
  for (const token of protectedTokens) {
    if (token.kind !== "tab") continue
    tabsByBoundary.set(token.position, (tabsByBoundary.get(token.position) ?? 0) + 1)
  }
  let value = "\t".repeat(tabsByBoundary.get(0) ?? 0)
  for (const slot of slots) {
    value += slot.text
    value += "\t".repeat(tabsByBoundary.get(slot.index + 1) ?? 0)
  }
  return value
}

function resolveAndVerifyElement(
  document: XmlDocument,
  locator: IdmlLocator,
  unitId: string,
): XmlElement {
  const target = resolveElementPath(document, locator.elementPath)
  if (!target) {
    throw new IdmlError("LOCATOR_MISSING", `IDML locator for ${unitId} cannot be resolved`)
  }
  if (locator.elementId && getAttribute(target, "Self") !== locator.elementId) {
    throw new IdmlError("LOCATOR_STALE", `IDML element ID changed for ${unitId}`)
  }
  return target
}

function replacementForSlot(
  source: string,
  element: XmlElement,
  translatedText: string,
  memberPath: string,
): Replacement {
  const pieces = translatedText.split(/\r\n|\r|\n/)
  const originalInterior = element.selfClosing
    ? ""
    : source.slice(element.openEnd, element.closeStart)
  const preserveCdata = /^<!\[CDATA\[[\s\S]*\]\]>$/.test(originalInterior)
  const translatedXml = pieces
    .map((piece) => {
      const escaped = escapeXmlText(piece, memberPath)
      return preserveCdata
        ? `<![CDATA[${piece.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
        : escaped
    })
    .join(`</${element.name}><Br/><${element.name}>`)
  if (!element.selfClosing) {
    return {
      start: element.openEnd,
      end: element.closeStart,
      value: translatedXml,
    }
  }
  const openTag = source.slice(element.start, element.end)
  const expandedOpenTag = openTag.replace(/\/>\s*$/, ">")
  return {
    start: element.start,
    end: element.end,
    value: `${expandedOpenTag}${translatedXml}</${element.name}>`,
  }
}

function applyReplacements(
  source: string,
  replacements: readonly Replacement[],
  memberPath: string,
): string {
  const sorted = [...replacements].sort((left, right) => right.start - left.start)
  let lastStart = source.length
  let output = source
  for (const replacement of sorted) {
    if (
      replacement.start < 0 ||
      replacement.end < replacement.start ||
      replacement.end > source.length ||
      replacement.end > lastStart
    ) {
      throw new IdmlError(
        "LOCATOR_DUPLICATED",
        `Overlapping or invalid replacements in ${memberPath}`,
      )
    }
    output =
      output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
    lastStart = replacement.start
  }
  return output
}

async function packageIdml(
  loaded: LoadedPackage,
  changedMembers: ReadonlyMap<string, Uint8Array>,
  options: IdmlExportOptions,
): Promise<Uint8Array> {
  const output = new JSZip()
  const mimetype = loaded.members.get("mimetype")
  if (!mimetype) {
    throw new IdmlError("INVALID_MIMETYPE", "IDML package is missing its mimetype member")
  }
  output.file("mimetype", mimetype.bytes, {
    binary: true,
    compression: "STORE",
    createFolders: false,
    date: mimetype.zipEntry.date,
  })
  const remainingMembers = loaded.inspection.members.filter(
    (member) => member.path !== "mimetype",
  )
  for (let index = 0; index < remainingMembers.length; index += 1) {
    throwIfAborted(options.signal)
    const memberInspection = remainingMembers[index]!
    const member = loaded.members.get(memberInspection.path)
    if (!member) {
      throw new IdmlError("MEMBER_REMOVED", `Unable to repackage ${memberInspection.path}`)
    }
    output.file(memberInspection.path, changedMembers.get(memberInspection.path) ?? member.bytes, {
      binary: true,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      createFolders: false,
      date: member.zipEntry.date,
      dir: memberInspection.isDirectory,
    })
    emitProgress(options.onProgress, {
      phase: "package",
      completed: index + 2,
      total: loaded.members.size,
      memberPath: memberInspection.path,
    })
    await yieldToEventLoop()
  }
  const generated = await output.generateAsync(
    {
      type: "uint8array",
      mimeType: IDML_MIMETYPE,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "UNIX",
      streamFiles: false,
    },
    (metadata) => {
      throwIfAborted(options.signal)
      emitProgress(options.onProgress, {
        phase: "package",
        completed: Math.min(
          loaded.members.size,
          Math.floor((metadata.percent / 100) * loaded.members.size),
        ),
        total: loaded.members.size,
        ...(metadata.currentFile ? { memberPath: metadata.currentFile } : {}),
      })
    },
  )
  return forceDeflateForEmptyMembers(generated)
}

/**
 * JSZip stores zero-byte files even when DEFLATE is explicitly requested.
 * UCF requires every member except `mimetype` to be deflated, so rewrite those
 * empty entries with the canonical two-byte raw-DEFLATE empty stream.
 */
function forceDeflateForEmptyMembers(bytes: Uint8Array): Uint8Array {
  const eocdOffset = findEndOfCentralDirectory(bytes)
  if (eocdOffset < 0) {
    throw new IdmlError("INVALID_ZIP", "Generated IDML has no ZIP end-of-central-directory record")
  }
  const entryCount = readUint16(bytes, eocdOffset + 10)
  const centralOffset = readUint32(bytes, eocdOffset + 16)
  let centralCursor = centralOffset
  let nextLocalOffset = 0
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(bytes, centralCursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new IdmlError("INVALID_ZIP", "Generated IDML central directory is malformed")
    }
    const compressedSize = readUint32(bytes, centralCursor + 20)
    const uncompressedSize = readUint32(bytes, centralCursor + 24)
    const nameLength = readUint16(bytes, centralCursor + 28)
    const centralExtraLength = readUint16(bytes, centralCursor + 30)
    const commentLength = readUint16(bytes, centralCursor + 32)
    const centralLength = 46 + nameLength + centralExtraLength + commentLength
    const centralRecord = bytes.slice(centralCursor, centralCursor + centralLength)
    const memberPath = new TextDecoder().decode(centralRecord.slice(46, 46 + nameLength))
    const originalLocalOffset = readUint32(bytes, centralCursor + 42)
    if (readUint32(bytes, originalLocalOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new IdmlError("INVALID_ZIP", `Generated local header is missing for ${memberPath}`)
    }
    const localNameLength = readUint16(bytes, originalLocalOffset + 26)
    const localExtraLength = readUint16(bytes, originalLocalOffset + 28)
    const localHeaderLength = 30 + localNameLength + localExtraLength
    const localRecord = bytes.slice(
      originalLocalOffset,
      originalLocalOffset + localHeaderLength + compressedSize,
    )
    const forceDeflate =
      memberPath !== "mimetype" &&
      !memberPath.endsWith("/") &&
      uncompressedSize === 0
    if (forceDeflate) {
      const rewrittenLocal = new Uint8Array(localHeaderLength + 2)
      rewrittenLocal.set(localRecord.slice(0, localHeaderLength))
      writeUint16(rewrittenLocal, 8, 8)
      writeUint32(rewrittenLocal, 18, 2)
      rewrittenLocal.set([0x03, 0x00], localHeaderLength)
      localParts.push(rewrittenLocal)
      writeUint16(centralRecord, 10, 8)
      writeUint32(centralRecord, 20, 2)
    } else {
      localParts.push(localRecord)
    }
    writeUint32(centralRecord, 42, nextLocalOffset)
    centralParts.push(centralRecord)
    nextLocalOffset += localParts.at(-1)?.byteLength ?? 0
    centralCursor += centralLength
  }

  const rebuiltCentral = concatenateBytes(centralParts)
  const eocd = bytes.slice(eocdOffset)
  writeUint32(eocd, 12, rebuiltCentral.byteLength)
  writeUint32(eocd, 16, nextLocalOffset)
  return concatenateBytes([...localParts, rebuiltCentral, eocd])
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const earliest = Math.max(0, bytes.byteLength - 22 - 0xffff)
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_EOCD_SIGNATURE) return offset
  }
  return -1
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true)
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true)
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function isRuntimeTranslation(value: unknown): value is IdmlTranslation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const candidate = value as {
    readonly unitId?: unknown
    readonly locator?: unknown
    readonly metadata?: unknown
    readonly sourceHtml?: unknown
    readonly targetHtml?: unknown
  }
  return (
    typeof candidate.unitId === "string"
    && candidate.unitId.length > 0
    && isRuntimeLocator(candidate.locator)
    && typeof candidate.metadata === "object"
    && candidate.metadata !== null
    && typeof candidate.sourceHtml === "string"
    && typeof candidate.targetHtml === "string"
  )
}

function isRuntimeLocator(value: unknown): value is IdmlLocator {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const locator = value as {
    readonly kind?: unknown
    readonly memberPath?: unknown
    readonly storyId?: unknown
    readonly elementPath?: unknown
    readonly elementId?: unknown
    readonly scope?: unknown
    readonly part?: unknown
    readonly slotIndexes?: unknown
    readonly sourceBlockHash?: unknown
  }
  if (
    locator.kind !== "idml"
    || typeof locator.memberPath !== "string"
    || locator.memberPath.length === 0
    || /[\u0000-\u001f]/.test(locator.memberPath)
    || locator.memberPath.startsWith("/")
    || /^[A-Za-z]:/.test(locator.memberPath)
    || locator.memberPath.includes("\\")
    || locator.memberPath.split("/").some((component) => (
      component === "" || component === "." || component === ".."
    ))
    || typeof locator.elementPath !== "string"
    || locator.elementPath.length === 0
    || (locator.storyId !== undefined && typeof locator.storyId !== "string")
    || (locator.elementId !== undefined && typeof locator.elementId !== "string")
    || typeof locator.scope !== "string"
    || !IDML_SCOPES.has(locator.scope as IdmlScope)
    || typeof locator.part !== "number"
    || !Number.isSafeInteger(locator.part)
    || locator.part < 0
    || !Array.isArray(locator.slotIndexes)
    || locator.slotIndexes.length === 0
    || typeof locator.sourceBlockHash !== "string"
    || !/^[a-f0-9]{64}$/.test(locator.sourceBlockHash)
  ) {
    return false
  }
  let previous = -1
  for (const slotIndex of locator.slotIndexes) {
    if (
      typeof slotIndex !== "number"
      || !Number.isSafeInteger(slotIndex)
      || slotIndex < 0
      || slotIndex <= previous
    ) {
      return false
    }
    previous = slotIndex
  }
  return true
}

function locatorLocationKey(locator: IdmlLocator): string {
  return `${locator.memberPath}\u0000${locator.elementPath}\u0000${locator.elementId ?? ""}`
}

function locatorIdentityKey(locator: IdmlLocator): string {
  return `${locatorLocationKey(locator)}\u0000${locator.sourceBlockHash}\u0000${locator.part}\u0000${locator.slotIndexes.join(",")}`
}

function sameLocatorBase(
  left: IdmlLocator,
  right: IdmlLocator,
  allowReconciledElementPath = false,
): boolean {
  return (
    left.kind === right.kind &&
    left.memberPath === right.memberPath &&
    left.storyId === right.storyId &&
    (left.elementPath === right.elementPath ||
      (allowReconciledElementPath &&
        left.elementId !== undefined &&
        left.elementId === right.elementId)) &&
    left.elementId === right.elementId &&
    left.scope === right.scope
  )
}

function unitSlotKey(locationKey: string, slotIndex: number): string {
  return `${locationKey}\u0000${slotIndex}`
}

function projectUnitForLocator(
  unit: IdmlTranslationUnit,
  locator: IdmlLocator,
): {
  readonly unit: IdmlTranslationUnit
  readonly slotPositions: readonly number[]
} | undefined {
  if (locator.slotIndexes.length === 0) return undefined
  const positionBySlotIndex = new Map(
    unit.locator.slotIndexes.map((slotIndex, position) => [slotIndex, position] as const),
  )
  const slotPositions = locator.slotIndexes.map((slotIndex) => positionBySlotIndex.get(slotIndex))
  if (
    slotPositions.some((position) => position === undefined)
    || slotPositions.some((position, index) => (
      index > 0 && position! <= slotPositions[index - 1]!
    ))
  ) {
    return undefined
  }
  const positions = slotPositions as number[]
  const slots = positions.map((position, index): IdmlTextSlot => {
    const source = unit.slots[position]!
    return { ...source, index }
  })
  const protectedTokens = unit.protectedTokens
    .filter((token) => {
      if (token.position === 0) {
        return positions[0] === 0 && locator.part === 0
      }
      if (token.position === unit.slots.length) {
        return positions.at(-1) === unit.slots.length - 1
      }
      return positions.indexOf(token.position) > 0
    })
    .map((token, index): IdmlProtectedToken => {
      let position: number
      if (token.position === 0) {
        position = 0
      } else if (token.position === unit.slots.length) {
        position = slots.length
      } else {
        position = positions.indexOf(token.position)
      }
      return { ...token, index, position }
    })
  const metadata: IdmlFormatMetadataV2 = {
    version: 2,
    slotCount: slots.length,
    editableSlotIndexes: slots.filter((slot) => slot.editable).map((slot) => slot.index),
    protectedTokenCount: protectedTokens.length,
    anchorSequenceHash: computeIdmlAnchorSequenceHash(slots, protectedTokens),
  }
  const draft: IdmlTranslationUnit = {
    ...unit,
    locator,
    slots,
    protectedTokens,
    metadata,
    sourceHtml: "",
  }
  return {
    unit: { ...draft, sourceHtml: renderIdmlUnitHtml(draft) },
    slotPositions: positions,
  }
}

function locatorElementIdKey(memberPath: string, elementId: string): string {
  return `${memberPath}\u0000${elementId}`
}

function sameMetadata(left: IdmlFormatMetadataV2, right: IdmlFormatMetadataV2): boolean {
  return (
    left.version === right.version &&
    left.slotCount === right.slotCount &&
    left.protectedTokenCount === right.protectedTokenCount &&
    left.anchorSequenceHash === right.anchorSequenceHash &&
    sameNumbers(left.editableSlotIndexes, right.editableSlotIndexes)
  )
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array
    ? new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    : new Uint8Array(bytes.slice(0))
}

function diagnostic(
  code: IdmlDiagnostic["code"],
  message: string,
  memberPath?: string,
  unitId?: string,
  details?: IdmlDiagnostic["details"],
): IdmlDiagnostic {
  return {
    code,
    severity: code === "UNSUPPORTED_CONSTRUCT" ? "warning" : "error",
    message,
    ...(memberPath ? { memberPath } : {}),
    ...(unitId ? { unitId } : {}),
    ...(details ? { details } : {}),
  }
}

function emitProgress(
  callback: ((progress: IdmlProgress) => void) | undefined,
  progress: IdmlProgress,
): void {
  callback?.(progress)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const nested of Object.values(object)) deepFreeze(nested, seen)
  return Object.freeze(value)
}
