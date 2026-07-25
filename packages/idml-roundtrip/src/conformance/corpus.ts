import JSZip from "jszip"

import { inspectIdml } from "../archive.js"
import { sha256 } from "../crypto.js"
import { exportIdml, parseIdml, validateExport } from "../engine.js"
import { IdmlError } from "../errors.js"
import { validateIdmlTranslation } from "../html.js"
import { upgradeLegacyIdmlMetadata } from "../legacy.js"
import type {
  IdmlExportOptions,
  IdmlFormatMetadataV2,
  IdmlLimits,
  IdmlLocator,
  IdmlProtectedTokenKind,
  IdmlScope,
  IdmlTranslation,
} from "../types.js"

interface ValidFixture {
  readonly path: string
  readonly sha256: string
  readonly profiles: readonly ("generic" | "biblica")[]
  readonly expectedScopes?: readonly IdmlScope[]
  readonly expectedUnitIds?: readonly string[]
}

interface InvalidFixture {
  readonly path: string
  readonly sha256: string
  readonly operation: "inspect" | "parse"
  readonly errorCode: string
  readonly limits?: Partial<IdmlLimits>
}

interface MetadataFixture {
  readonly path: string
  readonly sha256: string
  readonly expected: "upgradeable" | "v2" | "export-rejected"
}

export interface IdmlCorpusManifest {
  readonly version: 1
  readonly generated: true
  readonly license: "CC0-1.0"
  readonly generator: string
  readonly valid: readonly ValidFixture[]
  readonly invalid: readonly InvalidFixture[]
  readonly metadata: readonly MetadataFixture[]
}

export interface IdmlCorpusLoader {
  loadBytes(path: string): Promise<Uint8Array>
  loadJson(path: string): Promise<unknown>
}

export interface IdmlCorpusConformanceReport {
  readonly validPackages: number
  readonly hostilePackagesRejected: number
  readonly metadataContracts: number
  readonly featureUnitCount: number
  readonly translatedUnitCount: number
  readonly runtime: string
}

interface V2CellRecord {
  readonly locator: IdmlLocator
  readonly metadata: IdmlFormatMetadataV2
  readonly sourceHtml: string
  readonly targetHtml: string
}

