import { readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

type DependabotUpdate = {
  "package-ecosystem": string
  directory: string
  "multi-ecosystem-group"?: string
  patterns?: string[]
  groups?: unknown
  schedule?: unknown
}

type DependabotConfig = {
  "multi-ecosystem-groups"?: Record<string, { schedule?: { interval?: string } }>
  updates: DependabotUpdate[]
}

function readConfig(): DependabotConfig {
  const raw = readFileSync(path.join(REPO_ROOT, ".github", "dependabot.yml"), "utf8")
  return parse(raw) as DependabotConfig
}

const agentWorkerEntry = (config: DependabotConfig, ecosystem: string) => {
  const entry = config.updates.find(
    (update) =>
      update["package-ecosystem"] === ecosystem && update.directory === "/agent-worker",
  )
  expect(entry, `dependabot.yml must have a ${ecosystem} entry for /agent-worker`).toBeDefined()
  return entry as DependabotUpdate
}

// The @cloudflare/sandbox SDK and the Dockerfile's cloudflare/sandbox base
// image must be the same version (agent-worker/test/runtime-policy.test.ts).
// Dependabot bumped the SDK alone twice (0.7.0 -> 0.12.5, 0.12.5 -> 0.12.9)
// because the npm entry could not touch the Dockerfile. One multi-ecosystem
// group makes both bumps land in the same pull request.
describe("Dependabot keeps the agent-worker SDK and sandbox image together", () => {
  it("puts the npm and docker /agent-worker entries in one scheduled multi-ecosystem group", () => {
    const config = readConfig()
    const npm = agentWorkerEntry(config, "npm")
    const docker = agentWorkerEntry(config, "docker")

    const group = npm["multi-ecosystem-group"]
    expect(group, "npm /agent-worker must join a multi-ecosystem group").toBeTruthy()
    expect(docker["multi-ecosystem-group"]).toBe(group)
    expect(config["multi-ecosystem-groups"]?.[group as string]?.schedule?.interval).toBeTruthy()
  })

  it("covers every dependency in both ecosystems", () => {
    const config = readConfig()
    // `patterns` is required for multi-ecosystem members; a narrower pattern
    // on either side could drop the SDK or the base image out of the shared PR.
    for (const ecosystem of ["npm", "docker"]) {
      const entry = agentWorkerEntry(config, ecosystem)
      expect(entry.patterns, `${ecosystem} /agent-worker patterns`).toEqual(["*"])
      // A per-entry `groups` block or schedule would split updates back out
      // of the multi-ecosystem pull request.
      expect(entry.groups, `${ecosystem} /agent-worker groups`).toBeUndefined()
      expect(entry.schedule, `${ecosystem} /agent-worker schedule`).toBeUndefined()
    }
  })
})
