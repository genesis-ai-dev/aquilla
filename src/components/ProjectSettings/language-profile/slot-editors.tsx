// The fields of each Language-profile row (AQU-1691). Each editor shows a
// draft from src/lib/bible-data/language-profile-drafts.ts and reports every
// change; ProfileSlotRow owns the draft, the save and the status line.

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type {
  DivineNamesDraft,
  KinTermsDraft,
  NumberWordsDraft,
  PronounsDraft,
  QuestionMarkersDraft,
  TriState,
} from "@/lib/bible-data/language-profile-drafts"

export interface EditorProps<D> {
  draft: D
  setDraft: (next: D) => void
  disabled: boolean
}

// ── Building blocks ─────────────────────────────────────────────────────────

function TextField(props: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  multiline?: boolean
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={props.id} className="text-sm">{props.label}</label>
      {props.multiline ? (
        <Textarea
          id={props.id}
          value={props.value}
          rows={3}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          className="bg-background"
        />
      ) : (
        <Input
          id={props.id}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          className="bg-background"
        />
      )}
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  )
}

function Choice<V extends string>(props: {
  id: string
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  onChange: (value: V) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={props.id} className="text-sm">{props.label}</label>
      <Select
        items={props.options}
        disabled={props.disabled}
        value={props.value}
        onValueChange={(next) => {
          if (next !== null) props.onChange(next as V)
        }}
      >
        <SelectTrigger id={props.id} aria-label={props.label} className="w-72 max-w-full bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function useTriOptions(): { value: TriState; label: string }[] {
  const t = useT()
  return [
    { value: "unset", label: t("languageProfile.notSet") },
    { value: "yes", label: t("languageProfile.choice.yes") },
    { value: "no", label: t("languageProfile.choice.no") },
  ]
}

// ── Slot editors ────────────────────────────────────────────────────────────

export function QuestionMarkersEditor({ draft, setDraft, disabled }: EditorProps<QuestionMarkersDraft>) {
  const t = useT()
  return (
    <>
      <TextField
        id="profile-question-particles"
        label={t("languageProfile.questionMarkers.particles")}
        hint={t("languageProfile.listHint")}
        value={draft.particles}
        onChange={(particles) => setDraft({ ...draft, particles })}
        disabled={disabled}
      />
      <TextField
        id="profile-question-suffix"
        label={t("languageProfile.questionMarkers.suffix")}
        hint={t("languageProfile.listHint")}
        value={draft.suffix}
        onChange={(suffix) => setDraft({ ...draft, suffix })}
        disabled={disabled}
      />
    </>
  )
}

/** One editable list, e.g. the negative words or the speech verbs. */
export function ListEditor({ id, label, draft, setDraft, disabled }: EditorProps<string> & { id: string; label: string }) {
  const t = useT()
  return (
    <TextField id={id} label={label} hint={t("languageProfile.listHint")} value={draft} onChange={setDraft} disabled={disabled} />
  )
}

/** The pronoun fields that hold a typed list. */
type PronounListKey =
  | "singular"
  | "plural"
  | "inclusive"
  | "exclusive"
  | "dualForms"
  | "trialForms"
  | "paucalForms"
  | "thirdPersonForms"

const EXTRA_NUMBERS: readonly {
  flag: "dual" | "trial" | "paucal"
  forms: "dualForms" | "trialForms" | "paucalForms"
  label: MessageKey
  formsLabel: MessageKey
}[] = [
  { flag: "dual", forms: "dualForms", label: "languageProfile.pronouns.dual", formsLabel: "languageProfile.pronouns.dualForms" },
  { flag: "trial", forms: "trialForms", label: "languageProfile.pronouns.trial", formsLabel: "languageProfile.pronouns.trialForms" },
  { flag: "paucal", forms: "paucalForms", label: "languageProfile.pronouns.paucal", formsLabel: "languageProfile.pronouns.paucalForms" },
]

export function PronounsEditor({ draft, setDraft, disabled }: EditorProps<PronounsDraft>) {
  const t = useT()
  const tri = useTriOptions()
  const set = (patch: Partial<PronounsDraft>) => setDraft({ ...draft, ...patch })
  const setFlag = (flag: "dual" | "trial" | "paucal", value: boolean) => {
    const next = { ...draft }
    next[flag] = value
    setDraft(next)
  }
  const list = (id: string, label: MessageKey, key: PronounListKey) => (
    <TextField
      id={id}
      label={t(label)}
      hint={t("languageProfile.listHint")}
      value={draft[key]}
      onChange={(value) => {
        const next = { ...draft }
        next[key] = value
        setDraft(next)
      }}
      disabled={disabled}
    />
  )
  return (
    <>
      <Choice id="profile-pronouns-second" label={t("languageProfile.pronouns.secondPerson")} value={draft.secondPerson}
        options={tri} onChange={(secondPerson) => set({ secondPerson })} disabled={disabled} />
      {draft.secondPerson === "yes" ? (
        <>
          {list("profile-pronouns-singular", "languageProfile.pronouns.singular", "singular")}
          {list("profile-pronouns-plural", "languageProfile.pronouns.plural", "plural")}
        </>
      ) : null}
      <Choice id="profile-pronouns-first-plural" label={t("languageProfile.pronouns.firstPersonPlural")}
        value={draft.firstPersonPlural} options={tri} onChange={(firstPersonPlural) => set({ firstPersonPlural })}
        disabled={disabled} />
      {draft.firstPersonPlural === "yes" ? (
        <>
          {list("profile-pronouns-inclusive", "languageProfile.pronouns.inclusive", "inclusive")}
          {list("profile-pronouns-exclusive", "languageProfile.pronouns.exclusive", "exclusive")}
        </>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm">{t("languageProfile.pronouns.extraNumbers")}</legend>
        <div className="flex flex-wrap gap-4">
          {EXTRA_NUMBERS.map(({ flag, label }) => (
            <span key={flag} className="flex items-center gap-2 text-sm">
              <Checkbox id={`profile-pronouns-${flag}`} checked={draft[flag]} disabled={disabled}
                onCheckedChange={(checked) => setFlag(flag, checked === true)} />
              <label htmlFor={`profile-pronouns-${flag}`}>{t(label)}</label>
            </span>
          ))}
        </div>
        {EXTRA_NUMBERS.filter(({ flag }) => draft[flag]).map(({ flag, forms, formsLabel }) => (
          <div key={flag}>{list(`profile-pronouns-${forms}`, formsLabel, forms)}</div>
        ))}
      </fieldset>
      <Choice id="profile-pronouns-third" label={t("languageProfile.pronouns.thirdPerson")} value={draft.thirdPerson}
        options={tri} onChange={(thirdPerson) => set({ thirdPerson })} disabled={disabled} />
      {draft.thirdPerson === "yes"
        ? list("profile-pronouns-third-forms", "languageProfile.pronouns.thirdPersonForms", "thirdPersonForms")
        : null}
      <TextField id="profile-pronouns-honorifics" label={t("languageProfile.pronouns.honorifics")}
        hint={t("languageProfile.pronouns.honorificsHint")} value={draft.honorifics}
        onChange={(honorifics) => set({ honorifics })} disabled={disabled} multiline />
    </>
  )
}

export function NumberWordsEditor({ draft, setDraft, disabled }: EditorProps<NumberWordsDraft>) {
  const t = useT()
  const options: { value: NumberWordsDraft["mode"]; label: string }[] = [
    { value: "unset", label: t("languageProfile.notSet") },
    { value: "cldr", label: t("languageProfile.numberWords.cldr") },
    { value: "explicit", label: t("languageProfile.numberWords.explicit") },
  ]
  return (
    <>
      <Choice id="profile-number-words-source" label={t("languageProfile.numberWords.source")} value={draft.mode}
        options={options} onChange={(mode) => setDraft({ ...draft, mode })} disabled={disabled} />
      {draft.mode === "explicit" ? (
        <TextField id="profile-number-words" label={t("languageProfile.numberWords.words")}
          hint={t("languageProfile.numberWords.wordsHint")} value={draft.words}
          onChange={(words) => setDraft({ ...draft, words })} disabled={disabled} multiline />
      ) : null}
    </>
  )
}

export function KinTermsEditor({ draft, setDraft, disabled }: EditorProps<KinTermsDraft>) {
  const t = useT()
  const tri = useTriOptions()
  return (
    <>
      <Choice id="profile-kin-relative-age" label={t("languageProfile.kinTerms.relativeAge")} value={draft.relativeAge}
        options={tri} onChange={(relativeAge) => setDraft({ ...draft, relativeAge })} disabled={disabled} />
      <TextField id="profile-kin-notes" label={t("languageProfile.kinTerms.notes")} value={draft.notes}
        onChange={(notes) => setDraft({ ...draft, notes })} disabled={disabled} multiline />
    </>
  )
}

export function DivineNamesEditor({ draft, setDraft, disabled }: EditorProps<DivineNamesDraft>) {
  const t = useT()
  const tri = useTriOptions()
  const fields: { key: "yhwh" | "kyriosGod" | "kyriosJesus"; label: MessageKey }[] = [
    { key: "yhwh", label: "languageProfile.divineNames.yhwh" },
    { key: "kyriosGod", label: "languageProfile.divineNames.kyriosGod" },
    { key: "kyriosJesus", label: "languageProfile.divineNames.kyriosJesus" },
  ]
  return (
    <>
      {fields.map(({ key, label }) => (
        <TextField key={key} id={`profile-divine-${key}`} label={t(label)} value={draft[key]}
          onChange={(value) => {
            const next = { ...draft }
            next[key] = value
            setDraft(next)
          }}
          disabled={disabled} />
      ))}
      <Choice id="profile-divine-capitalization" label={t("languageProfile.divineNames.capitalization")}
        value={draft.capitalization} options={tri}
        onChange={(capitalization) => setDraft({ ...draft, capitalization })} disabled={disabled} />
    </>
  )
}

/** A one-choice policy: measures, textual variants or headings. "unset" is not set. */
export function PolicyEditor({
  id,
  label,
  options,
  draft,
  setDraft,
  disabled,
}: EditorProps<string> & { id: string; label: string; options: readonly { value: string; label: string }[] }) {
  const t = useT()
  return (
    <Choice id={id} label={label} value={draft} options={[{ value: "unset", label: t("languageProfile.notSet") }, ...options]}
      onChange={setDraft} disabled={disabled} />
  )
}
