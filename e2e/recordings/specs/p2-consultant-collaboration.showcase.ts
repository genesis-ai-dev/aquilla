import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"
import { ensureAuthState } from "../../helpers/auth"
import { createProjectServerSide, addProjectMember, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * P2 · The Translation Consultant — see docs/distribution/PERSONAS.md.
 *
 * Marquee money moment: a translator's work shows up on the consultant's
 * screen, live — one source of truth, no emailed files.
 *
 * STAGED (`test.fixme`): this mirrors e2e/specs/collab/file-propagation.smoke,
 * which is itself fixme pending the sync-wake regression (bob's workspace
 * shows "Local only / Sync disabled" so the file never propagates). The
 * moment that journey is green, drop the `.fixme` and this becomes the hero
 * launch recording. Do NOT record a broken flow — a take is only shippable
 * when the value moment is real.
 */
test.fixme(
  "P2 · Consultant — a translator's work appears live on the reviewer's screen",
  async ({ alice, bob }) => {
    const show = new Showcase(alice, {
      persona: "p2-consultant-reviewer",
      feature: "realtime-collaboration",
      title: "Your whole team. One source of truth. In real time.",
      cta: "Aquilla — review live, wherever your team is.",
    })

    // Alice (translator) creates the project and bridges local → synced.
    const aliceDash = new Dashboard(alice)
    await aliceDash.goto()
    await show.chapter("The translator drafts", "On her laptop, in the field.")
    const name = "Acts — review copy"
    await aliceDash.createProject({ name })
    await aliceDash.openProject(name)
    const projectId = alice.url().split("/project/")[1]?.split("/")[0]
    expect(projectId).toBeTruthy()

    const aliceSession = await ensureAuthState("alice")
    await createProjectServerSide(aliceSession.jwt, { id: projectId!, name })
    await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.REVIEWER)

    const aliceWs = new Workspace(alice)
    await show.caption("She imports the passage and starts translating.")
    await aliceWs.importFile(SAMPLE_MD)
    await aliceWs.openFileBySubstring("sample")
    await aliceWs.waitForEditor()

    // Bob (consultant) opens the shared project — the work is just… there.
    const bobDash = new Dashboard(bob)
    await show.chapter("The consultant opens it", "A continent away. No screen-share. No file attachment.")
    await bobDash.goto()
    await expect(bob.getByText(name)).toBeVisible({ timeout: 15_000 })
    await bobDash.openProject(name)
    await show.caption("The same project, the same source of truth, instantly.")
    await expect(
      bob.locator("aside").locator("div").filter({ hasText: /sample/i }).first(),
    ).toBeVisible({ timeout: 20_000 })
    await show.beat(1500)

    await show.save()
  },
)
