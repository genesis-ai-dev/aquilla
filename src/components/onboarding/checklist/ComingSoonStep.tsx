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
    <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-60">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border border-muted-foreground/30 text-[10px] text-muted-foreground">
        —
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <Badge variant="secondary">{t("onboarding.checklist.comingSoon.badge")}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
