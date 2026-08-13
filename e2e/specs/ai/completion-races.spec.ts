// Sparkle commit races: realistic sequences that could chain an AI-draft
// commit onto a stale parent and trip the "draft was outdated ... not saved"
// dead-letter guard (commitCompletedCell's onStaleSiblings check). Pins that
// the RACE-3/QW-2 pending-parent machinery keeps rapid consecutive commits —
// regenerate, hand-edit-then-sparkle, per-lane repeats — chaining cleanly, so
// the guard only ever fires for genuine cross-client conflicts.

import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { MockLLMServer } from "../../helpers/mock-llm-server"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

const mockLLM = new MockLLMServer()
test.beforeAll(async () => { await mockLLM.start() })
test.afterAll(async () => { await mockLLM.stop() })

const DEAD_LETTER_MSG = "was not saved"

async function setupProject(alice: import("@playwright/test").Page, name: string) {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })
  const ws = await openSeededProject(alice, seeded)
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint, model: "mock-model", apiKey: "",
    }))
  }, { endpoint: `${mockLLM.baseUrl}/v1` })
  await alice.reload()
  await ws.waitForEditor()
  return ws
}

async function sparkleFirstCell(alice: import("@playwright/test").Page) {
  const sparkle = alice
    .locator("[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']")
    .first()
  await sparkle.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await expect(sparkle).toBeVisible()
  await sparkle.click()
  // A non-empty cell pops the overwrite-confirm dialog — confirm if present.
  const confirm = alice.getByRole("button", { name: /Replace|Overwrite|Continue/i }).first()
  try {
    await confirm.waitFor({ state: "visible", timeout: 1_500 })
    await confirm.click()
  } catch { /* empty cell — no dialog */ }
}

function targetCell(alice: import("@playwright/test").Page) {
  return alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]')
}

function deadLetterError(alice: import("@playwright/test").Page) {
  return alice.locator("[data-cell-id]").first().getByText(DEAD_LETTER_MSG)
}

test("repeat sparkle (regenerate) on the same cell never dead-letters", async ({ alice }) => {
  test.setTimeout(90_000)
  const ws = await setupProject(alice, `Race regen ${Date.now()}`)
  void ws
  mockLLM.setNextResponse("draft one")
  await sparkleFirstCell(alice)
  await expect(targetCell(alice)).toContainText("draft one", { timeout: 15_000 })

  // Immediately sparkle again — the projection read-back may still be in flight.
  mockLLM.setNextResponse("draft two")
  await sparkleFirstCell(alice)
  await expect(targetCell(alice)).toContainText("draft two", { timeout: 15_000 })
  await expect(deadLetterError(alice)).not.toBeVisible()

  // And a third, rapid-fire.
  mockLLM.setNextResponse("draft three")
  await sparkleFirstCell(alice)
  await expect(targetCell(alice)).toContainText("draft three", { timeout: 15_000 })
  await expect(deadLetterError(alice)).not.toBeVisible()
})

test("hand edit then immediate sparkle never dead-letters", async ({ alice }) => {
  test.setTimeout(90_000)
  const ws = await setupProject(alice, `Race edit ${Date.now()}`)
  mockLLM.setNextResponse("post-edit draft")
  await ws.editCell(0, "typed by hand")
  // No settle wait — sparkle while the edit's commit round-trip is in flight.
  await sparkleFirstCell(alice)
  await expect(targetCell(alice)).toContainText("post-edit draft", { timeout: 15_000 })
  await expect(deadLetterError(alice)).not.toBeVisible()
})

test("lane: repeat sparkle in a secondary lane never dead-letters", async ({ alice }) => {
  test.setTimeout(120_000)

  // Failure forensics: every POST /events exchange and console error/warn,
  // dumped in the assertion message — this test guards a silent-loss shape,
  // so a bare "" tells us nothing about which layer dropped the draft.
  const eventPosts: Array<{ reqBody: string; status: number; resBody: string }> = []
  alice.on("response", (response) => {
    const req = response.request()
    if (req.method() === "POST" && new URL(response.url()).pathname.endsWith("/events")) {
      void (async () => {
        let resBody = ""
        try { resBody = await response.text() } catch { /* stream gone */ }
        eventPosts.push({ reqBody: req.postData() ?? "", status: response.status(), resBody })
      })()
    }
  })
  const consoleLines: string[] = []
  alice.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`)
    }
  })
  const forensics = () =>
    `POST /events exchanges:\n${JSON.stringify(eventPosts, null, 2)}\n` +
    `console errors/warnings:\n${consoleLines.join("\n")}`

  const ws = await setupProject(alice, `Race lane ${Date.now()}`)
  mockLLM.setNextResponse("english draft")
  await sparkleFirstCell(alice)
  await expect(targetCell(alice)).toContainText("english draft", { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  await settings.openSettings()
  await settings.addTargetLanguage("es")
  await settings.backToEditor()
  await ws.waitForEditor()
  await ws.switchLane("es")

  mockLLM.setNextResponse("hola uno")
  await sparkleFirstCell(alice)
  await expect(targetCell(alice), forensics()).toContainText("hola uno", { timeout: 15_000 })
  await expect(deadLetterError(alice)).not.toBeVisible()

  mockLLM.setNextResponse("hola dos")
  await sparkleFirstCell(alice)
  try {
    await expect(targetCell(alice)).toContainText("hola dos", { timeout: 15_000 })
  } catch {
    const errLine = await alice
      // AQU-891: the inline cell error is now InlineAiError (a role="alert"
      // <span>, not a bare <p>) — a friendly line plus an info popover.
      .locator("[data-cell-id]").first().locator("[role='alert'].text-destructive")
      .textContent()
      .catch(() => null)
    throw new Error(
      `second lane draft did not land — cell error line: ${JSON.stringify(errLine)}\n${forensics()}`,
    )
  }
  await expect(deadLetterError(alice)).not.toBeVisible()
})
