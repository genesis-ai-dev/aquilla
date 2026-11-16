import { describe, expect, it } from "vitest"
import {
  ceilingRefusal,
  MAINTENANCE_SESSION_OPTIONS,
  type SessionSetting,
} from "./maintenance-session"
import { neonClient, neonConfig } from "./neon-connection"

const row = (name: string, setting: string, source: string): SessionSetting => ({
  name,
  setting,
  unit: "ms",
  source,
})

/** What a direct session reports once the startup options have arrived. */
const LIFTED = [
  row("idle_in_transaction_session_timeout", "0", "client"),
  row("statement_timeout", "0", "client"),
]

describe("maintenance sessions opt out of the workers' timeout ceilings", () => {
  const NEON_ENV = {
    NEON_PG_HOST: "direct.example.invalid",
    NEON_PG_POOLER_HOST: "pooler.example.invalid",
    NEON_PG_PASSWORD: "not-a-real-password",
  }
  const optionsOf = (client: unknown) =>
    (client as { connectionParameters: { options?: string } }).connectionParameters.options

  it("zeroes both ceilings at startup, where a role default cannot outrank them", () => {
    expect(MAINTENANCE_SESSION_OPTIONS).toBe(
      "-c statement_timeout=0 -c idle_in_transaction_session_timeout=0",
    )
  })

  it("sends the options on a direct Neon connection but not through the pooler", () => {
    expect(neonConfig(false, NEON_ENV)).toMatchObject({
      host: "direct.example.invalid",
      options: MAINTENANCE_SESSION_OPTIONS,
    })
    expect(neonConfig(true, NEON_ENV)).not.toHaveProperty("options")
    expect(optionsOf(neonClient(false, NEON_ENV))).toBe(MAINTENANCE_SESSION_OPTIONS)
  })

  it("sends the options to the local dev-stack database too", () => {
    const client = neonClient(false, {
      AQUILLA_LOCAL_PG_URL: "postgresql://aquilla:local@127.0.0.1:5432/aquilla",
    })
    expect(optionsOf(client)).toBe(MAINTENANCE_SESSION_OPTIONS)
  })
})

describe("the migration runner refuses to start under a ceiling", () => {
  it("proceeds when both ceilings read 0", () => {
    expect(ceilingRefusal(LIFTED)).toBeNull()
  })

  it("refuses when a role default is still in force, and says which", () => {
    const refusal = ceilingRefusal([
      row("idle_in_transaction_session_timeout", "30000", "user"),
      row("statement_timeout", "15000", "user"),
    ])
    expect(refusal).toContain("statement_timeout=15000ms (source: user)")
    expect(refusal).toContain("idle_in_transaction_session_timeout=30000ms (source: user)")
    expect(refusal).toContain("Nothing was applied")
  })

  it("refuses when only one of the two is in force", () => {
    expect(ceilingRefusal([LIFTED[0], row("statement_timeout", "15000", "user")])).toContain(
      "statement_timeout=15000ms",
    )
  })

  it("refuses when the settings could not be read at all", () => {
    expect(ceilingRefusal([])).toContain("neither setting was readable")
  })
})
