import { Circle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"

export function ComingSoonStep({
  title,
  description,
}: {
  title: string
  description: string
}) {
  const t = useT()
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Circle
        className="mt-0.5 size-4 shrink-0 text-muted-foreground/40"
        aria-hidden
      />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <Badge variant="secondary">{t("onboarding.checklist.comingSoon.badge")}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
