/**
 * AQU-538 (slice 2) — add a target language → switch lane → translate per lane.
 *
 * Full-suite journey (not smoke — settings drill-down + import + two rounds
 * of cell editing is too long for the <2min smoke budget). Single-user: only
 * alice is needed (no cross-user collaboration in this flow), so this uses
 * the `alice`-only fixture from `../../helpers/multi-user`, which is the
 * established convention for single-actor journeys in this repo (resetBackend
 * + auth is handled by the `alice` fixture itself — see multi-user.ts). No
 * spec in the suite actually uses a bare `@playwright/test` import with its
 * own `beforeEach`/`resetBackend()`; every "single-user" journey, including
 * this one, is written as an alice-only multi-user test.
 *
 * Flow:
 *   1. Create a project (source en, target fr), import a small file.
 *   2. Translate cell 0 in the default lane.
 *   3. Assert the lane switcher does NOT render (only the default lane exists).
 *   4. Open Settings → Languages, add lane "es".
 *   5. Back in the workspace, the switcher appears; switch to "es".
 *   6. Cell 0's target is EMPTY and Autopilot explains that v1 is default-lane-only.
 *   7. Type Spanish text, commit (targetLang: "es" on the wire).
 *   8. Switch back to the default lane — the original French text is intact.
 *   9. Switch to "es" again — the Spanish text is intact.
 *
 * AQU-602: the lane switcher is the TARGET language tag in the editor's column
 * header — a dropdown when >1 lane exists, a static pill otherwise (there is no
 * separate header control). The earlier `overlaySettings()` blocker (targetLanes
 * not merged onto the workspace `project` record) is resolved — see
 * `src/hooks/useProject.ts` (`assign("targetLanes", …)`).
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("add target language, switch lane, translate independently per lane", async ({ alice }) => {
  test.setTimeout(60_000)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `LaneJourney ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Translate cell 0 in the default (fr) lane.
  const frenchText = `Bonjour e2e ${Date.now()}`
  await ws.editCell(0, frenchText)
  await expect(ws.cellRow(0)).toContainText(frenchText, { timeout: 5_000 })

  // Only the default lane exists — the switcher must not render (N=1
  // byte-identical behavior per the AQU-538 decision doc).
  await expect(ws.laneSwitcher()).not.toBeVisible()

  // Add a second target lane ("es") from Project Settings → Languages.
  const settings = new ProjectSettings(alice)
  await settings.openSettings()
  await settings.addTargetLanguage("es")
  await settings.backToEditor()

  // Back in the workspace: the switcher appears now that a second lane exists.
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.laneSwitcher()).toBeVisible({ timeout: 10_000 })

  // Switch to "es" — cell 0's target is empty (lanes are independent; no
  // Spanish translation has been committed yet).
  await ws.switchLane("es")
  expect(await ws.readActiveLane()).toBe("es")
  expect(await ws.readTargetText(0)).toBe("")
  const autopilot = alice.getByTestId("contextual-run-pill")
  await expect(autopilot).toContainText("Autopilot works in Project default only")
  await expect(alice.getByRole("button", { name: "Run Autopilot" })).not.toBeVisible()

  // Translate cell 0 in the "es" lane.
  const spanishText = `Hola e2e ${Date.now()}`
  await ws.editCell(0, spanishText)
  await expect(ws.cellRow(0)).toContainText(spanishText, { timeout: 5_000 })

  // Switch back to the default lane — the original French text is intact,
  // untouched by the "es" edit.
  await ws.switchLane("")
  expect(await ws.readActiveLane()).toBe("")
  await expect(ws.cellRow(0)).toContainText(frenchText, { timeout: 5_000 })
  expect(await ws.readTargetText(0)).not.toContain(spanishText)
  await expect(alice.getByRole("button", { name: "Run Autopilot" })).toBeVisible()

  // Switch to "es" again — the Spanish text persisted.
  await ws.switchLane("es")
  await expect(ws.cellRow(0)).toContainText(spanishText, { timeout: 5_000 })
  await expect(autopilot).toContainText("Autopilot works in Project default only")

  // Reload and re-check BOTH lanes from the server projection. The in-memory
  // optimistic shadow satisfied the assertions above even when the server had
  // dead-lettered the es commit (the unqualified chain-slot regression behind
  // the "saved but empty lane cell" bug) — only a fresh load proves the lane
  // writes actually projected.
  await alice.reload()
  await ws.waitForEditor()
  if ((await ws.readActiveLane()) !== "es") await ws.switchLane("es")
  await expect(ws.cellRow(0)).toContainText(spanishText, { timeout: 10_000 })
  await ws.switchLane("")
  await expect(ws.cellRow(0)).toContainText(frenchText, { timeout: 10_000 })
})
