import type { MemberLaneAccess } from "@/lib/lanes/lane-access-choice"
import { createServerInvite, type ServerInviteCreated } from "@/lib/sync/invites"

/**
 * Mint a project invite, adding the lane choice only when the sharer made one.
 * Lives outside invites.ts so a test mock of that module still sees the
 * underlying createServerInvite call, with the same argument list as before
 * when no choice was required.
 */
export function createServerInviteWithChoice(
  jwt: string,
  projectId: string,
  role: number,
  email: string | undefined,
  expiresInDays: number | null | undefined,
  access: MemberLaneAccess | undefined,
): Promise<ServerInviteCreated | null> {
  if (access && "scopeLanes" in access) {
    return createServerInvite(jwt, projectId, role, undefined, email, expiresInDays, access.scopeLanes)
  }
  if (access) {
    return createServerInvite(jwt, projectId, role, undefined, email, expiresInDays, undefined, true)
  }
  if (expiresInDays !== undefined) {
    return createServerInvite(jwt, projectId, role, undefined, email, expiresInDays)
  }
  if (email !== undefined) {
    return createServerInvite(jwt, projectId, role, undefined, email)
  }
  return createServerInvite(jwt, projectId, role)
}
