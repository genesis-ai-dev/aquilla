import { test, expect } from "../../helpers/multi-user"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { jwtFor, openSeededProject, readProjectedCells, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Verify the sparkle-button → mock LLM flow.
 *
 * We bypass the project-settings UI entirely by writing the project's
 * completionSettings directly into IDB. This sidesteps a real bug in
 * ProjectSettings.tsx (a useEffect re-syncs `endpoint` from store after
 * every save, racing UI fill→blur→click) and tests only what this spec
 * is meant to verify: when configured to point at a custom OpenAI-
 * compatible endpoint, the sparkle button populates a target cell with
 * the LLM's response and records the AI-draft provenance server-side.
 *
 * IDB layout: db "codex" v4, store "projects" keyed by id.
 */
test("sparkle button fills target cell from mock LLM (config injected via IDB)", async ({ alice }) => {
  test.setTimeout(90_000)
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AI ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Point the per-device LLM override at the mock server. getUserProviderOverride()
  // is checked first in complete() AND now in useCompletion (so isConfigured is
  // correct). useProject reads from the server, not IDB, so IDB writes are ignored.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await applyUserProviderOverride(alice, alice.username, `${llmBase}/v1`)

  // Reload so React reads the patched project state.
  await alice.reload()
  await ws.waitForEditor()

  await ws.clickSparkleOnFirstCell()

  // Mock LLM's default response is "Traducción de prueba".
  await expect(
    alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]'),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
  // AQU-1041 removed the visible AI-draft tag — the cell header renders the
  // same as a human-typed draft (RTL: EditorTable.aiDraftBadge.test.tsx).
  // The provenance must still cross the stack: the sparkle commit carries
  // ai_suggestion and the sync-worker projects it as aiDrafted on the row,
  // which bulk-validate eligibility and the org AI-drafted stat read.
  await expect
    .poll(async () => {
      const cells = await readProjectedCells(await jwtFor("alice"), seeded, "target")
      return cells.find((c) => c.cellId === seeded.cellIds[0])?.aiDrafted ?? false
    }, { timeout: 15_000, intervals: [500, 1_000] })
    .toBe(true)

  // Individual review is the approval boundary for an AI draft. The button
  // must visibly acknowledge the click immediately while the validator
  // projection catches up, then remain pressed after the server round-trip.
  await ws.validateCell(0)
  await expect(
    ws.cellRow(0).getByRole("button", { name: /Validated/i }).first(),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })
})
