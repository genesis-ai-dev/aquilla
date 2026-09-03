import { useEffect, useRef } from "react"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"
import { toast } from "@/components/ui/toast"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { formatInfractionReason } from "@/lib/rules/format-infraction"

interface ViolationToastProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  infraction: RuleInfraction
  ruleName: string
  waivers: RuleWaiver[]
  onOpenRule: (ruleId: string) => void
  onWaive: (input: { ruleId: string; reason?: string }) => void
  onUnwaive: (ruleId: string) => void
}

/**
 * Shows one actionable violation surface in the app's standard toast stack.
 * The global toaster owns its bottom-right position and dismissal behavior.
 */
export function ViolationToast({
  open,
  onOpenChange,
  infraction,
  ruleName,
  waivers,
  onOpenRule,
  onWaive,
  onUnwaive,
}: ViolationToastProps) {
  const t = useT()
  const waiver = waivers.find((candidate) => candidate.ruleId === infraction.ruleId)
  const description = waiver
    ? waiverSummary(waiver, t)
    : formatInfractionReason(infraction, t)
  const callbacksRef = useRef({ onOpenChange, onOpenRule, onWaive, onUnwaive })
  const generationRef = useRef(0)
  const activeGenerationRef = useRef(0)
  callbacksRef.current = { onOpenChange, onOpenRule, onWaive, onUnwaive }

  useEffect(() => {
    if (!open) return
    const generation = ++generationRef.current
    const toastId = toast.add({
      // Keep one visible toast while tracking effect setups separately. The
      // generation prevents StrictMode's discarded close from clearing state.
      id: `violation:${infraction.cellId}:${infraction.ruleId}`,
      type: waiver ? "info" : "warning",
      timeout: 0,
      title: (
        <button
          type="button"
          className="text-start hover:underline"
          onClick={() => {
            callbacksRef.current.onOpenRule(infraction.ruleId)
            toast.close(toastId)
          }}
        >
          {ruleName}
        </button>
      ),
      description,
      actionProps: {
        children: waiver
          ? t("rules.violationPopover.unwaive")
          : t("rules.violationPopover.waive"),
        onClick: () => {
          if (waiver) callbacksRef.current.onUnwaive(infraction.ruleId)
          else callbacksRef.current.onWaive({ ruleId: infraction.ruleId })
          toast.close(toastId)
        },
      },
      onClose: () => {
        // React StrictMode replays effects in development. Ignore the close
        // from that discarded setup, while still reflecting a user dismissal.
        if (activeGenerationRef.current !== generation) return
        activeGenerationRef.current = 0
        callbacksRef.current.onOpenChange(false)
      },
    })
    activeGenerationRef.current = generation

    return () => {
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = 0
      }
      toast.close(toastId)
    }
  }, [description, infraction.cellId, infraction.ruleId, open, ruleName, t, waiver])

  return null
}

function waiverSummary(waiver: RuleWaiver, t: TFunction): string {
  const parts = [
    t("rules.violationPopover.waivedAt", { time: relativeTime(waiver.waivedAt, t) }),
  ]
  if (waiver.reason) parts.push(waiver.reason)
  if (waiver.waivedBy) {
    parts.push(t("rules.violationPopover.waivedBy", { user: waiver.waivedBy }))
  }
  return parts.join(" · ")
}

function relativeTime(iso: string, t: TFunction): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return t("nav.outbox.timeJustNow")
  if (mins < 60) return t("nav.outbox.timeMinutesAgo", { min: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("nav.outbox.timeHoursAgo", { hr: hrs })
  return t("nav.outbox.timeDaysAgo", { d: Math.floor(hrs / 24) })
}
