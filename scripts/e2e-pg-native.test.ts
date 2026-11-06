import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8")

// AQU-1820: the native-Postgres path is the suite's documented Docker-less
// prerequisite. It only works while the provisioning helper and the reset in
// e2e-up.ts agree on the endpoint, the role and the env var name, so pin that
// handshake here — a drift on either side strands every AFK run again.
describe("native Postgres provisioning helper (scripts/e2e-pg-native.sh)", () => {
  const script = read("scripts/e2e-pg-native.sh")

  it("provisions exactly what the e2e reset connects to", () => {
    expect(script).toMatch(/^#!/)
    expect(script).toContain("set -euo pipefail")
    // The endpoint e2e-up.ts builds E2E_PG_URL from (AQU-2107: IPv4 literal).
    expect(script).toContain("PGPORT=\"${E2E_PG_PORT:-5432}\"")
    expect(script).toContain("127.0.0.1")
    expect(script).toContain("PG_ROLE=aquilla")
    // DROP/CREATE DATABASE on every run is why the role is a superuser.
    expect(script).toContain("SUPERUSER")
    // The one stdout line the caller evals; e2e-up.ts reads this exact name.
    expect(script).toContain('echo "export E2E_PG_ADMIN_URL=')
  })

  it("stays honest about the fallback it exists for", () => {
    const e2eUp = read("scripts/e2e-up.ts")
    expect(e2eUp).toContain("process.env.E2E_PG_ADMIN_URL")
    // The Docker-less branch the README now advertises.
    expect(e2eUp).toContain("hasLocalPsql()")
    expect(e2eUp).toContain("scripts/e2e-pg-native.sh")
  })
})
