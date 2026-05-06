import type { EventKind } from './types'

// Numeric role levels matching frontier-server's role hierarchy.
// 100-gaps for future extensibility (e.g. inserting a 350 between
// REVIEWER and CONTRIBUTOR if a workflow ever needs it).
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

// Source of truth for "who can do what." Adding a new EventKind triggers a
// TypeScript exhaustiveness error here until a row is added — the type
// system enforces that every event kind has an explicit role requirement.
export const REQUIRED_ROLE: Record<EventKind, number> = {
  'cell.commit': ROLE.CONTRIBUTOR,
  'cell.validate': ROLE.REVIEWER,
  'cell.unvalidate': ROLE.REVIEWER,
  'thread.add': ROLE.COMMENTER,
  'thread.resolve': ROLE.REVIEWER,
  'cell.metadata.set': ROLE.CONTRIBUTOR,
  // file.create is a structural project change — gated to PROJECT_LEAD so
  // contributors can't sprinkle stray file rows during normal editing. The
  // legacy import path uses an admin sync-token with this role.
  'file.create': ROLE.PROJECT_LEAD,
}

export function requiredRoleFor(kind: EventKind): number {
  return REQUIRED_ROLE[kind]
}
