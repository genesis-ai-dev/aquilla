// How every script under scripts/ reaches Neon (or the local dev-stack
// database) with `pg`. Re-exported by scripts/pg.ts, which is where the
// scripts import it from.
import net from "node:net"
import dns from "node:dns"
import { Client } from "pg"
import { MAINTENANCE_SESSION_OPTIONS } from "./maintenance-session"

// Neon publishes AAAA records, but many networks (and geo-restricted locales)
// have no IPv6 route to it. Node's happy-eyeballs (autoSelectFamily, default-on
// since v20) then stalls on the unreachable v6 addresses and pg surfaces a bare
// `AggregateError` instead of falling through to the working IPv4 path. Prefer
// IPv4 and disable the auto-selection race so every neon script connects.
dns.setDefaultResultOrder("ipv4first")
net.setDefaultAutoSelectFamily?.(false)

/** `env` is a parameter so a test can pass one; every script uses the default. */
type Env = Record<string, string | undefined>

export function neonConfig(pooled = false, env: Env = process.env) {
  const host = pooled ? env.NEON_PG_POOLER_HOST : env.NEON_PG_HOST
  if (!host || !env.NEON_PG_PASSWORD) {
    throw new Error("Neon creds missing — run: set -a; . ./.env; set +a")
  }
  return {
    host,
    database: env.NEON_PG_DB,
    user: env.NEON_PG_ROLE,
    password: env.NEON_PG_PASSWORD,
    port: 5432,
    ssl: { rejectUnauthorized: true }, // Neon uses publicly-trusted certs
    // Keeps a role-level timeout default (set for the workers) off this
    // session. The pooler does not pass `options` through, so direct only.
    ...(pooled ? {} : { options: MAINTENANCE_SESSION_OPTIONS }),
  }
}

export function neonClient(pooled = false, env: Env = process.env): Client {
  // `neon-target.ts local` points every neon:* script at the dev-stack
  // container: plain TCP, no SSL, no Neon creds.
  const local = env.AQUILLA_LOCAL_PG_URL?.trim()
  if (local) return new Client({ connectionString: local, options: MAINTENANCE_SESSION_OPTIONS })
  return new Client(neonConfig(pooled, env))
}
