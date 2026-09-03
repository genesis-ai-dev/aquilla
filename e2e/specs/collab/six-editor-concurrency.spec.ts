/**
 * AQU-1060 — 6 simultaneous editors on one project.
 *
 * Not smoke: this is a load/latency journey (six Chromium contexts + a
 * whole-Bible helloao import in flight). It runs on `pnpm test:e2e` / release,
 * not the 2-minute merge gate. The two-cursor product lie stays in
 * `concurrent-edit.smoke.spec.ts`.
 *
 * Contract:
 *   - Six distinct contributors have the same file open (ProjectSync connected).
 *   - Each commits a different cell at the same moment (blur → POST /events).
 *   - A same-project Berean Standard Bible import (checked-in helloao
 *     `complete.json` fixture, whole canon) is already in flight — the AQU-1005
 *     convoy (seq-counter row lock held across a slow write txn) would make
 *     those commits wait for the import. After the fix they must not.
 *   - Cell-write latency (blur → events ack) and live-update latency
 *     (ack → another open editor rendering the text) stay inside budget.
 */

import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { test, expect, openAuthedPage } from "../../helpers/multi-user"
import { type PersistedSession } from "../../helpers/auth"
import {
  addProjectMember,
  registerAccount,
  ROLE,
} from "../../helpers/frontier-api"
import {
  importHelloaoStringsIntoProject,
  jwtFor,
  loadHelloaoBsbFixture,
  openSeededProject,
  seedProjectWithFile,
} from "../../helpers/seed-project"
import { waitForProjectSyncReady } from "../../helpers/project-sync"
import { Workspace } from "../../helpers/page-objects/Workspace"

const EDITOR_COUNT = 6
const EXTRA_USERS = ["dave", "erin", "frank"] as const
/** Blur → POST /events 200, including Playwright protocol delay across six
 * Chromium contexts. Server-side `/events` stays well under 1s when the
 * AQU-1005 two-cursor path is healthy; a seq-lock convoy behind a whole-Bible
 * import chunk is tens of seconds to minutes. Stay under that without making
 * success depend on machine speed. */
const WRITE_BUDGET_MS = 8_000
/** Events ack → text visible in a different open editor. Matches the
 * two-cursor smoke (`concurrent-edit.smoke.spec.ts`) 15s round-trip. */
const LIVE_UPDATE_BUDGET_MS = 15_000
/** BSB verse count from helloao available_translations.json (headings add more). */
const BSB_VERSE_COUNT = 31_086

test("six editors commit distinct cells while a whole-BSB helloao import is in flight", async ({
  alice,
  bob,
  carol,
  browser,
  baseURL,
}) => {
  test.setTimeout(600_000)

  const aliceJwt = await jwtFor("alice")
  // Parse the checked-in BSB snapshot during setup so write timing only races
  // the `/import` save, not disk/gunzip.
  const bsbReady = loadHelloaoBsbFixture()
  const seeded = await seedProjectWithFile(aliceJwt, {
    name: `Six editors ${Date.now()}`,
  })
  expect(
    seeded.cellIds.length,
    "sample.md must yield at least one cell per editor",
  ).toBeGreaterThanOrEqual(EDITOR_COUNT)

  const extraSessions: PersistedSession[] = []
  for (const username of EXTRA_USERS) {
    const registered = await registerAccount({
      username,
      email: `${username}@example.test`,
      password: `${username}-test-pw`,
    })
    extraSessions.push({
      jwt: registered.jwt,
      username: registered.username,
      email: registered.email,
      createdAt: new Date().toISOString(),
    })
  }

  await addProjectMember(aliceJwt, seeded.projectId, "bob", ROLE.CONTRIBUTOR)
  await addProjectMember(aliceJwt, seeded.projectId, "carol", ROLE.CONTRIBUTOR)
  for (const session of extraSessions) {
    await addProjectMember(aliceJwt, seeded.projectId, session.username, ROLE.CONTRIBUTOR)
  }

  const extraPages: Page[] = []
  try {
    for (const session of extraSessions) {
      extraPages.push(await openAuthedPage(browser, session, { baseURL }))
    }

    const pages: Page[] = [alice, bob, carol, ...extraPages]
    const names = [
      "alice",
      "bob",
      "carol",
      ...extraSessions.map((s) => s.username),
    ]
    expect(pages).toHaveLength(EDITOR_COUNT)

    const workspaces: Workspace[] = []
    for (const page of pages) {
      const syncReady = waitForProjectSyncReady(page, seeded.projectId)
      const ws = await openSeededProject(page, seeded)
      await syncReady
      workspaces.push(ws)
    }

    const bsb = await bsbReady
    expect(bsb.id).toBe("BSB")
    expect(
      bsb.strings.length,
      "BSB fixture should parse to at least the published verse count",
    ).toBeGreaterThanOrEqual(BSB_VERSE_COUNT)

    const runId = randomUUID().slice(0, 8)
    const texts = names.map((name, i) => `aqu1060-${name}-${runId}`)

    // Start waiters before the writes so we measure ack → render, not
    // test-start → render. Each editor watches the next editor's cell
    // (circular) so every commit is observed by someone who did not type it.
    const visibleAt = texts.map((text, i) => {
      const observer = pages[(i + 1) % EDITOR_COUNT]
      const cellId = seeded.cellIds[i]
      if (!cellId) throw new Error(`missing cell id at index ${i}`)
      return observer
        .locator(`[data-cell-id="${cellId}"]`)
        .filter({ hasText: text })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => Date.now())
    })

    const loadInFlight = importHelloaoStringsIntoProject(
      aliceJwt,
      seeded.projectId,
      bsb,
    )

    const writeResults = await Promise.all(
      workspaces.map(async (ws, i) => {
        const text = texts[i]
        if (!text) throw new Error(`missing marker text at index ${i}`)
        return ws.editCellMeasuringWrite(i, text)
      }),
    )

    for (const [i, result] of writeResults.entries()) {
      expect(
        result.writeMs,
        `${names[i]} cell-write POST /events took ${result.writeMs}ms (budget ${WRITE_BUDGET_MS}ms)`,
      ).toBeLessThan(WRITE_BUDGET_MS)
    }

    const visibleTimes = await Promise.all(visibleAt)
    for (const [i, visibleMs] of visibleTimes.entries()) {
      const liveMs = visibleMs - writeResults[i]!.ackedAt
      expect(
        liveMs,
        `${names[i]} live-update to ${names[(i + 1) % EDITOR_COUNT]} took ${liveMs}ms (budget ${LIVE_UPDATE_BUDGET_MS}ms)`,
      ).toBeLessThan(LIVE_UPDATE_BUDGET_MS)
    }

    const loaded = await loadInFlight
    expect(loaded.cellIds.length).toBe(bsb.strings.length)
  } finally {
    await Promise.all(extraPages.map((page) => page.context().close()))
  }
})
