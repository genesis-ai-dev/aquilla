/**
 * AQU-1579. An invite bound to an email address may be redeemed only by an
 * account that has proven it controls that address. Registration stores the
 * address and mints a verification token; `POST /api/v2/auth/verify-email`
 * is what stamps `users.email_verified_at`. A matching string alone is not
 * that proof.
 *
 * Invites with no bound email are unchanged: pass a null/empty email and
 * this returns null.
 */
export const EMAIL_UNVERIFIED_INVITE_BODY = {
  error: "Verify your email address before accepting an invite sent to it.",
  code: "email_unverified",
} as const

export async function emailBoundInviteUnverified(
  db: AquillaDb,
  userId: number,
  inviteEmail: string | null | undefined,
): Promise<typeof EMAIL_UNVERIFIED_INVITE_BODY | null> {
  if (!inviteEmail) return null
  const row = await db
    .prepare("SELECT email_verified_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email_verified_at: string | null }>()
  if (row?.email_verified_at) return null
  return EMAIL_UNVERIFIED_INVITE_BODY
}
