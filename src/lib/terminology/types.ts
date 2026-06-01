// TEMP STUB — SWARM-TODO: superseded by WS-TERM-DATA agent's real implementation.
// Remove this file at merge; do NOT extend the logic here.

export type RenderingStatus = 'preferred' | 'admitted' | 'forbidden'

export interface TermRendering {
  rendering: string
  status: RenderingStatus
}

export interface Concept {
  id: string
  sourceTerm: string
  renderings: TermRendering[]
  notes?: string
  status: 'active' | 'draft' | 'deprecated'
  createdAt: string
  createdBy?: string
  updatedAt?: string
}
