import { type Page, type Locator, expect } from "@playwright/test"

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
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto(): Promise<void> {
    // Prefer the authed fixture's org id (AuthedPage.orgId) so we never resume
    // a stale org:active into OrgRouteGate's not-found shell.
    const orgId = (this.page as Page & { orgId?: number }).orgId
    const target =
      typeof orgId === "number" && orgId > 0 ? `/orgs/${orgId}` : "/"
    await this.page.goto(target)
    await this.page.waitForLoadState("networkidle")
    await expect(this.page.getByRole("button", { name: /new project/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  }

  async createProject(opts: CreateProjectOpts = {}): Promise<string> {
    const name = opts.name ?? `Project ${Date.now()}`
    const source = opts.source ?? "en"
    const target = opts.target ?? "fr"

    const dialog = await this.openCreateProjectDialog()
    // Anchored, case-insensitive labels: the AD-9 "Advanced: project shape"
    // radios carry long descriptions (e.g. the "Source-only" option mentions
    // "target language"), so we anchor with ^...$ to avoid matching those,
    // while /i tolerates label casing ("Project name" vs "Project Name").
    await dialog.getByLabel(/^Project name$/i).fill(name)
    await dialog.getByLabel(/^Source language$/i).fill(source)
    // Self-contained projects support extra target-language lanes and label
    // the primary field "Target language(s)"; linked-target projects retain
    // the singular label. Accept both accessible names.
    await dialog.getByLabel(/^Target language(?:\(s\))?$/i).fill(target)
    const createResponse = this.page.waitForResponse((response) => {
      const request = response.request()
      if (request.method() !== "POST" || !response.ok()) return false
      try {
        return new URL(response.url()).pathname.endsWith("/api/v2/projects")
      } catch {
        return false
      }
    }, { timeout: 15_000 })
    await Promise.all([
      createResponse,
      dialog.getByRole("button", { name: /^Create Project$/i }).click(),
    ])

    // The project name renders in more than one place after creation (card +
    // heading), so scope to the first match to avoid strict-mode violations.
    await expect(dialog).toBeHidden({ timeout: 10_000 })
    await expect(this.page).toHaveURL(/\/projects\/[^/?#]+(?:[?#].*)?$/, { timeout: 15_000 })
    await expect(this.page.getByText(name).first()).toBeVisible({ timeout: 15_000 })
    return name
  }

  async openCreateProjectDialog(): Promise<Locator> {
    // A freshly-reset org renders three "+ New Project" buttons on /projects:
    // the page header, the empty-state "Create your first project" CTA, and the
    // org setup checklist. They all open the same create dialog, so scope to the
    // first (the header) to avoid a strict-mode violation.
    await this.page.getByRole("button", { name: /new project/i }).first().click()
    const dialog = this.page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  /** Click a project card by name and wait for the workspace shell to render.
   * Dismisses the per-project Setup Checklist drawer if it auto-opens. */
  async openProject(name: string): Promise<void> {
    // A project card now lands on the project Overview (/projects/:id). Enter
    // the editor workspace (/project/:id/editor) via its "Open project" action when
    // present (older UIs went straight to the editor).
    const openInEditor = this.page.getByRole("button", { name: /^Open project$/i })
    if (!(await openInEditor.isVisible({ timeout: 1_000 }).catch(() => false))) {
      await this.page.getByRole("link", { name, exact: true }).click()
    }
    if (await openInEditor.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await openInEditor.click()
    }
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
