// Pure planning for the frontier-db-v2 → aquilla-db user import.
//
// The codex author strings on migrated events ARE Frontier usernames, so once
// the legacy users exist in aquilla-db, attribution "links up" by username
// (and email). aquilla-db has no legacy_id column, so we dedup on the two
// UNIQUE keys it does have: username and email. Idempotent — a re-run finds
// every previously-inserted user already present and inserts nothing.

export interface SourceUser {
  username: string
  email: string
  password_hash: string
  created_at?: string | null
  updated_at?: string | null
}

export interface ExistingUser {
  username: string
  email: string
}

export interface UserImportPlan {
  /** New users (neither username nor email present in the target). Safe to INSERT. */
  toInsert: SourceUser[]
  /** Users already in the target (username AND email match the same row). */
  alreadyPresent: number
  /** Username or email collides with a DIFFERENT target row — skipped, surfaced. */
  conflicts: { username: string; email: string; reason: string }[]
}

const lc = (s: string | undefined | null): string => (s ?? "").trim().toLowerCase()

export function planUserImport(src: SourceUser[], existing: ExistingUser[]): UserImportPlan {
  const byUsername = new Map<string, ExistingUser>()
  const byEmail = new Map<string, ExistingUser>()
  for (const e of existing) {
    if (e.username) byUsername.set(lc(e.username), e)
    if (e.email) byEmail.set(lc(e.email), e)
  }

  const toInsert: SourceUser[] = []
  const conflicts: UserImportPlan["conflicts"] = []
  let alreadyPresent = 0

  for (const u of src) {
    if (!u.username || !u.email) {
      conflicts.push({ username: u.username, email: u.email, reason: "missing username or email" })
      continue
    }
    const mu = byUsername.get(lc(u.username))
    const me = byEmail.get(lc(u.email))

    if (mu && me) {
      // Both keys resolve. Same row → already imported. Different rows → the
      // legacy identity is split across two aquilla users; skip + surface.
      if (mu === me) alreadyPresent++
      else
        conflicts.push({
          username: u.username,
          email: u.email,
          reason: "username and email map to different existing users",
        })
      continue
    }
    if (mu) {
      conflicts.push({ username: u.username, email: u.email, reason: `username taken by <${mu.email}>` })
      continue
    }
    if (me) {
      conflicts.push({ username: u.username, email: u.email, reason: `email taken by @${me.username}` })
      continue
    }
    toInsert.push(u)
  }

  return { toInsert, alreadyPresent, conflicts }
}
