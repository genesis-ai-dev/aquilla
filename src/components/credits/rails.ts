// Rail palette + cap-danger helper for the credit surfaces. Kept separate from
// credit-visuals.tsx (which exports the React components) so fast-refresh isn't
// disrupted by mixing component and non-component exports in one module.

export type Rail = "agent" | "llm" | "tts"

/** Display metadata per rail. `label` is user-facing; `dot`/`seg` are Tailwind
 *  bg classes for the legend dot and the segmented-bar fill. */
export const RAIL_META: Record<Rail, { label: string; dot: string; seg: string }> = {
  agent: { label: "Agent", dot: "bg-amber-500", seg: "bg-amber-500" },
  llm: { label: "Chat", dot: "bg-sky-500", seg: "bg-sky-500" },
  tts: { label: "TTS", dot: "bg-violet-500", seg: "bg-violet-500" },
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
