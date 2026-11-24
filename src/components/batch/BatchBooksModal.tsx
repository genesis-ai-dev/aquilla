/**
 * AQU-2673: batch validation and AI drafts across books.
 *
 * This is the header action. It never changes which file the editor has open.
 * Each checked book is taken whole; a chapter belongs to the open book's own
 * dialog.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BatchBook } from "@/lib/review/batch-books"

/** Measured book row (checkbox + name). A larger estimate makes LegendList build extra rows. */
const BOOK_ROW_PX = 20
const BOOK_LIST_MAX_PX = 256

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

  const toggle = useCallback((id: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // LegendList re-renders a mounted row only when `extraData` changes, so the
  // checked set travels there. The row callback stays stable across a toggle.
  const renderBook = useCallback(
    ({ item, extraData }: LegendListRenderItemProps<BatchBook>) => (
      <BookCheckRow
        book={item}
        checked={(extraData as Set<string>).has(item.id)}
        onToggle={toggle}
      />
    ),
    [toggle],
  )

  const title = request === "validate"
    ? t("editor.batchBooks.validateTitle")
    : t("editor.batchBooks.draftTitle")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {request === "validate"
              ? t("editor.batchBooks.validateDescription")
              : t("editor.batchBooks.description")}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend variant="label" className="flex items-center gap-1.5">
            <Checkbox
              id="batch-books-all"
              checked={allChecked}
              indeterminate={checked.size > 0 && !allChecked}
              disabled={books.length === 0}
              onCheckedChange={(value) => {
                setChecked(value === true ? new Set(books.map((book) => book.id)) : new Set())
              }}
            />
            <FieldLabel
              htmlFor="batch-books-all"
              onClick={(event) => {
                event.preventDefault()
                if (books.length === 0) return
                setChecked(allChecked ? new Set() : new Set(books.map((book) => book.id)))
              }}
            >
              {t("editor.batchBooks.section")}
            </FieldLabel>
          </FieldLegend>
          <div
            className="overflow-hidden"
            style={{ height: Math.min(BOOK_LIST_MAX_PX, Math.max(BOOK_ROW_PX, books.length * BOOK_ROW_PX)) }}
          >
            <LegendList
              data={books}
              extraData={checked}
              renderItem={renderBook}
              keyExtractor={(book) => book.id}
              estimatedItemSize={BOOK_ROW_PX}
              recycleItems={false}
              style={{ height: "100%" }}
              contentContainerStyle={{ width: "100%" }}
            />
          </div>
        </FieldSet>
        {request === "validate" ? (
          <FieldSet>
            <OptionRow
              id="batch-books-ready"
              checked={includeReady}
              onCheckedChange={setIncludeReady}
              label={t("editor.batchFile.includeUnvalidated")}
              help={t("editor.batchFile.readyHelp")}
            />
            <OptionRow
              id="batch-books-ai"
              checked={canIncludeUntouchedAi && includeAi}
              disabled={!canIncludeUntouchedAi}
              onCheckedChange={setIncludeAi}
              label={t("editor.batchBooks.aiDrafts")}
              help={canIncludeUntouchedAi
                ? t("editor.batchBooks.aiDraftsHelp")
                : t("editor.batchFile.aiDraftsLocked")}
            />
            <OptionRow
              id="batch-books-flagged"
              checked={includeFlagged}
              onCheckedChange={setIncludeFlagged}
              label={t("editor.batchFile.includeUnresolved")}
              help={t("editor.batchBooks.flaggedHelp")}
            />
          </FieldSet>
        ) : (
          <FieldSet>
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
              help={t("editor.batchBooks.refreshHelp")}
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

function BookCheckRow({
  book, checked, onToggle,
}: {
  book: BatchBook
  checked: boolean
  onToggle: (id: string, on: boolean) => void
}) {
  const id = `batch-book-${book.id}`
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onToggle(book.id, value === true)}
      />
      <FieldContent>
        <FieldLabel
          htmlFor={id}
          className="w-full"
          onClick={(event) => {
            event.preventDefault()
            onToggle(book.id, !checked)
          }}
        >
          {book.name}
        </FieldLabel>
      </FieldContent>
    </Field>
  )
}

export interface BatchBooksDialogHandle {
  open: (request: BatchBooksRequest) => void
}

/**
 * Owns which run the header asked for. The workspace only holds a ref, so
 * opening the dialog does not add state to ProjectWorkspace.
 */
export const BatchBooksDialog = forwardRef<BatchBooksDialogHandle, {
  books: readonly BatchBook[]
  initialFileId: string | null
  canIncludeUntouchedAi: boolean
  onConfirm: (request: BatchBooksRequest, choices: BatchBooksChoices) => void
}>(function BatchBooksDialog({ books, initialFileId, canIncludeUntouchedAi, onConfirm }, ref) {
  const [request, setRequest] = useState<BatchBooksRequest | null>(null)
  useImperativeHandle(ref, () => ({ open: setRequest }), [])
  if (!request) return null
  return (
    <BatchBooksModal
      open
      onOpenChange={(open) => { if (!open) setRequest(null) }}
      request={request}
      books={books}
      initialFileId={initialFileId}
      canIncludeUntouchedAi={canIncludeUntouchedAi}
      onConfirm={(choices) => {
        const kind = request
        setRequest(null)
        onConfirm(kind, choices)
      }}
    />
  )
})

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
        <FieldLabel
          htmlFor={id}
          className="w-full"
          onClick={(event) => {
            event.preventDefault()
            if (disabled) return
            onCheckedChange(!checked)
          }}
        >
          {label}
        </FieldLabel>
        <FieldDescription>{help}</FieldDescription>
      </FieldContent>
    </Field>
  )
}
