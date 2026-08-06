import type { Layout } from "react-resizable-panels"

export type AgentWorkbenchPreset = "balanced" | "luna" | "review"

export const AGENT_WORKBENCH_LAYOUTS: Record<AgentWorkbenchPreset, Layout> = {
  balanced: { source: 28, luna: 44, target: 28 },
  luna: { source: 20, luna: 60, target: 20 },
  review: { source: 24, luna: 30, target: 46 },
}

const PANE_IDS = ["source", "luna", "target"] as const
const DEFAULT_LAYOUT = AGENT_WORKBENCH_LAYOUTS.balanced

function isValidLayout(value: unknown): value is Layout {
  if (!value || typeof value !== "object") return false
  const layout = value as Record<string, unknown>
  const sizes = PANE_IDS.map((id) => layout[id])
  return (
    sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size >= 0) &&
    Math.abs((sizes as number[]).reduce((sum, size) => sum + size, 0) - 100) < 1
  )
}

export function agentWorkbenchLayoutKey(projectId: string): string {
  return `aquilla:agent-workbench-layout:${projectId}`
}

export function readAgentWorkbenchLayout(projectId: string): Layout {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT }
  try {
    const stored = window.localStorage.getItem(agentWorkbenchLayoutKey(projectId))
    if (!stored) return { ...DEFAULT_LAYOUT }
    const parsed: unknown = JSON.parse(stored)
    return isValidLayout(parsed) ? parsed : { ...DEFAULT_LAYOUT }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function writeAgentWorkbenchLayout(projectId: string, layout: Layout): void {
  if (typeof window === "undefined" || !isValidLayout(layout)) return
  try {
    window.localStorage.setItem(agentWorkbenchLayoutKey(projectId), JSON.stringify(layout))
  } catch {
    // A private browsing/storage policy should not make the workbench unusable.
  }
}

export function matchingAgentWorkbenchPreset(layout: Layout): AgentWorkbenchPreset | null {
  for (const preset of Object.keys(AGENT_WORKBENCH_LAYOUTS) as AgentWorkbenchPreset[]) {
    const candidate = AGENT_WORKBENCH_LAYOUTS[preset]
    if (PANE_IDS.every((id) => Math.abs((layout[id] ?? 0) - candidate[id]) < 0.75)) return preset
  }
  return null
}
