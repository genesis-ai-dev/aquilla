/**
 * The lock beside a locked Living Memory control. It names, on a click, why
 * the viewer cannot edit: offline, or below the role the control is gated on
 * (AQU-255 pattern; AQU-2260 — a click, never a hover).
 */

import { Lock } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { NoteOnClick } from "@/components/ui/info-note"

/** Which floor a locked control is actually gated on. */
export type LockedRole = "maintainer" | "projectLead" | "contributor"

const ROLE_TOOLTIP_KEY = {
  maintainer: "terminology.livingMemory.maintainerRequiredTooltip",
  projectLead: "terminology.livingMemory.projectLeadRequiredTooltip",
  contributor: "terminology.livingMemory.contributorRequiredTooltip",
} as const

export function RoleLockTooltip({
  reason,
  // Instructions are maintainer-gated; the style-rule library gates on lower
  // floors, so the lock must name the real one rather than overstate it.
  requiredRole = "maintainer",
}: {
  reason: "offline" | "role" | null
  requiredRole?: LockedRole
}) {
  const t = useT()
  if (reason === null) return null
  const message =
    reason === "offline"
      ? t("terminology.livingMemory.offlineTooltip")
      : t(ROLE_TOOLTIP_KEY[requiredRole])
  return (
    <NoteOnClick note={message} label={message} side="left" className="text-muted-foreground/50 hover:text-muted-foreground">
      <Lock className="h-3 w-3" aria-hidden="true" />
    </NoteOnClick>
  )
}
