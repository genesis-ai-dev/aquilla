import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test"

/** The first-party editor extension's name (manifest name, also its "Edit with" label). */
export const DEFAULT_EDITOR = "Aquilla editor (Smart Extension)"

/** The native (built-in) editor's "Edit with" label; "(default)" is appended
 *  to whichever editor is the effective default. */
export const NATIVE_EDITOR = "Aquilla editor"
export const NATIVE_EDITOR_DEFAULT = "Aquilla editor (default)"

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

  /** Add a ready-made starter: "Try {name}" opens Review & try (a sandboxed
   *  preview), then "Add to project" (reads granted, writes ask on first use). */
  async installStarter(name: string, opts: { landsIn?: "page" | "editor" } = {}): Promise<void> {
    const installed = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/tools$/.test(new URL(r.url()).pathname),
    )
    await this.page.getByRole("button", { name: `Try ${name}` }).click()
    await expect(this.page.getByTestId("built-candidate")).toBeVisible()
    await this.page.getByTestId("candidate-add").click()
    expect((await installed).status()).toBe(201)
    // Editor extensions land in the editor (its switcher); others on their page.
    await this.page.waitForURL(opts.landsIn === "editor" ? /\/editor/ : /\/extensions\/[0-9a-f-]{36}$/)
  }

  /** Step 1 of the builder: describe it, "Build it", and wait for Review &
   *  try. Resolves to the built extension's name. */
  async buildExtension(description: string, opts: { timeout?: number } = {}): Promise<string> {
    await this.page.getByRole("textbox", { name: "What should it do?" }).fill(description)
    await this.page.getByTestId("builder-build").click()
    const candidate = this.page.getByTestId("built-candidate")
    await expect(candidate).toBeVisible({ timeout: opts.timeout ?? 780_000 })
    return ((await candidate.getByRole("heading", { level: 2 }).textContent()) ?? "").trim()
  }

  /** Step 3: "Add to project" from Review & try. */
  async addCandidate(): Promise<void> {
    const installed = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/tools$/.test(new URL(r.url()).pathname),
    )
    await this.page.getByTestId("candidate-add").click()
    expect((await installed).status()).toBe(201)
  }

  /** Pick an editor in the file view's editor switcher (the native "Aquilla editor" or an extension). */
  async switchEditor(label: string): Promise<void> {
    await this.page.getByRole("combobox", { name: "Edit with" }).first().selectOption({ label })
  }

  /** Restore the product default for this browser context — the first-party
   *  editor extension (the e2e build pins it off). Call before navigating. */
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
    const label = { Allow: "Allow once", Always: "Always allow", Deny: "Not now" }[answer]
    await this.permissionPrompt().getByRole("button", { name: label, exact: true }).click()
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
    await this.openToolMenu(name, "Changes & undo")
    return this.page.getByRole("dialog").getByRole("region", { name: "Changes" })
  }

  /** The permissions dialog: one row per declared scope, granted ones marked. */
  async openPermissions(name: string): Promise<Locator> {
    await this.openToolMenu(name, "Permissions")
    return this.page.getByRole("dialog")
  }

  async revertSince(activity: Locator): Promise<void> {
    await activity.getByRole("button", { name: "Undo these changes" }).click()
    await activity.getByRole("button", { name: "Confirm" }).click()
  }
}
