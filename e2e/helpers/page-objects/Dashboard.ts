import { type Page, expect } from "@playwright/test"

export interface CreateProjectOpts {
  name?: string
  source?: string
  target?: string
}

/** Page object for the dashboard route ("/").
 *
 * Methods are user-intent verbs (createProject, openProject, deleteProject)
 * and selectors live only here so spec authors don't duplicate them. */
export class Dashboard {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/")
    await this.page.waitForLoadState("networkidle")
  }

  async createProject(opts: CreateProjectOpts = {}): Promise<string> {
    const name = opts.name ?? `Project ${Date.now()}`
    const source = opts.source ?? "en"
    const target = opts.target ?? "fr"

    await this.page.getByRole("button", { name: /new project/i }).click()
    await this.page.getByLabel("Project Name").fill(name)
    await this.page.getByLabel("Source Language").fill(source)
    await this.page.getByLabel("Target Language").fill(target)
    await this.page.getByRole("button", { name: "Create Project" }).click()

    await expect(this.page.getByText(name)).toBeVisible({ timeout: 5_000 })
    return name
  }

  /** Click a project card by name and wait for the workspace shell to render.
   * Dismisses the per-project Setup Checklist drawer if it auto-opens. */
  async openProject(name: string): Promise<void> {
    await this.page.getByText(name).click()
    await expect(this.page.locator("aside")).toBeVisible({ timeout: 10_000 })
    const setupSheet = this.page.getByRole("dialog", { name: /project setup/i })
    if (await setupSheet.isVisible().catch(() => false)) {
      await this.page.keyboard.press("Escape")
      await expect(setupSheet).not.toBeVisible({ timeout: 3_000 })
    }
  }

  async deleteProject(name: string): Promise<void> {
    const card = this.page.locator(`text=${name}`).first()
    await card.hover()
    await card.locator("..").getByRole("button", { name: /more/i }).click()
    await this.page.getByRole("menuitem", { name: /delete|trash/i }).click()
    await this.page.getByRole("button", { name: /confirm|delete/i }).click()
    await expect(this.page.getByText(name)).not.toBeVisible({ timeout: 5_000 })
  }
}
