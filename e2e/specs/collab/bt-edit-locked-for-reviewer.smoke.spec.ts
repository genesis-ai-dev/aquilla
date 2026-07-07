import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, addProjectMember, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * EditorTable — BT "Edit" button is locked for Reviewer role.
 *
 * EditorTable.tsx: in the BT tab of the expanded cell, if the user's
 * role is below Contributor, the "Edit" affordance is a disabled span
 * labelled "Contributor+ required to edit back-translations".
 *
 * BT generation is LLM-only and Contributor+ (persisting the BT is a project
 * write), so the reviewer can't generate one themselves. Alice generates it
 * against the mock LLM (per-device provider override, same pattern as the AI
 * completion smoke); the `cell.backtranslation.set` event persists via the
 * outbox, and bob's workspace hydrates it from the backtranslations read route.
 *
 * This spec:
 *   1. Alice creates a project, imports sample.md, edits cell 0.
 *   2. Alice points her device override at the mock LLM and generates a BT.
 *   3. Bob is added as a Reviewer and opens the same cell → BT tab.
 *   4. Verifies the locked "Edit" span is present (and no generate button).
 */
test("BT Edit is locked with Contributor+ tooltip for reviewer", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.REVIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BTLocked ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Point alice's per-device LLM override at the mock server so "Read it back
  // with AI" hits a real (mock) endpoint. complete() applies this override on
  // top of project settings.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${llmBase}/v1` })
  await alice.reload()
  await alice.waitForLoadState("networkidle")

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  // Edit cell 0 so there's a translation (BT requires translated text).
  await ws.editCell(0, "Translation for BT locked test")

  // Alice generates the back-translation from the BT tab.
  const aliceRow = ws.cellRow(0)
  await aliceRow.scrollIntoViewIfNeeded()
  await aliceRow.hover()
  const aliceExpandBtn = aliceRow.getByRole("button", { name: /Open cell details/i })
  await expect(aliceExpandBtn).toBeVisible({ timeout: 8_000 })
  await aliceExpandBtn.click()
  const aliceBtTab = alice.getByRole("button", { name: /back-translation/i })
    .or(alice.getByRole("tab", { name: /back-translation/i }))
  await expect(aliceBtTab.first()).toBeVisible({ timeout: 5_000 })
  await aliceBtTab.first().click()
  const aliceBtPanel = alice.getByRole("tabpanel", { name: /back-translation/i })
  const generateBtn = aliceBtPanel.getByRole("button", { name: /read it back|reading it back/i })
  await expect(generateBtn).toBeVisible({ timeout: 8_000 })
  await generateBtn.click()
  // Mock LLM's default response — proves generation completed. The
  // `cell.backtranslation.set` event drains via the outbox flusher (~5s).
  await expect(aliceBtPanel).toContainText("Traducción de prueba", { timeout: 15_000 })

  // Extract project ID so bob can navigate to it.
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Add bob to this project directly with Reviewer role.
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.REVIEWER)

  // Bob opens the project and file.
  await bob.goto(`/project/${projectId}`)
  await bob.waitForLoadState("networkidle")

  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  const openBtTabAsBob = async () => {
    const row = bobWs.cellRow(0)
    await row.scrollIntoViewIfNeeded()
    await row.hover()
    const expandBtn = row.getByRole("button", { name: /Open cell details/i })
    await expect(expandBtn).toBeVisible({ timeout: 8_000 })
    await expandBtn.click()
    const btTab = bob.getByRole("button", { name: /back-translation/i })
      .or(bob.getByRole("tab", { name: /back-translation/i }))
    await expect(btTab.first()).toBeVisible({ timeout: 5_000 })
    await btTab.first().click()
  }
  await openBtTabAsBob()

  // The Edit affordance renders once the cell HAS a back-translation. For a
  // Reviewer it's the locked span. Alice's `cell.backtranslation.set` drains
  // via the 5s outbox interval and bob's workspace hydrates BTs once on file
  // load — so bob's first fetch can legitimately race the write. Poll by
  // reloading bob's page (re-running the hydration fetch) rather than
  // weakening the cross-user assertion.
  const btPanel = bob.getByRole("tabpanel", { name: /back-translation/i })
  const lockedEdit = btPanel.getByLabel("Contributor+ required to edit back-translations")
  await expect(async () => {
    const visible = await lockedEdit.isVisible().catch(() => false)
    if (!visible) {
      await bob.reload()
      await bob.waitForLoadState("networkidle")
      await bobWs.waitForEditor()
      await openBtTabAsBob()
      await expect(lockedEdit).toBeVisible({ timeout: 2_000 })
    }
  }).toPass({ timeout: 30_000 })

  // Reviewer must NOT see the generate affordance — generation persists a BT,
  // which is a Contributor+ write.
  await expect(btPanel.getByRole("button", { name: /read it back/i })).toHaveCount(0)
})
