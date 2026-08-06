import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { MockLLMServer } from "../../helpers/mock-llm-server"

const mockLLM = new MockLLMServer()

test.beforeAll(async () => {
  await mockLLM.start()
})

test.afterAll(async () => {
  await mockLLM.stop()
})

test("translate as read drafts the viewport without replacing human text", async ({ alice }) => {
  test.setTimeout(90_000)
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `Translate as read ${Date.now()}`,
  })
  const ws = await openSeededProject(alice, seeded)

  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${mockLLM.baseUrl}/v1` })
  await alice.reload()
  await ws.waitForEditor()

  // Establish a human-owned head in the visible viewport before automation.
  await ws.editCell(0, "Human translation")
  mockLLM.setNextResponse("Viewport AI draft")

  let toggle = alice.getByRole("switch", { name: "Translate as read" })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toBeChecked()

  // The next empty visible row is drafted automatically.
  await expect.poll(() => ws.readTargetText(1), { timeout: 20_000 }).toContain("Viewport AI draft")
  await expect(ws.cellRow(1).getByLabel("AI draft — individual human review required")).toBeVisible()

  // Human ownership is a hard stop even though the row remained visible.
  await expect.poll(() => ws.readTargetText(0)).toContain("Human translation")
  await expect.poll(() => ws.readTargetText(0)).not.toContain("Viewport AI draft")

  // It is a reading mode, not an ephemeral button state.
  await alice.reload()
  await ws.waitForEditor()
  toggle = alice.getByRole("switch", { name: "Translate as read" })
  await expect(toggle).toBeChecked()

  await toggle.click()
  await expect(toggle).not.toBeChecked()
})
