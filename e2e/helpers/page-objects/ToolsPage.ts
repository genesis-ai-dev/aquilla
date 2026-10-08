import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test"

/**
 * Smart Extensions (prototype): the management page (/project/:id/extensions), a mounted
 * tool's sandboxed frame and its host-side permission prompt.
 */
export class ToolsPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async open(projectId: string): Promise<void> {
    const listed = this.page.waitForResponse(
      (r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(`/projects/${projectId}/tools`),
    )
    await this.page.goto(`/project/${projectId}/extensions`)
    expect((await listed).ok()).toBe(true)
  }

  /** Install a starter; leaves the read scopes checked and write scopes off
   *  (the install dialog's defaults), so writes prompt on first use. */
  async installStarter(name: string): Promise<void> {
    await this.page.getByRole("button", { name: `Install: ${name}` }).click()
    const dialog = this.page.getByRole("dialog", { name: `Install ${name}?` })
    await expect(dialog).toBeVisible()
    const installed = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/tools$/.test(new URL(r.url()).pathname),
    )
    await dialog.getByRole("button", { name: "Install", exact: true }).click()
    expect((await installed).status()).toBe(201)
    await this.page.waitForURL(/\/extensions\/[0-9a-f-]{36}$/)
  }

  /** The running tool's document (an opaque-origin sandboxed frame). */
  toolFrame(name: string): FrameLocator {
    return this.page.frameLocator(`iframe[title="${name} (sandboxed extension)"]`)
  }

  permissionPrompt(): Locator {
    return this.page.getByRole("alertdialog")
  }

  async answerPrompt(answer: "Allow once" | "Always allow" | "Deny"): Promise<void> {
    await this.permissionPrompt().getByRole("button", { name: answer }).click()
    await expect(this.permissionPrompt()).toBeHidden()
  }

  installedTool(name: string): Locator {
    return this.page.locator(`[data-testid="installed-tool"][data-tool-name="${name}"]`)
  }

  async openActivity(name: string): Promise<Locator> {
    const card = this.installedTool(name)
    await card.getByRole("button", { name: "Activity" }).click()
    return card.getByRole("region", { name: "Activity" })
  }

  async revertSince(activity: Locator): Promise<void> {
    await activity.getByRole("button", { name: "Revert everything since then" }).click()
    await activity.getByRole("button", { name: "Confirm" }).click()
  }
}
