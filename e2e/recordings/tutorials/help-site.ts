import type { BrowserContext, Route } from "@playwright/test"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/** The help site's address, as the app's Help menu links to it (VITE_DOCS_URL's default). */
export const HELP_SITE = "https://help.aquilla.app"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".pf_meta": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
}

/** The file under `dir` that a path on the site is, as a static host finds it. */
export function fileFor(dir: string, pathname: string): string | null {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
  if (clean.startsWith("..")) return null
  for (const candidate of [clean, path.join(clean, "index.html"), `${clean}.html`]) {
    const file = path.join(dir, candidate)
    if (existsSync(file) && statSync(file).isFile()) return file
  }
  return null
}

/**
 * Where the help site comes from in a take. With TUTORIALS_HELP_SITE_DIR set
 * to a built aquilla-help (`pnpm build` there makes `dist/`), the browser is
 * served those files at help.aquilla.app, so the video shows the help site of
 * that checkout and needs no network. Without it the live site is filmed.
 *
 * On the whole context: the Help menu opens the site in a new tab.
 */
export async function serveHelpSite(context: BrowserContext): Promise<void> {
  const dir = process.env.TUTORIALS_HELP_SITE_DIR
  if (!dir) return
  await context.route(`${HELP_SITE}/**`, async (route: Route) => {
    const file = fileFor(dir, new URL(route.request().url()).pathname)
    if (!file) return route.fulfill({ status: 404, body: "Not found" })
    await route.fulfill({
      status: 200,
      body: readFileSync(file),
      contentType: TYPES[path.extname(file)] ?? "application/octet-stream",
    })
  })
}
