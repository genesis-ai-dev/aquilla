import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

type DependabotUpdate = {
  "package-ecosystem": string
  directory: string
}

function npmDirectories(): string[] {
  const raw = readFileSync(path.join(REPO_ROOT, ".github", "dependabot.yml"), "utf8")
  const config = parse(raw) as { updates: DependabotUpdate[] }
  return config.updates
    .filter((update) => update["package-ecosystem"] === "npm")
    .map((update) => update.directory)
}

// AQU-1204: the /auth-worker job crashed during file fetching with
// `undefined method '[]' for nil` and so never opened a dependency PR at all.
// Dependabot's npm_and_yarn file fetcher guards only against a *missing*
// pnpm-workspace.yaml (`return {} unless pnpm_workspace_yaml`) before indexing
// the parse result (`parsed_pnpm_workspace_yaml["packages"]`). auth-worker's
// file existed but held nothing except comments, which YAML parses to nil.
// `typeof null` is "object" in JS, so classify explicitly — otherwise the
// assertion below would pass on exactly the value that crashed Dependabot.
function shape(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "sequence"
  return typeof value === "object" ? "mapping" : typeof value
}

describe("pnpm-workspace.yaml files Dependabot has to read (AQU-1204)", () => {
  it("parses every one to a mapping, never to null", () => {
    const directories = npmDirectories()
    expect(directories.length).toBeGreaterThan(0)

    // A comment-only file is the specific shape that crashed the fetcher, so
    // assert the parsed value per directory rather than merely that the file
    // is non-empty on disk.
    const parsed = directories
      .map((directory) => ({
        directory,
        file: path.join(REPO_ROOT, directory, "pnpm-workspace.yaml"),
      }))
      .filter(({ file }) => existsSync(file))
      .map(({ directory, file }) => [directory, shape(parse(readFileSync(file, "utf8")))])

    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed).toEqual(parsed.map(([directory]) => [directory, "mapping"]))
  })
})
