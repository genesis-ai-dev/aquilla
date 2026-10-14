// The Language-profile rows after the quotation marks (AQU-1691): one
// collapsible row per slot, in plain language, each with one example. Most
// projects fill in only a few, so every row starts closed and says only
// whether it is set.
//
// Each row saves its own slot merged over the STORED profile, so a slot this
// version does not know survives every save, and saving one slot never wipes
// another.

import type { ReactNode } from "react"
import { SettingsBlock } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import {
  divineNamesDraft,
  divineNamesValue,
  joinList,
  kinTermsDraft,
  kinTermsValue,
  numberWordsDraft,
  numberWordsValue,
  pronounsDraft,
  pronounsValue,
  questionMarkersDraft,
  questionMarkersValue,
  splitList,
} from "@/lib/bible-data/language-profile-drafts"
import {
  HEADING_POLICIES,
  MEASURES_STRATEGIES,
  TEXTUAL_VARIANT_POLICIES,
  languageProfileSlotProblem,
  readLanguageProfile,
  type LanguageProfile,
  type LanguageProfileSlot,
} from "../../../../db/shared/language-profile"
import { ProfileSlotRow } from "./ProfileSlotRow"
import { profileSaveError } from "./save-error"
import {
  DivineNamesEditor,
  KinTermsEditor,
  ListEditor,
  NumberWordsEditor,
  PolicyEditor,
  PronounsEditor,
  QuestionMarkersEditor,
} from "./slot-editors"

export interface LanguageProfileSlotsProps {
  /** The stored `languageProfile`, as it is. */
  value: LanguageProfile | undefined
  canEdit: boolean
  disabledTooltip: ReactNode
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

type RowSlot = Exclude<LanguageProfileSlot, "quoteMarks">
type PolicySlot = "measures" | "textualVariants" | "headings"

const POLICIES: Readonly<Record<PolicySlot, { values: readonly string[]; labels: Readonly<Record<string, MessageKey>> }>> = {
  measures: {
    values: MEASURES_STRATEGIES,
    labels: {
      convert: "languageProfile.measures.convert",
      transliterate: "languageProfile.measures.transliterate",
      mixed: "languageProfile.measures.mixed",
    },
  },
  textualVariants: {
    values: TEXTUAL_VARIANT_POLICIES,
    labels: {
      omit: "languageProfile.textualVariants.omit",
      bracket: "languageProfile.textualVariants.bracket",
      footnote: "languageProfile.textualVariants.footnote",
    },
  },
  headings: {
    values: HEADING_POLICIES,
    labels: { none: "languageProfile.headings.none", pericope: "languageProfile.headings.pericope" },
  },
}

const COPY: Readonly<Record<RowSlot, { title: MessageKey; description: MessageKey; example: MessageKey }>> = {
  questionMarkers: {
    title: "languageProfile.questionMarkers.title",
    description: "languageProfile.questionMarkers.description",
    example: "languageProfile.questionMarkers.example",
  },
  pronouns: {
    title: "languageProfile.pronouns.title",
    description: "languageProfile.pronouns.description",
    example: "languageProfile.pronouns.example",
  },
  negators: {
    title: "languageProfile.negators.title",
    description: "languageProfile.negators.description",
    example: "languageProfile.negators.example",
  },
  numberWords: {
    title: "languageProfile.numberWords.title",
    description: "languageProfile.numberWords.description",
    example: "languageProfile.numberWords.example",
  },
  speechVerbs: {
    title: "languageProfile.speechVerbs.title",
    description: "languageProfile.speechVerbs.description",
    example: "languageProfile.speechVerbs.example",
  },
  kinTerms: {
    title: "languageProfile.kinTerms.title",
    description: "languageProfile.kinTerms.description",
    example: "languageProfile.kinTerms.example",
  },
  divineNames: {
    title: "languageProfile.divineNames.title",
    description: "languageProfile.divineNames.description",
    example: "languageProfile.divineNames.example",
  },
  measures: {
    title: "languageProfile.measures.title",
    description: "languageProfile.measures.description",
    example: "languageProfile.measures.example",
  },
  textualVariants: {
    title: "languageProfile.textualVariants.title",
    description: "languageProfile.textualVariants.description",
    example: "languageProfile.textualVariants.example",
  },
  headings: {
    title: "languageProfile.headings.title",
    description: "languageProfile.headings.description",
    example: "languageProfile.headings.example",
  },
}

const listDraft = (stored: unknown) =>
  joinList(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [])

const listValue = (draft: string) => {
  const items = splitList(draft)
  return items.length > 0 ? items : null
}

export function LanguageProfileSlots({ value, canEdit, disabledTooltip, patch }: LanguageProfileSlotsProps) {
  const t = useT()
  // The stored object as it is, unknown slots included: rows merge over this.
  const stored: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}
  const filled = readLanguageProfile(stored)

