import type { Layout } from "react-resizable-panels"

const DEFAULT_LAYOUT: Layout = { source: 28, agent: 44, target: 28 }
const PANE_IDS = ["source", "agent", "target"] as const

function normalizeLayout(value: unknown): Layout | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  // The preserved prototype called the center pane "luna". Accept that key
  // so anyone who used the prototype keeps their chosen widths.
  const layout: Layout = {
    source: Number(raw.source),
    agent: Number(raw.agent ?? raw.luna),
    target: Number(raw.target),
  }
  const sizes = PANE_IDS.map((id) => layout[id])
  if (!sizes.every((size) => Number.isFinite(size) && size >= 0)) return null
  if (Math.abs(sizes.reduce((sum, size) => sum + size, 0) - 100) >= 1) return null
  return layout
}

function storageKey(projectId: string): string {
  return `aquilla:agent-workbench-layout:${projectId}`
}

export function readAgentWorkbenchLayout(projectId: string): Layout {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT }
  try {
    const stored = window.localStorage.getItem(storageKey(projectId))
    const normalized = stored ? normalizeLayout(JSON.parse(stored)) : null
    // A drag-to-collapse is an exit gesture, not the next session's layout.
    return normalized && normalized.agent > 0 ? normalized : { ...DEFAULT_LAYOUT }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function writeAgentWorkbenchLayout(projectId: string, layout: Layout): void {
  if (typeof window === "undefined") return
  const normalized = normalizeLayout(layout)
  if (!normalized || normalized.agent === 0) return
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(normalized))
  } catch {
    // Storage policy should never make the workbench unusable.
  }
}
