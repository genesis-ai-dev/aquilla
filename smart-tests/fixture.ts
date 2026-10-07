import { expect, type Browser, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resetBackend } from "../e2e/helpers/seed"
import { ensureAuthState, injectSession, type PersistedSession } from "../e2e/helpers/auth"
import {
  seedProjectWithFile, readProjectedCells, mintSyncToken,
  type ProjectedCellRow, type SeededProject,
} from "../e2e/helpers/seed-project"
import { postIdempotentJson } from "../e2e/helpers/idempotent-request"
import { OUTBOX_SCHEMA_VERSION } from "../src/lib/sync/outbox-types"
import { v7 as uuidv7 } from "uuid"
import type { ValidationContract } from "./validation-oracle"
import { assertOwnedStack, verifyEdit, type EditContract } from "./outcome"

const directory = path.dirname(fileURLToPath(import.meta.url))

export async function prepareEdit() {
  assertOwnedStack(process.env)
  await resetBackend()
  const session = await ensureAuthState("alice")
  const runId = randomUUID()
  const seeded = await seedProjectWithFile(session.jwt, {
    name: `Smart QA ${runId.slice(0, 8)}`,
    fixturePath: path.join(directory, "fixtures/smart-edit.md"),
  })
  const contract: EditContract = {
    cellId: seeded.cellIds[0],
    expected: `The correction survives. ${runId.slice(0, 8)}`,
    baseline: await readProjectedCells(session.jwt, seeded),
  }
  return { session, seeded, contract, runId }
}

export function editorUrl(seeded: SeededProject): string {
  return `/project/${seeded.projectId}/editor/file/${seeded.fileId}`
}

export function targetSurface(page: Page, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] [data-cell-type="target"]`).first()
}

/** The reviewer's own sign-off control on one row, as the editor renders it. */
export function validationButton(page: Page, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] button[data-showcase="cell.validation"]`).first()
}

export async function authenticatedPage(
  browser: Browser, session: PersistedSession, seeded: SeededProject,
) {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1280, height: 900 },
  })
  try {
    const page = await context.newPage()
    await page.goto("/")
    await injectSession(page, session)
    // This is fixture setup, matching the existing smoke helper. The journey
    // still opens the project and file through Jev's own observed choices.
    await page.evaluate((id) => localStorage.setItem(`aquilla.setupAutoShown.${id}`, "1"), seeded.projectId)
    return { page, context }
  } catch (error) {
    await context.close()
    throw error
  }
}

export async function verifyInFreshSession(
  browser: Browser,
  fixture: Awaited<ReturnType<typeof prepareEdit>>,
  inputObserved: boolean,
) {
  const { session, seeded, contract } = fixture
  let rows = await readProjectedCells(session.jwt, seeded)
  const deadline = Date.now() + 10_000
  // Poll an authoritative API. Expiry records the failed contract; transport
  // errors throw and become inconclusive, never a fabricated product failure.
  while (inputObserved && Date.now() < deadline
    && !rows.some((row) => row.cellId === contract.cellId
      && row.side === "target" && row.value === contract.expected)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    rows = await readProjectedCells(session.jwt, seeded)
  }
  const { context, page } = await authenticatedPage(browser, session, seeded)
  try {
    await page.goto(editorUrl(seeded))
    const surface = targetSurface(page, contract.cellId)
    await expect(surface).toBeVisible({ timeout: 30_000 })
    // Presence cursors are siblings of the text, not part of its value.
    const freshVisible = await surface.locator("[data-target-read-view] > [data-ph-mask], .ProseMirror").first().innerText()
    return { ...verifyEdit(contract, rows, freshVisible.trim(), inputObserved), rows, freshVisible }
  } finally {
    await context.close()
  }
}

/**
 * Seed a translation on every target row through the same POST /events
 * boundary the SPA writes to. A reviewer's sign-off journey needs a file
 * that is already translated: the validation control only renders beside a
 * target that has content, and every row must offer one so the oracle can
 * still catch a sign-off on the wrong cell.
 */
export async function seedTargetTranslations(
  session: PersistedSession, seeded: SeededProject,
): Promise<ProjectedCellRow[]> {
  const sources = await readProjectedCells(session.jwt, seeded, "source")
  const token = await mintSyncToken(session.jwt, seeded.projectId, seeded.fileId)
  const events = seeded.cellIds.map((cellId, index) => ({
    id: uuidv7(),
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: seeded.projectId,
    fileId: seeded.fileId,
    cellId,
    // The source chain head is this first target commit's parent; a wrong
    // parent would be accepted and logged as a stale sibling instead.
    parentId: sources.find((row) => row.cellId === cellId)?.eventId ?? null,
    author: session.username,
    payload: { value: `Tafsiri ya mstari wa ${index + 1}.` },
    clientTs: Date.now(),
  }))
  const response = await postIdempotentJson({
    url: `http://${process.env.VITE_SYNC_WORKER_HOST}/events`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: { events },
    operation: "seed target translations",
  })
  const { rejected } = await response.json() as { rejected: unknown[] }
  if (rejected.length > 0) throw new Error("Seeded translations were rejected")
  const rows = await readProjectedCells(session.jwt, seeded)
  if (rows.filter((row) => row.side === "target" && row.value).length !== seeded.cellIds.length) {
    throw new Error("Seeded translations did not project")
  }
  return rows
}

/** A reviewer starts from a fully translated, wholly unvalidated file. */
export async function prepareValidation() {
  const fixture = await prepareEdit()
  const baseline = await seedTargetTranslations(fixture.session, fixture.seeded)
  if (baseline.some((row) => row.validated)) throw new Error("Fixture is not unvalidated")
  return {
    ...fixture,
    contract: {
      // Sign off on the last row, so reaching the first control is not enough.
      cellId: fixture.seeded.cellIds[fixture.seeded.cellIds.length - 1],
      author: fixture.session.username,
      baseline,
    } satisfies ValidationContract,
  }
}
