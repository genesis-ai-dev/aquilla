import { expect, test } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import {
  commitTargetServerSide,
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
// fast machine does not skip it. While held, the editor must say so and show
// no rows — paired with the `''` fallback lane they read "— empty" although
// row 1 has a translation (AQU-1901) — and accept no edit; once released, the
// row shows its translation, and the edit must land on the lane — after a
// reload, in the database, validated on the new text.
test("an edit made as soon as the project opens lands on its lane, with its validation (AQU-1901)", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Open and edit ${Date.now()}` })
  // Like the adversarial fixture: row 1 already translated on the lane. No
  // digits: a number the source lacks raises a health popover on click.
  const seededTranslation = "Hapo mwanzo Mungu aliumba"
  await commitTargetServerSide(jwt, seeded, seeded.cellIds[0], seededTranslation, "alice")

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

  // The window: languages not loaded. It says so, and shows no row at all —
  // so none can read "empty", and there is nothing to type into.
  await expect(alice.getByTestId("lanes-loading-banner")).toBeVisible({ timeout: 30_000 })
  await expect(alice.getByTestId("cell-area-lanes-loading")).toBeVisible()
  await expect(ws.cellRows()).toHaveCount(0)

  // Let the lanes arrive; the rows appear on their lane, translation and all.
  releaseSettings()
  await ws.waitForEditor(seeded.cellIds[0])
  await expect(alice.getByTestId("lanes-loading-banner")).toBeHidden({ timeout: 30_000 })
  await expect(ws.cellRow(0)).toContainText(seededTranslation)

  // The edit goes on the next row, which has no translation yet.
  const text = `Mwanzo ${Date.now()}`
  await ws.editCell(1, text)
  await ws.expectSelfValidated(1)

  // Survives a reload — it is on the server, not only in the optimistic echo.
  await alice.reload()
  await ws.waitForEditor(seeded.cellIds[0])
  await expect(ws.cellRow(1)).toContainText(text, { timeout: 30_000 })
  await ws.expectSelfValidated(1)

  // And it is on the lane: the projected target row carries the lane's tag and
  // id, holds the new text, and is validated.
  const targets = await readProjectedCells(jwt, seeded, "target")
  const row = targets.find((cell) => cell.cellId === seeded.cellIds[1])
  expect(row, JSON.stringify(targets)).toBeDefined()
  expect(row!.value).toBe(text)
  expect(row!.validated).toBe(true)
  expect(row!.targetLang ?? "").not.toBe("")
  expect(row!.laneId ?? "").not.toBe("")
  expect(rejected).toEqual([])
})

// AQU-1901: /events answers 200 and lists a refused write in `rejected[]`; the
// flusher drops it, since retrying fails the same way. Before, nothing else
// happened: the line kept the typed text and the status chip went back to
// "Synced", so an edit that never saved looked saved. The refusal is injected
// (a 422 like AQU-1900's for a write with no lane) because a real client no
// longer sends one — the point is what the reader sees when the server says no.
test("an edit the server refuses is undone and announced, not left looking saved (AQU-1901)", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Refused edit ${Date.now()}` })
  // No digits: a number the source lacks raises a health popover on click.
  const saved = "Hapo mwanzo Mungu aliumba"
  await commitTargetServerSide(jwt, seeded, seeded.cellIds[0], saved, "alice")
  const ws = await openSeededProject(alice, seeded)
  await expect(ws.cellRow(0)).toContainText(saved, { timeout: 30_000 })

  await alice.route(
    (url) => url.pathname.endsWith("/events"),
    async (route) => {
      const request = route.request()
      if (request.method() !== "POST") return route.continue()
      const { events } = request.postDataJSON() as { events: Array<{ id: string; kind: string }> }
      const refused = events.filter((e) => e.kind === "target.cell.commit" || e.kind === "cell.validate")
      if (refused.length === 0) return route.continue()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: [],
          rejected: refused.map((e) => ({ id: e.id, status: 422, reason: "no lane named" })),
        }),
      })
    },
  )

  const typed = "Neno hili halikuhifadhiwa"
  await ws.editCell(0, typed)

  await expect(alice.getByText(/(wasn't|weren't) saved/).first()).toBeVisible({ timeout: 30_000 })
  await expect(alice.getByText(/no lane named/).first()).toBeVisible()
  // The line goes back to what the server has.
  await expect(ws.cellRow(0)).toContainText(saved, { timeout: 30_000 })
  await expect(ws.cellRow(0)).not.toContainText(typed)
})
