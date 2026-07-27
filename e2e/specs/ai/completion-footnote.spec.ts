import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { MockLLMServer } from "../../helpers/mock-llm-server"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FOOTNOTE_FIXTURE = path.resolve(__dirname, "../../fixtures/footnote-source.md")

/**
 * Sparkle on a source cell that carries a USFM footnote (`\f + \ft ...\f*`).
 *
 * Regression: this used to report "Saved" while committing an EMPTY target —
 * the old prompt embedded footnote instructions inside the `Source:` payload,
 * contradicting the system prompt's "final source line only" output rule, and
 * the empty model reply was committed unguarded.
 *
 * Fixed contract under test, end-to-end with the real app: the model receives
 * clean `[n]`-caller base text (instructions ride in the system prompt), its
 * `[n]`-form reply is reassembled into a real `\f...\f*` marker, and the
 * committed target renders the translated base with a footnote chip — no raw
 * `[1]` placeholder, no raw `\f` markup, never an empty cell.
 *
 * Uses a spec-local MockLLMServer (not the e2e-up global one) so the reply can
 * be footnote-shaped; the per-device provider override points the browser at
 * it, same mechanism as completion.smoke.spec.ts.
 */
const mockLLM = new MockLLMServer()

test.beforeAll(async () => {
  await mockLLM.start()
})

test.afterAll(async () => {
  await mockLLM.stop()
})

test("sparkle on a footnoted source commits translated base + reintegrated footnote", async ({ alice }) => {
  mockLLM.setNextResponse("En el principio [1] Dios creó los cielos\n[1] o al principio")

  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `AI footnote ${Date.now()}`,
    fixturePath: FOOTNOTE_FIXTURE,
  })
  const ws = await openSeededProject(alice, seeded)

  // Point the per-device LLM override at the spec-local mock server (checked
  // first in complete() and in useCompletion's isConfigured).
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${mockLLM.baseUrl}/v1` })
  await alice.reload()
  await ws.waitForEditor()

  // The sparkle lives in CellActionRail, hidden until the row is hovered
  // (same interaction dance as completion.smoke.spec.ts).
  const sparkle = alice
    .locator("[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']")
    .first()
  await sparkle.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await expect(sparkle).toBeVisible()
  await sparkle.click()

  const targetCell = alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]')

  // Translated base text lands (the old bug left this empty while "Saved").
  await expect(targetCell).toContainText("En el principio", { timeout: 15_000 })
  await expect(targetCell).toContainText("Dios creó los cielos")

  // The [n] placeholder was reassembled into a real footnote: the read-only
  // renderer shows it as a role="note" chip whose aria-label carries the
  // translated note text — and neither the placeholder nor raw USFM leaks.
  await expect(
    targetCell.getByRole("note", { name: /o al principio/ }).first(),
  ).toBeVisible({ timeout: 15_000 })
  await expect(targetCell).not.toContainText("[1]")
  await expect(targetCell).not.toContainText("\\f")

  // Still an AI draft requiring individual human review.
  await expect(
    alice.getByLabel("AI draft — individual human review required").first(),
  ).toBeVisible({ timeout: 15_000 })
})
