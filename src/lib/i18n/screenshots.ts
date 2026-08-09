/**
 * Localization screenshot surfaces (AQU-832).
 *
 * A "surface" is one screen or dialog of the app that a translator can look at
 * to understand a whole group of strings at once — the workspace nav, the cell
 * editor, a confirm dialog, settings. One screenshot therefore covers dozens of
 * keys, which is what makes context metadata cheap enough to keep complete.
 *
 * This registry is the single source of truth for the screenshot set:
 *   - `context.ts` may only reference a `ScreenshotId` declared here (enforced
 *     by `catalogContextIssues()`), so metadata can never point at a shot that
 *     nothing produces;
 *   - `e2e/specs/i18n/catalog-shots.spec.ts` iterates this list to regenerate
 *     the PNGs deterministically, so adding a surface here is the only step
 *     needed to get it captured.
 *
 * Files land at `<SCREENSHOT_DIR>/<id>.png` and are referenced by the stable
 * `id`, never by path, so the storage location can move (repo → R2) without
 * rewriting the metadata.
 */

/** Repo-relative directory holding the captured surface screenshots. */
export const SCREENSHOT_DIR = "src/lib/i18n/screenshots"

export interface ScreenshotSurface {
  /** Stable id; also the PNG basename. Kebab-case, no locale suffix. */
  id: string
  /** Human title shown to translators alongside the image. */
  title: string
  /**
   * Route the capture spec navigates to, in the seeded E2E project. `:projectId`
   * is substituted with the seeded project's id at capture time.
   */
  route: string
  /** What a translator should look for in this shot. */
  notes: string
}

export const SCREENSHOTS = [
  {
    id: "workspace-nav",
    title: "Workspace navigation",
    route: "/project/:projectId",
    notes:
      "Left sidebar and top chrome of a project. Navigation labels sit in a narrow " +
      "column, so translations that are much longer than the English will wrap or clip.",
  },
  {
    id: "cell-editor",
    title: "Cell editor",
    route: "/project/:projectId",
    notes:
      "The source/target editing table. Strings here appear as inline controls and " +
      "status text next to translation content, competing for horizontal space.",
  },
  {
    id: "confirm-dialog",
    title: "Confirmation dialog",
    route: "/project/:projectId",
    notes:
      "Modal confirm/cancel pattern. The action verbs are buttons sitting side by " +
      "side; keep them short and imperative.",
  },
  {
    id: "project-settings",
    title: "Project settings",
    route: "/project/:projectId/settings",
    notes:
      "Settings surface, including the language switcher. Labels are form labels " +
      "above or beside their control and have more room than nav or button text.",
  },
  {
    id: "error-state",
    title: "Error state",
    route: "/project/:projectId",
    notes:
      "Generic failure surface (error boundary / failed load). Wording should be " +
      "reassuring and non-technical; the title is a heading, not a button.",
  },
] as const satisfies readonly ScreenshotSurface[]

/**
 * Literal union of the declared surface ids. Because `context.ts` types its
 * `screenshot` fields as `ScreenshotId`, a reference to an undeclared surface is
 * a compile error, not just a lint failure.
 */
export type ScreenshotId = (typeof SCREENSHOTS)[number]["id"]

const SCREENSHOT_IDS: ReadonlySet<string> = new Set(SCREENSHOTS.map((s) => s.id))

export function isScreenshotId(id: string): boolean {
  return SCREENSHOT_IDS.has(id)
}

/** Repo-relative path of a surface's PNG. */
export function screenshotPath(id: string): string {
  return `${SCREENSHOT_DIR}/${id}.png`
}

export function screenshotSurface(id: string): ScreenshotSurface | undefined {
  return SCREENSHOTS.find((s) => s.id === id)
}
