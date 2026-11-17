// Decides whether the desktop shell needs a release, and writes the version
// bump when it does. .github/workflows/desktop-release-cut.yml acts on the
// plan; the rules are in scripts/lib/desktop-release.ts::planCut and
// docs/DESKTOP-RELEASES.md.
//
//   tsx scripts/desktop-release-cut.ts plan          → the plan, as JSON
//   tsx scripts/desktop-release-cut.ts bump 0.2.4 0.2.5
//
// `plan` reads BUMP_PR_OPEN=true|false from the environment (the workflow looks
// for a bump branch in this repository; a local run defaults to false).

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readMinShellVersion } from "./lib/desktop-bundle"
import { bumpVersionFile, planCut, VERSION_FILES } from "./lib/desktop-release"

const root = path.resolve(import.meta.dirname, "..")
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const lines = (text: string) => text.split("\n").filter((l) => l.length > 0)

const [command, ...args] = process.argv.slice(2)

if (command === "plan") {
  const headVersion = readMinShellVersion(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  const taggedVersions = lines(git("tag", "-l", "v*")).map((t) => t.slice(1))
  const changedSinceTag = taggedVersions.includes(headVersion)
    ? lines(git("diff", "--name-only", `v${headVersion}`, "HEAD"))
    : []
  const plan = planCut({ headVersion, taggedVersions, changedSinceTag, bumpPrOpen: process.env.BUMP_PR_OPEN === "true" })
  process.stdout.write(`${JSON.stringify(plan)}\n`)
} else if (command === "bump" && args.length === 2) {
  const [from, to] = args
  for (const file of VERSION_FILES) {
    const full = path.join(root, file)
    writeFileSync(full, bumpVersionFile(file, readFileSync(full, "utf8"), from, to))
  }
  process.stdout.write(`bumped ${VERSION_FILES.join(", ")} from ${from} to ${to}\n`)
} else {
  process.stderr.write("usage: desktop-release-cut.ts plan | bump <from> <to>\n")
  process.exit(2)
}
