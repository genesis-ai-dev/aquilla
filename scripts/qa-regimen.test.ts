import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const regimen = readFileSync(path.join(root, "e2e/journeys/QA-BOT-REGIMEN.md"), "utf8")
const deploy = readFileSync(path.join(root, "e2e/journeys/RELEASE-CUT.md"), "utf8")
const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8")
const prBot = readFileSync(path.join(root, "e2e/journeys/PR-BOT.md"), "utf8")
const fixtures = readFileSync(path.join(root, "e2e/journeys/README.md"), "utf8")
const previewStack = readFileSync(path.join(root, "scripts/cloudflare-stack-preview.mjs"), "utf8")

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
    expect(deploy).toContain("The workflow does not start Jev and does not read its result")
    expect(deploy).toContain("refs/heads/release/YYYY/MM/DD-NN")
  })
})

// AQU-1436: an AI-control claim used to come back FAIL on every preview for
// two reasons that were never the diff, so the walk said nothing. Both halves
// of the answer live in prose the bots read, and the recipe is the only place
// the device-local half can live at all — a trim of either silently brings the
// uninformative FAIL back.
describe("the AI fixture the bots walk (AQU-1436)", () => {
  it("tells the bot where hosted drafting comes from, that Set up AI is per browser, and to report the gap as NOT CHECKED", () => {
    // The key half: every preview has one, enforced at deploy time.
    expect(previewStack).toContain("OPENROUTER_API_KEY")
    expect(fixtures).toContain("platform `OPENROUTER_API_KEY` (AQU-1500)")
    // The device-local half: not a project column, so no seed can pre-answer it.
    expect(fixtures).toContain("`aiProviderChosen` is device-local")
    expect(fixtures).toContain("no such column in Postgres")
    expect(fixtures).toContain("Set up AI is not on this list, and cannot be.")
    // The one-off click, and what the tooltip says before and after it.
    expect(fixtures).toContain("Set up AI to enable")
    expect(fixtures).toContain("Translate with AI")
    // A name long enough to truncate (absorbed AQU-1437), in both the fixture
    // list and the rebuild recipe.
    const longName = "QA Long Project Name For Truncation And Ellipsis Acceptance Criteria"
    expect(longName.length).toBeGreaterThan(60)
    expect(fixtures.split(longName).length - 1).toBeGreaterThanOrEqual(2)
    // The verdict rule: a missing fixture is never a finding against the app.
    expect(prBot).toContain("An AI control is walkable on a preview too (AQU-1436)")
    expect(prBot).toContain("**NOT CHECKED**, naming which of the two was missing — never **FAIL**")
  })
})
