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

/** AQU-2186: naming a new section, or correcting the name of one. */
export type SectionDialogMode = "start" | "rename"

/**
 * AQU-2185: name a navigator division of your own, starting at the cell whose
 * menu opened this. AQU-2186: and correct that name afterwards.
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
 * what counts as blank. In `rename` mode that disabled button is also how
 * "renaming to an empty name is refused" is enforced: clearing the field and
 * confirming is not a way to remove the section, because **Remove section** is.
 *
 * ONE COMPONENT FOR BOTH MODES, because they are one form — a field holding a
 * section's name — and the only differences are the words around it and
 * whether the field starts empty. Splitting it would leave two copies of the
 * blank-name rule to keep in step.
 */
export function StartSectionDialog({
  open,
  mode = "start",
  initialName = "",
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  /** `"rename"` retitles the dialog and seeds the field. Default `"start"`. */
  mode?: SectionDialogMode
  /**
   * AQU-2186: the name to open with, in `rename` mode. Read ONCE, as the
   * field's initial state — so the render site gives this dialog a `key` that
   * changes per opening (see ProjectWorkspace) rather than having an effect
   * push the prop into state on every change, which would fight the user's
   * typing and trip `react-hooks/set-state-in-effect`.
   */
  initialName?: string
  onOpenChange: (open: boolean) => void
  /** Called with the trimmed name. Never called with a blank one. */
  onSubmit: (label: string) => void
}) {
  const t = useT()
  const [name, setName] = useState(initialName)
  const renaming = mode === "rename"

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
    setName(initialName)
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
          <DialogTitle id="start-section-title">
            {t(renaming ? "editor.renameSection.title" : "editor.startSection.title")}
          </DialogTitle>
          <DialogDescription id="start-section-desc">
            {t(renaming
              ? "editor.renameSection.description"
              : "editor.startSection.description")}
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
            {t(renaming ? "editor.renameSection.save" : "editor.startSection.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
