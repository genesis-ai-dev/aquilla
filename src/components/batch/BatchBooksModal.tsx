/**
 * AQU-2673: batch validation and AI drafts across books.
 *
 * This is the header action. It never changes which file the editor has open.
 * Each checked book is taken whole; a chapter belongs to the open book's own
 * dialog.
 */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BatchBook } from "@/lib/review/batch-books"

export type BatchBooksRequest = "validate" | "draft"

export interface BatchBooksChoices {
  fileIds: string[]
  includeReadyCells: boolean
  includeUntouchedAiDrafts: boolean
  includeFlaggedCells: boolean
  includeEmpty: boolean
  refreshAiDrafts: boolean
}

interface BatchBooksModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: BatchBooksRequest
  books: readonly BatchBook[]
  /** The open file, checked when the dialog opens. */
  initialFileId: string | null
  canIncludeUntouchedAi: boolean
  onConfirm: (choices: BatchBooksChoices) => void
}

export function BatchBooksModal({
  open,
  onOpenChange,
  request,
  books,
  initialFileId,
  canIncludeUntouchedAi,
  onConfirm,
}: BatchBooksModalProps) {
  const t = useT()
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [includeReady, setIncludeReady] = useState(true)
  const [includeAi, setIncludeAi] = useState(false)
  const [includeFlagged, setIncludeFlagged] = useState(false)
  const [includeEmpty, setIncludeEmpty] = useState(true)
  const [refreshAi, setRefreshAi] = useState(false)
  const opened = useRef(false)

  useEffect(() => {
    if (!open) {
      opened.current = false
      return
    }
    if (opened.current) return
    opened.current = true
    setChecked(new Set(initialFileId && books.some((book) => book.id === initialFileId) ? [initialFileId] : []))
    setIncludeReady(true)
    setIncludeAi(false)
    setIncludeFlagged(false)
    setIncludeEmpty(true)
    setRefreshAi(false)
  }, [open, initialFileId, books, request])

  const allChecked = books.length > 0 && books.every((book) => checked.has(book.id))

  const toggle = (id: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const title = request === "validate"
    ? t("editor.batchBooks.validateTitle")
    : t("editor.batchBooks.draftTitle")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("editor.batchBooks.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={books.length === 0}
            onClick={() => setChecked(allChecked ? new Set() : new Set(books.map((book) => book.id)))}
          >
            {allChecked ? t("editor.batchBooks.clear") : t("editor.batchBooks.selectAll")}
          </Button>
        </div>
        <ScrollArea className="max-h-64">
          <FieldSet>
            <FieldLegend variant="label">{t("editor.batchBooks.section")}</FieldLegend>
            {books.map((book) => (
              <Field key={book.id} orientation="horizontal">
                <Checkbox
                  id={`batch-book-${book.id}`}
                  checked={checked.has(book.id)}
                  onCheckedChange={(value) => toggle(book.id, value === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`batch-book-${book.id}`}>{book.name}</FieldLabel>
                </FieldContent>
              </Field>
            ))}
          </FieldSet>
        </ScrollArea>
        {request === "validate" ? (
          <FieldSet>
            <FieldLegend variant="label">{t("editor.batchFile.legend")}</FieldLegend>
            <OptionRow
              id="batch-books-ready"
              checked={includeReady}
              onCheckedChange={setIncludeReady}
              label={t("editor.batchBooks.ready")}
              help={t("editor.batchFile.readyHelp")}
            />
            <OptionRow
              id="batch-books-ai"
              checked={canIncludeUntouchedAi && includeAi}
              disabled={!canIncludeUntouchedAi}
              onCheckedChange={setIncludeAi}
              label={t("editor.batchBooks.aiDrafts")}
              help={canIncludeUntouchedAi
                ? t("editor.batchFile.aiDraftsHelp")
                : t("editor.batchFile.aiDraftsLocked")}
            />
            <OptionRow
              id="batch-books-flagged"
              checked={includeFlagged}
              onCheckedChange={setIncludeFlagged}
              label={t("editor.batchBooks.flagged")}
              help={t("editor.batchBooks.flaggedHelp")}
            />
          </FieldSet>
        ) : (
          <FieldSet>
            <FieldLegend variant="label">{t("editor.batchFile.legend")}</FieldLegend>
            <OptionRow
              id="batch-books-empty"
              checked={includeEmpty}
              onCheckedChange={setIncludeEmpty}
              label={t("editor.batchBooks.empty")}
              help={t("editor.batchFile.emptyHelp")}
            />
            <OptionRow
              id="batch-books-refresh"
              checked={refreshAi}
              onCheckedChange={setRefreshAi}
              label={t("editor.batchBooks.refresh")}
              help={t("editor.batchFile.refreshHelp")}
            />
          </FieldSet>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={checked.size === 0}
            onClick={() => onConfirm({
              fileIds: books.filter((book) => checked.has(book.id)).map((book) => book.id),
              includeReadyCells: includeReady,
              includeUntouchedAiDrafts: canIncludeUntouchedAi && includeAi,
              includeFlaggedCells: includeFlagged,
              includeEmpty,
              refreshAiDrafts: refreshAi,
            })}
          >
            {request === "validate"
              ? t("editor.batchBooks.confirmValidate")
              : t("editor.batchBooks.confirmDraft")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OptionRow({
  id, checked, disabled, onCheckedChange, label, help,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  help: string
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled ? true : undefined}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{help}</FieldDescription>
      </FieldContent>
    </Field>
  )
}
