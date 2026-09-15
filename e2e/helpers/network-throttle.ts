import type { Page } from "@playwright/test"

/**
 * Chromium-only network shaping through CDP `Network.emulateNetworkConditions`.
 * Applies to every request the page makes, including the ProjectSync
 * WebSocket, so both the outbox flush (`POST /events`) and the DO broadcast
 * path see the added latency. Apply it AFTER login/navigation so setup stays
 * fast; call `release()` to restore an unshaped connection.
 */
export interface ThrottleProfile {
  latencyMs: number
  /** bytes per second */
  downloadBps: number
  /** bytes per second */
  uploadBps: number
}

/** Roughly "Regular 3G": ~700 ms RTT half, ~500 kbps down / ~400 kbps up. */
export const SLOW_3G: ThrottleProfile = {
  latencyMs: 700,
  downloadBps: (500 * 1024) / 8,
  uploadBps: (400 * 1024) / 8,
}

export async function throttleNetwork(
  page: Page,
  profile: ThrottleProfile = SLOW_3G,
): Promise<{ release: () => Promise<void> }> {
  const session = await page.context().newCDPSession(page)
  await session.send("Network.enable")
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadBps,
    uploadThroughput: profile.uploadBps,
  })
  return {
    release: async () => {
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      await session.detach()
    },
  }
}
