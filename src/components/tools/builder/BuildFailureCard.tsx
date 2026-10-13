import { useState } from "react"
import { ChevronRight, CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** A build that failed every attempt: what happened in plain words, what to
 *  try, and the technical text only on request. */
export function BuildFailureCard({ failure, onEdit, onRetry }: { failure: string; onEdit: () => void; onRetry: () => void }) {
  const t = useT()
  const [details, setDetails] = useState(false)
  return (
    <section role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 sm:p-5" data-testid="builder-failure">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-tight">{t("extensions.failure.title")}</h2>
          <p className="text-sm text-foreground/80">{t("extensions.failure.body")}</p>
          <p className="text-sm text-muted-foreground">{t("extensions.failure.tip")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 ps-8">
        <Button size="sm" onClick={onEdit}>{t("extensions.failure.edit")}</Button>
        <Button size="sm" variant="outline" onClick={onRetry}>{t("extensions.build.tryAgain")}</Button>
        {failure && (
          <Button size="sm" variant="ghost" className="ms-auto text-muted-foreground" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            <ChevronRight className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", details && "rotate-90")} aria-hidden />
            {t("extensions.build.details")}
          </Button>
        )}
      </div>
      {details && failure && (
        <pre className="ms-8 max-h-40 overflow-auto rounded-lg bg-muted p-2.5 text-xs whitespace-pre-wrap text-muted-foreground">{failure}</pre>
      )}
    </section>
  )
}
