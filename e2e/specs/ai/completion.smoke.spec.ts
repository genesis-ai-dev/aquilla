import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Verify the sparkle-button → mock LLM flow.
 *
 * We bypass the project-settings UI entirely by writing the project's
 * completionSettings directly into IDB. This sidesteps a real bug in
 * ProjectSettings.tsx (a useEffect re-syncs `endpoint` from store after
 * every save, racing UI fill→blur→click) and tests only what this spec
 * is meant to verify: when configured to point at a custom OpenAI-
 * compatible endpoint, the sparkle button populates a target cell with
 * the LLM's response.
 *
 * IDB layout: db "codex" v4, store "projects" keyed by id.
 */
test("sparkle button fills target cell from mock LLM (config injected via IDB)", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AI ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "es" })
  await dash.openProject(name)

  // Point the per-device LLM override at the mock server. getUserProviderOverride()
  // is checked first in complete() AND now in useCompletion (so isConfigured is
  // correct). useProject reads from the server, not IDB, so IDB writes are ignored.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,   // e.g. http://127.0.0.1:<port>/v1
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${llmBase}/v1` })

  // Reload so React reads the patched project state.
  await alice.reload()
  await alice.waitForLoadState("networkidle")

  // Import sample, open, click sparkle.
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The sparkle lives in CellActionRail, hidden until the row is hovered
  // and faded in over 180ms. Playwright's auto-hover-on-click occasionally
  // doesn't trigger the row's onMouseEnter (the rail wrapper is
  // pointer-events:none and Playwright teleports the cursor), leaving the
  // children container at opacity:0 + pointer-events:none and the chip
  // parent intercepting. Hover the cell row explicitly first.
  const sparkle = alice
    .locator("[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']")
    .first()
  await sparkle.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await alice.waitForTimeout(250) // let the 180ms opacity fade settle
  await sparkle.click()

  // Mock LLM's default response is "Traducción de prueba".
  await expect(
    alice.locator("[data-cell-id]").first().locator('[data-cell-type="target"]'),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
})
