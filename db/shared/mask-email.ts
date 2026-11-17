// AQU-2576 — one masking rule for every surface that has to *name* an email
// address it must not hand over.
//
// The join-link rejection is the motivating case: an invite bound to an
// address the signed-in account doesn't own has to say WHICH address it
// wanted, or neither the recipient nor the project owner can act on it. The
// full address is not ours to disclose — the person holding the link is, by
// definition, not the person it was minted for — so the local part is reduced
// to its first and last character and the domain is kept intact. That is
// enough for the invited person to recognise their own address, and useless
// to someone fishing for one.
//
// Masking is presentation only. Every comparison, lookup and authorization
// check runs against the real address; nothing branches on a masked string.

/**
 * Mask the local part of an email, keeping the domain: `naladda@proton.me`
 * becomes `n…a@proton.me`.
 *
 * - A local part of 1 character becomes `…` (there is nothing to keep that
 *   would not be the whole thing).
 * - A local part of 2 characters keeps only the first (`ab@x` → `a…@x`), so
 *   the mask never reproduces the input.
 * - Anything that is not a recognisable `local@domain` string is masked whole
 *   as `…`, so a malformed row can never leak verbatim.
 */
export function maskEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) return "…"
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length <= 1) return `…@${domain}`
  if (local.length === 2) return `${local[0]}…@${domain}`
  return `${local[0]}…${local[local.length - 1]}@${domain}`
}

/**
 * Does this identifier look like an email address rather than a username?
 *
 * Deliberately loose: it only decides which *lookup* to try, never whether an
 * address is valid. Usernames cannot contain `@` (signup rejects it), so the
 * presence of an `@` with something either side is a sufficient tell.
 */
export function looksLikeEmail(identifier: string): boolean {
  const trimmed = identifier.trim()
  const at = trimmed.lastIndexOf("@")
  return at > 0 && at < trimmed.length - 1 && !/\s/.test(trimmed)
}
