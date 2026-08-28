import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label: string
  initialValue: string
  onSubmit: (next: string) => void | Promise<void>
  saving?: boolean
  error?: string | null
}

export function RenameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  initialValue,
  onSubmit,
  saving = false,
  error = null,
}: RenameDialogProps) {
  const t = useT()
  const [draft, setDraft] = useState(initialValue)

  useEffect(() => {
    if (!open) return
    setDraft(initialValue)
  }, [open, initialValue])

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialValue.trim() && !saving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSave) return
            void onSubmit(trimmed)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rename-dialog-name">{label}</FieldLabel>
              <Input
                id="rename-dialog-name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={saving}
                aria-invalid={error ? true : undefined}
                autoFocus
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
