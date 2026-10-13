// Catalog keys for the Bible data registry (AQU-1686).
//
// The registry itself (db/shared/bible-enrichments.ts) is shared with the
// workers, so it carries ids and no UI words. These typed tables are the only
// way an id becomes text: a new id fails to compile until it has keys here.

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { BibleDataSourceId, BibleEnrichmentId } from "../../../db/shared/bible-enrichments"

export const BIBLE_ENRICHMENT_LABEL_KEYS: Readonly<Record<BibleEnrichmentId, MessageKey>> = {
  voices: "bibleData.enrichment.voices.label",
  "whos-who": "bibleData.enrichment.whosWho.label",
  structure: "bibleData.enrichment.structure.label",
  "original-context": "bibleData.enrichment.originalContext.label",
  helps: "bibleData.enrichment.helps.label",
  terms: "bibleData.enrichment.terms.label",
  places: "bibleData.enrichment.places.label",
  checks: "bibleData.enrichment.checks.label",
  autopilot: "bibleData.enrichment.autopilot.label",
}

export const BIBLE_ENRICHMENT_DESCRIPTION_KEYS: Readonly<Record<BibleEnrichmentId, MessageKey>> = {
  voices: "bibleData.enrichment.voices.description",
  "whos-who": "bibleData.enrichment.whosWho.description",
  structure: "bibleData.enrichment.structure.description",
  "original-context": "bibleData.enrichment.originalContext.description",
  helps: "bibleData.enrichment.helps.description",
  terms: "bibleData.enrichment.terms.description",
  places: "bibleData.enrichment.places.description",
  checks: "bibleData.enrichment.checks.description",
  autopilot: "bibleData.enrichment.autopilot.description",
}

/** Full dataset names, for the Data sources dialog. */
export const BIBLE_DATA_SOURCE_NAME_KEYS: Readonly<Record<BibleDataSourceId, MessageKey>> = {
  macula: "bibleData.source.macula.name",
  opentext: "bibleData.source.opentext.name",
  "speaker-quotations": "bibleData.source.speakerQuotations.name",
  acai: "bibleData.source.acai.name",
  unfoldingword: "bibleData.source.unfoldingword.name",
}

/** Short dataset names, for the source/license chip on each row. */
export const BIBLE_DATA_SOURCE_SHORT_NAME_KEYS: Readonly<Record<BibleDataSourceId, MessageKey>> = {
  macula: "bibleData.source.macula.short",
  opentext: "bibleData.source.opentext.short",
  "speaker-quotations": "bibleData.source.speakerQuotations.short",
  acai: "bibleData.source.acai.short",
  unfoldingword: "bibleData.source.unfoldingword.short",
}
