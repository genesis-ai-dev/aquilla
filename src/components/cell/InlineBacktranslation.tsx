import { AlertTriangle, Languages } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/**
 * The cell's back-translation, as one quiet line under its translation.
 *
 * Readings used to live only in the row's BT tab, so checking a passage meant
 * opening every row. With live back-translation on, a reading lands under the
 * row moments after each save. Readings made by hand show here too.
 *
 * Four states, nothing else:
 *  - a reading that matches the text on screen: plain muted text;
 *  - a reading of older text: faded, marked "Out of date";
 *  - a reading in progress: a spinner (over the old reading, when there is one);
 *  - a reading that failed: "Back-translation failed", the reason on hover —
 *    otherwise a live reading that the platform refused (a model it does not
 *    offer, no credits) would leave the row looking as if nothing was tried.
 *
 * Renders nothing when there is no reading and none is being made. Clicking
 * the line opens the BT tab, where the reading can be edited or refreshed.
 */
export function InlineBacktranslation({
  reading,
  stale,
  generating,
  error,
  onOpen,
}: {
  reading: string | undefined
  stale: boolean
  generating: boolean
  error?: string
  onOpen?: () => void
}) {
  const t = useT()
  const text = reading?.trim() ?? ""
  const failed = Boolean(error) && !generating
  if (!text && !generating && !failed) return null

  return (
    <button
      type="button"
      data-testid="inline-backtranslation"
      data-state={generating ? "generating" : failed ? "failed" : stale ? "stale" : "current"}
      title={failed ? error : t("editor.bt.inlineOpen")}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      className={cn(
        "mt-1 flex w-full min-w-0 items-start gap-1.5 rounded-sm px-1 py-0.5 text-start text-xs leading-snug",
        "text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {generating ? (
        <Spinner className="mt-px size-3 shrink-0" />
      ) : failed ? (
        <AlertTriangle aria-hidden className="mt-px size-3 shrink-0 text-destructive" />
      ) : (
        <Languages aria-hidden className="mt-px size-3 shrink-0 opacity-70" />
      )}
      <span className={cn("min-w-0 flex-1", (stale || generating) && text && "opacity-55")}>
        <span className="sr-only">{t("editor.bt.label")}: </span>
        {failed && !text ? t("editor.bt.failed") : text || t("editor.bt.inlineGenerating")}
      </span>
      {failed && text && (
        <span className="shrink-0 text-[10px] font-medium text-destructive">{t("editor.bt.failed")}</span>
      )}
      {stale && !generating && !failed && text && (
        <span className="shrink-0 rounded-sm bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          {t("editor.bt.inlineStale")}
        </span>
      )}
    </button>
  )
}
