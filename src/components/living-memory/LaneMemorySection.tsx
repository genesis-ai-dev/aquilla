/**
 * The Living Memory page's lane chrome (AQU-2348).
 *
 *   * `LivingMemoryLanePicker` — the "Viewing language lane" picker, hoisted to
 *     the page header. It is the SAME control the Rules section already uses
 *     (`LaneCombobox` over the project's target lanes) and shares the editor's
 *     active lane when the workspace passes one down, so a maintainer never has
 *     to hold two different "current lanes" in their head. HIDDEN on a project
 *     with one lane: a picker with one option is noise, and criterion #1 asks
 *     for a single-lane project to look exactly as it did.
 *   * `LaneOverrideControl` — the per-section inherited/customized state and
 *     the Customize / Revert actions, for the two sections a lane can OWN.
 *   * `LaneListNote` — the explanation for the sections a lane ADDS to rather
 *     than replaces. Deliberately no Customize/Revert: see lane-sections.ts.
 *
 * Both notes render only in a lane view. In the project-wide view the page is
 * what it always was.
 *
 * Role gating (criterion #11) reuses the page's own `canEdit` + `RoleLockTooltip`
 * (the AQU-255 pattern), so below MAINTAINER the actions are absent and the lock
 * names the required role — the same affordance as every other control here,
 * rather than a second, lane-shaped way of saying "you may not".
 */

import { useState } from "react"
import { ChevronDown, Layers } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LaneCombobox } from "@/components/LaneCombobox"
import { RoleLockTooltip } from "./AuthoredEntriesSection"

// ── Page-level lane picker ────────────────────────────────────────────────

export interface MemoryLaneOption {
  /** The lane's legacy tag — the key the editor and Rules share (`''` = default). */
  tag: string
  label: string
  archived?: boolean
}

export function LivingMemoryLanePicker({
  options,
  value,
  onValueChange,
  sharedWithEditor = false,
}: {
  options: readonly MemoryLaneOption[]
  value: string
  onValueChange: (tag: string) => void
  /** True when switching here also switches the editor's lane. */
  sharedWithEditor?: boolean
}) {
  const t = useT()
  // Criterion #1: a single-lane project renders no picker at all.
  if (options.length <= 1) return null
  const label = options.find((o) => o.tag === value)?.label ?? value

  return (
    <section
      aria-label={t("terminology.livingMemory.lane.ariaLabel")}
      data-testid="living-memory-lane-scope"
      className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">
          {t("terminology.livingMemory.lane.viewingLabel")}
        </span>
        <LaneCombobox
          options={options.map((o) => ({ value: o.tag, label: o.label, archived: o.archived }))}
          value={value}
          onValueChange={onValueChange}
          searchPlaceholder={t("editor.lane.searchPlaceholder")}
          searchAriaLabel={t("editor.lane.searchAriaLabel")}
          emptyText={t("editor.lane.searchEmpty")}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t("terminology.livingMemory.lane.chooseLaneAriaLabel", { lane: label })}
            >
              {label}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("terminology.livingMemory.lane.explainer", { lane: label })}
        {sharedWithEditor && ` ${t("terminology.livingMemory.lane.sharedWithEditor")}`}
      </p>
    </section>
  )
}

// ── Per-section inherited / customized state ──────────────────────────────

export function LaneOverrideControl({
  laneLabel,
  customized,
  canEdit,
  reasonCannotEdit,
  onCustomize,
  onRevert,
}: {
  laneLabel: string
  /** Whether the lane OWNS the value — not whether it reads one. */
  customized: boolean
  canEdit: boolean
  reasonCannotEdit: "offline" | "role" | null
  onCustomize: () => void
  onRevert: () => void
}) {
  const t = useT()
  const [confirmRevert, setConfirmRevert] = useState(false)

  return (
    <section
      aria-label={t("terminology.livingMemory.lane.ariaLabel")}
      data-testid="lane-override-control"
      data-lane-state={customized ? "customized" : "inherited"}
      className="flex flex-col gap-1.5 rounded-md border border-dashed bg-muted/30 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {customized ? (
          <Badge>{t("terminology.livingMemory.lane.customizedBadge", { lane: laneLabel })}</Badge>
        ) : (
          <Badge variant="secondary">
            {t("terminology.livingMemory.lane.inheritedBadge")}
          </Badge>
        )}
        <div className="flex-1" />
        {canEdit ? (
          customized ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirmRevert(true)}>
              {t("terminology.livingMemory.lane.revertAction")}
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onCustomize}>
              {t("terminology.livingMemory.lane.customizeAction")}
            </Button>
          )
        ) : (
          // Criterion #11: below the floor the actions are absent and the lock
          // names the role, exactly as the rest of the page does.
          <RoleLockTooltip reason={reasonCannotEdit} />
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {customized
          ? t("terminology.livingMemory.lane.customizedExplainer", { lane: laneLabel })
          : t("terminology.livingMemory.lane.inheritedExplainer", { lane: laneLabel })}
      </p>

      <Dialog open={confirmRevert} onOpenChange={(open: boolean) => { if (!open) setConfirmRevert(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("terminology.livingMemory.lane.revertConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("terminology.livingMemory.lane.revertConfirmBody", { lane: laneLabel })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRevert(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => { onRevert(); setConfirmRevert(false) }}
            >
              {t("terminology.livingMemory.lane.revertAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/**
 * The note for a LIST section. A lane adds to the project's list rather than
 * replacing it, so there is nothing to customize and nothing to revert —
 * saying otherwise would promise a restore of something never taken away.
 */
export function LaneListNote({ laneLabel }: { laneLabel: string }) {
  const t = useT()
  return (
    <p
      data-testid="lane-list-note"
      className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground leading-relaxed"
    >
      {t("terminology.livingMemory.lane.listNote", { lane: laneLabel })}
    </p>
  )
}
