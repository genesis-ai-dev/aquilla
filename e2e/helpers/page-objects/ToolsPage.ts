import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test"

/** The first-party default editor extension's name. */
export const DEFAULT_EDITOR = "Aquilla Editor"

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

  /** Install a starter in one click (reads granted, writes ask on first use). */
  async installStarter(name: string, opts: { landsIn?: "page" | "editor" } = {}): Promise<void> {
    const installed = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/tools$/.test(new URL(r.url()).pathname),
    )
    await this.page.getByRole("button", { name: `Install: ${name}` }).click()
    expect((await installed).status()).toBe(201)
    // Editor extensions land in the editor (its switcher); others on their page.
    await this.page.waitForURL(opts.landsIn === "editor" ? /\/editor/ : /\/extensions\/[0-9a-f-]{36}$/)
  }

  /** Pick an editor in the file view's editor switcher ("Standard editor" or an extension). */
  async switchEditor(label: string): Promise<void> {
    await this.page.getByRole("combobox", { name: "Edit with" }).first().selectOption({ label })
  }

  /** Opt this page's browser context into the first-party default editor
   *  extension (the e2e stack builds with it off so the built-in editor smoke
   *  journeys keep their editor). Call before navigating. */
  async optIntoDefaultEditorExtension(): Promise<void> {
    await this.page.context().addInitScript(() => {
      localStorage.setItem("aquilla.extensions.defaultEditor", "on")
    })
  }

  /** Open a file straight into whichever editor is the default, waiting for
   *  the first-party extension editor's frame to render its rows. */
  async openFileInDefaultEditor(projectId: string, fileId: string, firstRef: string): Promise<FrameLocator> {
    await this.page.goto(`/project/${projectId}/editor/file/${fileId}`)
    const frame = this.toolFrame(DEFAULT_EDITOR)
    await expect(this.translationBox(frame, firstRef)).toBeVisible({ timeout: 30_000 })
    return frame
  }

  /** The target surface of one row in the default editor extension (the
   *  read view, which becomes the editing surface when activated — like the
   *  built-in's TranslatedEditor). */
  translationBox(frame: FrameLocator, ref: string): Locator {
    return frame.locator(`.cell[data-ref="${ref}"] [data-target-read-view]`)
  }

  /** One row (source, target, badges) of the default editor extension. */
  editorRow(frame: FrameLocator, ref: string): Locator {
    return frame.locator(`.cell[data-ref="${ref}"]`)
  }

  /** A row's text-validation control (same aria as the built-in's). */
  validationButton(frame: FrameLocator, ref: string): Locator {
    return this.editorRow(frame, ref).locator("[data-testid=validation-gutter] button")
  }

  /** The running tool's document (an opaque-origin sandboxed frame). */
  toolFrame(name: string): FrameLocator {
    return this.page.frameLocator(`iframe[title="${name} (sandboxed extension)"]`)
  }

  permissionPrompt(): Locator {
    return this.page.getByRole("alertdialog")
  }

  async answerPrompt(answer: "Allow" | "Always" | "Deny"): Promise<void> {
    await this.permissionPrompt().getByRole("button", { name: answer }).click()
    await expect(this.permissionPrompt()).toBeHidden()
  }

  installedTool(name: string): Locator {
    return this.page.locator(`[data-testid="installed-tool"][data-tool-name="${name}"]`)
  }

  /** The editor's extensions palette (bar button) → "<name>: open in side panel". */
  async openInSidePanelFromPalette(name: string): Promise<void> {
    await this.page.getByRole("button", { name: "Smart Extensions (⌘⇧E)", exact: true }).click()
    await this.page.getByRole("option", { name: `${name}: open in side panel` }).click()
  }

  /** An installed extension's "…" menu item. */
  async openToolMenu(name: string, item: string): Promise<void> {
    await this.installedTool(name).getByTestId("tool-menu").click()
    await this.page.getByRole("menuitem", { name: item, exact: true }).click()
  }

  async openActivity(name: string): Promise<Locator> {
    await this.openToolMenu(name, "Activity")
    return this.page.getByRole("dialog").getByRole("region", { name: "Activity" })
  }

  /** The permissions dialog: one row per declared scope, granted ones marked. */
  async openPermissions(name: string): Promise<Locator> {
    await this.openToolMenu(name, "Permissions")
    return this.page.getByRole("dialog")
  }

  async revertSince(activity: Locator): Promise<void> {
    await activity.getByRole("button", { name: "Revert everything since then" }).click()
    await activity.getByRole("button", { name: "Confirm" }).click()
  }
}
