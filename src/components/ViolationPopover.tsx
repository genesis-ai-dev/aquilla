import { useState } from "react"
import { Popover, PopoverContent } from "@/components/ui/popover"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { formatInfractionReason } from "@/lib/rules/format-infraction"

/** Rect snapshot of the clicked violation blot — the blot's DOM node may be
 *  detached by re-renders before the popover positions, so callers pass a
 *  virtual anchor instead of the element itself. */
export interface ViolationAnchor {
  getBoundingClientRect: () => DOMRect
}

interface ViolationPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  infraction: RuleInfraction
  ruleName: string
  waivers: RuleWaiver[]
  anchor: ViolationAnchor | null
  onOpenRule: (ruleId: string) => void
  onWaive: (input: { ruleId: string; reason?: string }) => void
  onUnwaive: (ruleId: string) => void
}

export function ViolationPopover({
  open, onOpenChange, infraction, ruleName, waivers, anchor,
  onOpenRule, onWaive, onUnwaive,
}: ViolationPopoverProps) {
  const t = useT()
  const waiver = waivers.find((w) => w.ruleId === infraction.ruleId)
  const [mode, setMode] = useState<"view" | "waive-reason">("view")
  const [reason, setReason] = useState("")

  const reset = () => { setMode("view"); setReason("") }

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <PopoverContent
        anchor={anchor}
        sideOffset={6}
        initialFocus={false}
        finalFocus={false}
        className="w-72 space-y-2 p-3 text-sm"
      >
        <button
          type="button"
          className="text-start font-medium hover:underline"
          onClick={() => onOpenRule(infraction.ruleId)}
        >
          {ruleName}
        </button>
        <p className="text-xs text-muted-foreground">{formatInfractionReason(infraction, t)}</p>

        {waiver && (
          <div className="rounded border border-muted-foreground/20 bg-muted/30 p-2 text-xs">
            <div className="font-medium">{t("rules.violationPopover.waivedAt", { time: relativeTime(waiver.waivedAt, t) })}</div>
            {waiver.reason && <div className="mt-0.5 text-muted-foreground">{waiver.reason}</div>}
            {waiver.waivedBy && (
              <div className="mt-0.5 text-muted-foreground">
                {t("rules.violationPopover.waivedBy", { user: waiver.waivedBy })}
              </div>
            )}
          </div>
        )}

        {mode === "view" && !waiver && (
          <button type="button" className={buttonCls} onClick={() => setMode("waive-reason")}>
            {t("rules.violationPopover.waive")}
          </button>
        )}
        {mode === "view" && waiver && (
          <button type="button" className={buttonCls} onClick={() => { onUnwaive(infraction.ruleId); reset() }}>
            {t("rules.violationPopover.unwaive")}
          </button>
        )}
        {mode === "waive-reason" && (
          <div className="space-y-2">
            <input
              className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t("rules.violationPopover.reasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button type="button" className={buttonCls} onClick={() => {
                onWaive({ ruleId: infraction.ruleId, ...(reason ? { reason } : {}) })
                reset()
              }}>
                {t("common.confirm")}
              </button>
              <button type="button" className={cn(buttonCls, "bg-transparent")} onClick={reset}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const buttonCls = "rounded border px-2 py-1 text-xs hover:bg-muted"

// Reuses nav's relative-time vocabulary (nav.outbox.time*) rather than
// authoring a near-identical set here — no-duplicates.test.ts flags an
// unexcused "just now" / "{n}m ago" collision, and this IS the same string.
function relativeTime(iso: string, t: TFunction): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return t("nav.outbox.timeJustNow")
  if (mins < 60) return t("nav.outbox.timeMinutesAgo", { min: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("nav.outbox.timeHoursAgo", { hr: hrs })
  return t("nav.outbox.timeDaysAgo", { d: Math.floor(hrs / 24) })
}
