// The fields of each Language-profile row (AQU-1691). Each editor shows a
// draft from src/lib/bible-data/language-profile-drafts.ts and reports every
// change; ProfileSlotRow owns the draft, the save and the status line.

import { Button } from "@/components/ui/button"
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
import { downloadBlob } from "@/lib/export/export-service"
import type { OrthographyException } from "../../../../db/shared/orthography"
import {
  NUMBER_FORMAT_ROLES,
  PUNCTUATION_MARK_CLASSES,
  orthographyExceptionsCsv,
  type DivineNamesDraft,
  type KinTermsDraft,
  type NumberFormatDraft,
  type NumberWordsDraft,
  type OrthographyDraft,
  type PronounsDraft,
  type PunctuationDraft,
  type PunctuationMarkClass,
  type QuestionMarkersDraft,
  type TriState,
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

/** AQU-1906: one field per mark class, plus "sentences end with no mark". */
const PUNCTUATION_LABELS: Readonly<Record<PunctuationMarkClass, MessageKey>> = {
  question: "languageProfile.punctuation.question",
  exclamation: "languageProfile.punctuation.exclamation",
  statement: "languageProfile.punctuation.statement",
  colon: "languageProfile.punctuation.colon",
  semicolon: "languageProfile.punctuation.semicolon",
}

export function PunctuationEditor({ draft, setDraft, disabled }: EditorProps<PunctuationDraft>) {
  const t = useT()
  const tri = useTriOptions()
  return (
    <>
      {PUNCTUATION_MARK_CLASSES.map((markClass) => (
        <TextField
          key={markClass}
          id={`profile-punctuation-${markClass}`}
          label={t(PUNCTUATION_LABELS[markClass])}
          hint={t("languageProfile.punctuation.marksHint")}
          value={draft[markClass]}
          onChange={(value) => setDraft({ ...draft, [markClass]: value })}
          disabled={disabled}
        />
      ))}
      <Choice
        id="profile-punctuation-no-terminal"
        label={t("languageProfile.punctuation.noTerminalMark")}
        value={draft.noTerminalMark}
        options={tri}
        onChange={(noTerminalMark) => setDraft({ ...draft, noTerminalMark })}
        disabled={disabled}
      />
    </>
  )
}

/** AQU-2430: one field per number-format role, each holding its character. */
const NUMBER_FORMAT_LABELS: Readonly<Record<(typeof NUMBER_FORMAT_ROLES)[number], MessageKey>> = {
  group: "languageProfile.numberFormat.group",
  decimal: "languageProfile.numberFormat.decimal",
}

export function NumberFormatEditor({ draft, setDraft, disabled }: EditorProps<NumberFormatDraft>) {
  const t = useT()
  return (
    <>
      {NUMBER_FORMAT_ROLES.map((role) => (
        <TextField
          key={role}
          id={`profile-number-format-${role}`}
          label={t(NUMBER_FORMAT_LABELS[role])}
          hint={t("languageProfile.numberFormat.hint")}
          value={draft[role]}
          onChange={(value) => setDraft({ ...draft, [role]: value })}
          disabled={disabled}
        />
      ))}
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

/**
 * AQU-2628: the orthography row — the rules, the canonical apostrophe and the
 * exception list in one place, because they are one decision.
 *
 * The exception list is the part that needs more than a text box: each entry
 * carries who proposed it and where they found it, and a maintainer approves
 * or rejects it here. A contributor's proposal is inert until then, so the
 * list is also the queue.
 */
export function OrthographyEditor({ draft, setDraft, disabled }: EditorProps<OrthographyDraft>) {
  const t = useT()
  const setStatus = (index: number, status: OrthographyException["status"]) =>
    setDraft({
      ...draft,
      exceptions: draft.exceptions.map((entry, i) => (i === index ? { ...entry, status } : entry)),
    })
  const remove = (index: number) =>
    setDraft({ ...draft, exceptions: draft.exceptions.filter((_, i) => i !== index) })

  return (
    <>
      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="profile-orthography-rules">
          {t("languageProfile.orthography.rules")}
        </label>
        <Textarea
          id="profile-orthography-rules"
          rows={4}
          className="font-mono text-sm"
          value={draft.rules}
          onChange={(event) => setDraft({ ...draft, rules: event.target.value })}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">{t("languageProfile.orthography.rulesHint")}</p>
      </div>
      <TextField
        id="profile-orthography-apostrophe"
        label={t("languageProfile.orthography.apostrophe")}
        hint={t("languageProfile.orthography.apostropheHint")}
        value={draft.apostrophe}
        onChange={(apostrophe) => setDraft({ ...draft, apostrophe })}
        disabled={disabled}
      />
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("languageProfile.orthography.exceptions")}</p>
        {draft.exceptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("languageProfile.orthography.exceptionsEmpty")}</p>
        ) : (
          <ul className="divide-y rounded border" data-testid="orthography-exceptions">
            {draft.exceptions.map((entry, index) => (
              <li key={`${entry.word}-${index}`} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <span className="font-mono">{entry.word}</span>
                <span
                  className={
                    entry.status === "pending"
                      ? "rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "rounded bg-muted px-1.5 text-xs text-muted-foreground"
                  }
                >
                  {t(
                    entry.status === "pending"
                      ? "languageProfile.orthography.pending"
                      : "languageProfile.orthography.approved",
                  )}
                </span>
                {entry.ref ? <span className="text-xs text-muted-foreground">{entry.ref}</span> : null}
                <span className="ms-auto flex gap-1">
                  {entry.status === "pending" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setStatus(index, "approved")}
                    >
                      {t("languageProfile.orthography.approve")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => remove(index)}
                  >
                    {t("languageProfile.orthography.reject")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          id="profile-orthography-add"
          rows={3}
          placeholder={t("languageProfile.orthography.addPlaceholder")}
          value={draft.added}
          onChange={(event) => setDraft({ ...draft, added: event.target.value })}
          disabled={disabled}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("languageProfile.orthography.addHint")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.exceptions.length === 0}
            onClick={() =>
              downloadBlob(
                new Blob([orthographyExceptionsCsv(draft.exceptions)], { type: "text/csv;charset=utf-8" }),
                "orthography-exceptions.csv",
              )
            }
          >
            {t("languageProfile.orthography.exportCsv")}
          </Button>
        </div>
      </div>
    </>
  )
}
