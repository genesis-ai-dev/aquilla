import { Building2, FileText, Layers, Users, type LucideIcon } from "lucide-react"

import type { ScopeType } from "@/lib/access/types"

/**
 * AQU-2317 (AQU-1352 §3.9): one icon per kind of place. Titles, chips, dialogs
 * and exports all read a place out of `formatScopePath`; this map is what makes
 * the same place *look* the same wherever it appears. Its own module so a
 * component is never the thing a later slice has to import a constant from.
 */
export const PLACE_ICON: Record<ScopeType, LucideIcon> = {
  org: Building2,
  team: Users,
  project: FileText,
  lane: Layers,
}
