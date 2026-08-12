import { Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import type { ProjectRecord } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { useT } from "@/lib/i18n/I18nProvider"

interface SystemPromptNudgeProps {
  project: ProjectRecord
  onProjectUpdated: (p: ProjectRecord) => void
  onCustomize: () => void
}

const NUDGE_DELAY_MS = 24 * 60 * 60 * 1000

/**
 * Soft, one-time banner that appears in the editor when:
 *  - the project is older than ~24h
 *  - the project actually has content (any file with cells)
 *  - the system prompt is still the default (or empty)
 *  - the user hasn't dismissed it before
 *
 * The "eventually" nudge for founders who skipped customizing AI instructions.
 * Customizing the prompt OR clicking the X both stop future nags via
 * `defaultPromptNudgeDismissedAt`.
 */
export function shouldShowSystemPromptNudge(project: ProjectRecord): boolean {
  if (project.defaultPromptNudgeDismissedAt) return false
  const prompt = project.completionSettings?.systemPrompt?.trim() ?? ""
  const isCustomized = prompt.length > 0 && prompt !== DEFAULT_SYSTEM_PROMPT.trim()
  if (isCustomized) return false
  const created = Date.parse(project.createdAt)
  if (!Number.isFinite(created)) return false
  if (Date.now() - created < NUDGE_DELAY_MS) return false
  const hasContent = (project.files ?? []).some((f) => f.cellCount > 0)
  if (!hasContent) return false
  return true
}

export function SystemPromptNudge({ project, onProjectUpdated, onCustomize }: SystemPromptNudgeProps) {
  const t = useT()
  if (!shouldShowSystemPromptNudge(project)) return null

  async function dismiss() {
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      defaultPromptNudgeDismissedAt: new Date().toISOString(),
    }))
    if (updated) onProjectUpdated(updated)
  }

  return (
    <div className="flex items-center gap-3 border-b bg-primary/5 px-4 py-2 text-xs">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <p className="flex-1 text-foreground/80">
        {t("onboarding.systemPromptNudge.message")}{" "}
        <span className="text-muted-foreground">
          {t("onboarding.systemPromptNudge.detail")}
        </span>
      </p>
      <Button
        size="sm"
        variant="default"
        onClick={() => {
          // Customizing fires the same dismiss path so we don't re-nag if the
          // user later resets to default.
          void dismiss()
          onCustomize()
        }}
      >
        {t("onboarding.systemPromptNudge.customizeButton")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => void dismiss()}
        aria-label={t("common.dismiss")}
        className="text-muted-foreground"
      >
        <X />
      </Button>
    </div>
  )
}
