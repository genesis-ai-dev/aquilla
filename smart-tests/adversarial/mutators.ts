import type { BrowserContext, Page } from "@playwright/test"
import type { MutatorId } from "./attacks"

export interface MutatorHandle {
  page: Page
  context: BrowserContext
  editorPath: string
}

/**
 * One hostile condition. `setup` runs after the page loads and before Jev
 * starts. `onInput` runs once, the first time the runner sees the agent's
 * intended input, and may stop the agent. `recover` returns the browser to a
 * normal state so the durable outbox can flush before the oracle reads.
 * `applied` is evidence: a condition that never fired makes the run
 * inconclusive, never a pass.
 */
export interface Mutator {
  applied: boolean
  setup(handle: MutatorHandle): Promise<void>
  onInput(handle: MutatorHandle): Promise<{ stop: boolean }>
  recover(handle: MutatorHandle): Promise<void>
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reopen the writer so a pending outbox can flush, as the cooperative suite does. */
async function reopen({ page, editorPath }: MutatorHandle) {
  await page.goto(editorPath)
  await page.waitForLoadState("domcontentloaded")
  await settle(5_000)
}

export function createMutator(id: MutatorId | undefined): Mutator {
  const m: Mutator = {
    applied: id === undefined,
    setup: async () => {},
    onInput: async () => ({ stop: false }),
    recover: async () => { await settle(3_000) },
  }
  switch (id) {
    case undefined:
      break
    case "reload":
      m.onInput = async ({ page }) => {
        await settle(200)
        await page.reload()
        m.applied = true
        return { stop: true }
      }
      m.recover = reopen
      break
    case "back-forward":
      m.onInput = async ({ page }) => {
        await page.goBack()
        await page.goForward()
        m.applied = true
        return { stop: true }
      }
      m.recover = reopen
      break
    case "offline-blip": {
      let back: Promise<void> = Promise.resolve()
      m.onInput = async ({ context }) => {
        await context.setOffline(true)
        m.applied = true
        back = settle(5_000).then(() => context.setOffline(false))
        return { stop: false }
      }
      m.recover = async (handle) => { await back; await handle.context.setOffline(false); await reopen(handle) }
      break
    }
    case "offline-before":
      m.setup = async ({ context }) => { await context.setOffline(true); m.applied = true }
      m.recover = async (handle) => {
        await handle.context.setOffline(false)
        await settle(8_000)
        await reopen(handle)
      }
      break
    case "duplicate-tab": {
      let second: Page | null = null
      m.setup = async ({ context, editorPath }) => {
        second = await context.newPage()
        await second.goto(editorPath)
        await second.waitForLoadState("domcontentloaded")
        m.applied = true
      }
      m.recover = async () => { await settle(5_000); await second?.close() }
      break
    }
    case "throttle-3g":
      m.setup = async ({ page, context }) => {
        // CDP throttling slows HTTP only; WebSocket frames stay fast.
        const cdp = await context.newCDPSession(page)
        await cdp.send("Network.enable")
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000,
        })
        m.applied = true
      }
      m.recover = async () => { await settle(8_000) }
      break
  }
  return m
}
