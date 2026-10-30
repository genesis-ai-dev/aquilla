/** Only an organization invitation may be carried through a reset email.
 * Do not accept arbitrary URLs, query strings, encoded separators or dot paths.
 * This context is navigation only: accepting the invitation still needs auth.
 */
export function orgInviteReturnTo(value: unknown): string | undefined {
  return typeof value === "string" && value === value.trim()
    && /^\/join-org\/[A-Za-z0-9_-]{8,256}$/.test(value)
    ? value
    : undefined
}
