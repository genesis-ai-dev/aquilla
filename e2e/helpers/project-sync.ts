import type { Page, WebSocket } from "@playwright/test"

function isPresenceFrame(payload: string | Buffer): boolean {
  try {
    const parsed = JSON.parse(payload.toString()) as { t?: unknown }
    return parsed.t === "presence"
  } catch {
    return false
  }
}

/**
 * Resolve after the project socket receives its initial presence snapshot.
 * Register this before navigation; waiting for a frame is the authoritative
 * indication that broadcasts can reach the page.
 */
export function waitForProjectSyncReady(
  page: Page,
  projectId: string,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket | null = null
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`ProjectSync socket for ${projectId} did not receive a presence frame within ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      page.off("websocket", onSocket)
      socket?.off("framereceived", onFrame)
      socket?.off("socketerror", onSocketError)
    }
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      if (!isPresenceFrame(payload)) return
      cleanup()
      resolve()
    }
    const onSocketError = (error: string) => {
      cleanup()
      reject(new Error(`ProjectSync socket failed before it was ready: ${error}`))
    }
    const onSocket = (candidate: WebSocket) => {
      if (!candidate.url().includes(`/parties/project-sync/${encodeURIComponent(projectId)}`)) return
      socket = candidate
      candidate.on("framereceived", onFrame)
      candidate.on("socketerror", onSocketError)
    }

    page.on("websocket", onSocket)
  })
}
