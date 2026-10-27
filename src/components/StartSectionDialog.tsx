import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * AQU-2185: name a navigator division of your own, starting at the cell whose
 * menu opened this.
 *
 * One field, because one field is the whole decision. Where the section ENDS is
 * the part a reader cannot guess from "Start a section here", so the
 * description says it rather than leaving them to find out by looking at the
 * navigator afterwards.
 *
 * The empty name is refused by DISABLING the confirm button rather than by
 * saving and then complaining: there is nothing to explain about a name that
 * has not been typed yet, and a disabled button says "not yet" without an error
 * the user has to dismiss. Whitespace-only is the same case — `trim()` is what
 * the emitter and the server's projection both apply, so the three agree on
 * what counts as blank.
 */
export function StartSectionDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the trimmed name. Never called with a blank one. */
  onSubmit: (label: string) => void
}) {
  const t = useT()
  const [name, setName] = useState("")

  /**
   * Cleared on the way OUT, not by an effect on the way in. The field must be
   * fresh every time the dialog opens — the previous section's name is never
   * the one you want for the next, and leaving it there invites naming two
   * sections alike by accident — but resetting it from an effect on `open` is a
   * cascading render for a value this component already owns
   * (`react-hooks/set-state-in-effect`). Every exit routes through here: the
   * Cancel button, a successful save, and the primitive's own Esc / outside
   * click.
   */
  const close = () => {
    setName("")
    onOpenChange(false)
  }

  const trimmed = name.trim()
  const submit = () => {
    if (!trimmed) return
    onSubmit(trimmed)
    close()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent aria-labelledby="start-section-title" aria-describedby="start-section-desc">
        <DialogHeader>
          <DialogTitle id="start-section-title">{t("editor.startSection.title")}</DialogTitle>
          <DialogDescription id="start-section-desc">
            {t("editor.startSection.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="start-section-name">{t("editor.startSection.nameLabel")}</Label>
          <Input
            id="start-section-name"
            data-testid="start-section-name"
            autoFocus
            value={name}
            placeholder={t("editor.startSection.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            // Enter is how a one-field form is finished. Guarded by the same
            // `trimmed` check as the button so the keyboard cannot save a blank
            // name the button refuses.
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              submit()
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("editor.startSection.cancel")}
          </Button>
          <Button
            data-testid="start-section-save"
            disabled={!trimmed}
            onClick={submit}
          >
            {t("editor.startSection.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
