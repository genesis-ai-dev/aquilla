// Render a Bible data check finding (AQU-1688).
//
// The rule engine keeps a finding as codes: `builtin:bkp:V2` plus
// `reasonParams` (src/lib/rules/bible-check-rules.ts). These turn that into
// the localized explanation and the evidence line. Refs, word numbers and
// quotation marks are data and are only interpolated.

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { LocaleFormatters } from "@/lib/i18n/format"
import type { RuleInfraction } from "@/lib/parsers/types"
import type { BibleCheckReason } from "../../../db/shared/bible-checks/types"
import { packBEvidenceLines, packBReasonKey } from "./check-messages-pack-b"

const REASON_KEY: Readonly<Record<BibleCheckReason, MessageKey>> = {
  "open-missing": "bibleData.check.reason.openMissing",
  "close-missing": "bibleData.check.reason.closeMissing",
  "close-after-aside": "bibleData.check.reason.closeAfterAside",
  "close-in-continuing-speech": "bibleData.check.reason.closeInContinuingSpeech",
  "wrong-level-marks": "bibleData.check.reason.wrongLevelMarks",
  "marks-without-speech": "bibleData.check.reason.marksWithoutSpeech",
  "interruption-not-marked": "bibleData.check.reason.interruptionNotMarked",
  "self-projection-adds-level": "bibleData.check.reason.selfProjectionAddsLevel",
  "question-mark-missing": "bibleData.check.reason.questionMarkMissing",
  // AQU-1697: check pack A.
  "number-missing": "bibleChecks.reason.numberMissing",
  "ordinal-missing": "bibleChecks.reason.ordinalMissing",
  "negation-missing": "bibleChecks.reason.negationMissing",
  "negation-fewer": "bibleChecks.reason.negationFewer",
  "sentence-ends-early": "bibleChecks.reason.sentenceEndsEarly",
  "variant-not-omitted": "bibleChecks.reason.variantNotOmitted",
  "variant-not-bracketed": "bibleChecks.reason.variantNotBracketed",
  "variant-no-footnote": "bibleChecks.reason.variantNoFootnote",
  "heading-missing": "bibleChecks.reason.headingMissing",
  "heading-inside-pericope": "bibleChecks.reason.headingInsidePericope",
  "verse-not-in-pack": "bibleChecks.reason.verseNotInPack",
  "pack-verse-without-cell": "bibleChecks.reason.packVerseWithoutCell",
  // AQU-1699: check pack B. Several pick their sentence by params (./check-messages-pack-b.ts).
  "name-missing": "bibleParticipants.reason.nameMissing",
  "name-variant-different": "bibleParticipants.reason.nameVariantDifferent",
  "name-variant-none": "bibleParticipants.reason.nameVariantNone",
  "homonym-name": "bibleParticipants.reason.homonymName",
  "name-form-missing": "bibleParticipants.reason.nameFormMissing",
  "name-not-in-source": "bibleParticipants.reason.nameNotInSource",
  "subject-name-wrong": "bibleParticipants.reason.subjectNameWrong",
  "you-number-missing": "bibleParticipants.reason.youSingularMissing",
  "you-number-wrong": "bibleParticipants.reason.youSingularWrong",
  "clusivity-missing": "bibleParticipants.reason.exclusiveMissing",
  "clusivity-wrong": "bibleParticipants.reason.exclusiveWrong",
  "group-number-missing": "bibleParticipants.reason.paucalMissing",
  "divine-name-missing": "bibleParticipants.reason.kyriosJesusMissing",
  "divine-name-swapped": "bibleParticipants.reason.kyriosJesusSwapped",
  "deity-pronoun-lowercase": "bibleParticipants.reason.deityPronounLowercase",
  "quotation-differs": "bibleParticipants.reason.quotationDiffers",
}

/** N1 says what it could read (`accepts`): digits only with standard number words, or a number the profile has no word for. */
const NUMBER_MISSING_KEY: Readonly<Record<string, MessageKey>> = {
  digits: "bibleChecks.reason.numberMissingDigitsOnly",
  "digits-unlisted-word": "bibleChecks.reason.numberMissingUnlisted",
}

/** The pack's speaker-evidence source ids (bible-wiki pipeline/src/bkp/README.md), by dataset name. */
const SPEAKER_SOURCE_KEY: Readonly<Record<string, MessageKey>> = {
  fcbh: "bibleData.source.speakerQuotations.name",
  macula: "bibleData.source.macula.short",
  "macula-1p": "bibleData.source.macula.short",
}

export function isBibleCheckInfraction(infraction: Pick<RuleInfraction, "reason">): boolean {
  return infraction.reason.startsWith("builtin:bkp:")
}

function isReason(value: string | undefined): value is BibleCheckReason {
  return value !== undefined && Object.hasOwn(REASON_KEY, value)
}

const refList = (raw: string | undefined) => (raw ?? "").split(",").filter(Boolean).join(", ")

