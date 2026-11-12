// Render a check-pack-B finding (AQU-1699): the sentence its params pick and
// its evidence lines. ./check-messages.ts calls these for the pack-B reasons
// and evidence kinds. Names, refs, word numbers and decision keys are data and
// are only interpolated; "singular", "inclusive" and "dual" choose a sentence,
// they are never shown.

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"

type Params = Readonly<Record<string, string>>

/** The sentence for a pack-B reason, chosen by its params; null for any other reason. */
export function packBReasonKey(params: Params): MessageKey | null {
  const plural = params.number === "plural"
  const inclusive = params.clusivity === "inclusive"
  switch (params.kind) {
    case "name-missing":
      return params.pronounOk === "true" ? "bibleParticipants.reason.nameMissingPronoun" : "bibleParticipants.reason.nameMissing"
    case "name-variant-different":
      return "bibleParticipants.reason.nameVariantDifferent"
    case "name-variant-none":
      return "bibleParticipants.reason.nameVariantNone"
    case "homonym-name":
      return "bibleParticipants.reason.homonymName"
    case "name-form-missing":
      return "bibleParticipants.reason.nameFormMissing"
    case "name-not-in-source":
      return "bibleParticipants.reason.nameNotInSource"
    case "subject-name-wrong":
      return "bibleParticipants.reason.subjectNameWrong"
    case "you-number-missing":
      return plural ? "bibleParticipants.reason.youPluralMissing" : "bibleParticipants.reason.youSingularMissing"
    case "you-number-wrong":
      return plural ? "bibleParticipants.reason.youPluralWrong" : "bibleParticipants.reason.youSingularWrong"
    case "clusivity-missing":
      return inclusive ? "bibleParticipants.reason.inclusiveMissing" : "bibleParticipants.reason.exclusiveMissing"
    case "clusivity-wrong":
      return inclusive ? "bibleParticipants.reason.inclusiveWrong" : "bibleParticipants.reason.exclusiveWrong"
    case "group-number-missing":
      return params.number === "dual"
        ? "bibleParticipants.reason.dualMissing"
        : params.number === "trial"
          ? "bibleParticipants.reason.trialMissing"
          : "bibleParticipants.reason.paucalMissing"
    case "divine-name-missing":
      return params.divine === "kyrios-jesus"
        ? "bibleParticipants.reason.kyriosJesusMissing"
        : params.divine === "kyrios-god"
          ? "bibleParticipants.reason.kyriosGodMissing"
          : "bibleParticipants.reason.holySpiritMissing"
    case "divine-name-swapped":
      return params.divine === "kyrios-jesus"
        ? "bibleParticipants.reason.kyriosJesusSwapped"
        : "bibleParticipants.reason.kyriosGodSwapped"
    case "deity-pronoun-lowercase":
      return "bibleParticipants.reason.deityPronounLowercase"
    case "quotation-differs":
      return "bibleParticipants.reason.quotationDiffers"
    default:
      return null
  }
}

/** Where the agreed name in the finding comes from: a decision (its key) or the terminology. */
function nameSourceLines(params: Params, t: TFunction): string[] {
  if (params.nameSource === "fact") return [t("bibleParticipants.evidence.fromDecision", { key: params.nameFrom ?? "" })]
  if (params.nameSource === "terminology" || params.nameSource === "acai") return [t("bibleParticipants.evidence.fromTerminology")]
  return []
}

/** The evidence lines of a pack-B finding; empty for any other evidence kind. `refs` is already a localized list. */
export function packBEvidenceLines(params: Params, t: TFunction, refs: string): string[] {
  const acai = t("bibleData.source.acai.short")
  const macula = t("bibleData.source.macula.short")
  const ref = (params.refs ?? "").split(",")[0] ?? ""
  const word = params.word ?? ""
  switch (params.evidence) {
    case "mention":
      return [
        params.mention === "subject"
          ? t("bibleParticipants.evidence.mentionSubject", { dataset: macula, ref, word, name: params.name ?? "" })
          : t("bibleParticipants.evidence.mention", { dataset: acai, ref, word, name: params.name ?? "" }),
        ...nameSourceLines(params, t),
      ]
    case "no-mention":
      return [t("bibleParticipants.evidence.noMention", { dataset: acai, refs, name: params.name ?? "" })]
    case "second-person":
      return [
        t(params.number === "plural" ? "bibleParticipants.evidence.secondPersonPlural" : "bibleParticipants.evidence.secondPersonSingular", {
          dataset: macula,
          refs,
        }),
      ]
    case "clusivity":
      return [
        t("bibleParticipants.evidence.clusivity", {
          dataset: acai,
          ref,
          word,
          referents: params.referents ?? "",
          addressees: params.addressees ?? "",
        }),
      ]
    case "decision":
      return [t("bibleParticipants.evidence.decision", { key: params.decision ?? "" })]
    case "group":
      return [t("bibleParticipants.evidence.group", { dataset: acai, ref, word, name: params.name ?? "", size: params.size ?? "" })]
    case "divine-name":
      return [t("bibleParticipants.evidence.divineName", { dataset: macula, ref, word })]
    case "alignment":
      return [t("bibleParticipants.evidence.alignment", { refs })]
    case "name-variants":
      return [t("bibleParticipants.evidence.nameVariants", { dataset: acai, refs, name: params.name ?? "" })]
    case "repeated-quotation":
      return [
        t("bibleParticipants.evidence.repeatedQuotation", {
          dataset: t("bibleData.source.opentext.short"),
          refs,
          other: params.other ?? "",
        }),
      ]
    default:
      return []
  }
}
