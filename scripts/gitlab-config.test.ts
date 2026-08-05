import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const LIVE_GITLAB_ORIGIN = "https://git.genesisrnd.com"
const RETIRED_GITLAB_ORIGIN = "https://gitlab.frontierrnd.com"

describe("GitLab migration configuration", () => {
  it("enables legacy-user migration in both production configuration blocks", () => {
    const config = readFileSync(
      path.join(REPO_ROOT, "auth-worker", "wrangler.toml"),
      "utf8",
    )
    const productionMarker = "[env.production.vars]"
    const productionStart = config.indexOf(productionMarker)
    const productionEnd = config.indexOf(
      "\n[",
      productionStart + productionMarker.length,
    )
    const topLevel = config.slice(0, productionStart)
    const production = config.slice(productionStart, productionEnd)

    expect(productionStart).toBeGreaterThan(-1)
    expect(productionEnd).toBeGreaterThan(productionStart)
    expect(topLevel).toContain('LEGACY_USER_MIGRATION_ENABLED = "true"')
    expect(production).toContain('LEGACY_USER_MIGRATION_ENABLED = "true"')
  })

  it("points every auth-worker environment at the live GitLab origin", () => {
    const config = readFileSync(
      path.join(REPO_ROOT, "auth-worker", "wrangler.toml"),
      "utf8",
    )
    const configuredOrigins = [...config.matchAll(/^GITLAB_URL = "([^"]+)"$/gm)]
      .map((match) => match[1])

    // One per config block that declares GITLAB_URL: top-level (local),
    // [env.production.vars], [env.development.vars]. Staging was retired.
    expect(configuredOrigins).toHaveLength(3)
    expect(new Set(configuredOrigins)).toEqual(new Set([LIVE_GITLAB_ORIGIN]))
    expect(config).not.toContain(RETIRED_GITLAB_ORIGIN)
  })

  it("keeps the local configuration example on the live origin", () => {
    const example = readFileSync(
      path.join(REPO_ROOT, "auth-worker", ".dev.vars.example"),
      "utf8",
    )

    expect(example).toContain(`GITLAB_URL="${LIVE_GITLAB_ORIGIN}"`)
    expect(example).not.toContain(RETIRED_GITLAB_ORIGIN)
  })
})
