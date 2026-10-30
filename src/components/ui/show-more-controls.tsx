import { useCallback, useMemo, useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Rows a capped list shows before its Show more / Show all controls kick in.
 * Also the batch size each "Show more" reveals. AQU-656 set it for the
 * imported-originals list; AQU-2293 made it the one page size every capped
 * list in the app shares.
 */
export const SHOW_MORE_PAGE_SIZE = 5

/**
 * The paging state behind a capped list (AQU-2293). `rows` is the full list;
 * `visible` is the slice to render.
 *
 * The count — not a set of ids — is what is held in state, so a list that
 * shrinks under the cap closes the gap by itself: remove a visible row and the
 * next hidden one slides up into the same five, and the "Show all (N)" total
 * drops by one. That is the Remove (×) behaviour the Team workload card needs.
 */
export function useShowMore<T>(rows: readonly T[], pageSize = SHOW_MORE_PAGE_SIZE) {
  const [shown, setShown] = useState(pageSize)
  const total = rows.length
  const visible = useMemo(() => rows.slice(0, shown), [rows, shown])
  const showMore = useCallback(() => setShown((n) => n + pageSize), [pageSize])
  const showAll = useCallback(() => setShown(total), [total])
  const showFewer = useCallback(() => setShown(pageSize), [pageSize])
  return {
    visible,
    controls: { total, shownCount: visible.length, pageSize, showMore, showAll, showFewer },
  }
}

export type ShowMoreState = ReturnType<typeof useShowMore<unknown>>["controls"]

/**
 * The Show more / Show all / Show fewer buttons under a capped list
 * (AQU-656, generalized by AQU-2293 — the Team workload card needed the same
 * controls, and a second hand-written copy of this markup would have drifted
 * from the first).
 *
 * "Show more" only earns its place while a full batch is still hidden — once
 * fewer than a page remains it would do exactly what "Show all" does. Nothing
 * renders at all for a list that fits inside one page.
 */
export function ShowMoreControls({
  state,
  controlsId,
  testIdPrefix,
}: {
  state: ShowMoreState
  /** The id of the list element these buttons expand, for `aria-controls`. */
  controlsId: string
  /** Prefix for the three buttons' `data-testid`s, e.g. `imported-originals`. */
  testIdPrefix: string
}) {
  const t = useT()
  const { total, shownCount, pageSize, showMore, showAll, showFewer } = state
  if (total <= pageSize) return null
  const hidden = Math.max(0, total - shownCount)
  const buttonClass =
    "text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {hidden > pageSize && (
        <button
          type="button"
          className={buttonClass}
          aria-controls={controlsId}
          data-testid={`${testIdPrefix}-show-more`}
          onClick={showMore}
        >
          {t("common.listShowMore", { count: pageSize })}
        </button>
      )}
      {hidden > 0 ? (
        <button
          type="button"
          className={buttonClass}
          aria-controls={controlsId}
          aria-expanded={false}
          data-testid={`${testIdPrefix}-show-all`}
          onClick={showAll}
        >
          {t("common.listShowAll", { count: total })}
        </button>
      ) : (
        <button
          type="button"
          className={buttonClass}
          aria-controls={controlsId}
          aria-expanded={true}
          data-testid={`${testIdPrefix}-show-fewer`}
          onClick={showFewer}
        >
          {t("common.listShowFewer")}
        </button>
      )}
    </div>
  )
}
