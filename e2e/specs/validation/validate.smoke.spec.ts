import { expect, test } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import {
  jwtFor,
  openSeededProject,
  readProjectedCells,
  seedProjectWithFile,
} from "../../helpers/seed-project"

// Restored codex behaviour (2026-07): directly editing a target cell
// auto-validates it — "a human has touched it" — in the same gesture, with no
// separate click. Aquilla had regressed to leaving a freshly typed cell
// unvalidated until the translator clicked the health ring; this asserts the
// edit alone flips the cell to self-validated (emerald).
test("directly editing a target cell auto-validates it (self-validated, emerald)", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Validate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Type a translation into an empty cell. This commits the text AND, per the
  // restored behaviour, marks the cell validated by the current user.
  await ws.editCell(0, "Test translation")

  // The edit alone flips the cell to self-validated — no manual validate click.
  await ws.expectSelfValidated(0)

  // The affordance now offers "remove your validation" — the popover branch
  // that only renders once the cell actually has a validator, proving the
  // green state is a real self-validation and not just styling.
  const row = ws.cellRow(0)
  await row.hover()
  const validatedButton = row.getByRole("button", { name: /remove your validation/i }).first()
  await expect(validatedButton).toHaveAttribute("aria-pressed", "true")
  await expect(validatedButton).not.toHaveAttribute("title", /.+/)
})

// AQU-1901 / AQU-1902: open a project whose target lanes all carry a real tag
// (every project created today — the seeded one has a single "Swahili" lane and
// no default lane), and edit the moment the editor appears. The editor used to
// accept that edit before the project's lane rows had loaded and send it with
// no lane; the server refused it ("DB batch failed", later a 422) and the
// outbox dropped it — the text and its validation silently never saved.
//
// The settings read that carries the lane rows is HELD until the editor is on
// screen, so the test sits in that window deliberately instead of hoping a
// fast machine does not skip it. While held, the editor must be read-only and
// say so; once released, the edit must land on the lane — after a reload, in
// the database, validated on the new text.
test("an edit made as soon as the project opens lands on its lane, with its validation (AQU-1901)", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Open and edit ${Date.now()}` })

  const settingsPath = `/api/v2/projects/${seeded.projectId}/settings`
  let releaseSettings: () => void = () => {}
  const settingsHeld = new Promise<void>((resolve) => { releaseSettings = resolve })
  await alice.route(
    (url) => url.pathname.endsWith(settingsPath),
    async (route) => {
      if (route.request().method() === "GET") await settingsHeld
      await route.continue()
    },
  )

  // Every write's per-event outcome: the bug's signature was a 200 response
  // whose body carried `rejected` entries.
  const rejected: unknown[] = []
  alice.on("response", (response) => {
    const request = response.request()
    if (request.method() !== "POST" || !new URL(response.url()).pathname.endsWith("/events")) return
    void response.json().then(
      (body: { rejected?: unknown[] }) => { rejected.push(...(body.rejected ?? [])) },
      () => {},
    )
  })

  // Project page → "Open project".
  await alice.goto(`/projects/${seeded.projectId}`)
  const openProject = alice.getByRole("button", { name: /^Open project$/i })
  await expect(openProject).toBeVisible({ timeout: 30_000 })
  await Promise.all([
    alice.waitForURL(/\/project\/[^/?#]+\/editor/, { timeout: 30_000 }),
    openProject.click(),
  ])
  const ws = new Workspace(alice)
  if (!/\/editor\/file\//.test(alice.url())) await ws.openFileBySubstring(seeded.fileName)
  await ws.waitForEditor(seeded.cellIds[0])

  // The window: rows on screen, languages not loaded. Read-only, and it says so.
  await expect(alice.getByTestId("lanes-loading-banner")).toBeVisible()
  await expect(
    ws.cellRow(0).locator('[data-cell-type="target"] [data-target-read-view]').first(),
  ).toHaveAttribute("aria-readonly", "true")

  // Let the lanes arrive; the editor goes live on its own.
  releaseSettings()
  await expect(alice.getByTestId("lanes-loading-banner")).toBeHidden({ timeout: 30_000 })

  const text = `Mwanzo ${Date.now()}`
  await ws.editCell(0, text)
  await ws.expectSelfValidated(0)

  // Survives a reload — it is on the server, not only in the optimistic echo.
  await alice.reload()
  await ws.waitForEditor(seeded.cellIds[0])
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 30_000 })
  await ws.expectSelfValidated(0)

  // And it is on the lane: the projected target row carries the lane's tag and
  // id, holds the new text, and is validated.
  const targets = await readProjectedCells(jwt, seeded, "target")
  const row = targets.find((cell) => cell.cellId === seeded.cellIds[0])
  expect(row, JSON.stringify(targets)).toBeDefined()
  expect(row!.value).toBe(text)
  expect(row!.validated).toBe(true)
  expect(row!.targetLang ?? "").not.toBe("")
  expect(row!.laneId ?? "").not.toBe("")
  expect(rejected).toEqual([])
})
