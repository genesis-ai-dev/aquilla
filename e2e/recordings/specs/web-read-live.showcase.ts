import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * read:web end to end against the LIVE Door43 (manual showcase; needs network):
 * a builder-made extension (saved JSON in BENCH_DIR) is installed, the user
 * approves the site in the prompt, and the real auth-worker proxy fetches the
 * real TN TSV. Writes aqu-1793-web-live-*.png into BENCH_DIR.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const DIR = process.env.BENCH_DIR ?? ""
const CASE = process.env.BENCH_CASE ?? "door43-notes"

test.use({ viewport: { width: 1280, height: 800 } })

test("read:web live: Door43 translation notes through the proxy", async ({ page }) => {
  test.setTimeout(300_000)
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { smartExtensions: true, name: "Matthew (Spanish)", fixturePath: FIXTURE })
  const built = JSON.parse(readFileSync(path.join(DIR, `aqu-1793-builder-eval-after-${CASE}.json`), "utf8"))
  const res = await fetch(`${AUTH_BASE}/api/v2/projects/${seeded.projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source: built.source, manifest: built.manifest, origin: "builder", grant: ["read:cells"] }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = ((await res.json()) as { tool: { id: string } }).tool.id
  const proxied = page.waitForResponse((r) => r.url().endsWith(`/tools/${id}/web-fetch`), { timeout: 120_000 })
  await page.goto(`/project/${seeded.projectId}/extensions/${id}`)
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(DIR, "aqu-1793-web-live-prompt.png") })
  await page.getByRole("alertdialog").getByRole("button", { name: "Always allow" }).click()
  const r = await proxied
  console.log(`PROXY ${r.status()} ${JSON.stringify(await r.json()).slice(0, 200)}`)
  await page.waitForTimeout(6000)
  await page.screenshot({ path: path.join(DIR, "aqu-1793-web-live-page.png") })
})
