import { readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

// AQU-681: non-security bumps lag the latest published version by ~1 week.
const COOLDOWN_DAYS = 7

type DependabotUpdate = {
  "package-ecosystem": string
  directory: string
  cooldown?: { "default-days"?: number }
}

function readUpdates(): DependabotUpdate[] {
  const raw = readFileSync(path.join(REPO_ROOT, ".github", "dependabot.yml"), "utf8")
  const config = parse(raw) as { version: number; updates: DependabotUpdate[] }
  expect(config.version).toBe(2)
  return config.updates
}

const label = (update: DependabotUpdate) =>
  `${update["package-ecosystem"]}:${update.directory}`

describe("Dependabot version-update cooldown (AQU-681)", () => {
  it("holds every ecosystem one week behind the latest release", () => {
    const updates = readUpdates()

    // A new ecosystem entry added without a cooldown would silently opt that
    // package manager back into same-day releases, so assert per entry rather
    // than spot-checking one.
    expect(updates.length).toBeGreaterThan(0)
    expect(
      updates.map((update) => [label(update), update.cooldown?.["default-days"]]),
    ).toEqual(updates.map((update) => [label(update), COOLDOWN_DAYS]))
  })

  it("does not reintroduce the 30-day lag the ticket replaced", () => {
    const raw = readFileSync(path.join(REPO_ROOT, ".github", "dependabot.yml"), "utf8")

    expect(raw).not.toMatch(/^\s*default-days:\s*30\s*$/m)
  })
})