  // Everything a row needs except its draft conversions and its editor.
  const row = (slot: RowSlot) => ({
    slot,
    title: t(COPY[slot].title),
    description: t(COPY[slot].description),
    example: t(COPY[slot].example),
    stored: stored[slot],
    isSet: filled[slot] !== undefined,
    problem: (slotValue: unknown) => languageProfileSlotProblem(slot, slotValue),
    canEdit,
    disabledTooltip,
    onSave: async (slotValue: unknown) => {
      const { [slot]: _cleared, ...rest } = stored
      const next = slotValue === undefined ? rest : { ...stored, [slot]: slotValue }
      return profileSaveError(await patch({ languageProfile: next as LanguageProfile }), t)
    },
  })

  const policyRow = (slot: PolicySlot) => {
    const { values, labels } = POLICIES[slot]
    return (
      <ProfileSlotRow
        {...row(slot)}
        toDraft={(held) => (typeof held === "string" && values.includes(held) ? held : "unset")}
        toValue={(draft) => (draft === "unset" ? null : draft)}
      >
        {(draft, setDraft, disabled) => (
          <PolicyEditor id={`profile-${slot}`} label={t(COPY[slot].title)} draft={draft} setDraft={setDraft}
            disabled={disabled} options={values.map((v) => ({ value: v, label: t(labels[v]) }))} />
        )}
      </ProfileSlotRow>
    )
  }

  const listRow = (slot: "negators" | "speechVerbs") => (
    <ProfileSlotRow {...row(slot)} toDraft={listDraft} toValue={listValue}>
      {(draft, setDraft, disabled) => (
        <ListEditor id={`profile-${slot}`} label={t(COPY[slot].title)} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
    </ProfileSlotRow>
  )

  return (
    <>
      <SettingsBlock className="space-y-1">
        <p className="text-sm font-medium">{t("languageProfile.more.label")}</p>
        <p className="text-xs text-muted-foreground">{t("languageProfile.more.description")}</p>
      </SettingsBlock>
      <ProfileSlotRow {...row("questionMarkers")} toDraft={questionMarkersDraft} toValue={questionMarkersValue}>
        {(draft, setDraft, disabled) => <QuestionMarkersEditor draft={draft} setDraft={setDraft} disabled={disabled} />}
      </ProfileSlotRow>
      <ProfileSlotRow {...row("pronouns")} toDraft={pronounsDraft} toValue={pronounsValue}>
        {(draft, setDraft, disabled) => <PronounsEditor draft={draft} setDraft={setDraft} disabled={disabled} />}
      </ProfileSlotRow>
      {listRow("negators")}
      <ProfileSlotRow {...row("numberWords")} toDraft={numberWordsDraft} toValue={numberWordsValue}>
        {(draft, setDraft, disabled) => <NumberWordsEditor draft={draft} setDraft={setDraft} disabled={disabled} />}
      </ProfileSlotRow>
      {listRow("speechVerbs")}
      <ProfileSlotRow {...row("kinTerms")} toDraft={kinTermsDraft} toValue={kinTermsValue}>
        {(draft, setDraft, disabled) => <KinTermsEditor draft={draft} setDraft={setDraft} disabled={disabled} />}
      </ProfileSlotRow>
      <ProfileSlotRow {...row("divineNames")} toDraft={divineNamesDraft} toValue={divineNamesValue}>
        {(draft, setDraft, disabled) => <DivineNamesEditor draft={draft} setDraft={setDraft} disabled={disabled} />}
      </ProfileSlotRow>
      {policyRow("measures")}
      {policyRow("textualVariants")}
      {policyRow("headings")}
    </>
  )
}
