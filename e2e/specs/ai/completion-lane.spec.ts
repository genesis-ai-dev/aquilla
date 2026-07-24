import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { MockLLMServer } from "../../helpers/mock-llm-server"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * Sparkle (single-cell AI draft) in a NON-default target lane.
 *
 * Regression: drafting in a secondary lane reported "Saved" while the lane's
 * cell stayed empty (the draft either failed server-side or landed in the
 * wrong lane). Hand-typed lane edits are covered by
 * projects/add-target-language.spec.ts; this covers the AI-draft commit path
 * (commitCompletedCell → emitTargetCellCommit with targetLang).
 *
 * Contract: the draft commits into the ACTIVE lane — visible there after the
 * server round-trip — and the default lane's target stays untouched.
 */
const mockLLM = new MockLLMServer()

test.beforeAll(async () => {
  await mockLLM.start()
})

test.afterAll(async () => {
  await mockLLM.stop()
})

test("sparkle in a secondary lane commits the draft into that lane only", async ({ alice }) => {
  test.setTimeout(90_000)
  mockLLM.setNextResponse("Hola lane draft")

  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AI lane ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Diagnostic capture: record every POST /events request/response pair so a
  // server-side rejection is visible in the test output, not just as a
  // mysteriously empty cell — and every target-side GET /cells exchange so a
  // read-path miss is equally visible.
  const eventPosts: Array<{ reqBody: string; status: number; resBody: string }> = []
  const cellReads: Array<{ url: string; status: number; resBody: string }> = []
  alice.on("response", (response) => {
    const req = response.request()
    const url = new URL(response.url())
    if (req.method() === "POST" && url.pathname.endsWith("/events")) {
      void (async () => {
        let resBody = ""
        try { resBody = await response.text() } catch { /* stream gone */ }
        eventPosts.push({ reqBody: req.postData() ?? "", status: response.status(), resBody })
      })()
    }
    if (req.method() === "GET" && url.pathname.endsWith("/cells") && url.searchParams.get("side") !== "source") {
      void (async () => {
        let resBody = ""
        try { resBody = await response.text() } catch { /* stream gone */ }
        cellReads.push({ url: response.url(), status: response.status(), resBody: resBody.slice(0, 1500) })
      })()
    }
  })

  // Point the per-device LLM override at the spec-local mock server.
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${mockLLM.baseUrl}/v1` })

  // Mirror the reported flow: the default (English) lane is in active use —
  // sparkle cell 0 there FIRST, so the cell has a default-lane AI-draft chain
  // (and the workspace's pending-commit bookkeeping for this cell) before the
  // lane draft happens.
  mockLLM.setNextResponse("English default draft")
  await alice.reload()
  await ws.waitForEditor()
  const sparkleDefault = alice
    .locator("[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']")
    .first()
  await sparkleDefault.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await expect(sparkleDefault).toBeVisible()
  await sparkleDefault.click()
  await expect(alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]'))
    .toContainText("English default draft", { timeout: 15_000 })

  // Add a second target lane ("es") from Project Settings → Languages.
  mockLLM.setNextResponse("Hola lane draft")
  const settings = new ProjectSettings(alice)
  await settings.openSettings()
  await settings.addTargetLanguage("es")
  await settings.backToEditor()
  await ws.waitForEditor()

  // Switch to the "es" lane; the cell is untranslated there.
  await ws.switchLane("es")
  expect(await ws.readActiveLane()).toBe("es")
  expect(await ws.readTargetText(0)).toBe("")

  // Sparkle the first cell (same interaction dance as completion.smoke.spec.ts).
  const sparkle = alice
    .locator("[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']")
    .first()
  await sparkle.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await expect(sparkle).toBeVisible()
  await sparkle.click()

  // The draft lands in the es lane.
  const targetCell = alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]')
  await expect(targetCell, `POST /events exchanges:\n${JSON.stringify(eventPosts, null, 2)}`)
    .toContainText("Hola lane draft", { timeout: 15_000 })

  // Reload — the value must come back from the SERVER projection, not the
  // optimistic shadow. Re-select the lane explicitly (the restore of the
  // active lane across reload is not what this spec pins down).
  cellReads.length = 0
  await alice.reload()
  await ws.waitForEditor()
  if ((await ws.readActiveLane()) !== "es") await ws.switchLane("es")
  // Give the boot-time cells fetch a beat to be captured, then assert with
  // the read exchanges embedded in the failure message.
  await expect
    .poll(() => cellReads.length, { timeout: 10_000 })
    .toBeGreaterThan(0)
  await expect(targetCell,
    `after reload — POST /events exchanges:\n${JSON.stringify(eventPosts, null, 2)}\n` +
    `target-side GET /cells since reload:\n${JSON.stringify(cellReads, null, 2)}`)
    .toContainText("Hola lane draft", { timeout: 15_000 })

  // The default lane's target keeps its own draft, untouched by the lane draft.
  await ws.switchLane("")
  await expect(targetCell).toContainText("English default draft", { timeout: 15_000 })
  await expect(targetCell).not.toContainText("Hola lane draft")
})
