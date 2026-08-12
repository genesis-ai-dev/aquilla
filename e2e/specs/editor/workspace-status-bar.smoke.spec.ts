import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * Workspace status bar (StatusBar.tsx + DecayBreakdown).
 *
 * The editor footer renders:
 *   - A HealthRing (with a DecayBreakdown popover parent)
 *   - Cell count text: "N cells · N translated (N%)"
 *   - Unvalidated / validated pill counts (when non-zero)
 *
 * This spec: import a file, open the editor, verify the cell count text
 * is present in the footer.
 */
test("workspace status bar shows cell count after importing a file", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `StatusBar ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Status bar footer shows "N cells · …"
  const footer = alice.locator("footer")
  await expect(footer).toBeVisible({ timeout: 5_000 })
  await expect(footer.getByText(/cells/i).first()).toBeVisible({ timeout: 5_000 })
})

test("file hydration shows explicit progress and withholds unresolved zero statistics", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `StatusBar loading ${Date.now()}`,
  })
  const cellsPath = `/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`
  let releaseCells!: () => void
  const cellsGate = new Promise<void>((resolve) => {
    releaseCells = resolve
  })

  await alice.route(`**${cellsPath}**`, async (route) => {
    const url = new URL(route.request().url())
    if (
      route.request().method() === "GET" &&
      url.pathname === cellsPath &&
      url.searchParams.get("side") === "source"
    ) {
      await cellsGate
    }
    await route.continue()
  })

  try {
    await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)

    const loading = alice.getByRole("status", {
      name: "Loading file from the cloud",
    })
    await expect(loading).toBeVisible()
    await expect(loading.locator("[data-slot='spinner']")).toBeVisible()
    await expect(alice.getByText("Loading file from the cloud…")).toBeVisible()
    await expect(alice.getByText(/^0 cells ·/)).toHaveCount(0)
  } finally {
    releaseCells()
  }

  const workspace = new Workspace(alice)
  await workspace.waitForEditor(seeded.cellIds[0])
  await expect(alice.getByText(/cells · \d+ translated/).first()).toBeVisible()
})
