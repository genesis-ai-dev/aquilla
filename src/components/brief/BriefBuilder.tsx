// src/components/brief/BriefBuilder.tsx
import { useState } from "react"
import { BRIEF_FIELDS } from "@/lib/brief/schema"
import type { TranslationBrief } from "@/lib/brief/types"
import type { BriefDraft } from "@/hooks/useTranslationBrief"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface BriefBuilderProps {
  open: boolean
  brief: TranslationBrief
  canEdit: boolean
  onSaveDraft: (draft: BriefDraft) => Promise<TranslationBrief | undefined>
  onGenerateL1: (draft: BriefDraft) => Promise<void>
  onClose: () => void
  /** Optional: per-field LLM draft helper. Absent → "Help me write this" hidden. */
  onHelpDraft?: (fieldId: string, draft: BriefDraft) => Promise<string>
  /** Optional: document pre-fill. Absent → upload step hidden. */
  onExtractDocument?: (text: string) => Promise<Record<string, string>>
}

export function BriefBuilder(props: BriefBuilderProps) {
  const { open, brief, canEdit, onSaveDraft, onGenerateL1, onClose, onHelpDraft, onExtractDocument } = props
  const [params, setParams] = useState<Record<string, string>>({ ...brief.parameters })
  const [notes, setNotes] = useState(brief.freeformNotes)
  // Resume at the first unanswered field (or 0). +1 slot is the notes step.
  const firstUnanswered = BRIEF_FIELDS.findIndex((f) => !(brief.parameters[f.id] ?? "").trim())
  const [step, setStep] = useState(firstUnanswered === -1 ? BRIEF_FIELDS.length : firstUnanswered)
  const [busy, setBusy] = useState(false)

  const draft: BriefDraft = { parameters: params, freeformNotes: notes }
  const isNotesStep = step >= BRIEF_FIELDS.length
  const field = isNotesStep ? null : BRIEF_FIELDS[step]

  function setField(id: string, value: string) {
    setParams((p) => ({ ...p, [id]: value }))
  }

  async function saveDraft() {
    setBusy(true)
    try { await onSaveDraft(draft) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Translation brief</DialogTitle>
        </DialogHeader>

        {onExtractDocument && step === 0 && (
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
            <div className="text-sm font-medium">{field.label}</div>
            <p className="text-xs text-muted-foreground">{field.helperText}</p>
            <Textarea
              value={params[field.id] ?? ""}
              readOnly={!canEdit}
              rows={5}
              onChange={(e) => setField(field.id, e.target.value)}
            />
            {canEdit && onHelpDraft && (
              <Button variant="ghost" size="sm" disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try { setField(field.id, await onHelpDraft(field.id, draft)) }
                  finally { setBusy(false) }
                }}>
                Help me write this
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">Anything else the AI should know?</div>
            <Textarea value={notes} readOnly={!canEdit} rows={5}
              onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!canEdit || busy} onClick={saveDraft}>
              Save draft
            </Button>
            {isNotesStep ? (
              <Button disabled={!canEdit || busy}
                onClick={async () => { setBusy(true); try { await onSaveDraft(draft); await onGenerateL1(draft) } finally { setBusy(false) } }}>
                Save & generate summary
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setStep((s) => s + 1)}>Next</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocumentPrefill(props: { disabled: boolean; onExtract: (text: string) => Promise<void> }) {
  const [text, setText] = useState("")
  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <div className="text-xs font-medium">Optional: paste an existing brief to pre-fill</div>
      <Textarea value={text} rows={3} disabled={props.disabled}
        placeholder="Paste notes or an existing brief…" onChange={(e) => setText(e.target.value)} />
      <Button size="sm" variant="secondary" disabled={props.disabled || !text.trim()}
        onClick={() => props.onExtract(text)}>
        Pre-fill from text
      </Button>
    </div>
  )
}
