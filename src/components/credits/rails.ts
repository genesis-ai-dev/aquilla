// Rail palette + cap-danger helper for the credit surfaces. Kept separate from
// credit-visuals.tsx (which exports the React components) so fast-refresh isn't
// disrupted by mixing component and non-component exports in one module.

import type { useT } from "@/lib/i18n/I18nProvider"

/** MessageKey, without importing from the generated catalog — see LeftDock.tsx. */
type RailMessageKey = Parameters<ReturnType<typeof useT>>[0]

export type Rail = "agent" | "llm" | "tts"

/** Display metadata per rail. `labelKey` is user-facing; `dot`/`seg` are
 *  Tailwind bg classes for the legend dot and the segmented-bar fill. */
export const RAIL_META: Record<Rail, { labelKey: RailMessageKey; dot: string; seg: string }> = {
  agent: { labelKey: "nav.dock.agentTab", dot: "bg-amber-500", seg: "bg-amber-500" },
  llm: { labelKey: "onboarding.credits.rail.llm", dot: "bg-sky-500", seg: "bg-sky-500" },
  tts: { labelKey: "onboarding.credits.rail.tts", dot: "bg-violet-500", seg: "bg-violet-500" },
}

// Agent first: it's the elevated rail (own cap, 5× markup) and the one an
// operator most needs to notice, so it anchors the left of every bar/legend.
export const RAIL_ORDER: Rail[] = ["agent", "llm", "tts"]

/** Color the % figure by how close spend is to the cap — the danger signal,
 *  independent of the rail-composition colors. */
export function pctTextClass(pct: number): string {
  if (pct >= 90) return "text-destructive"
  if (pct >= 70) return "text-amber-600 dark:text-amber-500"
  return "text-muted-foreground"
}
