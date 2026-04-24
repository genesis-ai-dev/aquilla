import { test, expect, type Page } from "@playwright/test"

async function seedProject(page: Page) {
  await page.evaluate(async () => {
    const dbReq = indexedDB.open("codex", 3)
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      dbReq.onsuccess = () => resolve(dbReq.result)
      dbReq.onerror = () => reject(dbReq.error)
      dbReq.onupgradeneeded = () => {
        const d = dbReq.result
        if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "id" })
        if (!d.objectStoreNames.contains("originals")) d.createObjectStore("originals")
        if (!d.objectStoreNames.contains("snapshots")) {
          const s = d.createObjectStore("snapshots", { keyPath: "id" })
          s.createIndex("by-project", "projectId")
        }
        if (!d.objectStoreNames.contains("shares")) {
          const s = d.createObjectStore("shares", { keyPath: "token" })
          s.createIndex("by-project", "projectId")
        }
      }
    })

    const project = {
      id: "autofix-e2e",
      name: "Autofix E2E",
      sourceLanguage: "en",
      targetLanguage: "fr",
      files: [],
      members: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: "r-forbid-foo",
          name: "Forbid foo",
          description: "Target must not contain 'foo'",
          severity: "minor",
          source: "user",
          scope: "project",
          check: { type: "target-forbids", targetPattern: "foo" },
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ],
      rulePenalties: { major: 15, minor: 5 },
      completionSettings: {
        provider: "custom",
        endpoint: "https://pop-os.tail85fd4.ts.net:8444",
        apiKey: "",
        model: "gemma-4-26B",
        maxTokens: 1024,
        temperature: 0.2,
        systemPrompt: "",
        llmHealthPenalty: 0.1,
      },
      usage: {
        llmCalls: {},
        fixesApplied: 0,
      },
    }

    const tx = db.transaction("projects", "readwrite")
    await new Promise<void>((resolve, reject) => {
      const req = tx.objectStore("projects").put(project)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    db.close()
  })
}

test.describe("autofix UI smoke", () => {
  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (err) => console.log("[page error]", err.message))
    // Commit-wait is enough to be on the origin; we don't need all resources
    // before we seed IndexedDB.
    await page.goto("/", { waitUntil: "commit" })
    await seedProject(page)
  })

  test("dashboard lists the seeded project", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Autofix E2E")).toBeVisible({ timeout: 30_000 })
  })

  test("rules page renders usage summary and the forbid-foo rule", async ({ page }) => {
    await page.goto("/project/autofix-e2e/rules")
    await expect(page.getByText("Translation Rules")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/0 fixes applied/)).toBeVisible()
    await expect(page.getByText(/LLM calls this project/)).toBeVisible()
    await expect(page.getByText("Forbid foo")).toBeVisible()
  })

  test("rules page: ?ruleId query param expands the inline autofix editor", async ({ page }) => {
    await page.goto("/project/autofix-e2e/rules?ruleId=r-forbid-foo&focus=autofix")
    const pattern = page.getByPlaceholder("Pattern")
    await expect(pattern).toBeVisible({ timeout: 30_000 })
    await expect(page.getByPlaceholder("Replacement")).toBeVisible()
    await expect(page.getByPlaceholder("Flags (e.g. gi)")).toBeVisible()
    await expect(page.getByRole("button", { name: /save autofix/i })).toBeVisible()
  })

  test("saving an autofix pattern adds the autofix badge to the rule", async ({ page }) => {
    await page.goto("/project/autofix-e2e/rules?ruleId=r-forbid-foo&focus=autofix")
    const pattern = page.getByPlaceholder("Pattern")
    await expect(pattern).toBeVisible({ timeout: 30_000 })
    await pattern.fill("\\bfoo\\b")
    await page.getByPlaceholder("Replacement").fill("bar")
    await page.getByRole("button", { name: /save autofix/i }).click()
    await page.waitForTimeout(500)
    await expect(page.getByText("autofix", { exact: true }).first()).toBeVisible()
  })
})
