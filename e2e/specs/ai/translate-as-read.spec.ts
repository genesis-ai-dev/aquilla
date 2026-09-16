import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, readProjectedCells, seedProjectWithFile } from "../../helpers/seed-project"
import { MockLLMServer, applyUserProviderOverride } from "../../helpers/mock-llm-server"

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

  await applyUserProviderOverride(alice, alice.username, `${mockLLM.baseUrl}/v1`)
  await alice.reload()
  await ws.waitForEditor()

  // Establish a human-owned head in the visible viewport before automation.
  await ws.editCell(0, "Human translation")
  mockLLM.setNextResponse("Viewport AI draft")

  // "Draft as you read" (relabelled from "Translate as read" in AQU-1078)
  // lives in the File options ⋯ menu as a checkbox item (moved off the
  // toolbar in 2e924890; Base UI checkbox items keep the menu open on click,
  // so checked state is assertable in place).
  const toggle = alice.getByRole("menuitemcheckbox", { name: "Draft as you read" })
  await ws.openFileOverflowMenu()
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await alice.keyboard.press("Escape")
  await expect(toggle).not.toBeVisible()

  // The next empty visible row is drafted automatically.
  await expect.poll(() => ws.readTargetText(1), { timeout: 20_000 }).toContain("Viewport AI draft")

  // AQU-1041 removed the visible AI-draft tag, so assert provenance on the
  // authoritative projection: the auto-draft is aiDrafted, the human-owned
  // row is not.
  await expect
    .poll(async () => {
      const cells = await readProjectedCells(await jwtFor("alice"), seeded, "target")
      return {
        autoDraft: cells.find((c) => c.cellId === seeded.cellIds[1])?.aiDrafted ?? false,
        humanRow: cells.find((c) => c.cellId === seeded.cellIds[0])?.aiDrafted ?? true,
      }
    }, { timeout: 15_000, intervals: [500, 1_000] })
    .toEqual({ autoDraft: true, humanRow: false })

  // Human ownership is a hard stop even though the row remained visible.
  await expect.poll(() => ws.readTargetText(0)).toContain("Human translation")
  await expect.poll(() => ws.readTargetText(0)).not.toContain("Viewport AI draft")

  // It is a reading mode, not an ephemeral button state.
  await alice.reload()
  await ws.waitForEditor()
  await ws.openFileOverflowMenu()
  await expect(toggle).toHaveAttribute("aria-checked", "true")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "false")
})
