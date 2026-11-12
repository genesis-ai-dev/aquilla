import { expect, type Page } from "@playwright/test"

export class Checking {
  private readonly page: Page
  constructor(page: Page) { this.page = page }
  async openCreator(projectId: string) {
    await this.page.goto(`/project/${projectId}/settings/experimental`)
    const toggle = this.page.getByRole("switch", { name: "Community checking (WIP)" })
    await expect(toggle).toBeVisible({ timeout: 30_000 })
    await toggle.check()
    await expect(this.page.getByRole("checkbox", { name: "Whole project" })).toBeVisible({ timeout: 30_000 })
  }
  async createProjectLink(title: string, pin?: string) {
    await this.page.getByLabel("Link title", { exact: true }).fill(title)
    if (pin) await this.page.getByLabel("PIN (optional)", { exact: true }).fill(pin)
    await this.page.getByRole("checkbox", { name: "Whole project" }).check()
    await this.page.getByRole("button", { name: "Create checking link", exact: true }).click()
    const result = this.page.getByRole("textbox", { name: `Checking URL for ${title}` })
    await expect(result).toBeVisible()
    return result.inputValue()
  }
  async join(url: string, name: string, pin?: string) {
    await this.page.goto(url)
    await this.page.getByLabel("Your name", { exact: true }).fill(name)
    if (pin) await this.page.getByLabel("PIN, if you received one", { exact: true }).fill(pin)
    await this.page.getByRole("button", { name: "Start listening", exact: true }).click()
    await expect(this.page.getByRole("region", { name: "Passage player" })).toBeVisible({ timeout: 30_000 })
  }
  async leaveFeedback(body: string) {
    await this.page.getByRole("textbox", { name: /Feedback on/ }).fill(body)
    await this.page.getByRole("button", { name: "Send feedback", exact: true }).click()
    await expect(this.page.getByText("Feedback saved to the project. Thank you.")).toBeVisible()
  }
}
