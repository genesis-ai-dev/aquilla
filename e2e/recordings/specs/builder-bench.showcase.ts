import { test, expect, type Page } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Builder benchmark screenshots (AQU-1793): real builder outputs, saved by a
 * benchmark run as `${BENCH_DIR}/aqu-1793-builder-eval-after-<case>.json`,
 * replayed through the real builder UI (the /tools/build response is the
 * saved one; smoke, preview, checklist and install are real). Optionally a
 * BEFORE source (`aqu-1793-builder-eval-before-<case>.html` + manifest json)
 * is installed directly for comparison. Writes `${BENCH_DIR}/aqu-1793-builder-eval-<phase>-<case>-<shot>.png`.
 *
 *   BENCH_DIR=… BENCH_CASES=verse-tracks,key-terms npm run record -- e2e/recordings/specs/builder-bench.showcase.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const DIR = process.env.BENCH_DIR ?? path.join(__dirname, "../output")
const CASES = (process.env.BENCH_CASES ?? "").split(",").filter(Boolean)

test.use({ viewport: { width: 1280, height: 800 } })

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: path.join(DIR, `aqu-1793-builder-eval-${name}.png`), fullPage })

test("builder benchmark — before/after screenshots", async ({ page }) => {
  test.setTimeout(600_000)
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)
  const jwt = await jwtFor("alice")

  for (const name of CASES) {
    const seeded = await seedProjectWithFile(jwt, { smartExtensions: true, name: `Bench ${name}`, fixturePath: FIXTURE })

    // BEFORE: the source the old prompt produced, installed as-is.
    const beforeSrc = path.join(DIR, `aqu-1793-builder-eval-before-${name}.html`)
    if (existsSync(beforeSrc)) {
      const manifest = JSON.parse(readFileSync(path.join(DIR, `aqu-1793-builder-eval-before-${name}.manifest.json`), "utf8"))
      const res = await fetch(`${AUTH_BASE}/api/v2/projects/${seeded.projectId}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ source: readFileSync(beforeSrc, "utf8"), manifest, origin: "builder", grant: ["read:cells", "read:terms", "read:comments"] }),
      })
      expect(res.status, await res.clone().text()).toBe(201)
      const id = ((await res.json()) as { tool: { id: string } }).tool.id
      await page.goto(`/project/${seeded.projectId}/extensions/${id}`)
      await page.waitForTimeout(700)
      await shot(page, `before-${name}-loading`)
      await page.waitForTimeout(5000)
      await shot(page, `before-${name}-page`)
    }

    // AFTER: the saved build replayed through the builder UI.
    const built = JSON.parse(readFileSync(path.join(DIR, `aqu-1793-builder-eval-after-${name}.json`), "utf8"))
    const request = readFileSync(path.join(DIR, `aqu-1793-builder-eval-${name}-request.txt`), "utf8").trim()
    await page.route(/\/tools\/build$/, (route) =>
      route.fulfill({ json: { ok: true, source: built.source, manifest: built.manifest, model: built.model, usage: built.usage, requirements: built.requirements, review: built.review } }),
    )
    await page.goto(`/project/${seeded.projectId}/extensions`)
    await page.getByRole("textbox", { name: "Describe your extension" }).fill(request)
    await page.getByTestId("builder-build").click()
    await expect(page.getByTestId("built-candidate")).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(4000)
    await shot(page, `after-${name}-review`, true)
    await page.unroute(/\/tools\/build$/)
    const installed = page.waitForResponse((r) => r.request().method() === "POST" && /\/tools$/.test(new URL(r.url()).pathname))
    await page.getByTestId("candidate-add").click()
    const id = ((await (await installed).json()) as { tool: { id: string } }).tool.id
    await page.goto(`/project/${seeded.projectId}/extensions/${id}`)
    await page.waitForTimeout(700)
    await shot(page, `after-${name}-loading`)
    await page.waitForTimeout(5000)
    await shot(page, `after-${name}-page`)
    if (built.manifest.mounts.includes("editor")) {
      await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
      await page.getByRole("combobox", { name: "Edit with" }).first().selectOption({ label: built.manifest.name })
      await page.waitForTimeout(6000)
      await shot(page, `after-${name}-editor`)
    }
  }
})
