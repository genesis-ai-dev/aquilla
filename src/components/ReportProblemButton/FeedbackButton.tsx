/**
 * AQU-1028: the prominent in-app feedback affordance.
 *
 * The same dialog has been reachable since AQU-307 — but only as the sixth item
 * inside a collapsed "Help & community" dropdown, which is not where a
 * translator who is stuck mid-onboarding will look. Come and See trials surfaced
 * that as the gap: people hit a wall and told us in a call days later, if at all.
 *
 * So this is a first-class button in the shell footer, sitting beside the help
 * and language controls rather than inside one of them. The Help menu keeps its
 * "Report" item — both open this dialog — because the discoverable path and the
 * looked-for path are not always the same one.
 */

import { useState } from "react"
import { MessageSquarePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { ReportProblemDialog } from "./ReportProblemDialog"
import { useT } from "@/lib/i18n/I18nProvider"

interface FeedbackButtonProps {
  /** Icon-only, for the 40px collapsed dock rail where a label cannot fit. */
  compact?: boolean
  className?: string
}

export function FeedbackButton({ compact = false, className }: FeedbackButtonProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const label = t("nav.feedback.buttonLabel")
  const tooltip = t("nav.feedback.buttonTooltip")

  return (
    <>
      <AppTooltip content={tooltip} side="top">
        <Button
          type="button"
          variant="secondary"
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? tooltip : undefined}
          onClick={() => setOpen(true)}
          className={cn("shrink-0", className)}
        >
          <MessageSquarePlus />
          {!compact && label}
        </Button>
      </AppTooltip>
      <ReportProblemDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
