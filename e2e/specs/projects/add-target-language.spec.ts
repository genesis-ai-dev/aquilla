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
 *   3. Assert the LaneSwitcher does NOT render (only the default lane exists).
 *   4. Open Settings → Languages, add lane "es".
 *   5. Back in the workspace, the LaneSwitcher appears; switch to "es".
 *   6. Cell 0's target is EMPTY in the "es" lane (lanes are independent).
 *   7. Type Spanish text, commit (targetLang: "es" on the wire).
 *   8. Switch back to the default lane — the original French text is intact.
 *   9. Switch to "es" again — the Spanish text is intact.
 *
 * KNOWN BLOCKER (documented, not fixed here — e2e/** only):
 * `src/hooks/useProject.ts`'s `overlaySettings()` merges every synced
 * `ProjectWideSettings` field (sourceLanguage, targetLanguage, rules, …) onto
 * the `ProjectRecord` the workspace reads as `project`, EXCEPT `targetLanes`
 * (added to the `ProjectWideSettings` interface in project-settings.ts:94 but
 * never assigned in the `assign(...)` calls in useProject.ts:39-60). Since
 * `ProjectWorkspace.tsx` computes `targetLanes`/`availableLanes` off
 * `project.targetLanes` (component ~line 1120), a lane added via Settings is
 * persisted and listed correctly on the Settings page, but the workspace
 * header's `project.targetLanes` stays `undefined`/`[]` forever, so the
 * LaneSwitcher never renders. See SWARM-TODO(AQU-538) in
 * docs/swarm/AQU538-TRACES.md. Steps 5-9 above are expected to fail on the
 * "LaneSwitcher appears" assertion until that's fixed — left in place
 * (not weakened) per AGENTS.md's "fix the product, don't water down the test".
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

  // Switch to "es" again — the Spanish text persisted.
  await ws.switchLane("es")
  await expect(ws.cellRow(0)).toContainText(spanishText, { timeout: 5_000 })
})
