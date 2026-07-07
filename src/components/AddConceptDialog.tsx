/**
 * AddConceptDialog — small confirm dialog for the "Add to termbase" action.
 *
 * Shown when the user selects source text and clicks "Add to termbase". It
 * pre-fills the selected term so the user can review (and optionally trim)
 * it before the draft concept is created.
 *
 * Props:
 *   open         — controlled open state
 *   sourceTerm   — pre-filled text from the current selection
 *   onConfirm    — called with the (possibly edited) term; caller persists
 *   onCancel     — called when the dialog is dismissed without confirming
 */

import React, { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

interface AddConceptDialogProps {
  open: boolean
  sourceTerm: string
  onConfirm: (term: string) => void | Promise<void>
  onCancel: () => void
}

export function AddConceptDialog({
  open,
  sourceTerm,
  onConfirm,
  onCancel,
}: AddConceptDialogProps) {
  const [term, setTerm] = useState(sourceTerm)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync pre-fill whenever a new selection triggers the dialog.
  useEffect(() => {
    if (open) {
      setTerm(sourceTerm)
      setSubmitting(false)
    }
  }, [open, sourceTerm])

  // Auto-focus + select-all on open so the user can immediately correct the term.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleConfirm = async () => {
    const trimmed = term.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onConfirm(trimmed)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      void handleConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="add-concept-title" aria-describedby="add-concept-desc">
        <DialogHeader>
          <DialogTitle id="add-concept-title">Add to term base</DialogTitle>
          <DialogDescription id="add-concept-desc">
            Creates a draft concept with this source term. Add renderings and
            activate it from the Terminology page.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="concept-term-input" className="text-xs font-medium">
              Source term
            </FieldLabel>
            <Input
              id="concept-term-input"
              ref={inputRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Source term…"
              aria-label="Source term for new concept"
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={!term.trim() || submitting}
            aria-label="Create draft concept"
          >
            {submitting ? "Saving…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
