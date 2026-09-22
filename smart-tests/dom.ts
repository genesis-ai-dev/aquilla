import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"

const directory = path.dirname(fileURLToPath(import.meta.url))
let snapshotScript: string | undefined

export interface DomAction {
  kind: string
  role?: string
  label: string
  node?: number
}

export async function observeDom(page: Page) {
  snapshotScript ??= execFileSync(path.join(directory, ".venv/bin/python"), [
    "-c", "from jev_ultrafast.browser import READ_STATE; print(READ_STATE)",
  ], { encoding: "utf8" })
  const snapshot = await page.evaluate<{
    actions: DomAction[]; omitted_actions: number; title: string;
  }>(snapshotScript)
  if (!snapshot) throw new Error("Cannot audit an unobserved document")
  return {
    path: new URL(page.url()).pathname,
    title: snapshot.title,
    actions: snapshot.actions.map(({ kind, role, label }) => ({ kind, role, label })),
    omittedActions: snapshot.omitted_actions,
    unnamedActions: snapshot.actions.filter((action) => action.role && action.label === action.role),
  }
}