export async function runIdmlCorpusConformance(
  loader: IdmlCorpusLoader,
  runtime: string,
): Promise<IdmlCorpusConformanceReport> {
  const manifest = asManifest(await loader.loadJson("manifest.json"))
  requireCondition(manifest.version === 1, "Unsupported generated corpus manifest")
  requireCondition(manifest.generated, "Corpus must declare generated provenance")
  requireCondition(manifest.license === "CC0-1.0", "Corpus must declare the CC0 fixture license")

  for (const fixture of [...manifest.valid, ...manifest.invalid, ...manifest.metadata]) {
    const bytes = await loader.loadBytes(fixture.path)
    requireEqual(
      await sha256(bytes),
      fixture.sha256,
      `Committed fixture checksum changed: ${fixture.path}`,
    )
  }

  for (const fixture of manifest.valid) {
    const bytes = await loader.loadBytes(fixture.path)
    const inspection = await inspectIdml(bytes)
    requireCondition(inspection.members.length >= 3, `${fixture.path} has too few package members`)
    requireEqual(inspection.members[0]?.path, "mimetype", `${fixture.path} is not UCF ordered`)
    requireEqual(
      inspection.members[0]?.compressionMethod,
      0,
      `${fixture.path} must store mimetype without compression`,
    )
    for (const profile of fixture.profiles) {
      const parsed = await parseIdml(bytes, profile)
      requireEqual(parsed.manifest.version, 2, `${fixture.path} emitted the wrong schema`)
      requireEqual(parsed.manifest.profile, profile, `${fixture.path} lost its semantic profile`)
      if (fixture.expectedUnitIds) {
        requireDeepEqual(
          parsed.units.map((unit) => unit.locator.elementId),
          fixture.expectedUnitIds,
          `${fixture.path} changed its unit identities`,
        )
      }
    }
  }

  const featurePath = "valid/feature-rich.idml"
  const featureBytes = await loader.loadBytes(featurePath)
  const feature = await parseIdml(featureBytes, "generic")
  const featureInspection = await inspectIdml(featureBytes)
  requireCondition(
    featureInspection.members.every((member) => !member.isDirectory),
    "Generated UCF fixture unexpectedly contains synthetic directory entries",
  )
  const featureMemberPaths = new Set(featureInspection.members.map((member) => member.path))
  for (const memberPath of [
    "Spreads/Spread_main.xml",
    "MasterSpreads/MasterSpread_master.xml",
    "Resources/Layers.xml",
    "Resources/Hyperlinks.xml",
    "Links/generated-image.png",
  ]) {
    requireCondition(featureMemberPaths.has(memberPath), `Feature fixture missed ${memberPath}`)
  }
  const originalZip = await JSZip.loadAsync(featureBytes)
  const originalSpread = await zipMemberText(originalZip, "Spreads/Spread_main.xml")
  requireEqual(
    occurrences(originalSpread, "<Page "),
    2,
    "Feature fixture must contain two generated pages",
  )
  const featureManifest = manifest.valid.find((fixture) => fixture.path === featurePath)
  requireCondition(featureManifest !== undefined, "Feature fixture is absent from manifest")
  const actualScopes = new Set(feature.units.map((unit) => unit.locator.scope))
  for (const expectedScope of featureManifest.expectedScopes ?? []) {
    requireCondition(actualScopes.has(expectedScope), `Feature fixture missed ${expectedScope}`)
  }

  const mixed = unit(feature, "p-mixed")
  requireDeepEqual(
    mixed.slots.map((slot) => slot.text),
    [
      "  Bold & preserved  ",
      "ثُمَّ RTL",
      "漢字とかな",
      "क्‍षेत्र e\u0301",
      "",
      "one",
      "two",
      "",
    ],
    "Mixed-run whitespace, entities, Unicode, tabs, or empty slots changed",
  )
  requireDeepEqual(
    mixed.slots.map((slot) => slot.characterStyleId),
    [
      "CharacterStyle/Bold",
      "CharacterStyle/Bold",
      "CharacterStyle/Italic",
      "CharacterStyle/Italic",
      "CharacterStyle/Italic",
      "CharacterStyle/Underline",
      "CharacterStyle/Underline",
      "CharacterStyle/Underline",
    ],
    "Character-style slot assignments changed",
  )
  const tokenKinds = new Set(mixed.protectedTokens.map((token) => token.kind))
  for (const kind of [
    "br",
    "tab",
    "cross-reference",
    "variable",
    "inline-object",
    "unknown",
  ] as const satisfies readonly IdmlProtectedTokenKind[]) {
    requireCondition(tokenKinds.has(kind), `Feature fixture missed protected token ${kind}`)
  }
  requireCondition(
    feature.diagnostics.some(
      (entry) =>
        entry.code === "UNSUPPORTED_CONSTRUCT" &&
        entry.message.includes("Computed text variable"),
    ),
    "Computed variables must remain protected and diagnosed",
  )
  requireDeepEqual(
    feature.diagnostics
      .filter((entry) => entry.code === "UNSUPPORTED_CONSTRUCT")
      .map((entry) => ({
        message: entry.message,
        unsupportedDisposition: entry.details?.unsupportedDisposition,
        constructKind: entry.details?.constructKind,
      })),
    [
      {
        message: "Unknown inline IDML element <Mystery> was preserved as a protected token",
        unsupportedDisposition: "preserved-nonliteral",
        constructKind: "unknown-inline-element",
      },
      {
        message: "Computed text variable TextVariable/Page was preserved",
        unsupportedDisposition: "preserved-nonliteral",
        constructKind: "computed-text-variable",
      },
      {
        message: "Computed text variable TextVariable/Date was preserved",
        unsupportedDisposition: "preserved-nonliteral",
        constructKind: "computed-text-variable",
      },
    ],
    "Feature fixture unsupported diagnostics changed classification",
  )
  requireEqual(unit(feature, "p-table-outer").locator.scope, "table-cell", "Outer table lost scope")
  requireEqual(unit(feature, "p-table-inner").locator.scope, "table-cell", "Nested table lost scope")
  requireEqual(unit(feature, "p-footnote").sourceText, "foot&note", "Entity semantics changed")
  requireEqual(unit(feature, "p-endnote").locator.scope, "endnote", "Endnote lost scope")
  requireEqual(unit(feature, "p-note").locator.scope, "note", "Note lost scope")
  requireEqual(unit(feature, "p-anchored").locator.scope, "anchored-story", "Anchor lost scope")
  requireEqual(unit(feature, "p-text-path").locator.scope, "text-path", "Text path lost scope")
  requireEqual(unit(feature, "p-master").locator.scope, "master-story", "Master story lost scope")
  requireCondition(unit(feature, "p-long").sourceText.length === 24_000, "Long paragraph was split")
  requireCondition(
    unit(feature, "p-terminator").sourceText.includes("\r"),
    "Numeric paragraph terminator semantics changed",
  )
  requireCondition(
    feature.units.some((entry) => entry.locator.elementId === "p-remaining"),
    "Unlisted story discovery regressed",
  )

  const noOp = await exportIdml(featureBytes, [], { strict: true })
  requireBytesEqual(noOp.bytes, featureBytes, "No-op export must return the original bytes exactly")

  const producedCells = feature.units.map((parsedUnit) => {
    const elementId = parsedUnit.locator.elementId ?? parsedUnit.id
    const targetHtml = elementId === "p-mixed"
      ? parsedUnit.sourceHtml.replace("漢字とかな", "translated CJK")
      : elementId === "p-table-inner"
        ? parsedUnit.sourceHtml.replace("nested cell", "nested<br>cell translated")
        : elementId === "p-footnote"
          ? parsedUnit.sourceHtml.replace("foot&amp;note", "translated footnote")
          : elementId === "TextVariable/Custom"
            ? parsedUnit.sourceHtml.replace(
                "literal custom variable",
                "translated variable",
              )
            : prependFirstEditableSlot(parsedUnit.sourceHtml, parsedUnit.metadata, elementId)
    requireCondition(
      targetHtml !== parsedUnit.sourceHtml,
      `Could not apply generated translation for ${elementId}`,
    )
    return {
      unitId: parsedUnit.id,
      locator: parsedUnit.locator,
      metadata: parsedUnit.metadata,
      sourceHtml: parsedUnit.sourceHtml,
      targetHtml,
    }
  })

  // This JSON boundary is the database/event-log reload. The immediate
  // consumer receives the producer's real locator, metadata, and HTML shape.
  const reloadedCells = JSON.parse(JSON.stringify(producedCells)) as IdmlTranslation[]
  for (const cell of reloadedCells) {
    const validation = validateIdmlTranslation(
      cell.sourceHtml,
      cell.targetHtml,
      cell.metadata,
    )
    requireCondition(validation.valid, `Reloaded cell ${cell.unitId} lost protected anchors`)
  }
  const exported = await exportIdml(featureBytes, reloadedCells, { strict: true })
  requireEqual(
    exported.report.translated,
    feature.units.length,
    "Strict export silently skipped a literal translation unit",
  )
  requireDeepEqual(
    exported.report.changedMemberPaths,
    [
      "Resources/TextVariables.xml",
      "Stories/Story_anchored.xml",
      "Stories/Story_long.xml",
      "Stories/Story_main.xml",
      "Stories/Story_master.xml",
      "Stories/Story_path.xml",
      "Stories/Story_remaining.xml",
      "Stories/Story_threaded.xml",
    ],
    "Surgical export touched unexpected package members",
  )
  const packageDiagnostics = await validateExport(exported.bytes, feature.manifest)
  requireCondition(
    packageDiagnostics.length === 0,
    `Exported package failed manifest validation: ${JSON.stringify(packageDiagnostics)}`,
  )
  const exportedZip = await JSZip.loadAsync(exported.bytes)
  requireBytesEqual(
    await zipMemberBytes(exportedZip, "Links/generated-image.png"),
    await zipMemberBytes(originalZip, "Links/generated-image.png"),
    "Linked image bytes changed during translation",
  )
  requireBytesEqual(
    (await zipMemberBytes(exportedZip, "Stories/Story_master.xml")).subarray(0, 3),
    Uint8Array.from([0xef, 0xbb, 0xbf]),
    "Translated master story lost its UTF-8 BOM",
  )
  const originalMain = await zipMemberText(originalZip, "Stories/Story_main.xml")
  const exportedMain = await zipMemberText(exportedZip, "Stories/Story_main.xml")
  requireCondition(
    exportedMain.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n'),
    "Changed story lost its XML declaration or CRLF convention",
  )
  requireEqual(
    occurrences(exportedMain, "\r\n"),
    occurrences(originalMain, "\r\n"),
    "Changed story normalized existing line endings",
  )
  requireCondition(
    exportedMain.includes("<Content>nested</Content><Br/><Content>cell translated</Content>"),
    "User line break was not surgically encoded inside the original style run",
  )
  const reparsed = await parseIdml(exported.bytes)
  requireCondition(
    unit(reparsed, "p-mixed").sourceText.includes("translated CJK"),
    "Mixed-run translation did not survive re-import",
  )
  const reparsedTable = unit(reparsed, "p-table-inner")
  requireDeepEqual(
    reparsedTable.slots.map((slot) => slot.text),
    ["nested", "cell translated"],
    "Line-break Content nodes did not remain inside the nested table style run",
  )
  requireCondition(
    reparsedTable.protectedTokens.some((token) => token.kind === "br"),
    "Translated nested table line break was not protected on re-import",
  )
  requireEqual(
    unit(reparsed, "p-footnote").sourceText,
    "translated footnote",
    "Footnote translation did not survive re-import",
  )
  requireEqual(
    unit(reparsed, "TextVariable/Custom").sourceText,
    "translated variable",
    "Custom variable translation did not survive re-import",
  )
  for (const originalUnit of feature.units) {
    const elementId = originalUnit.locator.elementId ?? originalUnit.id
    if (
      elementId === "p-mixed" ||
      elementId === "p-table-inner" ||
      elementId === "p-footnote" ||
      elementId === "TextVariable/Custom"
    ) {
      continue
    }
    requireCondition(
      unit(reparsed, elementId).sourceText.startsWith(`[translated:${elementId}] `),
      `Translation did not survive re-import for ${elementId}`,
    )
  }

  for (const fixture of manifest.invalid) {
    const bytes = await loader.loadBytes(fixture.path)
    let failure: unknown
    try {
      if (fixture.operation === "inspect") {
        await inspectIdml(bytes, fixture.limits)
      } else {
        await parseIdml(bytes, "generic", { limits: fixture.limits })
      }
    } catch (error) {
      failure = error
    }
    requireCondition(failure instanceof IdmlError, `${fixture.path} was not rejected as IDML`)
    requireEqual(
      failure.code,
      fixture.errorCode,
      `${fixture.path} produced the wrong typed failure`,
    )
  }

  const legacy = await loader.loadJson("metadata/legacy-codex.json")
  const legacyUpgrade = upgradeLegacyIdmlMetadata(legacy)
  requireCondition(
    legacyUpgrade.ok,
    `Generated Codex metadata did not upgrade: ${
      JSON.stringify(legacyUpgrade.ok ? [] : legacyUpgrade.diagnostics)
    }`,
  )
  if (legacyUpgrade.ok) {
    requireEqual(legacyUpgrade.metadata.version, 2, "Legacy metadata did not converge on v2")
    requireCondition(
      validateIdmlTranslation(
        legacyUpgrade.sourceHtml,
        legacyUpgrade.targetHtml ?? legacyUpgrade.sourceHtml,
        legacyUpgrade.metadata,
      ).valid,
      "Legacy upgrade emitted invalid protected HTML",
    )
  }

  const canonical = asV2Cell(await loader.loadJson("metadata/v2-cell.json"))
  const canonicalUpgrade = upgradeLegacyIdmlMetadata(canonical)
  requireCondition(canonicalUpgrade.ok, "Canonical v2 metadata did not pass through")

  const stale = asV2Cell(await loader.loadJson("metadata/stale-locator.json"))
  const staleTranslation: IdmlTranslation = {
    unitId: unit(feature, "p-mixed").id,
    locator: stale.locator,
    metadata: stale.metadata,
    sourceHtml: stale.sourceHtml,
    targetHtml: stale.targetHtml,
  }
  let staleFailure: unknown
  try {
    await exportIdml(featureBytes, [staleTranslation], {
      strict: true,
    } satisfies IdmlExportOptions)
  } catch (error) {
    staleFailure = error
  }
  requireCondition(staleFailure instanceof IdmlError, "Stale locator did not block export")
  requireEqual(staleFailure.code, "EXPORT_REJECTED", "Stale locator used an untyped failure")
  requireCondition(
    staleFailure.diagnostics.some((entry) => entry.code === "SOURCE_HASH_MISMATCH"),
    "Stale source hash was not diagnosed",
  )

  return {
    validPackages: manifest.valid.length,
    hostilePackagesRejected: manifest.invalid.length,
    metadataContracts: manifest.metadata.length,
    featureUnitCount: feature.units.length,
    translatedUnitCount: exported.report.translated,
    runtime,
  }
}

