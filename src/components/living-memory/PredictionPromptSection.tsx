/**
 * Default prediction prompt (`settings.systemPrompt`) — a Collapsible block on
 * the Instructions pane, collapsed by default so the authored entries stay the
 * headline. The collapsed row still tells the whole story via a Default/Custom
 * badge; expanding reveals a monospace editor with explicit Save.
 */

import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { RoleLockTooltip } from "./AuthoredEntriesSection"

interface PredictionPromptSectionProps {
  /** The stored `settings.systemPrompt` (undefined/empty → default prompt). */
  stored: string | undefined
  canEdit: boolean
  reasonCannotEdit: "offline" | "role" | null
  /** The PAGE's useProjectSettings patch (optimistic overlay lives there). */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

export function PredictionPromptSection({
  stored,
  canEdit,
  reasonCannotEdit,
  patch,
}: PredictionPromptSectionProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Race-guarded seed: `null` = untouched, so the rendered value tracks the
  // stored prompt (a late settings GET updates it); the first keystroke pins
  // `draft` and later fetches can no longer clobber the in-progress edit.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const seeded = stored && stored.trim() ? stored : DEFAULT_SYSTEM_PROMPT
  const value = draft ?? seeded
  const isCustomStored = Boolean(stored && stored.trim()) && stored !== DEFAULT_SYSTEM_PROMPT
  const changed = value !== seeded

  async function handleSave() {
    if (!canEdit || !changed || saving) return
    setSaving(true)
    try {
      const outcome = await patch({ systemPrompt: value })
      // On success the optimistic overlay makes `stored` reflect the save, so
      // dropping the draft keeps the rendered text identical. On failure the
      // draft is kept — the user's edit survives to retry.
      if (outcome.kind === "ok") setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const label = t("projectSettings.systemPrompt.label")

  return (
    <section aria-label={label}>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="rounded-lg border border-border/60"
      >
        <div className="flex items-center gap-2 pe-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-start hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded-lg"
            >
              <span className="flex-1 truncate text-xs font-semibold text-muted-foreground">
                {label}
              </span>
              <Badge variant={isCustomStored ? "default" : "secondary"} className="text-[10px]">
                {isCustomStored
                  ? t("terminology.livingMemory.prompt.customBadge")
                  : t("terminology.livingMemory.prompt.defaultBadge")}
              </Badge>
              <ChevronDown
                className={[
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground/60",
                  open ? "rotate-180" : "",
                ].join(" ")}
                aria-hidden="true"
              />
            </button>
          </CollapsibleTrigger>
          {!canEdit && <RoleLockTooltip reason={reasonCannotEdit} />}
        </div>

        <CollapsibleContent className="flex flex-col gap-2 border-t border-border/60 p-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("projectSettings.systemPrompt.navDescription")}
          </p>
          <Textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!canEdit}
            aria-label={label}
            className="min-h-[160px] font-mono text-xs"
          />
          {canEdit && (
            <div className="flex justify-end gap-2">
              {value !== DEFAULT_SYSTEM_PROMPT && (
                <Button
                  variant="ghost"
                  onClick={() => setDraft(DEFAULT_SYSTEM_PROMPT)}
                >
                  {/* Same action as onboarding's AI-instructions reset. */}
                  {t("onboarding.checklist.aiInstructions.resetToDefault")}
                </Button>
              )}
              <Button onClick={handleSave} disabled={!changed || saving}>
                {t("common.save")}
              </Button>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
