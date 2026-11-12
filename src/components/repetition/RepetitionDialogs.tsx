// AQU-1486 — the two questions a repeated-row validation may ask:
//
//  • choice:   "Validate the repeated rows too?" — after one row's validation
//              check, or before a bulk validation writes anything.
//  • conflict: in a bulk run, rows being validated share a source text but
//              hold different translations; which one do the other rows get?
//
// Both are controlled by `useRepetitionValidation`, which awaits the answer.
// Closing either one (Esc) is the cautious answer: "Just this row" (the
// repeats are still filled, as before AQU-1486) or "Skip" for a conflict.

import { useId, useRef, useState, type ReactNode } from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import type { RepetitionChoice } from "@/lib/workflow/repetition-validation"

export type RepetitionPrompt =
  | {
    kind: "choice"
    scope: "single" | "bulk"
    /** Rows outside what the user validated that would be validated too. */
    repeatCount: number
    /** Votes the batch validation size still allows; null = uncapped. */
    room: number | null
  }
  | {
    kind: "conflict"
    source: string
    /** Each distinct translation, with the names of the run's rows holding it. */
    candidates: Array<{ text: string; rows: string[] }>
    /** Rows outside the run that receive the chosen translation. */
    targetCount: number
    /** False on the run's last conflict — there is no "rest" to apply it to. */
    canApplyToRest: boolean
  }

export type RepetitionAnswer =
  | { kind: "choice"; choice: RepetitionChoice; remember: boolean }
  | { kind: "conflict"; pick: number | "skip"; applyToRest: boolean }

export function RepetitionDialogs({
  prompt,
  onAnswer,
}: {
  /** `id` re-keys the dialog so every question starts from fresh controls. */
  prompt: (RepetitionPrompt & { id: number }) | null
  onAnswer: (answer: RepetitionAnswer) => void
}) {
  if (!prompt) return null
  return prompt.kind === "choice"
    ? <ChoiceDialog key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
    : <ConflictDialog key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
}

function ChoiceDialog({
  prompt,
  onAnswer,
}: {
  prompt: Extract<RepetitionPrompt, { kind: "choice" }>
  onAnswer: (answer: RepetitionAnswer) => void
}) {
  const t = useT()
  const rememberId = useId()
  const [remember, setRemember] = useState(false)
  const answered = useRef(false)
  const answer = (choice: RepetitionChoice, keep: boolean) => {
    if (answered.current) return
    answered.current = true
    onAnswer({ kind: "choice", choice, remember: keep })
  }
  const validatable = prompt.room === null ? prompt.repeatCount : Math.min(prompt.room, prompt.repeatCount)
  const single = prompt.scope === "single"

  return (
    <AlertDialog
      open
      // Esc: the cautious answer, never remembered.
      onOpenChange={(open) => { if (!open) answer("one", false) }}
    >
      <AlertDialogContent data-testid="repetition-choice-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("editor.repetition.choiceTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(single ? "editor.repetition.choiceSingleBody" : "editor.repetition.choiceBulkBody", {
              count: prompt.repeatCount,
            })}
          </AlertDialogDescription>
          {validatable < prompt.repeatCount && (
            <p className="text-sm text-muted-foreground">
              {t("editor.repetition.choiceCapNote", { count: validatable })}
            </p>
          )}
        </AlertDialogHeader>
        <Field orientation="horizontal">
          <Checkbox
            id={rememberId}
            checked={remember}
            onCheckedChange={(value) => setRemember(value === true)}
          />
          <FieldContent>
            <FieldLabel htmlFor={rememberId}>{t("editor.repetition.dontAskAgain")}</FieldLabel>
            <FieldDescription>{t("editor.repetition.dontAskAgainHelp")}</FieldDescription>
          </FieldContent>
        </Field>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => answer("one", remember)}>
            {t(single ? "editor.repetition.justThisRow" : "editor.repetition.justTheseRows")}
          </Button>
          <AlertDialogAction autoFocus onClick={() => answer("all", remember)}>
            {t("editor.repetition.validateMore", { count: validatable })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const SKIP = "skip"

function ConflictDialog({
  prompt,
  onAnswer,
}: {
  prompt: Extract<RepetitionPrompt, { kind: "conflict" }>
  onAnswer: (answer: RepetitionAnswer) => void
}) {
  const t = useT()
  const { list: formatList } = useFormat()
  const applyId = useId()
  const [pick, setPick] = useState<string>("0")
  const [applyToRest, setApplyToRest] = useState(false)
  const answered = useRef(false)
  const answer = (value: number | "skip", rest: boolean) => {
    if (answered.current) return
    answered.current = true
    onAnswer({ kind: "conflict", pick: value, applyToRest: rest })
  }
  const last = prompt.candidates.length - 1
  const picked = pick === SKIP ? SKIP : Number(pick)
  // Only a positional pick (first, last) or Skip means anything for the next
  // disagreement, whose translations are different strings.
  const rememberable = picked === SKIP || picked === 0 || picked === last

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) answer(SKIP, false) }}>
      <AlertDialogContent data-testid="repetition-conflict-dialog" className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("editor.repetition.conflictTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("editor.repetition.conflictBody", { count: prompt.targetCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <blockquote className="line-clamp-3 border-l-2 pl-3 text-sm text-muted-foreground">
          {prompt.source}
        </blockquote>
        <RadioGroup value={pick} onValueChange={(value) => setPick(String(value))} className="gap-1">
          {prompt.candidates.map((candidate, index) => (
            <ConflictOption key={index} value={String(index)} selected={pick === String(index)}>
              <span className="line-clamp-3 text-sm">{candidate.text}</span>
              {candidate.rows.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("editor.repetition.conflictFrom", { rows: formatList(candidate.rows, { type: "conjunction" }) })}
                </span>
              )}
            </ConflictOption>
          ))}
          <ConflictOption value={SKIP} selected={pick === SKIP}>
            <span className="text-sm">{t("editor.repetition.conflictSkip")}</span>
          </ConflictOption>
        </RadioGroup>
        {prompt.canApplyToRest && (
          <Field orientation="horizontal" data-disabled={rememberable ? undefined : true}>
            <Checkbox
              id={applyId}
              checked={applyToRest && rememberable}
              disabled={!rememberable}
              onCheckedChange={(value) => setApplyToRest(value === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor={applyId}>{t("editor.repetition.conflictApplyToRest")}</FieldLabel>
              <FieldDescription>{t("editor.repetition.conflictApplyToRestHelp")}</FieldDescription>
            </FieldContent>
          </Field>
        )}
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => answer(picked, applyToRest && rememberable)}>
            {t("editor.repetition.conflictConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ConflictOption({
  value,
  selected,
  children,
}: {
  value: string
  selected: boolean
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
        selected ? "bg-muted/60" : "hover:bg-accent/40",
      )}
    >
      <RadioGroupItem value={value} className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
    </label>
  )
}
