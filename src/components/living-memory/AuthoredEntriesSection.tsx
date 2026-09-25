/**
 * Authored living-memory entries — one section per entry `kind`
 * ("instruction" on the Instructions pane, "standard" on the Translation
 * quality pane) with add/edit/delete dialogs.
 *
 * Edit access is gated at MAINTAINER (600) via useProjectSettings.canEdit;
 * below-floor users see read-only affordances with a tooltip naming the
 * required role (AQU-255 pattern). `RoleLockTooltip` is shared with the
 * prediction-prompt block so every locked control explains itself the same way.
 */

import React, { useState } from "react"
import { Plus, Pencil, Trash2, Lock } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { LivingMemoryEntry } from "@/lib/parsers/types"

// ── Entry form (used in add dialog + inline edit) ───────────────────────────

interface EntryFormProps {
  initialText?: string
  onSave: (text: string) => void
  onCancel: () => void
}

function EntryForm({ initialText = "", onSave, onCancel }: EntryFormProps) {
  const t = useT()
  const [text, setText] = useState(initialText)
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        placeholder={t("terminology.livingMemory.enterTextPlaceholder")}
        className="min-h-[72px] resize-none"
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          onClick={() => { if (text.trim()) onSave(text) }}
          disabled={!text.trim()}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  )
}

// ── Role-lock icon with tooltip ────────────────────────────────────────────

/** Which floor a locked control is actually gated on. */
export type LockedRole = "maintainer" | "projectLead" | "contributor"

const ROLE_TOOLTIP_KEY = {
  maintainer: "terminology.livingMemory.maintainerRequiredTooltip",
  projectLead: "terminology.livingMemory.projectLeadRequiredTooltip",
  contributor: "terminology.livingMemory.contributorRequiredTooltip",
} as const

export function RoleLockTooltip({
  reason,
  // Entries and the prediction prompt are maintainer-gated; the style-rule
  // library gates on lower floors, so the lock must name the real one rather
  // than overstate it.
  requiredRole = "maintainer",
}: {
  reason: "offline" | "role" | null
  requiredRole?: LockedRole
}) {
  const t = useT()
  if (reason === null) return null
  const message =
    reason === "offline"
      ? t("terminology.livingMemory.offlineTooltip")
      : t(ROLE_TOOLTIP_KEY[requiredRole])
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={message}
            className="inline-flex items-center text-muted-foreground/50"
          />
        }
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[200px] text-xs">
        {message}
      </TooltipContent>
    </Tooltip>
  )
}

// ── Authored entries section ───────────────────────────────────────────────

interface AuthoredEntriesSectionProps {
  title: string
  description: string
  placeholder: string
  example: string
  kind: LivingMemoryEntry["kind"]
  entries: LivingMemoryEntry[]
  canEdit: boolean
  reasonCannotEdit: "offline" | "role" | null
  onAdd: (text: string) => void
  onUpdate: (id: string, text: string) => void
  onDelete: (id: string) => void
}

export function AuthoredEntriesSection({
  title,
  description,
  placeholder,
  example,
  kind,
  entries,
  canEdit,
  reasonCannotEdit,
  onAdd,
  onUpdate,
  onDelete,
}: AuthoredEntriesSectionProps) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LivingMemoryEntry | null>(null)

  const filtered = entries.filter((e) => e.kind === kind)
  // `title` arrives already translated (the two call sites pass
  // t("terminology.livingMemory.instructionsTitle") / standardsTitle); this
  // section only ever lower-cases it for the {section} placeholder below.
  const sectionLower = title.toLowerCase()

  return (
    <section aria-label={title}>
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xs font-semibold text-muted-foreground flex-1">
          {title}
        </h2>
        {canEdit && (
          <Button
            variant="ghost"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setAdding(true)}
            aria-label={t("terminology.livingMemory.addEntryAria", { section: sectionLower })}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t("common.add")}
          </Button>
        )}
        {!canEdit && <RoleLockTooltip reason={reasonCannotEdit} />}
      </div>

      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{description}</p>

      <Dialog
        open={adding}
        onOpenChange={(open: boolean) => { if (!open) setAdding(false) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("terminology.livingMemory.addEntryAria", { section: sectionLower })}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <EntryForm
            onSave={(text) => { onAdd(text); setAdding(false) }}
            onCancel={() => setAdding(false)}
          />
        </DialogContent>
      </Dialog>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-5 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground/60 italic">{placeholder}</p>
          <p className="text-xs text-muted-foreground/50">
            <span className="font-medium not-italic text-muted-foreground/70">
              {t("terminology.livingMemory.exampleLabel")}{" "}
            </span>
            {example}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((entry) => (
            <Card key={entry.id} className="overflow-hidden">
              <CardContent className="p-3">
                {editingId === entry.id ? (
                  <EntryForm
                    initialText={entry.text}
                    onSave={(text) => { onUpdate(entry.id, text); setEditingId(null) }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-start gap-2">
                    <p className="text-sm leading-relaxed flex-1">{entry.text}</p>
                    {canEdit && (
                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => setEditingId(entry.id)}
                          aria-label={t("terminology.livingMemory.editEntryAria")}
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(entry)}
                          aria-label={t("terminology.livingMemory.deleteEntryAria")}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                  {entry.author} · <DateTooltip value={entry.createdAt} label={t("common.date.created")} />
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open: boolean) => { if (!open) setDeleteTarget(null) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("terminology.livingMemory.deleteEntryConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("terminology.livingMemory.deleteEntryConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) { onDelete(deleteTarget.id); setDeleteTarget(null) }
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
