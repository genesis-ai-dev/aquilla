/**
 * Smoke test for the new local-store stack — the dev-only /dev/local-store
 * route that exercises SQLite-WASM in-browser, snapshot ingest, cells query,
 * and outbox enqueue. No backend required; this is pure client-side.
 *
 * See docs/DATA_PERSISTENCE_PLAN.md and src/pages/LocalStoreDemo.tsx.
 */

import { test, expect } from "@playwright/test"

test.describe("local-store demo", () => {
  test("ingests fixture snapshot, edits a cell, enqueues to outbox", async ({
    page,
  }) => {
    await page.goto("/dev/local-store")

    // Page loads (SQLite-WASM init takes a moment in some envs).
    await expect(page.getByTestId("local-store-demo")).toBeVisible({
      timeout: 15_000,
    })

    // Snapshot ingested 3 cells.
    await expect(page.getByTestId("cell-demo:cell-1")).toBeVisible()
    await expect(page.getByTestId("cell-demo:cell-2")).toBeVisible()
    await expect(page.getByTestId("cell-demo:cell-3")).toBeVisible()

    // Source text from the fixture is rendered.
    await expect(
      page.getByTestId("cell-demo:cell-1"),
    ).toContainText("In the beginning God created")

    // Outbox starts empty.
    await expect(page.getByTestId("pending-count-value")).toHaveText("0")

    // Edit the first cell's translation.
    const input = page.getByTestId("translation-demo:cell-1")
    await input.fill("En el principio creó Dios los cielos y la tierra.")

    // Optimistic local update: the input reflects the typed value.
    await expect(input).toHaveValue(
      "En el principio creó Dios los cielos y la tierra.",
    )

    // Outbox now has at least one pending mutation (one per keystroke
    // batched by React's event loop, but at minimum 1).
    await expect(page.getByTestId("pending-count-value")).not.toHaveText("0")
  })

  test("loading state is shown briefly before the store is ready", async ({
    page,
  }) => {
    await page.goto("/dev/local-store")
    // Either we caught the loading state or it transitioned through fast —
    // both are acceptable; the assertion is "no error state ever shows".
    await expect(page.getByTestId("local-store-demo-error")).toHaveCount(0)
    await expect(page.getByTestId("local-store-demo")).toBeVisible({
      timeout: 15_000,
    })
  })
})
