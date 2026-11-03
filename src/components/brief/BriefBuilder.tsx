// src/components/brief/BriefBuilder.tsx
import { useState } from "react"
import { BRIEF_FIELDS } from "@/lib/brief/schema"
import type { TranslationBrief } from "@/lib/brief/types"
import type { BriefDraft } from "@/hooks/useTranslationBrief"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { cn } from "@/lib/utils"

/** The freeform-notes step sits one slot past the last interview field. */
const NOTES_STEP = BRIEF_FIELDS.length

// Only one field is on screen at a time, so a constant id per slot is enough
// to wire its <label> and helper text. Single-instance dialog.
const FIELD_INPUT_ID = "brief-field-input"
const FIELD_HELP_ID = "brief-field-help"
const NOTES_INPUT_ID = "brief-notes-input"

interface BriefNavSection {
  /** Wizard step this section occupies — the nav and Back/Next share one space. */
  step: number
  labelKey: MessageKey
}

/**
 * The brief's jumpable sections, in interview order: one per schema field, then
 * the notes step. AQU-2347 — the brief is a document, so every part of it must
 * be reachable in one click instead of only through Back/Next.
 */
const BRIEF_SECTIONS: readonly BriefNavSection[] = [
  ...BRIEF_FIELDS.map((f, index) => ({ step: index, labelKey: f.labelKey })),
  { step: NOTES_STEP, labelKey: "agent.brief.notesStepLabel" },
]

export interface BriefBuilderProps {
  open: boolean
  brief: TranslationBrief
  canEdit: boolean
  onSaveDraft: (draft: BriefDraft) => Promise<TranslationBrief | undefined>
  /**
   * Save the draft and generate its L1 summary. Resolves `true` when a summary
   * was generated (the dialog then closes), `false` when it wasn't — e.g. no
   * AI provider is configured, or the LLM call failed. The handler is
   * responsible for surfacing that outcome to the user (AQU-968).
   */
  onGenerateL1: (draft: BriefDraft) => Promise<boolean>
  onClose: () => void
  /** Optional: per-field LLM draft helper. Absent → "Help me write this" hidden. */
  onHelpDraft?: (fieldId: string, draft: BriefDraft) => Promise<string>
  /** Optional: document pre-fill. Absent → upload step hidden. */
  onExtractDocument?: (text: string) => Promise<Record<string, string>>
}

