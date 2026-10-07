import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const regimen = readFileSync(path.join(root, "e2e/journeys/QA-BOT-REGIMEN.md"), "utf8")
const deploy = readFileSync(path.join(root, "e2e/journeys/DEPLOY-BOT.md"), "utf8")

describe("the merge rule the bots follow", () => {
  it("merges on ci.yml, not on the walk", () => {
    expect(regimen).toContain("The `ci.yml` jobs are green")
    expect(regimen).toContain("does not have the label `on hold`")
    expect(regimen).toContain("The base is `dev`")
    expect(regimen).toContain("not stacked on an open parent")
    expect(regimen).toContain("`FAIL`, `FLAKY`, and `BLOCKED` still merge")
    expect(regimen).not.toContain("is **PASS** for that sha")
    expect(regimen).toContain("GitHub Actions does not click merge")
    expect(regimen).toContain("`enforce_admins` is false")
  })

  it("holds a release HEAD only on a smart-Jev FAIL", () => {
    for (const text of [regimen, deploy]) {
      expect(text).toContain("Only a result for the branch's current HEAD counts")
      expect(text).toContain("does not deploy")
      expect(text).toContain("`INCONCLUSIVE` and `HARNESS UNAVAILABLE` do not hold")
      expect(text).toContain("does not affect the cut or the deploy")
    }
    expect(deploy).toContain("This bot does not start Jev and does not read its result")
    expect(deploy).toContain("refs/heads/release/YYYY/MM/DD-NN")
  })
})
