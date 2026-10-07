import { type Page, expect } from "@playwright/test"
export class AgentConnectionPage {
  private readonly page: Page
  constructor(page: Page) { this.page = page }
  async review(url: string) {
    await this.page.goto(url)
    await this.page.getByRole("button", { name: "Review request" }).click()
    await expect(this.page.getByText("Agent name: E2E agent", { exact: true })).toBeVisible({ timeout: 30_000 })
  }
  async chooseProject(name: string) {
    await this.page.getByRole("combobox", { name: "Project" }).click()
    await this.page.getByRole("option", { name, exact: true }).click()
  }
  async authorize(code: string) {
    await this.page.getByRole("checkbox", { name: `I started this request and the code ${code} matches the code shown by my agent.` }).check()
    await this.page.getByRole("button", { name: "Authorize agent", exact: true }).click()
    await expect(this.page.getByRole("status")).toContainText("Access approved")
  }
  async reviewOAuth(url: string) {
    await this.page.goto(url)
    await expect(this.page.getByRole("checkbox", { name: "All current organizations", exact: true })).toBeVisible({ timeout: 30_000 })
  }
  async chooseAllCurrentOrganizations() {
    await this.page.getByRole("checkbox", { name: "All current organizations", exact: true }).check()
  }
  async excludeOrganization(name: string) {
    await this.page.getByRole("checkbox", { name, exact: true }).uncheck()
  }
  async allowOAuth() {
    const decision = this.page.waitForResponse(response =>
      response.url().includes("/api/v2/mcp-oauth/decision") && response.request().method() === "POST")
    await this.page.getByRole("button", { name: "Allow access", exact: true }).click()
    expect((await decision).status()).toBe(200)
  }

}