function unit(
  parsed: Awaited<ReturnType<typeof parseIdml>>,
  elementId: string,
) {
  const result = parsed.units.find((entry) => entry.locator.elementId === elementId)
  if (!result) throw new Error(`Generated corpus unit ${elementId} is missing`)
  return result
}

function asManifest(value: unknown): IdmlCorpusManifest {
  requireCondition(typeof value === "object" && value !== null, "Corpus manifest is not an object")
  return value as IdmlCorpusManifest
}

function asV2Cell(value: unknown): V2CellRecord {
  requireCondition(typeof value === "object" && value !== null, "V2 fixture is not an object")
  return value as V2CellRecord
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message)
}

function requireEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
  }
}

function requireDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}

function requireBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string,
): void {
  if (
    actual.byteLength !== expected.byteLength ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(message)
  }
}

async function zipMemberBytes(zip: JSZip, path: string): Promise<Uint8Array> {
  const entry = zip.file(path)
  if (!entry) throw new Error(`Generated package member ${path} is missing`)
  return entry.async("uint8array")
}

async function zipMemberText(zip: JSZip, path: string): Promise<string> {
  return new TextDecoder().decode(await zipMemberBytes(zip, path))
}

function occurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let cursor = 0
  while (true) {
    const index = value.indexOf(needle, cursor)
    if (index < 0) return count
    count += 1
    cursor = index + needle.length
  }
}

function prependFirstEditableSlot(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
  elementId: string,
): string {
  const slotIndex = metadata.editableSlotIndexes[0]
  if (slotIndex === undefined) {
    throw new Error(`Generated unit ${elementId} has no editable text slot`)
  }
  const anchor = `<span data-idml-slot="${slotIndex}"`
  const anchorStart = sourceHtml.indexOf(anchor)
  const contentStart = sourceHtml.indexOf(">", anchorStart) + 1
  if (anchorStart < 0 || contentStart === 0) {
    throw new Error(`Generated unit ${elementId} lost slot ${slotIndex}`)
  }
  return `${sourceHtml.slice(0, contentStart)}[translated:${elementId}] ${sourceHtml.slice(contentStart)}`
}
