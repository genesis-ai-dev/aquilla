// TEMP STUB — SWARM-TODO: superseded by WS-TERM-DATA agent's real implementation.
// These are minimal type stubs so TerminologyPage.tsx can typecheck.
// Do NOT add logic here; the data agent owns this module.

import type { Concept } from './types'

export function addConcept(_concept: Omit<Concept, 'id' | 'createdAt'>): Promise<Concept> {
  return Promise.reject(new Error('STUB: not implemented — see WS-TERM-DATA agent'))
}

export function updateConcept(_id: string, _patch: Partial<Concept>): Promise<Concept> {
  return Promise.reject(new Error('STUB: not implemented — see WS-TERM-DATA agent'))
}

export function deleteConcept(_id: string): Promise<void> {
  return Promise.reject(new Error('STUB: not implemented — see WS-TERM-DATA agent'))
}
