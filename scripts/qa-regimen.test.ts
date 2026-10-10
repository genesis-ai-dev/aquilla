import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const regimen = readFileSync(path.join(root, "e2e/journeys/QA-BOT-REGIMEN.md"), "utf8")
const deploy = readFileSync(path.join(root, "e2e/journeys/DEPLOY-BOT.md"), "utf8")
const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8")

describe("the merge rule the bots follow", () => {
  it("lets the agent merge its own pull request once the walk is PASS", () => {
    expect(regimen).toContain("An agent may merge its own pull request into `dev`")
    expect(regimen).toContain("is **PASS** for that sha")
    expect(regimen).toContain("no unresolved finding it could prove")
    expect(regimen).toContain("Those checks are the `ci.yml` jobs")
    expect(regimen).toContain("the label is `on hold`")
    expect(regimen).toContain("the base is not `dev`")
    expect(regimen).toContain("stacked on an open parent")
    expect(regimen).toContain("Inconclusive is a checker bug, not QA work.")
    expect(regimen).not.toContain("`FAIL`, `FLAKY`, and `BLOCKED` still merge")
    expect(regimen).toContain("GitHub Actions does not click merge")
    expect(regimen).toContain("`enforce_admins` is false")
    expect(agents).toContain("**Awaiting Deployment**")
    expect(agents).toContain("production calver tag")
    expect(agents).not.toContain("Dev Verification Needed")
    expect(agents).not.toContain("merged the ticket into `main`")
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
