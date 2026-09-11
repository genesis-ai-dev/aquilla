import type { OverflowMenuItem } from "@/components/OverflowMenu"

/** Shared chrome for the editor chapter row and the agent workbench row.
 *  Height is `py-2` plus the `h-8` segmented control. Start inset is `ps-4`
 *  so a 16px leading icon has the same air on the left as above it; end
 *  inset stays `pe-2` so trailing icon buttons sit closer to the edge. */
export const EDITOR_SURFACE_TOOLBAR_CLASS =
  "relative flex min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background/90 py-2 ps-4 pe-2 backdrop-blur-xl"

/** Square outline ⋯ matching the mode switch height on both surfaces. */
export const EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS = "size-8 p-0 bg-card shadow-xs"

/**
 * File-identity actions that still apply on Agent. Editor-only tools
 * (Check file, Draft as you read, View settings, Next unfinished, Diarize)
 * stay on the chapter row — they operate on the translation grid, not the
 * agent working set.
 */
const AGENT_SURFACE_FILE_OPTION_IDS = new Set([
  "file-rename",
  "file-move",
  "assign-work",
  "file-segmentation",
  "file-export",
  "file-export-source",
  "file-delete",
])

export function fileOptionsForAgentSurface(items: OverflowMenuItem[]): OverflowMenuItem[] {
  const kept: OverflowMenuItem[] = []
  for (const item of items) {
    if (item.type === "separator") {
      if (kept.length > 0 && kept[kept.length - 1]?.type !== "separator") kept.push(item)
      continue
    }
    if (AGENT_SURFACE_FILE_OPTION_IDS.has(item.id)) kept.push(item)
  }
  if (kept[kept.length - 1]?.type === "separator") kept.pop()
  return kept
}
