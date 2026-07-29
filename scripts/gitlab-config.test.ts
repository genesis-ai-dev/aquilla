import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const LIVE_GITLAB_ORIGIN = "https://git.genesisrnd.com"
const RETIRED_GITLAB_ORIGIN = "https://gitlab.frontierrnd.com"

describe("GitLab migration configuration", () => {
  it("points every auth-worker environment at the live GitLab origin", () => {
    const config = readFileSync(
      path.join(REPO_ROOT, "auth-worker", "wrangler.toml"),
      "utf8",
    )
    const configuredOrigins = [...config.matchAll(/^GITLAB_URL = "([^"]+)"$/gm)]
      .map((match) => match[1])

    expect(configuredOrigins).toHaveLength(4)
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
