import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, "../../fixtures/paragraph-draft.md")

/**
 * Verify the pilcrow "Draft paragraph" rail button → completeParagraph flow
 * (p1-paragraph-ui-wiring, Task 4).
 *
 * Seeds a 2-paragraph, 4-cell markdown doc (2 cells per paragraph, so both
 * the boundary indicator and the rail button are eligible — the button is
 * hidden for single-cell groups). Config follows completion.smoke.spec.ts:
 * the per-device LLM override is injected via localStorage rather than
 * driven through ProjectSettings.tsx.
 *
 * Mock LLM protocol note: completeParagraph sends a `stream:false` request
 * whose prompt encodes the live paragraph's cells as `<c id="CELLID">source</c>`
 * tags (src/lib/completion/paragraph-protocol.ts, D11) and reconciles the
 * response against those exact ids — any id the response doesn't echo is
 * flagged "missing" and NEVER committed. The stock MockLLMServer returned a
 * single fixed string ("Traducción de prueba") for every request, which
 * would leave 100% of cells "missing" and commit nothing. e2e/helpers/mock-llm-server.ts
 * was extended (this task) to generically parse `<c id="...">` tags out of
 * the incoming request and echo them back as `<c id="...">[DRAFT] text</c>` —
 * this mirrors what a real model does with the protocol rather than faking
 * the assertion, and leaves the old fixed-string fallback in place for
 * completion.smoke.spec.ts's single-cell (non-tagged) request.
 */
test("Draft-paragraph rail button drafts every cell of a paragraph as one unit (mock LLM)", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `Paragraph draft ${Date.now()}`,
    fixturePath: FIXTURE_PATH,
  })
  const ws = await openSeededProject(alice, seeded)

  // Point the per-device LLM override at the mock server (same pattern as
  // completion.smoke.spec.ts — sidesteps the ProjectSettings.tsx race bug).
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
  await ws.waitForEditor(seeded.cellIds[0])

  // seeded.cellIds is in document order: [p1-cell0, p1-cell1, p2-cell0, p2-cell1].
  const [p1Cell0, p1Cell1, p2Cell0, p2Cell1] = seeded.cellIds

  // The second paragraph's first row carries the boundary indicator — a pilcrow
  // labelled "New paragraph" by AppTooltip (no native title to key off) — and
  // the row wrapper is flagged `data-paragraph-start="true"` (the first
  // paragraph's own start row is suppressed — it's the file's first row).
  const p2StartRow = ws.cellRow(2)
  await expect(p2StartRow).toHaveAttribute("data-paragraph-start", "true")
  await expect(p2StartRow.getByTestId("paragraph-boundary-indicator")).toBeVisible()

  // The first paragraph's start row (index 0, the file's very first row)
  // must NOT show the boundary indicator.
  const p1StartRow = ws.cellRow(0)
  await expect(p1StartRow).not.toHaveAttribute("data-paragraph-start", "true")

  // Reveal the rail (hover) and click "Draft paragraph (2 cells)".
  await p2StartRow.scrollIntoViewIfNeeded()
  await p2StartRow.hover()
  const draftButton = p2StartRow.locator('button[aria-label^="Draft paragraph"]').first()
  await expect(draftButton).toBeVisible()
  await expect(draftButton).toHaveAttribute("aria-label", "Draft paragraph (2 cells)")
  await draftButton.click()

  // Confirm dialog — copy includes "will be drafted".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/will be drafted/i)).toBeVisible()
  await dialog.getByRole("button", { name: "Draft paragraph" }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Both cells of the SECOND paragraph get drafted text from the mock's
  // echoed `<c id>` response (prefixed "[DRAFT] " by the mock).
  await expect(
    alice.locator(`[data-cell-id="${p2Cell0}"] [data-cell-type="target"]`),
  ).toContainText("[DRAFT]", { timeout: 15_000 })
  await expect(
    alice.locator(`[data-cell-id="${p2Cell1}"] [data-cell-type="target"]`),
  ).toContainText("[DRAFT]", { timeout: 15_000 })

  // The FIRST paragraph's cells were never requested — they must stay empty.
  await expect(
    alice.locator(`[data-cell-id="${p1Cell0}"] [data-cell-type="target"]`),
  ).not.toContainText("[DRAFT]")
  await expect(
    alice.locator(`[data-cell-id="${p1Cell1}"] [data-cell-type="target"]`),
  ).not.toContainText("[DRAFT]")
})
