import { describe, expect, it } from "vitest"
import {
  catalogLeafKeys,
  parseLeafKey,
  sourceHash,
  type SourceHashes,
} from "./catalog-export"
import { DEFAULT_LOCALE, LOCALES } from "./locales"
import { CATALOGS } from "./messages"
import { en, type MessageKey } from "./messages/en"
import { isPluralMessage } from "./plurals"
import sourceHashes from "./source-hashes.json" with { type: "json" }

/**
 * Catalog completeness (AQU-1188).
 *
 * Every shipping locale must have an explicit translation for every English
 * leaf, except identity strings that are correctly left in English (brand
 * names, format codes, tool identifiers, URL/email examples). Those stay
 * absent from the generated catalog on purpose: `i18n:import` treats a value
 * still equal to English as untranslated, and `translate()` then falls back
 * to the English source — which is the right rendering for "USFM" / "Gemini".
 *
 * A future English-only key that is *not* on this list fails the suite, so
 * new surfaces cannot silently ship unlocalized.
 */

const IDENTITY_LEAVES = new Set<string>([
  // Format / protocol / file-type labels shown as-is in every locale.
  "importExport.landing.tn.hint",
  "importExport.landing.biblica.hint",
  "importExport.landing.obs.hint",
  "importExport.landing.sdbh.hint",
  "importExport.landing.tm.hint",
  "importExport.landing.helloao.hint",
  "importExport.landing.spreadsheet.hint",
  "importExport.format.usfm.label",
  "importExport.format.md.label",
  "importExport.format.xlf.label",
  "importExport.format.tmx.label",
  "importExport.format.docx.label",
  "importExport.format.pptx.label",
  "importExport.format.sdbhXml.label",
  "importExport.idml.labelNative",
  "importExport.idml.labelBeta",
  "importExport.upload.formatsTranslation",
  "importExport.upload.formatsDocuments",
  "importExport.upload.formatsLocalization",
  "importExport.upload.formatsSubtitles",
  "importExport.helloao.apiLinkText",
  "importExport.ebible.corpusLinkText",
  "importExport.ebible.otBooks",
  "importExport.ebible.ntBooks",
  // Product / provider / catalog titles that are proper names.
  "autopilot.name",
  "billing.plan.field",
  "onboarding.checklist.aiProvider.frontierLabel",
  "onboarding.credits.rail.tts",
  "projectSettings.section.monday",
  "projectSettings.advancedLlm.providerFrontierName",
  "projectSettings.voice.studioLabel",
  "importExport.landing.gdrive.title",
  "importExport.landing.dcs.title",
  "importExport.landing.ebible.title",
  "importExport.landing.obs.title",
  "importExport.landing.helloao.title",
  "importExport.landing.badgeBeta",
  "importExport.dialog.titleHelloao",
  "importExport.sdbh.dictionaryName",
  "nav.beta.badge",
  // Tool identifiers shown in the agent run log.
  "agent.run.tool.sql",
  "agent.run.tool.stage",
  "agent.run.tool.docs",
  "agent.run.tool.read",
  "agent.run.tool.examples",
  "agent.run.tool.search",
  "agent.run.tool.draft",
  // Input-mask / example values that must stay machine-shaped.
  "common.datePlaceholder",
  "org.projectOverview.deadlineDatePlaceholder",
  "projectSettings.share.emailPlaceholder",
  "projectSettings.user.usernamePlaceholder",
  "projectSettings.advancedLlm.endpointPlaceholder",
  "projectSettings.advancedLlm.modelManualPlaceholderOpenRouter",
  "projectSettings.voice.geminiKeyPlaceholder",
  "projectSettings.validation.namedValidatorsPlaceholder",
  "settings.personalProvider.apiKeyPlaceholder",
  "workspace.orgStep.emailsPlaceholder",
  "workspace.typeahead.usernameModeLabel",
  // Structural templates that are only placeholders / units.
  "audio.recordingModal.lineCounter",
  "autopilot.graph.decision.phase",
  "autopilot.overview.startResult.outcome",
  "editor.row.editorAria",
  "importExport.dialog.formatOptionAriaLabel",
  "importExport.upload.idmlCountSuffix",
  "importExport.upload.idmlPhase",
  "onboarding.checklist.aiModels.downloadProgress",
  "onboarding.checklist.aiModels.sizeMb",
  "org.exportSettings.roleOptionPlain",
  "rules.infraction.withRuleName",
  "workspace.durationBar.overBy",
  "workspace.timelineCard.camLabel",
  // Loanwords that correctly match English in the locale that still needs them.
  "nav.lens.media",
  "editor.timeline.colorMagenta",
  "editor.timeline.trackAddFolder",
  "editor.timeline.videoPaneTitle",
  "importExport.dialog.audioSectionTitle",
  "projectSettings.advancedLlm.modelLabel",
  "projectSettings.gitSync.minutesAbbrev",
])

function hasValue(
  catalog: (typeof CATALOGS)[string],
  leaf: string,
): boolean {
  const { key, category } = parseLeafKey(leaf)
  const value = catalog[key as MessageKey]
  if (value === undefined) return false
  if (!isPluralMessage(value)) return true
  if (!category) return true
  return value.forms[category] !== undefined
}

function isStale(locale: string, leaf: string): boolean {
  const { key } = parseLeafKey(leaf)
  const hashes = (sourceHashes as Record<string, SourceHashes>)[locale] ?? {}
  const stored = hashes[key as MessageKey]
  return stored !== undefined && stored !== sourceHash(key as MessageKey)
}

const translatedLocales = LOCALES.filter((l) => l.code !== DEFAULT_LOCALE)

describe("shipping locale catalog completeness", () => {
  it.each(translatedLocales.map((l) => [l.code] as const))(
    "%s has a translation for every non-identity leaf",
    (code) => {
      const catalog = CATALOGS[code]
      expect(catalog, `no catalog registered for "${code}"`).toBeDefined()

      const missing: string[] = []
      const stale: string[] = []
      for (const leaf of catalogLeafKeys(code)) {
        if (IDENTITY_LEAVES.has(leaf)) continue
        if (!hasValue(catalog, leaf)) {
          missing.push(leaf)
          continue
        }
        if (isStale(code, leaf)) stale.push(leaf)
      }

      expect(missing, `${code} missing ${missing.length} leaf/leaves:\n${missing.join("\n")}`).toEqual(
        [],
      )
      expect(stale, `${code} stale ${stale.length} leaf/leaves:\n${stale.join("\n")}`).toEqual([])
    },
  )

  it("does not allowlist a leaf that English never defined", () => {
    const base = new Set<string>([
      ...catalogLeafKeys("en"),
      ...catalogLeafKeys("ar"),
    ])
    const unknown = [...IDENTITY_LEAVES].filter((leaf) => !base.has(leaf))
    expect(unknown, `IDENTITY_LEAVES has unknown leaves:\n${unknown.join("\n")}`).toEqual([])
  })

  it("keeps English as the only complete authored catalog", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key], `en is missing ${key}`).toBeDefined()
    }
  })
})
