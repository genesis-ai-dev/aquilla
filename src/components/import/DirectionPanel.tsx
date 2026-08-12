import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { languagesEqual } from "@/lib/language-normalize"

interface DirectionPanelProps {
  sourceLanguage: string
  targetLanguage: string
  onSourceChange: (v: string) => void
  onTargetChange: (v: string) => void
  onConfirm: () => void
  onSkip: () => void
  confirming?: boolean
  /** AQU-249: shown inline when onImported throws so the user can retry. */
  error?: string | null
}

/** One-time prompt shown after import when source==target or target is unset.
 *  The user enters source and target language so back-translation and QA rules
 *  operate against the correct language pair.
 *
 *  WARN c: both fields are editable — explicit user input always wins over the
 *  project's existing values (consistent with BLOCKER 1 explicit-wins fix). */
export function DirectionPanel({
  sourceLanguage,
  targetLanguage,
  onSourceChange,
  onTargetChange,
  onConfirm,
  onSkip,
  confirming = false,
  error = null,
}: DirectionPanelProps) {
  // WARN e: use normalizer so "French"=="fra" registers as same and blocks confirm.
  const targetTrimmed = targetLanguage.trim()
  const sourceTrimmed = sourceLanguage.trim()
  const confirmDisabled =
    confirming ||
    !targetTrimmed ||
    languagesEqual(targetTrimmed, sourceTrimmed)

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        We detected the source language from the imported project. Please confirm the
        source and set the target language so back-translation and QA rules work correctly.
      </p>
      <FieldGroup className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="dl-source">Source language</FieldLabel>
          <Input
            id="dl-source"
            value={sourceLanguage}
            onChange={(e) => onSourceChange(e.target.value)}
            placeholder="e.g. English, arb, hbo"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="dl-target">
            Target language <span className="text-destructive">*</span>
          </FieldLabel>
          <Input
            id="dl-target"
            value={targetLanguage}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder="e.g. Spanish, fra, swh"
            autoFocus
          />
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        You can change these later in <strong>Project Settings → Project Info</strong>.
      </p>
      {/* AQU-249: restore direction screen on failure so the user can retry */}
      {error && <FieldError role="alert">{error}</FieldError>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={confirming}>
          Skip for now
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirming ? "Setting…" : "Set direction"}
        </Button>
      </div>
    </div>
  )
}
