import type { AquillaDb } from "../../../db/shim/postgres"

/** Read-only capability check: a successful build does not prove the migration
 * reached this database. Do not send a user to Google for an unusable signup. */
export async function googleLoginSchemaReady(db: AquillaDb): Promise<boolean> {
  try {
    const password = await db.prepare(`SELECT NOT attnotnull AS nullable FROM pg_attribute
      WHERE attrelid='users'::regclass AND attname='password_hash' AND NOT attisdropped`).first<{ nullable: boolean }>()
    if (password?.nullable !== true) return false
    // Parse every column the flow depends on, without reading account data.
    await db.prepare(`SELECT p.provider, p.subject, p.user_id, f.state_hash,
      f.browser_challenge, f.google_verifier, f.nonce, f.app_origin, f.status,
      f.code_hash, f.subject, f.email, f.authoritative_email, f.expires_at
      FROM provider_identities p CROSS JOIN social_login_flows f LIMIT 0`).all()
    const constraints = await db.prepare(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='provider_identities'::regclass`).all<{ definition: string }>()
    const definitions = constraints.results.map(row => row.definition)
    return definitions.some(value => value === 'PRIMARY KEY (provider, subject)') &&
      definitions.some(value => value === 'UNIQUE (provider, user_id)') &&
      definitions.some(value => /^FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE$/.test(value))
  } catch { return false }
}