export function BriefBuilder(props: BriefBuilderProps) {
  const t = useT()
  const { open, brief, canEdit, onSaveDraft, onGenerateL1, onClose, onHelpDraft, onExtractDocument } = props
  const [params, setParams] = useState<Record<string, string>>({ ...brief.parameters })
  const [notes, setNotes] = useState(brief.freeformNotes)
  // Where the interview resumes, frozen at open so a save mid-session can't
  // move the user: the first unanswered field, or -1 when the brief is already
  // complete.
  const [resumeAt] = useState(() =>
    BRIEF_FIELDS.findIndex((f) => !(brief.parameters[f.id] ?? "").trim()),
  )
  const openedComplete = resumeAt === -1
  // AQU-2347: a finished brief used to open on its LAST step (the notes slot),
  // so reviewing it meant clicking Back through every field. A complete
  // document opens at its beginning; only an unfinished one resumes in place.
  const [step, setStep] = useState(openedComplete ? 0 : resumeAt)
  const [busy, setBusy] = useState(false)

  const draft: BriefDraft = { parameters: params, freeformNotes: notes }
  const isNotesStep = step >= NOTES_STEP
  const field = isNotesStep ? null : BRIEF_FIELDS[step]

  function setField(id: string, value: string) {
    setParams((p) => ({ ...p, [id]: value }))
  }

  async function saveDraft() {
    setBusy(true)
    // Deliberately does NOT move `step`: saving a section leaves the user in
    // the section they just edited (AQU-2347).
    try { await onSaveDraft(draft) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("autopilot.readiness.brief.label")}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-4 sm:flex-row">
            {/* One section per interview field plus the notes step. A brief with
                a single section has nothing to navigate between, so the nav is
                suppressed rather than rendered as a list of one. */}
            {BRIEF_SECTIONS.length > 1 && (
              <nav
                aria-label={t("agent.brief.sectionsNavAriaLabel")}
                className="shrink-0 sm:w-56"
              >
                <ol className="flex flex-wrap gap-1 sm:flex-col sm:flex-nowrap">
                  {BRIEF_SECTIONS.map((section) => {
                    const current = section.step === step
                    return (
                      <li key={section.step}>
                        <button
                          type="button"
                          aria-current={current ? "step" : undefined}
                          onClick={() => setStep(section.step)}
                          className={cn(
                            "w-full rounded-md px-2 py-1 text-start text-xs transition-colors",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            current
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50",
                          )}
                        >
                          {t(section.labelKey)}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </nav>
            )}

            <div className="min-w-0 flex-1 space-y-4">
              {/* Pre-filling only has something to do while fields are still
                  blank; on a brief that opened complete it would be a dead
                  control (AQU-2347 moved that brief's landing step to 0). */}
              {onExtractDocument && step === 0 && !openedComplete && (
                <DocumentPrefill
                  disabled={!canEdit || busy}
                  onExtract={async (text) => {
                    setBusy(true)
                    try {
                      const extracted = await onExtractDocument(text)
                      setParams((p) => ({ ...extracted, ...p })) // keep any manual edits
                    } finally { setBusy(false) }
                  }}
                />
              )}

              {field ? (
                <div className="space-y-2">
                  {/* A real <label>: the section's name now also appears in the
                      nav, so the field needs its own accessible name rather
                      than relying on the heading sitting next to it. */}
                  <label htmlFor={FIELD_INPUT_ID} className="block text-sm font-medium">
                    {t(field.labelKey)}
                  </label>
                  <p id={FIELD_HELP_ID} className="text-xs text-muted-foreground">
                    {t(field.helperTextKey)}
                  </p>
                  <Textarea
                    id={FIELD_INPUT_ID}
                    aria-describedby={FIELD_HELP_ID}
                    value={params[field.id] ?? ""}
                    readOnly={!canEdit}
                    rows={5}
                    onChange={(e) => setField(field.id, e.target.value)}
                  />
                  {canEdit && onHelpDraft && (
                    <Button variant="ghost" disabled={busy}
                      onClick={async () => {
                        setBusy(true)
                        try { setField(field.id, await onHelpDraft(field.id, draft)) }
                        finally { setBusy(false) }
                      }}>
                      {t("agent.brief.helpMeWrite")}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <label htmlFor={NOTES_INPUT_ID} className="block text-sm font-medium">
                    {t("agent.brief.notesPrompt")}
                  </label>
                  <Textarea id={NOTES_INPUT_ID} value={notes} readOnly={!canEdit} rows={5}
                    onChange={(e) => setNotes(e.target.value)} />
                </div>
              )}
            </div>
          </div>
        </DialogBody>

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
            {t("common.back")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!canEdit || busy} onClick={saveDraft}>
              {t("agent.brief.saveDraft")}
            </Button>
            {isNotesStep ? (
              <Button disabled={!canEdit || busy}
                onClick={async () => {
                  setBusy(true)
                  // onGenerateL1 saves the draft itself; close only when a
                  // summary was actually generated (AQU-968).
                  try { if (await onGenerateL1(draft)) onClose() } finally { setBusy(false) }
                }}>
                {t("agent.brief.saveAndGenerate")}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setStep((s) => s + 1)}>{t("common.next")}</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocumentPrefill(props: { disabled: boolean; onExtract: (text: string) => Promise<void> }) {
  const t = useT()
  const [text, setText] = useState("")
  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <div className="text-xs font-medium">{t("agent.brief.pasteToPrefill")}</div>
      <Textarea value={text} rows={3} disabled={props.disabled}
        placeholder={t("agent.brief.pastePlaceholder")} onChange={(e) => setText(e.target.value)} />
      <Button variant="secondary" disabled={props.disabled || !text.trim()}
        onClick={() => props.onExtract(text)}>
        {t("agent.brief.prefillFromText")}
      </Button>
    </div>
  )
}