/** The one-sentence explanation of a Bible data finding. */
export function formatBibleCheckReason(infraction: RuleInfraction, t: TFunction): string {
  const params = infraction.reasonParams ?? {}
  if (!isReason(params.kind)) return infraction.reason
  const numberKey =
    params.kind === "number-missing" && Object.hasOwn(NUMBER_MISSING_KEY, params.accepts ?? "")
      ? NUMBER_MISSING_KEY[params.accepts ?? ""]
      : undefined
  return t(numberKey ?? packBReasonKey(params) ?? REASON_KEY[params.kind], {
    level: params.level ?? "1",
    open: params.open ?? "",
    close: params.close ?? "",
    value: params.value ?? "",
    found: params.found ?? "",
    expected: params.expected ?? "",
    passage: params.passage ?? "",
    title: params.title ?? "",
    refs: refList(params.refs),
    // AQU-1699: check pack B.
    name: params.name ?? "",
    renderings: params.renderings ?? "",
    rendering: params.rendering ?? "",
    usual: params.usual ?? "",
    other: params.other ?? "",
    form: params.form ?? "",
    similarity: params.similarity ?? "",
  })
}

type EvidenceFormat = Pick<LocaleFormatters, "list" | "percent">

function speakerSources(raw: string | undefined, t: TFunction): string[] {
  const names: string[] = []
  for (const id of (raw ?? "").split(",").filter(Boolean)) {
    const name = Object.hasOwn(SPEAKER_SOURCE_KEY, id) ? t(SPEAKER_SOURCE_KEY[id]) : id
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Where the finding's fact comes from, e.g. "OpenText speech JHN 4:9 words
 * 8–18; speaker from Clear speaker-quotations (confidence 97%)". A second
 * line says when the cell holds only part of a split verse. Empty for any
 * other infraction.
 */
export function formatBibleCheckEvidence(infraction: RuleInfraction, t: TFunction, format: EvidenceFormat): string[] {
  if (!isBibleCheckInfraction(infraction)) return []
  const params = infraction.reasonParams ?? {}
  const lines: string[] = []
  const refs = format.list((params.refs ?? "").split(",").filter(Boolean))
  if (params.evidence === "speech") {
    const dataset = t("bibleData.source.opentext.short")
    const sources = speakerSources(params.speakerSources, t)
    const sameVerse = params.startRef === params.endRef
    const where: Record<string, string> = sameVerse
      ? { dataset, ref: params.startRef ?? "", from: params.startWord ?? "", to: params.endWord ?? "" }
      : {
          dataset,
          startRef: params.startRef ?? "",
          from: params.startWord ?? "",
          endRef: params.endRef ?? "",
          to: params.endWord ?? "",
        }
    if (sources.length === 0) {
      lines.push(
        t(sameVerse ? "bibleData.check.evidence.speechNoSpeaker" : "bibleData.check.evidence.speechAcrossVersesNoSpeaker", where),
      )
    } else {
      const speaker = { sources: format.list(sources), confidence: format.percent(Number(params.speakerConf ?? 0)) }
      lines.push(
        t(sameVerse ? "bibleData.check.evidence.speech" : "bibleData.check.evidence.speechAcrossVerses", {
          ...where,
          ...speaker,
        }),
      )
    }
  } else if (params.evidence === "no-speech") {
    lines.push(t("bibleData.check.evidence.noSpeech", { dataset: t("bibleData.source.opentext.short"), refs }))
  } else if (params.evidence === "question") {
    lines.push(t("bibleData.check.evidence.question", { dataset: t("bibleData.source.macula.short"), refs }))
  } else {
    lines.push(...packAEvidence(infraction, t, refs), ...packBEvidenceLines(params, t, refs))
  }
  if (params.approximate === "true") lines.push(t("bibleData.check.evidence.approximate"))
  return lines
}

/** AQU-1697: the evidence lines of check pack A's findings. */
function packAEvidence(infraction: RuleInfraction, t: TFunction, refs: string): string[] {
  const params = infraction.reasonParams ?? {}
  const macula = t("bibleData.source.macula.short")
  const opentext = t("bibleData.source.opentext.short")
  switch (params.evidence) {
    case "number": {
      const where = { dataset: macula, ref: refs, from: params.startWord ?? "", to: params.endWord ?? "" }
      const lines = [
        t(params.startWord === params.endWord ? "bibleChecks.evidence.numberWord" : "bibleChecks.evidence.number", where),
      ]
      if (params.about === "true") lines.push(t("bibleChecks.evidence.about"))
      if (params.indefinite === "true") lines.push(t("bibleChecks.evidence.indefinite"))
      return lines
    }
    case "negation":
      return [t("bibleChecks.evidence.negation", { dataset: macula, refs })]
    case "move":
      return [t("bibleChecks.evidence.move", { dataset: opentext, refs })]
    case "variant":
      return [
        t(infraction.reason === "builtin:bkp:S7" ? "bibleChecks.evidence.disputedPassage" : "bibleChecks.evidence.absentVerse", {
          passage: params.passage ?? "",
        }),
      ]
    case "pericope":
      return [
        t(params.kind === "heading-inside-pericope" ? "bibleChecks.evidence.pericopeInside" : "bibleChecks.evidence.pericope", {
          dataset: opentext,
          title: params.title ?? "",
          refs,
        }),
      ]
    default:
      return []
  }
}
