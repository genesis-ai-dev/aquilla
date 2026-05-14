import { useState } from "react"
import { Popover, PopoverContent } from "@/components/ui/popover"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

interface ViolationPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  infraction: RuleInfraction
  ruleName: string
  waivers: RuleWaiver[]
  anchor: HTMLElement | null
  onOpenRule: (ruleId: string) => void
  onWaive: (input: { ruleId: string; reason?: string }) => void
  onUnwaive: (ruleId: string) => void
}

export function ViolationPopover({
  open, onOpenChange, infraction, ruleName, waivers, anchor,
  onOpenRule, onWaive, onUnwaive,
}: ViolationPopoverProps) {
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
          className="text-left font-medium hover:underline"
          onClick={() => onOpenRule(infraction.ruleId)}
        >
          {ruleName}
        </button>
        <p className="text-xs text-muted-foreground">{infraction.message}</p>

        {waiver && (
          <div className="rounded border border-muted-foreground/20 bg-muted/30 p-2 text-xs">
            <div className="font-medium">Waived {relativeTime(waiver.waivedAt)}</div>
            {waiver.reason && <div className="mt-0.5 text-muted-foreground">{waiver.reason}</div>}
            {waiver.waivedBy && <div className="mt-0.5 text-muted-foreground">by {waiver.waivedBy}</div>}
          </div>
        )}

        {mode === "view" && !waiver && (
          <button type="button" className={buttonCls} onClick={() => setMode("waive-reason")}>
            Waive
          </button>
        )}
        {mode === "view" && waiver && (
          <button type="button" className={buttonCls} onClick={() => { onUnwaive(infraction.ruleId); reset() }}>
            Unwaive
          </button>
        )}
        {mode === "waive-reason" && (
          <div className="space-y-2">
            <input
              className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button type="button" className={buttonCls} onClick={() => {
                onWaive({ ruleId: infraction.ruleId, ...(reason ? { reason } : {}) })
                reset()
              }}>
                Confirm
              </button>
              <button type="button" className={cn(buttonCls, "bg-transparent")} onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const buttonCls = "rounded border px-2 py-1 text-xs hover:bg-muted"

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
