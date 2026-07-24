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
const XML_MEMBER_PATTERN = /\.xml$/i
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
}

interface UnitExtraction {
  readonly unit: IdmlTranslationUnit
  readonly slotElements: readonly SlotElement[]
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
  if (options.strict !== true) {
    throw new IdmlError("EXPORT_REJECTED", "IDML export must run in strict mode")
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
  const seenUnitLocations = new Set<string>()
  const diagnostics: IdmlDiagnostic[] = []
  const accepted: Array<{
    readonly translation: IdmlTranslation
    readonly unit: IdmlTranslationUnit
    readonly targetSlots: readonly string[]
  }> = []

  for (let index = 0; index < translations.length; index += 1) {
    throwIfAborted(options.signal)
    const translation = translations[index]!
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
    const resolvedLocationKey = locatorLocationKey(unit.locator)
    if (seenUnitLocations.has(resolvedLocationKey)) {
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
    seenUnitLocations.add(resolvedLocationKey)
    if (!sameLocatorStructure(translation.locator, unit.locator, reconciledByElementId)) {
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
      translation.sourceHtml !== unit.sourceHtml ||
      !sameMetadata(translation.metadata, unit.metadata)
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
    if (validation.slots.length !== unit.slots.length) {
      diagnostics.push(
        diagnostic(
          "ANCHOR_INVALID",
          `Translation returned ${validation.slots.length} slots; expected ${unit.slots.length}`,
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
    accepted.push({ translation, unit, targetSlots: validation.slots })
    emitProgress(options.onProgress, {
      phase: "validate",
      completed: index + 1,
      total: translations.length,
      memberPath: translation.locator.memberPath,
    })
  }

  if (diagnostics.length > 0) {
    throw new IdmlError(
      "EXPORT_REJECTED",
      `IDML export rejected ${diagnostics.length} invalid translation mapping(s)`,
      deepFreeze(diagnostics),
    )
  }

  emitProgress(options.onProgress, {
    phase: "export",
    completed: 0,
    total: accepted.length,
  })
  const replacementsByMember = new Map<string, Replacement[]>()
  let translatedCount = 0
  for (let acceptedIndex = 0; acceptedIndex < accepted.length; acceptedIndex += 1) {
    throwIfAborted(options.signal)
    const item = accepted[acceptedIndex]!
    const member = parsed.loaded.members.get(item.unit.locator.memberPath)
    if (!member?.xml) {
      throw new IdmlError(
        "LOCATOR_MISSING",
        `IDML member ${item.unit.locator.memberPath} is unavailable during export`,
      )
    }
    const target = resolveAndVerifyElement(member.xml, item.unit.locator, item.unit.id)
    const slotElements = extractSlotElements(
      target,
      item.unit.locator.scope,
      member.xml.source,
    )
    if (
      slotElements.length !== item.unit.slots.length ||
      !sameNumbers(
        item.unit.locator.slotIndexes,
        slotElements.map((slot) => slot.slot.index),
      )
    ) {
      throw new IdmlError(
        "LOCATOR_STALE",
        `IDML slot structure changed for ${item.unit.id}`,
      )
    }

    let unitChanged = false
    for (let slotIndex = 0; slotIndex < slotElements.length; slotIndex += 1) {
      const slotElement = slotElements[slotIndex]!
      const translatedText = item.targetSlots[slotIndex] ?? ""
      if (translatedText === slotElement.slot.text) continue
      unitChanged = true
      const replacement = replacementForSlot(
        member.xml.source,
        slotElement.element,
        translatedText,
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
      total: accepted.length,
      memberPath: item.unit.locator.memberPath,
    })
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
  const changedMemberPaths = [...changedMemberBytes.keys()].sort()
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

export async function validateExport(
  bytes: Uint8Array | ArrayBuffer,
  manifest: IdmlSourceManifest,
): Promise<readonly IdmlDiagnostic[]> {
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
    loaded = await loadPackage(bytes)
  } catch (error) {
    if (error instanceof IdmlError && isReadableValidationDifference(error.code)) {
      return deepFreeze([...error.diagnostics])
    }
    throw error
  }

  const diagnostics: IdmlDiagnostic[] = []
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
  for (const expectedMember of manifest.members) {
    const actualMember = actual.get(expectedMember.path)
    if (
      actualMember &&
      !translatableMembers.has(expectedMember.path) &&
      actualMember.hash !== expectedMember.sha256
    ) {
      diagnostics.push(
        diagnostic(
          "MEMBER_CHANGED",
          "A non-translatable IDML member changed during export",
          expectedMember.path,
        ),
      )
    }
  }

  for (const locator of manifest.unitLocators) {
    const member = actual.get(locator.memberPath)
    if (!member?.xml) {
      if (member) {
        diagnostics.push(
          diagnostic("LOCATOR_MISSING", "Locator member is not XML", locator.memberPath),
        )
      }
      continue
    }
    const target = resolveLocatorForValidation(member.xml, locator)
    if (!target) {
      diagnostics.push(
        diagnostic(
          "LOCATOR_MISSING",
          "Exported IDML no longer contains an expected locator",
          locator.memberPath,
        ),
      )
    }
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

  emitProgress(options?.onProgress, {
    phase: "parse",
    completed: 0,
    total: storyMembers.length,
  })
  for (let storyIndex = 0; storyIndex < storyMembers.length; storyIndex += 1) {
    throwIfAborted(options?.signal)
    const memberPath = storyMembers[storyIndex]!
    const member = loaded.members.get(memberPath)
    if (!member?.xml) {
      throw new IdmlError("MISSING_STORY", `Story member ${memberPath} is missing or is not XML`)
    }
    const paragraphs = elementDescendants(
      member.xml.root,
      (element) => element.localName === "ParagraphStyleRange",
    )
    for (const paragraph of paragraphs) {
      const extraction = await extractParagraphUnit(
        member.xml,
        memberPath,
        paragraph,
        order,
        storyContext,
      )
      if (!extraction) continue
      extractions.push(extraction)
      diagnostics.push(...extraction.unit.diagnostics)
      order += 1
    }
    emitProgress(options?.onProgress, {
      phase: "parse",
      completed: storyIndex + 1,
      total: storyMembers.length,
      memberPath,
    })
  }

  for (const member of loaded.members.values()) {
    if (!member.xml) continue
    const variables = elementDescendants(
      member.xml.root,
      (element) => element.localName === "TextVariable",
    )
    for (const variable of variables) {
      const variableType = getAttribute(variable, "VariableType") ?? ""
      if (!/CustomTextType/i.test(variableType)) {
        diagnostics.push(
          diagnostic(
            "UNSUPPORTED_CONSTRUCT",
            `Computed text variable ${getAttribute(variable, "Self") ?? "(unnamed)"} was preserved`,
            member.inspection.path,
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
  }

  const includeUnit =
    typeof profile === "object" && profile.includeUnit ? profile.includeUnit : undefined
  const units = includeUnit
    ? extractions.map((entry) => entry.unit).filter((unit) => includeUnit(unit))
    : extractions.map((entry) => entry.unit)
  const profileId = typeof profile === "string" ? profile : profile.id
  const manifest: IdmlSourceManifest = {
    version: 2,
    sourceSha256: await sha256(loaded.inputBytes),
    profile: profileId,
    members: [...loaded.members.values()]
      .map((member) => ({
        path: member.inspection.path,
        sha256: member.hash,
        byteLength: member.bytes.byteLength,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
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
  const fileMembers = inspection.members.filter((member) => !member.isDirectory)
  const members = new Map<string, LoadedMember>()
  emitProgress(options?.onProgress, {
    phase: "unpack",
    completed: 0,
    total: fileMembers.length,
  })
  for (let memberIndex = 0; memberIndex < fileMembers.length; memberIndex += 1) {
    throwIfAborted(options?.signal)
    const memberInspection = fileMembers[memberIndex]!
    const entry = zip.file(memberInspection.path)
    if (!entry) {
      throw new IdmlError(
        "INVALID_ZIP",
        `Central-directory member ${memberInspection.path} could not be loaded`,
      )
    }
    const memberBytes = await entry.async("uint8array")
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
      total: fileMembers.length,
      memberPath: memberInspection.path,
    })
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
  for (const element of elementDescendants(
    designmap.root,
    (candidate) => candidate.localName === "Story",
  )) {
    const rawSource = getAttribute(element, "src")
    if (!rawSource) continue
    const source = rawSource.replace(/^\.\//, "")
    if (!STORY_MEMBER_PATTERN.test(source)) continue
    if (!loaded.members.has(source)) {
      diagnostics.push(
        diagnostic("MISSING_STORY", `designmap.xml references missing story ${source}`, source),
      )
      continue
    }
    if (!seen.has(source)) {
      seen.add(source)
      ordered.push(source)
    }
  }
  const remaining = [...loaded.members.keys()]
    .filter((memberPath) => STORY_MEMBER_PATTERN.test(memberPath) && !seen.has(memberPath))
    .sort((left, right) => left.localeCompare(right))
  ordered.push(...remaining)
  return ordered
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
): Promise<UnitExtraction | null> {
  const scope = paragraphScope(paragraph, storyContext)
  const slotElements = extractSlotElements(paragraph, scope, document.source)
  if (slotElements.length === 0) return null
  const { tokens, diagnostics } = extractProtectedTokens(paragraph, memberPath, document.source)
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
  return { unit, slotElements }
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
  const slotElements: SlotElement[] = contents.map((element, index) => ({
    element,
    slot: {
      index,
      text: contentText(element),
      characterStyleId: DEFAULT_CHARACTER_STYLE,
      editable: !contentHasOpaqueMarkup(document.source, element),
    },
  }))
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
    [],
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
    return elementDescendants(
      paragraphOrVariable,
      (element) =>
        element.localName === "Contents" &&
        nearestAncestor(element, (ancestor) => ancestor.localName === "TextVariable") ===
          paragraphOrVariable,
    ).map((element, index) => ({
      element,
      slot: {
        index,
        text: contentText(element),
        characterStyleId: DEFAULT_CHARACTER_STYLE,
        editable: !contentHasOpaqueMarkup(source, element),
      },
    }))
  }

  const slots: SlotElement[] = []
  const visit = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.kind !== "element") continue
      if (child.localName === "ParagraphStyleRange") continue
      if (child.localName === "Content") {
        const text = contentText(child)
        const characterRange = nearestAncestor(
          child,
          (ancestor) => ancestor.localName === "CharacterStyleRange",
        )
        slots.push({
          element: child,
          slot: {
            index: slots.length,
            text,
            characterStyleId:
              (characterRange &&
                (getAttribute(characterRange, "AppliedCharacterStyle") ??
                  getAttribute(characterRange, "Self"))) ||
              DEFAULT_CHARACTER_STYLE,
            editable: !text.includes("\t") && !contentHasOpaqueMarkup(source, child),
          },
        })
        continue
      }
      visit(child)
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
        if (text.includes("\t")) {
          tokens.push({
            index: tokens.length,
            kind: "tab",
            xmlName: child.name,
            position: slotBoundary,
          })
          if (text !== "\t") {
            diagnostics.push(
              diagnostic(
                "UNSUPPORTED_CONSTRUCT",
                "A Content slot containing both a tab and text was locked to prevent tab loss",
                memberPath,
              ),
            )
          }
        }
        if (contentHasOpaqueMarkup(source, child)) {
          tokens.push({
            index: tokens.length,
            kind: "unknown",
            xmlName: child.name,
            position: slotBoundary,
          })
          diagnostics.push(
            diagnostic(
              "UNSUPPORTED_CONSTRUCT",
              "Markup inside an IDML Content slot was locked and preserved",
              memberPath,
            ),
          )
        }
        slotBoundary += 1
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
      return null
    default:
      return nearestAncestor(element, (ancestor) => ancestor.localName === "CharacterStyleRange")
        ? "unknown"
        : null
  }
}

function isOpaqueToken(kind: IdmlProtectedTokenKind | null): boolean {
  return kind === "variable" || kind === "cross-reference" || kind === "inline-object"
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
    sourceText: slots.map((slot) => slot.text).join(""),
    sourceHtml: "",
    locator,
    metadata,
    slots: [...slots],
    protectedTokens: [...protectedTokens],
    diagnostics: [...diagnostics],
  }
  return { ...draft, sourceHtml: renderIdmlUnitHtml(draft) }
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
    (member) => !member.isDirectory && member.path !== "mimetype",
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
    })
    emitProgress(options.onProgress, {
      phase: "package",
      completed: index + 2,
      total: loaded.members.size,
      memberPath: memberInspection.path,
    })
  }
  const generated = await output.generateAsync({
    type: "uint8array",
    mimeType: IDML_MIMETYPE,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
    streamFiles: false,
  })
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
    const forceDeflate = memberPath !== "mimetype" && uncompressedSize === 0
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

function locatorLocationKey(locator: IdmlLocator): string {
  return `${locator.memberPath}\u0000${locator.elementPath}\u0000${locator.elementId ?? ""}`
}

function locatorIdentityKey(locator: IdmlLocator): string {
  return `${locatorLocationKey(locator)}\u0000${locator.sourceBlockHash}\u0000${locator.slotIndexes.join(",")}`
}

function sameLocatorStructure(
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
    left.scope === right.scope &&
    left.part === right.part &&
    sameNumbers(left.slotIndexes, right.slotIndexes)
  )
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
): IdmlDiagnostic {
  return {
    code,
    severity: code === "UNSUPPORTED_CONSTRUCT" ? "warning" : "error",
    message,
    ...(memberPath ? { memberPath } : {}),
    ...(unitId ? { unitId } : {}),
  }
}

function emitProgress(
  callback: ((progress: IdmlProgress) => void) | undefined,
  progress: IdmlProgress,
): void {
  callback?.(progress)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const nested of Object.values(object)) deepFreeze(nested, seen)
  return Object.freeze(value)
}
