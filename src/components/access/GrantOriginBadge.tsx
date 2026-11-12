import { Badge } from "@/components/ui/badge"
import type { GrantOrigin } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { originLabel } from "./labels"

/** AQU-1352 §3.7 rule 1: every roster row carries its origin as a badge. */
export function GrantOriginBadge({ origin, className }: { origin: GrantOrigin; className?: string }) {
  const t = useT()
  return (
    <Badge variant="soft" className={className} data-origin={origin.kind}>
      {originLabel(t, origin)}
    </Badge>
  )
}
