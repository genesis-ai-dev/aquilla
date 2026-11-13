// The one word a saved LangQuest connection's health comes down to, coloured.

import { AlertTriangle, CheckCircle2, CloudOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import type { LangQuestConnectionHealth } from "@/lib/langquest/types"

export function LangQuestHealthBadge({ health }: { health: LangQuestConnectionHealth }) {
  const t = useT()
  const broken = health === "needs_reauth" || health === "expired"
  return (
    <Badge
      variant="outline"
      data-testid="langquest-health"
      data-health={health}
      className={
        broken
          ? "border-destructive/40 text-destructive"
          : health === "unreachable"
            ? "text-muted-foreground"
            : "border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
      }
    >
      {broken ? (
        <AlertTriangle className="size-3" aria-hidden />
      ) : health === "unreachable" ? (
        <CloudOff className="size-3" aria-hidden />
      ) : (
        <CheckCircle2 className="size-3" aria-hidden />
      )}
      {t(`langquest.health.${health}`)}
    </Badge>
  )
}
