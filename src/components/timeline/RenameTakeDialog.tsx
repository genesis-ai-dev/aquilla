// AQU-1767 (Sam, 2026-10-14): "Rename…" from a take's right-click menu.
// Same shape as the Add Track dialog beside it; saving an unchanged or empty
// name does nothing, as renaming in the takes lists does.

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"

export function RenameTakeDialog({
  open,
  current,
  onCancel,
  onConfirm,
}: {
  open: boolean
  /** The take's own name, or "" when it has none. */
  current: string
  onCancel(): void
  onConfirm(label: string): void
}) {
  const t = useT()
  const [name, setName] = useState(current)
  useEffect(() => {
    if (open) setName(current)
  }, [open, current])
  const trimmed = name.trim()
  const canSave = trimmed !== "" && trimmed !== current.trim()
  const save = () => {
    if (canSave) onConfirm(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-sm" data-testid="tl-rename-take-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.timeline.renameTakeTitle")}</DialogTitle>
        </DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t("editor.timeline.renameTakeLabel")}</span>
          <input
            data-testid="tl-rename-take-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save()
            }}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-sky-500"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button data-testid="tl-rename-take-save" disabled={!canSave} onClick={save}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
