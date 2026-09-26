/**
 * Severity chrome shared by every rules surface.
 *
 * Lived inside RulesSurface until AQU-1131 split the org-rules card out into
 * `OrgRulesPanel`. Both need these, and importing them back out of
 * RulesSurface would close an import cycle — hence their own module.
 */
import { AlertCircle, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export function SeverityBadge({ severity }: { severity: string }) {
  const t = useT()
  return (
    <Badge variant={severity === "major" ? "destructive" : "outline"}>
      {severity === "major" ? t("rules.severity.major") : t("rules.severity.minor")}
    </Badge>
  )
}

export function SeverityIcon({ severity }: { severity: string }) {
  const Icon = severity === "major" ? AlertTriangle : AlertCircle
  return (
    <Icon className={cn(
      "size-4 shrink-0",
      severity === "major" ? "text-destructive" : "text-muted-foreground",
    )} />
  )
}
