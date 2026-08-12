import { useSyncExternalStore } from "react"
import { ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { checkScopeSummary } from "@/components/CheckFindingsDrawer"
import { cn } from "@/lib/utils"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatTime } from "@/lib/i18n/format"
import type { CheckRunResult } from "@/lib/check/deterministic-check"

/** Tailwind `md` — at/above this, the "Check file" label is visible. */
const MD_MIN_WIDTH_QUERY = "(min-width: 768px)"

function useIsMdUp(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(MD_MIN_WIDTH_QUERY)
      mq.addEventListener("change", onStoreChange)
      return () => mq.removeEventListener("change", onStoreChange)
    },
    () => window.matchMedia(MD_MIN_WIDTH_QUERY).matches,
    () => true,
  )
}

interface CheckFileButtonProps {
  checkOpen: boolean
  checkRunning: boolean
  checkResult: CheckRunResult | null
  onToggle: () => void
  /** When true, render only the button (parent supplies the ButtonGroup). */
  grouped?: boolean
}

/** Phase 0.5 deterministic "Check file" — styled like the old PrimaryActionButton. */
export function CheckFileButton({
  checkOpen,
  checkRunning,
  checkResult,
  onToggle,
  grouped = false,
}: CheckFileButtonProps) {
  const { locale } = useI18n()
  const t = useT()
  const mdUp = useIsMdUp()
  const showBadge = Boolean(checkResult && !checkRunning)
  // Below md the label hides; use a true icon button so width matches the ⋯
  // control beside it. Keep default sizing when a finding-count badge is shown.
  const iconOnly = !mdUp && !showBadge

  const button = (
    <Button
      type="button"
      variant="outline"
      size={iconOnly ? "icon" : "default"}
      className={cn("bg-card", !mdUp && showBadge && "gap-1 px-1.5")}
      onClick={onToggle}
      disabled={checkRunning}
      aria-expanded={checkOpen}
      aria-label={t("rules.checkFileButton.label")}
      data-testid="check-file-button"
    >
      {checkRunning
        ? <Spinner data-icon={iconOnly ? undefined : "inline-start"} className="size-4" />
        : <ListChecks data-icon={iconOnly ? undefined : "inline-start"} />}
      {mdUp ? <span>{t("rules.checkFileButton.label")}</span> : null}
      {showBadge && checkResult && (
        <span className={checkResult.totalFindingCount > 0
          ? "rounded-md bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
          : "rounded-md bg-green-100 px-1.5 text-[10px] font-semibold text-green-800 dark:bg-green-900/50 dark:text-green-300"}>
          {checkResult.totalFindingCount}
        </span>
      )}
    </Button>
  )

  const trigger = grouped ? button : (
    <ButtonGroup className="shadow-xs">{button}</ButtonGroup>
  )

  return (
    <AppTooltip
      content={
        checkOpen
          ? t("rules.checkDrawer.closeAriaLabel")
          : checkResult
            ? t("rules.checkFileButton.lastCheckTooltip", {
                issues: t("rules.checkFileButton.issueCount", { count: checkResult.totalFindingCount }),
                summary: checkScopeSummary(checkResult, t, locale),
                time: formatTime(checkResult.ranAt, locale, { hour: "numeric", minute: "2-digit" }),
              })
            : t("rules.checkFileButton.idleTooltip")
      }
    >
      {trigger}
    </AppTooltip>
  )
}
