/**
 * The glossary's "Add term" form.
 *
 * Its two text fields are its own state (AQU-2654). They used to live in
 * GlossaryEditor, so every letter typed here re-rendered the editor and, with
 * it, the whole term list behind the dialog — on a 664-term glossary that is
 * the list a translator is adding to. The editor now hears about the form
 * once, when it is submitted.
 */
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"

export interface GlossaryAddTermDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** At or above the termbase floor the term is enforced; below it this files a suggestion. */
  canManage: boolean
  /**
   * Called with the two fields as typed. Returns true when the term was
   * accepted (the form then clears); false leaves the form as it is so the
   * editor's message can be read next to what was typed.
   */
  onAdd: (sourceTerm: string, rendering: string) => boolean
}

export function GlossaryAddTermDialog({ open, onOpenChange, canManage, onAdd }: GlossaryAddTermDialogProps) {
  const t = useT()
  const [newSource, setNewSource] = useState("")
  const [newRendering, setNewRendering] = useState("")

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setNewSource("")
      setNewRendering("")
    }
  }

  function submit() {
    if (!onAdd(newSource, newRendering)) return
    setNewSource("")
    setNewRendering("")
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("terminology.editor.addTerm")}</DialogTitle>
          {/* AQU-872: say which of the two things this form does before it is
              submitted. Below the floor it files a suggestion, and a
              translator who expected the term to start being checked would
              otherwise read the silent draft row as the feature not working. */}
          <DialogDescription>
            {canManage
              ? t("terminology.editor.addTermDescription")
              : t("terminology.editor.addTermSuggestionDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="glossary-new-source">
              {t("terminology.editor.sourceTermLabel")}
            </FieldLabel>
            <Input
              id="glossary-new-source"
              value={newSource}
              placeholder={t("terminology.editor.sourceTermPlaceholder")}
              onChange={(e) => setNewSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="glossary-new-rendering">
              {t("terminology.editor.renderingLabel")}
            </FieldLabel>
            <Input
              id="glossary-new-rendering"
              value={newRendering}
              placeholder={t("terminology.editor.renderingLabel")}
              onChange={(e) => setNewRendering(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!newSource.trim() || !newRendering.trim()}>
            {t("terminology.editor.addTerm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
