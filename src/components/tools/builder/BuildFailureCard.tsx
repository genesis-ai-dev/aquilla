import { useState } from "react"
import { ChevronRight, CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** A build that failed every attempt: one line, two actions, details on request. */
export function BuildFailureCard({ failure, onEdit, onRetry }: { failure: string; onEdit: () => void; onRetry: () => void }) {
  const t = useT()
  const [details, setDetails] = useState(false)
  return (
    <section
      role="alert"
      className="w-full rounded-2xl border border-destructive/20 bg-destructive/[0.04] p-4 transition-[opacity,transform] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0 dark:bg-destructive/10"
      data-testid="builder-failure"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <CircleAlert className="size-4.5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("extensions.failure.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("extensions.failure.body")}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onEdit}>{t("extensions.failure.edit")}</Button>
          <Button size="sm" onClick={onRetry}>{t("extensions.build.tryAgain")}</Button>
        </div>
      </div>
      {failure && (
        <div className="mt-2 ps-7.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            <ChevronRight className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", details && "rotate-90")} aria-hidden />
            {t("extensions.build.details")}
          </button>
          {details && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2.5 text-xs whitespace-pre-wrap text-muted-foreground">{failure}</pre>}
        </div>
      )}
    </section>
  )
}
