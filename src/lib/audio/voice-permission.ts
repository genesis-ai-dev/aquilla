import { ROLE } from "@/lib/frontier/roles"

/**
 * AQU-2041. A local project (no role) and a maintainer may always manage
 * voices. A project lead may only when the project setting is on and, when
 * the caller passes it, the lane they are writing is one they can write.
 * Contributors and viewers never may.
 */
export function canManageVoices(
  roleLevel: number | null | undefined,
  leadsManageVoices: boolean,
  laneReady = true,
): boolean {
  if (roleLevel == null) return true
  if (roleLevel >= ROLE.MAINTAINER) return true
  return roleLevel >= ROLE.PROJECT_LEAD && leadsManageVoices && laneReady
}
