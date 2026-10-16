import { expect, test } from "@playwright/test"
import { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * AQU-642 guards the harness itself, so it needs no backend: both cases drive
 * the real `Workspace.waitForEditor` over synthetic markup.
 *
 * AQU-642 ("all editor smokes fail at waitForEditor") stayed open for three
 * months partly because a render throw in the cell grid and a route that is
 * merely slow look identical to a `[data-cell-id]` locator — the boundary
 * swaps the grid for the recovery screen, the row never appears, and every
 * editor spec reports a bare 30-second timeout with the actual throw reachable
 * only from a trace. `waitForEditor` now races the row against the recovery
 * screen's `data-slot`/`data-boundary` marker (src/components/ErrorBoundary.tsx,
 * pinned from the product side in src/components/ErrorBoundary.test.tsx).
 *
 * Non-smoke by design: no user can lose data if this breaks and it crosses no
 * service boundary (AGENTS.md "Smoke admission"). It belongs in the full suite
 * because a false positive here would misdiagnose every editor spec at once.
 */
const CRASH_SCREEN = `<!doctype html><html><body>
  <div data-slot="error-boundary-fallback" data-boundary="project-workspace">
    <h3>Something went wrong</h3>
    <p>An unexpected error occurred. Your work is saved locally — reload to continue.</p>
  </div>
</body></html>`

const MOUNTED_GRID = `<!doctype html><html><body>
  <div data-cell-id="11111111-1111-4111-8111-111111111111">In the beginning</div>
</body></html>`

test("a crashed editor fails as a crash, naming the boundary, not as a locator timeout", async ({ page }) => {
  await page.setContent(CRASH_SCREEN)

  const waited = await new Workspace(page).waitForEditor().then(
    () => new Error("waitForEditor resolved although the recovery screen was showing"),
    (error: Error) => error,
  )

  expect(waited.message).toContain("Editor crashed at mount")
  // The boundary's name is the whole point: it says which surface threw.
  expect(waited.message).toContain('"project-workspace"')
  expect(waited.message).toContain("Something went wrong")
})

test("a mounted cell grid still satisfies waitForEditor", async ({ page }) => {
  await page.setContent(MOUNTED_GRID)
  // Resolving is the assertion — the crash branch must not fire on a healthy
  // grid, or it would misdiagnose every editor spec in the suite.
  await new Workspace(page).waitForEditor()
  await new Workspace(page).waitForEditor("11111111-1111-4111-8111-111111111111")
})
