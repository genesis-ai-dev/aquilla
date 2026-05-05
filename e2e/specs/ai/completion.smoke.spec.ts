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
 * IDB layout: db "codex" v3, store "projects" keyed by id.
 */
test("sparkle button fills target cell from mock LLM (config injected via IDB)", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AI ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "es" })
  await dash.openProject(name)
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Inject completionSettings pointing at the orchestrator's mock LLM.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

  await alice.evaluate(async ({ id, endpoint }) => {
    const open = indexedDB.open("codex", 3)
    await new Promise<void>((resolve, reject) => {
      open.onsuccess = () => resolve()
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error("IDB upgrade blocked"))
    })
    const db = open.result
    const tx = db.transaction("projects", "readwrite")
    const store = tx.objectStore("projects")
    const existing = await new Promise<unknown>((resolve, reject) => {
      const req = store.get(id)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!existing) throw new Error(`project ${id} not in IDB`)
    const project = existing as Record<string, unknown>
    project.completionSettings = {
      provider: "custom",
      endpoint,
      apiKey: "",
      model: "mock-model",
      maxTokens: 256,
      temperature: 0.2,
      systemPrompt: "Translate.",
    }
    await new Promise<void>((resolve, reject) => {
      const req = store.put(project)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, { id: projectId!, endpoint: llmBase })

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
  const sparkle = alice.locator("button[title*='Generate translation']").first()
  await sparkle.scrollIntoViewIfNeeded()
  await alice.locator("[data-cell-id]").first().hover()
  await alice.waitForTimeout(250) // let the 180ms opacity fade settle
  await sparkle.click()

  // Mock LLM's default response is "Traducción de prueba".
  await expect(
    alice.locator("[data-cell-id]").first().locator("textarea, .ProseMirror"),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
})
