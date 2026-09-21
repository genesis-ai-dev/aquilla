/**
 * DiscoveredFormsChips (AQU-1271) — the surface forms a concept's matcher has
 * actually hit, rendered as toggleable chips. Clicking a chip excludes/
 * includes that surface form from matching; the caller owns the resulting
 * `TermMatchOptions.excludedForms` update.
 */

import { useState } from "react"
import { X, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { DiscoveredForm } from "@/lib/terminology/discover-forms"
import { cn } from "@/lib/utils"

interface Props {
  forms: DiscoveredForm[]
  disabled?: boolean
  limit?: number
  onToggleExclude: (surface: string, excluded: boolean) => void
}

export function DiscoveredFormsChips({ forms, disabled, limit = 6, onToggleExclude }: Props) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  if (forms.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("terminology.match.formsEmpty")}</p>
  }
  const shown = expanded ? forms : forms.slice(0, limit)
  const hidden = forms.length - shown.length
  return (
    <div className="flex flex-wrap gap-1" data-testid="discovered-forms">
      {shown.map((f) => (
        <button
          key={f.surface}
          type="button"
          disabled={disabled}
          aria-pressed={!f.excluded}
          aria-label={
            f.excluded
              ? t("terminology.match.includeForm", { form: f.surface })
              : t("terminology.match.excludeForm", { form: f.surface })
          }
          onClick={() => onToggleExclude(f.surface, !f.excluded)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
            f.excluded ? "border-dashed text-muted-foreground line-through" : "bg-muted",
          )}
        >
          <span dir="auto">{f.surface}</span>
          <span className="tabular-nums text-muted-foreground">{f.count}</span>
          {f.excluded ? <Plus className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
        </button>
      ))}
      {hidden > 0 && (
        <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded(true)}>
          {t("terminology.match.moreForms", { count: hidden })}
        </Button>
      )}
    </div>
  )
}
