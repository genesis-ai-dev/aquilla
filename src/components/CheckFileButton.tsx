import { ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { checkScopeSummary } from "@/components/CheckFindingsDrawer"
import type { CheckRunResult } from "@/lib/check/deterministic-check"

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
  const button = (
    <Button
      type="button"
      variant="outline"
      size="default"
      className="bg-card"
      onClick={onToggle}
      disabled={checkRunning}
      aria-expanded={checkOpen}
      aria-label="Check file"
      data-testid="check-file-button"
    >
      {checkRunning
        ? <Spinner data-icon="inline-start" className="size-4" />
        : <ListChecks data-icon="inline-start" />}
      <span className="hidden md:inline">Check file</span>
      {checkResult && !checkRunning && (
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
          ? "Close file check"
          : checkResult
            ? `Last check: ${checkResult.totalFindingCount} issue${checkResult.totalFindingCount === 1 ? "" : "s"} · ${checkScopeSummary(checkResult)} · ${new Date(checkResult.ranAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
            : "Check the open file against the project's rules and term base"
      }
    >
      {trigger}
    </AppTooltip>
  )
}
